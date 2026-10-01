import { readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CollectorFailure } from './contract.js';
import { writeFileAtomic } from './fs.js';

export interface CollectorInstallState {
  installer_version: string;
  collector_version: string;
  git_sha: string | null;
  checksum: string;
  // MCP導入前のinstall.jsonには無いためnullで読む。
  mcp_checksum: string | null;
  policy_version: number | null;
}

// install.jsonはinstaller/collector version・Git SHA・checksum・setup policy versionだけを持つ。
// token・rules・pathは保存しない。
export async function readCollectorInstallState(filePath: string): Promise<CollectorInstallState | null> {
  const text = await readFile(filePath, 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const { installer_version, collector_version, git_sha, checksum, policy_version } = parsed as Record<string, unknown>;
      const mcpChecksum = (parsed as Record<string, unknown>).mcp_checksum;
      const mcp_checksum = typeof mcpChecksum === 'string' && mcpChecksum.length > 0 ? mcpChecksum : null;
      if (
        typeof installer_version === 'string' &&
        installer_version.length > 0 &&
        typeof collector_version === 'string' &&
        collector_version.length > 0 &&
        (git_sha === undefined || git_sha === null || (typeof git_sha === 'string' && /^[0-9a-f]{40}$/.test(git_sha))) &&
        typeof checksum === 'string' &&
        checksum.length > 0 &&
        (policy_version === null || typeof policy_version === 'number')
      ) {
        return { installer_version, collector_version, git_sha: typeof git_sha === 'string' ? git_sha : null, checksum, mcp_checksum, policy_version };
      }
    }
  } catch {
    // 壊れたstateは成功扱いしない。
  }
  throw new CollectorFailure('collector_install_error');
}

export async function writeCollectorInstallState(filePath: string, state: CollectorInstallState): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

// yori-cli本体のpackage.jsonはbin隣接、またはsource実行時のrepository rootにある。
export async function readInstallerVersion(): Promise<string> {
  const entry = process.argv[1];
  let binDir = process.cwd();
  if (entry !== undefined) {
    try {
      binDir = path.dirname(await realpath(entry));
    } catch {
      binDir = path.dirname(entry);
    }
  }
  const candidates = [
    path.join(binDir, 'package.json'),
    path.resolve(binDir, '..', 'package.json'),
    path.resolve(binDir, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
      if (typeof version === 'string' && version.length > 0) {
        return version;
      }
    } catch {
      // 隣接候補のpackage.jsonが無いだけなので次の候補を試す。
    }
  }
  throw new CollectorFailure('collector_install_error');
}
