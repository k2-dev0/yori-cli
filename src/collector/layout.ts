import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CollectorArtifact } from './artifact.js';
import {
  COLLECTOR_BUNDLE_FILE_NAME,
  COLLECTOR_CONFIG_FILE_NAME,
  COLLECTOR_INSTALL_ROOT_PARTS,
  COLLECTOR_INSTALL_STATE_FILE_NAME,
  COLLECTOR_LAUNCHER_FILE_NAME,
  COLLECTOR_MANIFEST_FILE_NAME,
  COLLECTOR_STATE_DIR_NAME,
  COLLECTOR_TOKEN_ENV,
  COLLECTOR_VERSION_DIR_NAME,
  type CollectorAgent,
} from './contract.js';
import { writeFileAtomic } from './fs.js';

// HOME overrideはtest/developmentの隔離にだけ使い、通常はOSのhomeへ解決する。
export function collectorHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  return home !== undefined && home.length > 0 ? home : homedir();
}

export function collectorConfigPath(home: string): string {
  return path.join(home, COLLECTOR_CONFIG_FILE_NAME);
}

export function collectorStateDir(home: string): string {
  return path.join(home, COLLECTOR_STATE_DIR_NAME);
}

export function collectorInstallRoot(home: string): string {
  return path.join(home, ...COLLECTOR_INSTALL_ROOT_PARTS);
}

function collectorVersionsDir(home: string): string {
  return path.join(collectorInstallRoot(home), COLLECTOR_VERSION_DIR_NAME);
}

export function collectorVersionDir(home: string, version: string): string {
  return path.join(collectorVersionsDir(home), version);
}

export function collectorLauncherPath(home: string): string {
  return path.join(collectorInstallRoot(home), COLLECTOR_LAUNCHER_FILE_NAME);
}

export function collectorInstallStatePath(home: string): string {
  return path.join(collectorInstallRoot(home), COLLECTOR_INSTALL_STATE_FILE_NAME);
}

export function collectorHookPath(home: string, agent: CollectorAgent): string {
  return agent === 'codex' ? path.join(home, '.codex', 'hooks.json') : path.join(home, '.claude', 'settings.json');
}

export function collectorSource(agent: CollectorAgent): string {
  return agent;
}

// stable launcherはconfigのapi_urlでKeychain tokenを内部captureし、子collector envへだけ渡す。
const LAUNCHER_SOURCE = [
  '// yori collector stable launcher: configのKeychain tokenを子collector envへだけ渡す。',
  "import { execFileSync, spawnSync } from 'node:child_process';",
  "import { readFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  '',
  'function fail() {',
  "  process.stderr.write('collector: launcher_error\\n');",
  '  process.exit(1);',
  '}',
  '',
  'const root = path.dirname(fileURLToPath(import.meta.url));',
  'const home = process.env.HOME;',
  'if (!home) { fail(); }',
  'let config;',
  'try {',
  "  config = JSON.parse(readFileSync(path.join(home, '.yori-collector.json'), 'utf8'));",
  '} catch { fail(); }',
  "if (typeof config !== 'object' || config === null || typeof config.api_url !== 'string' || config.api_url.length === 0) { fail(); }",
  "const security = process.env.YORI_SECURITY_BIN && process.env.YORI_SECURITY_BIN.length > 0 ? process.env.YORI_SECURITY_BIN : '/usr/bin/security';",
  'let token;',
  'try {',
  "  token = execFileSync(security, ['find-generic-password', '-s', 'online.yori.collector', '-a', config.api_url, '-w'], {",
  "    encoding: 'utf8',",
  "    stdio: ['ignore', 'pipe', 'ignore'],",
  '  }).trim();',
  '} catch { fail(); }',
  'if (!token) { fail(); }',
  'let state;',
  'try {',
  "  state = JSON.parse(readFileSync(path.join(root, 'install.json'), 'utf8'));",
  '} catch { fail(); }',
  "const bundle = path.join(root, 'versions', String(state.collector_version), 'yori-collector.mjs');",
  'const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {',
  "  stdio: 'inherit',",
  '  env: { ...process.env, YORI_COLLECTOR_TOKEN: token },',
  '});',
  "process.exit(typeof result.status === 'number' ? result.status : 1);",
  '',
].join('\n');

export async function writeCollectorLauncher(home: string): Promise<void> {
  await writeFileAtomic(collectorLauncherPath(home), LAUNCHER_SOURCE, 0o500);
}

// 検証済みartifactをversions/<version>/へcopyする。manifestは本文をそのまま置く。
export async function writeCollectorVersion(home: string, artifact: CollectorArtifact): Promise<void> {
  const versionsDir = collectorVersionsDir(home);
  await mkdir(versionsDir, { recursive: true, mode: 0o700 });
  await chmod(versionsDir, 0o700);
  const dir = collectorVersionDir(home, artifact.version);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFileAtomic(path.join(dir, COLLECTOR_BUNDLE_FILE_NAME), artifact.bundle, 0o600);
  await writeFileAtomic(path.join(dir, COLLECTOR_MANIFEST_FILE_NAME), artifact.manifest, 0o600);
}

export async function writeCollectorConfig(home: string, apiUrl: string): Promise<void> {
  const config = { api_url: apiUrl, token_env: COLLECTOR_TOKEN_ENV, state_dir: collectorStateDir(home) };
  await writeFileAtomic(collectorConfigPath(home), `${JSON.stringify(config, null, 2)}\n`, 0o600);
}
