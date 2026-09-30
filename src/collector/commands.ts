import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AdminResult } from '../admin/contract.js';
import { loadCollectorApiUrl, requestCollectorSetup, type CollectorSetupResult } from './api.js';
import { readCollectorArtifact } from './artifact.js';
import {
  COLLECTOR_BUNDLE_FILE_NAME,
  COLLECTOR_MANIFEST_FILE_NAME,
  type CollectorAgent,
  type CollectorCommandOutput,
  CollectorFailure,
  isSupportedCollectorPlatform,
} from './contract.js';
import { collectorGitBin, resolveRepositoryFromCwd } from './git.js';
import {
  collectorHookIsCurrent,
  commitCollectorHooks,
  detectCollectorAgents,
  planCollectorHooks,
  restoreCollectorHooks,
} from './hooks.js';
import {
  readCollectorInstallState,
  readInstallerVersion,
  writeCollectorInstallState,
  type CollectorInstallState,
} from './install-state.js';
import { writeFileAtomic } from './fs.js';
import { deleteKeychainToken, ensureKeychainToken, readKeychainToken } from './keychain.js';
import {
  listCollectorSecrets,
  removeCollectorSecret,
  storeCollectorSecret,
  type CollectorSecretListOutput,
  type CollectorSecretOutput,
} from './secrets.js';
import {
  collectorConfigPath,
  collectorHome,
  collectorHookPath,
  collectorInstallRoot,
  collectorInstallStatePath,
  collectorLauncherPath,
  collectorStateDir,
  collectorVersionDir,
  writeCollectorConfig,
  writeCollectorLauncher,
  writeCollectorVersion,
} from './layout.js';

export interface CollectorDoctorOutput extends CollectorCommandOutput {
  policy_version: number | null;
}

interface FileSnapshot {
  path: string;
  content: Buffer;
  mode: number;
}

// 書き込み前の存在とbytes/mode。rollback時に元の状態へ戻すためだけに使う。
interface InstallFootprint {
  installRootExisted: boolean;
  config: FileSnapshot | null;
  launcher: FileSnapshot | null;
  installState: FileSnapshot | null;
  versionDirExisted: boolean;
  versionBundle: FileSnapshot | null;
  versionManifest: FileSnapshot | null;
}

function successOutput(status: string, version: string | null, agents: CollectorAgent[], checks: Record<string, boolean>): CollectorCommandOutput {
  return { status, version, agents, checks };
}

// 同一versionの識別情報が変わるartifactは、通常の再install/updateで上書きしない。
function rejectConflictingSameVersion(installed: CollectorInstallState | null, artifact: { version: string; gitSha: string; checksum: string }): void {
  if (
    installed !== null &&
    installed.collector_version === artifact.version &&
    (installed.checksum !== artifact.checksum || (installed.git_sha !== null && installed.git_sha !== artifact.gitSha))
  ) {
    throw new CollectorFailure('collector_artifact_invalid');
  }
}

async function snapshotFile(filePath: string): Promise<FileSnapshot | null> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CollectorFailure('collector_install_error');
  }
  return { path: filePath, content: await readFile(filePath), mode: stats.mode & 0o777 };
}

async function captureInstallFootprint(home: string, collectorVersion: string): Promise<InstallFootprint> {
  const versionDir = collectorVersionDir(home, collectorVersion);
  return {
    installRootExisted: existsSync(collectorInstallRoot(home)),
    config: await snapshotFile(collectorConfigPath(home)),
    launcher: await snapshotFile(collectorLauncherPath(home)),
    installState: await snapshotFile(collectorInstallStatePath(home)),
    versionDirExisted: existsSync(versionDir),
    versionBundle: await snapshotFile(path.join(versionDir, COLLECTOR_BUNDLE_FILE_NAME)),
    versionManifest: await snapshotFile(path.join(versionDir, COLLECTOR_MANIFEST_FILE_NAME)),
  };
}

async function restoreSnapshot(snapshot: FileSnapshot | null, target: string): Promise<void> {
  if (snapshot === null) {
    await rm(target, { force: true });
    return;
  }
  await writeFileAtomic(target, snapshot.content, snapshot.mode);
}

// install/updateの書き込みを元のbytes/mode・不存在へ戻す。1つでも戻せなければrollback_failedにする。
async function rollbackInstallFootprint(home: string, collectorVersion: string, footprint: InstallFootprint): Promise<void> {
  const versionDir = collectorVersionDir(home, collectorVersion);
  let failed = false;
  const attempt = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch {
      failed = true;
    }
  };
  if (!footprint.installRootExisted) {
    await attempt(() => rm(collectorInstallRoot(home), { recursive: true, force: true }));
  } else {
    if (footprint.versionDirExisted) {
      await attempt(() => restoreSnapshot(footprint.versionBundle, path.join(versionDir, COLLECTOR_BUNDLE_FILE_NAME)));
      await attempt(() => restoreSnapshot(footprint.versionManifest, path.join(versionDir, COLLECTOR_MANIFEST_FILE_NAME)));
    } else {
      await attempt(() => rm(versionDir, { recursive: true, force: true }));
    }
    await attempt(() => restoreSnapshot(footprint.launcher, collectorLauncherPath(home)));
    await attempt(() => restoreSnapshot(footprint.installState, collectorInstallStatePath(home)));
  }
  await attempt(() => restoreSnapshot(footprint.config, collectorConfigPath(home)));
  if (failed) {
    throw new CollectorFailure('collector_rollback_failed');
  }
}

// installはcommit pointのinstall.jsonを最後に書く。失敗時はhooksを含む全成果物をrollbackする。
async function installCollector(env: NodeJS.ProcessEnv): Promise<CollectorCommandOutput> {
  const home = collectorHome(env);
  const agents = await detectCollectorAgents(home);
  if (agents.length === 0) {
    throw new CollectorFailure('agent_not_found');
  }
  const artifact = await readCollectorArtifact(env);
  const previousInstall = await readCollectorInstallState(collectorInstallStatePath(home));
  rejectConflictingSameVersion(previousInstall, artifact);
  const launcherPath = collectorLauncherPath(home);
  const configPath = collectorConfigPath(home);
  const hookUpdates = await planCollectorHooks(home, agents, launcherPath, configPath, 'install');
  const apiUrl = await loadCollectorApiUrl(configPath);
  const repository = resolveRepositoryFromCwd(env, process.cwd());
  const keychain = ensureKeychainToken(env, apiUrl);
  let setup: CollectorSetupResult;
  try {
    setup = await requestCollectorSetup(apiUrl, keychain.token, repository);
  } catch (error) {
    // このrunで新規作成したitemだけを戻す。既存itemは絶対に削除しない。
    if (keychain.created) {
      await deleteKeychainToken(env, apiUrl);
    }
    throw error;
  }
  const installerVersion = await readInstallerVersion();
  const footprint = await captureInstallFootprint(home, artifact.version);
  let hooksCommitted = false;
  try {
    await writeCollectorVersion(home, artifact);
    await writeCollectorLauncher(home);
    await writeCollectorConfig(home, apiUrl);
    await commitCollectorHooks(hookUpdates);
    hooksCommitted = true;
    await writeCollectorInstallState(collectorInstallStatePath(home), {
      installer_version: installerVersion,
      collector_version: artifact.version,
      git_sha: artifact.gitSha,
      checksum: artifact.checksum,
      policy_version: setup.policy_version,
    });
  } catch (error) {
    let rollbackFailed = false;
    if (keychain.created) {
      try {
        deleteKeychainToken(env, apiUrl);
      } catch {
        rollbackFailed = true;
      }
    }
    try {
      if (hooksCommitted) {
        await restoreCollectorHooks(hookUpdates);
      }
      await rollbackInstallFootprint(home, artifact.version, footprint);
    } catch {
      rollbackFailed = true;
    }
    if (rollbackFailed) {
      throw new CollectorFailure('collector_rollback_failed');
    }
    throw error instanceof CollectorFailure ? error : new CollectorFailure('collector_install_error');
  }
  return successOutput('installed', artifact.version, agents, { artifact: true, launcher: true, config: true, hooks: true });
}

// updateは検証済みartifactへinstall.jsonを最後に切り替える。旧versionとsetup policy_versionを維持する。
async function updateCollector(env: NodeJS.ProcessEnv): Promise<CollectorCommandOutput> {
  const home = collectorHome(env);
  const installed = await readCollectorInstallState(collectorInstallStatePath(home));
  if (installed === null) {
    throw new CollectorFailure('collector_not_installed');
  }
  const artifact = await readCollectorArtifact(env);
  rejectConflictingSameVersion(installed, artifact);
  const installerVersion = await readInstallerVersion();
  const footprint = await captureInstallFootprint(home, artifact.version);
  try {
    await writeCollectorVersion(home, artifact);
    await writeCollectorLauncher(home);
    await writeCollectorInstallState(collectorInstallStatePath(home), {
      installer_version: installerVersion,
      collector_version: artifact.version,
      git_sha: artifact.gitSha,
      checksum: artifact.checksum,
      policy_version: installed.policy_version,
    });
  } catch (error) {
    try {
      await rollbackInstallFootprint(home, artifact.version, footprint);
    } catch {
      throw new CollectorFailure('collector_rollback_failed');
    }
    throw error instanceof CollectorFailure ? error : new CollectorFailure('collector_install_error');
  }
  const agents = await detectCollectorAgents(home);
  return successOutput('updated', artifact.version, agents, { artifact: true, launcher: true, state: true });
}

async function fileMode(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch {
    return null;
  }
}

// 秘密文件のgroup/other permissionとowner実行権、hookのowner書込み可否だけを診断する。
async function collectorPermissionsOkay(home: string, agents: readonly CollectorAgent[], collectorVersion: string | null): Promise<boolean> {
  const strictFiles: { path: string; needsExecutable: boolean }[] = [
    { path: collectorLauncherPath(home), needsExecutable: true },
    { path: collectorConfigPath(home), needsExecutable: false },
    { path: collectorInstallStatePath(home), needsExecutable: false },
  ];
  if (collectorVersion !== null) {
    const versionDir = collectorVersionDir(home, collectorVersion);
    strictFiles.push({ path: path.join(versionDir, COLLECTOR_BUNDLE_FILE_NAME), needsExecutable: false });
    strictFiles.push({ path: path.join(versionDir, COLLECTOR_MANIFEST_FILE_NAME), needsExecutable: false });
  }
  for (const file of strictFiles) {
    const mode = await fileMode(file.path);
    if (mode === null || (mode & 0o077) !== 0 || (file.needsExecutable && (mode & 0o100) === 0)) {
      return false;
    }
  }
  const stateMode = await fileMode(collectorStateDir(home));
  if (stateMode !== null && (stateMode & 0o077) !== 0) {
    return false;
  }
  for (const agent of agents) {
    const mode = await fileMode(collectorHookPath(home, agent));
    if (mode !== null && (mode & 0o200) === 0) {
      return false;
    }
  }
  return true;
}

// 配置・hook・configと現在のsetup policyを読み取りだけで診断する。tokenやpathは出力しない。
async function doctorCollector(env: NodeJS.ProcessEnv): Promise<CollectorDoctorOutput> {
  const home = collectorHome(env);
  const agents = await detectCollectorAgents(home);
  let installed: CollectorInstallState | null = null;
  try {
    installed = await readCollectorInstallState(collectorInstallStatePath(home));
  } catch {
    installed = null;
  }
  const collectorVersion = installed?.collector_version ?? null;
  const checks: Record<string, boolean> = {
    installed: installed !== null,
    artifact: false,
    launcher: existsSync(collectorLauncherPath(home)),
    config: false,
    hooks: false,
    keychain: false,
    setup: false,
    platform: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 24,
    git: false,
    permissions: false,
  };
  if (collectorVersion !== null) {
    const versionDir = collectorVersionDir(home, collectorVersion);
    const [bundle, manifestText] = await Promise.all([
      readFile(path.join(versionDir, COLLECTOR_BUNDLE_FILE_NAME)).catch(() => null),
      readFile(path.join(versionDir, COLLECTOR_MANIFEST_FILE_NAME), 'utf8').catch(() => null),
    ]);
    if (bundle !== null && manifestText !== null) {
      try {
        const manifest = JSON.parse(manifestText) as { version?: unknown; git_sha?: unknown; checksum?: unknown };
        checks.artifact =
          manifest.version === installed?.collector_version &&
          manifest.git_sha === installed?.git_sha &&
          manifest.checksum === installed?.checksum &&
          manifest.checksum === createHash('sha256').update(bundle).digest('hex');
      } catch {
        checks.artifact = false;
      }
    }
  }
  const launcherPath = collectorLauncherPath(home);
  const configPath = collectorConfigPath(home);
  const configText = await readFile(configPath, 'utf8').catch(() => null);
  checks.config = configText !== null;
  checks.hooks =
    agents.length > 0 && (await Promise.all(agents.map((agent) => collectorHookIsCurrent(home, agent, launcherPath, configPath)))).every(Boolean);
  checks.permissions = await collectorPermissionsOkay(home, agents, collectorVersion);
  checks.git = path.isAbsolute(collectorGitBin(env)) && existsSync(collectorGitBin(env));

  let policyVersion: number | null = null;
  try {
    const apiUrl = await loadCollectorApiUrl(configPath);
    const token = readKeychainToken(env, apiUrl);
    checks.keychain = token !== null;
    if (token !== null) {
      const repository = resolveRepositoryFromCwd(env, process.cwd());
      const setup = await requestCollectorSetup(apiUrl, token, repository);
      policyVersion = setup.policy_version;
      checks.setup = true;
    }
  } catch {
    // 診断は失敗を null/false として返し、raw errorや応答bodyを出さない。
  }
  const status = !checks.installed ? 'not_installed' : Object.values(checks).every(Boolean) ? 'ok' : 'degraded';
  return { status, version: collectorVersion, agents, policy_version: policyVersion, checks };
}

// 所有hook entry・config・install rootを削除し、Keychainとstate ~/.yori-collectorは保持する。
async function uninstallCollector(env: NodeJS.ProcessEnv): Promise<CollectorCommandOutput> {
  const home = collectorHome(env);
  const agents = await detectCollectorAgents(home);
  const installed = await readCollectorInstallState(collectorInstallStatePath(home)).catch(() => null);
  const launcherPath = collectorLauncherPath(home);
  const configPath = collectorConfigPath(home);
  const hookUpdates = await planCollectorHooks(home, agents, launcherPath, configPath, 'uninstall');
  await commitCollectorHooks(hookUpdates);
  await rm(configPath, { force: true });
  await rm(collectorInstallRoot(home), { recursive: true, force: true });
  return successOutput('uninstalled', installed?.collector_version ?? null, agents, { keychain: true, hooks: true });
}

type CollectorCommandResult =
  | CollectorCommandOutput
  | CollectorDoctorOutput
  | CollectorSecretOutput
  | CollectorSecretListOutput
  | Record<string, unknown>;

const BACKFILL_SOURCES = ['codex', 'claude_code', 'deepseek_harness'] as const;

function parseBackfillArguments(args: readonly string[]): { dryRun: boolean; source?: (typeof BACKFILL_SOURCES)[number] } {
  let dryRun = false;
  let source: (typeof BACKFILL_SOURCES)[number] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--dry-run') {
      if (dryRun) {
        throw new CollectorFailure('collector_invalid_request');
      }
      dryRun = true;
      continue;
    }
    if (key === '--source') {
      const value = args[index + 1];
      if (source !== undefined || value === undefined || !BACKFILL_SOURCES.includes(value as (typeof BACKFILL_SOURCES)[number])) {
        throw new CollectorFailure('collector_invalid_request');
      }
      source = value as (typeof BACKFILL_SOURCES)[number];
      index += 1;
      continue;
    }
    throw new CollectorFailure('collector_invalid_request');
  }
  return { dryRun, source };
}

// 起動時cwdを一度だけ固定し、stable launcher経由で配布済みcollectorのbackfillを実行する。
async function backfillCollector(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const parsed = parseBackfillArguments(args);
  const home = collectorHome(env);
  const installed = await readCollectorInstallState(collectorInstallStatePath(home));
  if (installed === null || !existsSync(collectorLauncherPath(home))) {
    throw new CollectorFailure('collector_not_installed');
  }
  const repositoryPath = process.cwd();
  const childArgs = [
    collectorLauncherPath(home),
    'backfill',
    '--repository',
    repositoryPath,
    '--config',
    collectorConfigPath(home),
  ];
  if (parsed.dryRun) {
    childArgs.push('--dry-run');
  }
  if (parsed.source !== undefined) {
    childArgs.push('--source', parsed.source);
  }
  const result = spawnSync(process.execPath, childArgs, {
    cwd: repositoryPath,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.stderr !== '' || typeof result.stdout !== 'string') {
    throw new CollectorFailure('collector_backfill_error');
  }
  try {
    const output: unknown = JSON.parse(result.stdout);
    if (typeof output !== 'object' || output === null || Array.isArray(output)) {
      throw new Error('invalid output');
    }
    return output as Record<string, unknown>;
  } catch {
    throw new CollectorFailure('collector_backfill_error');
  }
}

// collector:secret:add/list/remove。値はKeychainだけへ置き、indexはlabelだけを持つ。
async function runCollectorSecretCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CollectorSecretOutput | CollectorSecretListOutput> {
  if (command === 'collector:secret:list') {
    if (args.length !== 0) {
      throw new CollectorFailure('collector_invalid_request');
    }
    return await listCollectorSecrets(env);
  }
  if (command === 'collector:secret:remove') {
    if (args.length !== 1) {
      throw new CollectorFailure('collector_invalid_request');
    }
    return await removeCollectorSecret(env, args[0]);
  }
  if (args.length === 1) {
    // 非表示promptはsecurity -wへ委ね、CLIはstdinを読まない。
    return await storeCollectorSecret(env, args[0], null);
  }
  if (args.length === 3 && args[1] === '--from-env') {
    // --from-envの値だけをsecurityのstdin経由で渡し、argv・stdoutへ出さない。
    // security子processは親envを継承するため、値を読んだ直後に元の環境変数を削除する。
    const name = args[2];
    const value = env[name];
    if (value === undefined) {
      throw new CollectorFailure('collector_invalid_request');
    }
    delete env[name];
    return await storeCollectorSecret(env, args[0], value);
  }
  throw new CollectorFailure('collector_invalid_request');
}

export async function runCollectorCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<AdminResult<CollectorCommandResult>> {
  if (!isSupportedCollectorPlatform(process.platform)) {
    return { ok: false, code: 'unsupported_platform' };
  }
  try {
    switch (command) {
      case 'collector:install':
        return { ok: true, value: await installCollector(env) };
      case 'collector:backfill':
        return { ok: true, value: await backfillCollector(args, env) };
      case 'collector:update':
        return { ok: true, value: await updateCollector(env) };
      case 'collector:doctor':
        return { ok: true, value: await doctorCollector(env) };
      case 'collector:uninstall':
        return { ok: true, value: await uninstallCollector(env) };
      case 'collector:secret:add':
      case 'collector:secret:list':
      case 'collector:secret:remove':
        return { ok: true, value: await runCollectorSecretCommand(command, args, env) };
      default:
        return { ok: false, code: 'invalid_arguments' };
    }
  } catch (error) {
    if (error instanceof CollectorFailure) {
      return { ok: false, code: error.code };
    }
    return { ok: false, code: 'collector_internal_error' };
  }
}
