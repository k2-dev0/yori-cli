import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCollectorArtifact } from '../../collector/artifact.js';
import { commitCollectorHooks, planCollectorHooks } from '../../collector/hooks.js';
import { writeCollectorInstallState } from '../../collector/install-state.js';
import {
  collectorConfigPath as collectorConfigPathFromHome,
  collectorInstallStatePath,
  collectorLauncherPath,
  writeCollectorConfig,
  writeCollectorLauncher,
  writeCollectorVersion,
} from '../../collector/layout.js';
import { REPO_ROOT } from './support.js';

// collector:install系のCLI契約を、実HOME・実Keychain・実API・実gitへ触れずに検証するためのfixture。
// CLIは子processとして起動し、stdout・stderr・終了コードと作成物だけを検証する。
// 実装が満たすtest seam（いずれもtest/development専用の明示override）:
// - YORI_COLLECTOR_ARTIFACT_DIR: install/updateが読むartifact directory。未設定時の既定は公開packageの
//   dist/collector隣接pathであり、PATH解決やsource repositoryの探索は契約にしない。読み込むmanifestの
//   checksum検証は必須で、override pathはinstall output・config・manifest・hooksへ保存しない。
// - YORI_SECURITY_BIN / YORI_GIT_BIN: 実行ファイルの絶対path override。未設定時の既定は /usr/bin/security と
//   /usr/bin/git の絶対path（PATHからの解決は契約にしない）。使うのは明示override時だけ。
// - globalThis.fetch: API呼出しはfetchを使い、このmockが--importで先に差し替える。
const CLI_PATH = path.join(REPO_ROOT, 'src', 'admin', 'cli.ts');
// テストはcwdをfixture repositoryへ変えるため、tsxはcwdへ依存しない絶対URLで読み込む。
const TSX_LOADER_URL = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const API_MOCK_URL = new URL('./fixtures/collector-api-mock.mjs', import.meta.url).href;

export const DEFAULT_API_URL = 'https://yori-pilot.online';
export const KEYCHAIN_SERVICE = 'online.yori.collector';
export const SECRET_KEYCHAIN_SERVICE = 'online.yori.collector.secret';
export const CONFIG_FILE_NAME = '.yori-collector.json';
export const SECRETS_INDEX_FILE_NAME = 'secrets.json';

export const HOOK_FILES = {
  codex: { relative: path.join('.codex', 'hooks.json'), source: 'codex' },
  claude_code: { relative: path.join('.claude', 'settings.json'), source: 'claude_code' },
} as const;
export type CollectorAgent = keyof typeof HOOK_FILES;

export interface CollectorFixture {
  root: string;
  home: string;
  binDir: string;
  artifactDir: string;
  gitRoot: string;
  gitOrigin: string;
  apiSpecPath: string;
  apiLogPath: string;
  securityLogPath: string;
  keychainPath: string;
  secretsDir: string;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  networkError?: boolean;
}

export interface CollectorRun {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_SHIM = `#!/bin/sh
# test fixture: 実git repositoryを要求せず、toplevelとoriginを固定値で返す。
case "$*" in
  *"rev-parse --is-inside-work-tree"*) printf '%s\\n' true ;;
  *"rev-parse --show-toplevel"*) printf '%s\\n' "\${YORI_TEST_GIT_ROOT:?}" ;;
  *"remote.origin.url"*) printf '%s\\n' "\${YORI_TEST_GIT_ORIGIN:?}" ;;
  *"remote get-url origin"*) printf '%s\\n' "\${YORI_TEST_GIT_ORIGIN:?}" ;;
  *) exit 1 ;;
esac
`;

const SECURITY_SHIM = `#!/bin/sh
# test fixture: 実Keychainへ触れず、呼出しargvとtoken/secretの受け渡しだけを記録する。
# token itemはkeychain file 1件、secret itemはonline.yori.collector.secret serviceのlabel別fileで模す。
log="\${YORI_TEST_SECURITY_LOG:?}"
for arg in "$@"; do
  printf '%s\\037' "$arg" >> "$log"
done
printf '\\n' >> "$log"

service=""
account=""
previous=""
for arg in "$@"; do
  case "$previous" in
    -s) service="$arg" ;;
    -a) account="$arg" ;;
  esac
  previous="$arg"
done

case "$service" in
  online.yori.collector.secret)
    secret_dir="\${YORI_TEST_SECRETS_DIR:?}"
    target="$secret_dir/$account"
    case "$1" in
      find-generic-password)
        if [ -f "$target" ]; then
          cat "$target"
          printf '\\n'
        else
          printf '%s\\n' 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2
          exit 44
        fi
        ;;
      add-generic-password)
        IFS= read -r value || exit 1
        mkdir -p "$secret_dir"
        printf '%s' "$value" > "$target"
        ;;
      delete-generic-password)
        if [ -f "$target" ]; then
          rm -f "$target"
        else
          exit 44
        fi
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  *)
    case "$1" in
      find-generic-password)
        if [ -f "\${YORI_TEST_KEYCHAIN_FILE:?}" ]; then
          cat "\${YORI_TEST_KEYCHAIN_FILE:?}"
        else
          printf '%s\\n' 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2
          exit 44
        fi
        ;;
      add-generic-password)
        IFS= read -r token || exit 1
        printf '%s' "$token" > "\${YORI_TEST_KEYCHAIN_FILE:?}"
        ;;
      delete-generic-password)
        if [ -f "\${YORI_TEST_KEYCHAIN_FILE:?}" ]; then
          rm -f "\${YORI_TEST_KEYCHAIN_FILE:?}"
        else
          exit 44
        fi
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
esac
`;

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function createCollectorFixture(): Promise<CollectorFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'yori-collector-test-'));
  const home = path.join(root, 'home');
  const binDir = path.join(root, 'bin');
  const artifactDir = path.join(root, 'artifact');
  const gitRoot = path.join(root, 'repo');
  const secretsDir = path.join(root, 'keychain-secrets');
  await Promise.all([mkdir(home), mkdir(binDir), mkdir(artifactDir), mkdir(gitRoot), mkdir(secretsDir)]);
  await Promise.all([
    writeFile(path.join(binDir, 'git'), GIT_SHIM, { mode: 0o755 }),
    writeFile(path.join(binDir, 'security'), SECURITY_SHIM, { mode: 0o755 }),
  ]);
  await Promise.all([chmod(path.join(binDir, 'git'), 0o755), chmod(path.join(binDir, 'security'), 0o755)]);
  return {
    root,
    home,
    binDir,
    artifactDir,
    gitRoot,
    gitOrigin: 'https://github.com/example/repo.git',
    apiSpecPath: path.join(root, 'api-spec.json'),
    apiLogPath: path.join(root, 'api-log.jsonl'),
    securityLogPath: path.join(root, 'security-log.txt'),
    keychainPath: path.join(root, 'keychain.txt'),
    secretsDir,
  };
}

export async function cleanupCollectorFixture(fixture: CollectorFixture): Promise<void> {
  // permission testでHOMEを読み取り専用にした場合も削除できるよう、先に戻す。
  await chmod(fixture.home, 0o700).catch(() => undefined);
  await chmod(fixture.root, 0o700).catch(() => undefined);
  await rm(fixture.root, { recursive: true, force: true });
}

export async function withCollectorFixture<T>(run: (fixture: CollectorFixture) => Promise<T>): Promise<T> {
  const fixture = await createCollectorFixture();
  try {
    return await run(fixture);
  } finally {
    await cleanupCollectorFixture(fixture);
  }
}

export function hookPath(fixture: CollectorFixture, agent: CollectorAgent): string {
  return path.join(fixture.home, HOOK_FILES[agent].relative);
}

export function collectorConfigPath(fixture: CollectorFixture): string {
  return path.join(fixture.home, CONFIG_FILE_NAME);
}

// collector本体の配置root。version directoryとstable launcherの所有範囲を一箇所へ固定する。
export function collectorInstallRoot(fixture: CollectorFixture): string {
  return path.join(fixture.home, '.local', 'share', 'yori', 'collector');
}

export function collectorVersionDir(fixture: CollectorFixture, version: string): string {
  return path.join(collectorInstallRoot(fixture), 'versions', version);
}

// test用artifact fixtureを作る。checksumを省略すると本文から計算し、指定すると不一致を作れる。
export async function writeCollectorArtifact(
  fixture: CollectorFixture,
  options: { version: string; content: string; checksum?: string },
): Promise<void> {
  const manifest = {
    version: options.version,
    file: 'yori-collector.mjs',
    checksum: options.checksum ?? sha256Hex(options.content),
  };
  await writeFile(path.join(fixture.artifactDir, 'yori-collector.mjs'), options.content, 'utf8');
  await writeFile(path.join(fixture.artifactDir, 'collector-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function writeApiSpec(fixture: CollectorFixture, responses: ApiResponse[]): Promise<void> {
  await writeFile(fixture.apiSpecPath, JSON.stringify(responses), 'utf8');
}

// fetch mockが記録したsetup request。tokenはtest用fixtureの値だけを扱う。
export async function readApiRequests(fixture: CollectorFixture): Promise<Record<string, unknown>[]> {
  const content = await readFile(fixture.apiLogPath, 'utf8').catch(() => '');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// security shimが記録したargv配列。1回の呼出しが1行。
export async function readSecurityCalls(fixture: CollectorFixture): Promise<string[][]> {
  const content = await readFile(fixture.securityLogPath, 'utf8').catch(() => '');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\u001f').filter((arg) => arg.length > 0));
}

export async function keychainToken(fixture: CollectorFixture): Promise<string | null> {
  return readFile(fixture.keychainPath, 'utf8').catch(() => null);
}

export interface RootCliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  artifactDir?: string;
}

// root CLIを隔離環境で起動する。NODE_OPTIONSではなく--importでfetch mockを先に読み込む。
export async function runRootCli(fixture: CollectorFixture, args: string[], options: RootCliOptions = {}): Promise<CollectorRun> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    // 実装はPATHではなくこれらの絶対path overrideを使う。未設定時だけ/usr/bin/security・/usr/bin/gitへ戻る。
    YORI_SECURITY_BIN: path.join(fixture.binDir, 'security'),
    YORI_GIT_BIN: path.join(fixture.binDir, 'git'),
    // collector commandがadmin用SSH transportを起動しないよう、実sshではなく不在pathを既定にする。
    YORI_SSH_BIN: path.join(fixture.binDir, 'ssh-not-configured'),
    YORI_TEST_GIT_ROOT: fixture.gitRoot,
    YORI_TEST_GIT_ORIGIN: fixture.gitOrigin,
    YORI_TEST_SECURITY_LOG: fixture.securityLogPath,
    YORI_TEST_KEYCHAIN_FILE: fixture.keychainPath,
    YORI_TEST_SECRETS_DIR: fixture.secretsDir,
    YORI_TEST_API_SPEC: fixture.apiSpecPath,
    YORI_TEST_API_LOG: fixture.apiLogPath,
    // test/development専用override。標準installはpackage隣接のdist/collectorを読む。
    YORI_COLLECTOR_ARTIFACT_DIR: options.artifactDir ?? fixture.artifactDir,
  };
  // collector commandがDATABASE_URLへ依存しないことを検証するため、既定では子から取り除く。
  delete env.DATABASE_URL;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const child = spawn(process.execPath, ['--import', TSX_LOADER_URL, '--import', API_MOCK_URL, CLI_PATH, ...args], {
    cwd: options.cwd ?? fixture.gitRoot,
    env,
  });
  child.stdin.end(options.input ?? '');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// 成功時は1行JSONだけをstdoutへ出す既存admin CLI契約を検証しつつparseする。
export function parseCollectorSuccess(run: CollectorRun): Record<string, unknown> {
  if (run.code !== 0 || run.stderr !== '') {
    throw new Error(`成功を期待したが code=${run.code} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`);
  }
  const lines = run.stdout.split('\n');
  if (lines.at(-1) !== '' || lines.length !== 2) {
    throw new Error(`stdoutが1行JSONではない: ${JSON.stringify(run.stdout)}`);
  }
  const parsed: unknown = JSON.parse(lines[0]);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`stdout JSONがobjectではない: ${JSON.stringify(run.stdout)}`);
  }
  return parsed as Record<string, unknown>;
}

// 未実装の間はunknown commandのinvalid_argumentsへ落ちるため、命令認識自体もRed条件にする。
export function assertCollectorFailure(run: CollectorRun, forbidden: string[] = []): string {
  const stderr = run.stderr;
  if (run.code !== 1 || run.stdout !== '' || !/^admin: [a-z_]+\n$/.test(stderr)) {
    throw new Error(`固定codeの失敗ではない: code=${run.code} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(stderr)}`);
  }
  if (stderr === 'admin: invalid_arguments\n') {
    throw new Error('collector commandが未実装でunknown commandとして拒否された');
  }
  for (const value of forbidden) {
    if (stderr.includes(value)) {
      throw new Error(`失敗出力に禁止文字列が含まれている: ${value}`);
    }
  }
  return stderr;
}

// hook JSONの全文字列から、collector設定を指すcommandだけを取り出す。
export function collectorCommands(hookJson: unknown): string[] {
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      strings.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(visit);
    }
  };
  visit(hookJson);
  return strings.filter((value) => value.includes(CONFIG_FILE_NAME));
}

// directory配下のfileを相対pathで列挙する。symlinkは辿らない。
export async function listFilesRecursively(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true });
    return entries.map(String).sort();
  } catch {
    return [];
  }
}

// 配置root配下の絶対pathをcommand文字列から抽出する。
export function commandPathsUnder(command: string, root: string): string[] {
  return (command.match(/\/[^\s'"]+/g) ?? []).filter((value) => value.startsWith(root));
}

export async function writeHookJson(fixture: CollectorFixture, agent: CollectorAgent, value: unknown): Promise<void> {
  const target = hookPath(fixture, agent);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// 無関係な既存設定の保持を検証するための既存hook。
export function agentHookFixture(): Record<string, unknown> {
  return {
    unrelated_setting: { keep: true },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo unrelated-prompt' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated-stop' }] }],
    },
  };
}

export const DEFAULT_TOKEN = 'yori_fixture_token_2f8a9c';
export const DEFAULT_COLLECTOR_VERSION = '9.9.9-test1';
// launcherがYORI_COLLECTOR_TOKENを子collector envへだけ渡すことを検出するfixture。
// envが無ければ非0で終了し、あればtoken値を出さずmarkerだけを出す。
export const DEFAULT_COLLECTOR_BUNDLE =
  "if (!process.env.YORI_COLLECTOR_TOKEN) { console.error('collector-fixture-missing-token'); process.exit(3); }\nconsole.log(\"collector-fixture-v1\");\n";
export const DEFAULT_SETUP_RESPONSE: ApiResponse = {
  status: 200,
  body: {
    project_id: '01930000-0000-7000-8000-000000000001',
    repository: 'github.com/example/repo',
    redaction_policy: {
      version: 3,
      fields: ['fixture_field'],
      terms: ['fixture-term'],
      suspicion_mode: 'observe',
      detector_version: 'initial-v1',
    },
  },
};

export interface PrepareCollectorOptions {
  agents?: readonly CollectorAgent[];
  token?: string;
  tokenRegistered?: boolean;
  version?: string;
  content?: string;
  setupResponse?: ApiResponse;
}

// install/updateの正常系入力をfixtureへ用意する。APIはmockだけを使い、Keychain登録の有無を選べる。
// artifactはYORI_COLLECTOR_ARTIFACT_DIRのtest overrideで渡す（標準ではpackage隣接dist/collector）。
export async function prepareCollectorInstall(fixture: CollectorFixture, options: PrepareCollectorOptions = {}): Promise<void> {
  const agents = options.agents ?? (['codex', 'claude_code'] as const);
  for (const agent of agents) {
    await writeHookJson(fixture, agent, agentHookFixture());
  }
  await writeCollectorArtifact(fixture, {
    version: options.version ?? DEFAULT_COLLECTOR_VERSION,
    content: options.content ?? DEFAULT_COLLECTOR_BUNDLE,
  });
  await writeApiSpec(fixture, [options.setupResponse ?? DEFAULT_SETUP_RESPONSE]);
  if (options.tokenRegistered === false) {
    await rm(fixture.keychainPath, { force: true });
  } else {
    await writeFile(fixture.keychainPath, options.token ?? DEFAULT_TOKEN, 'utf8');
  }
}

// setup APIのpolicy契約に依存せず、検証済みartifactからcollector:installと同じlayoutを直接作る。
// collector:installが新policyへ追随する前でもstable launcher自体の挙動を検証するためのfixture。
export async function installCollectorWithoutSetup(fixture: CollectorFixture, content: string): Promise<void> {
  const agents = ['codex', 'claude_code'] as const;
  for (const agent of agents) {
    await writeHookJson(fixture, agent, agentHookFixture());
  }
  await writeCollectorArtifact(fixture, { version: DEFAULT_COLLECTOR_VERSION, content });
  await writeFile(fixture.keychainPath, DEFAULT_TOKEN, 'utf8');
  const artifact = await readCollectorArtifact({ ...process.env, YORI_COLLECTOR_ARTIFACT_DIR: fixture.artifactDir });
  await writeCollectorVersion(fixture.home, artifact);
  await writeCollectorLauncher(fixture.home);
  await writeCollectorConfig(fixture.home, DEFAULT_API_URL);
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
  await writeCollectorInstallState(collectorInstallStatePath(fixture.home), {
    installer_version: packageJson.version,
    collector_version: artifact.version,
    checksum: artifact.checksum,
    policy_version: null,
  });
  await commitCollectorHooks(
    await planCollectorHooks(fixture.home, agents, collectorLauncherPath(fixture.home), collectorConfigPathFromHome(fixture.home), 'install'),
  );
}

export async function collectorCommandsFor(fixture: CollectorFixture, agent: CollectorAgent): Promise<string[]> {
  const content = await readFile(hookPath(fixture, agent), 'utf8').catch(() => '');
  return content.length === 0 ? [] : collectorCommands(JSON.parse(content));
}

export async function hookCommandFor(fixture: CollectorFixture, agent: CollectorAgent, kind: 'collect' | 'notify'): Promise<string> {
  const commands = await collectorCommandsFor(fixture, agent);
  const command = commands.find((value) => (kind === 'notify' ? value.includes('notify') : value.includes('collect') && !value.includes('notify')));
  if (command === undefined) {
    throw new Error(`${agent}の${kind} commandがない: ${JSON.stringify(commands)}`);
  }
  return command;
}

// hookへ登録されたcommandを実際に起動し、stable launcherが現在versionを実行することを確認する。
// security/git overrideはhook実行にも渡し、実Keychain・実gitへ触れない。
export function runShellCommand(fixture: CollectorFixture, command: string, envOverrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    YORI_SECURITY_BIN: path.join(fixture.binDir, 'security'),
    YORI_GIT_BIN: path.join(fixture.binDir, 'git'),
    // launcher自体はadmin用SSH transportを持ち込まない。実sshを起動しないための既定。
    YORI_SSH_BIN: path.join(fixture.binDir, 'ssh-not-configured'),
    YORI_TEST_SECURITY_LOG: fixture.securityLogPath,
    YORI_TEST_KEYCHAIN_FILE: fixture.keychainPath,
    YORI_TEST_SECRETS_DIR: fixture.secretsDir,
    YORI_TEST_GIT_ROOT: fixture.gitRoot,
    YORI_TEST_GIT_ORIGIN: fixture.gitOrigin,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return spawnSync('/bin/sh', ['-c', command], { cwd: fixture.gitRoot, encoding: 'utf8', env });
}

// known secretのlocal indexとKeychain itemを合成fixtureとして直接用意する。
// 実値は明示的なsynthetic値だけを扱い、repositoryへ実秘密を入れない。
export function collectorSecretsIndexPath(fixture: CollectorFixture): string {
  return path.join(fixture.home, '.yori-collector', SECRETS_INDEX_FILE_NAME);
}

export async function readSecretsIndexText(fixture: CollectorFixture): Promise<string | null> {
  return readFile(collectorSecretsIndexPath(fixture), 'utf8').catch(() => null);
}

// 厳密なindex契約の検証用。labels-only JSON arrayをそのまま書き込む。
export async function writeSecretsIndexJson(fixture: CollectorFixture, value: unknown): Promise<void> {
  const filePath = collectorSecretsIndexPath(fixture);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

export async function writeSecretIndexLabels(fixture: CollectorFixture, labels: readonly string[]): Promise<void> {
  await writeSecretsIndexJson(fixture, labels);
}

export async function readSecretIndexLabels(fixture: CollectorFixture): Promise<string[] | null> {
  const text = await readSecretsIndexText(fixture);
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

export async function writeKeychainSecret(fixture: CollectorFixture, label: string, value: string): Promise<void> {
  await mkdir(fixture.secretsDir, { recursive: true });
  await writeFile(path.join(fixture.secretsDir, label), value, 'utf8');
}

export async function readKeychainSecret(fixture: CollectorFixture, label: string): Promise<string | null> {
  return readFile(path.join(fixture.secretsDir, label), 'utf8').catch(() => null);
}

export async function readKeychainSecretLabels(fixture: CollectorFixture): Promise<string[]> {
  const entries = await readdir(fixture.secretsDir).catch(() => [] as string[]);
  return entries.map(String).sort();
}

export async function removeKeychainSecret(fixture: CollectorFixture, label: string): Promise<void> {
  await rm(path.join(fixture.secretsDir, label), { force: true });
}

// launcherが子collector envへ渡したYORI_KNOWN_SECRETS_JSONを分類して出す合成bundle。
export const KNOWN_SECRETS_BUNDLE =
  "const raw = process.env.YORI_KNOWN_SECRETS_JSON;\n" +
  "process.stdout.write('known-secrets:' + (raw === undefined ? 'UNSET' : raw) + '\\n');\n";

// launcherがfail-closedで子を起動しないことの検出用。起動時だけmarkerを出す。
export const KNOWN_SECRETS_MARKER_BUNDLE = "console.log('collector-known-secrets-child-spawned');\n";
