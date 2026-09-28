import type { AdminErrorCode } from '../admin/contract.js';

// collector install/updateの端末側レイアウトとAPI契約。yori本体のcollector設定と用語を揃える。
export const COLLECTOR_API_DEFAULT_URL = 'https://yori-pilot.online';
export const COLLECTOR_KEYCHAIN_SERVICE = 'online.yori.collector';
export const COLLECTOR_TOKEN_ENV = 'YORI_COLLECTOR_TOKEN';
export const COLLECTOR_STATE_DIR_NAME = '.yori-collector';
export const COLLECTOR_CONFIG_FILE_NAME = '.yori-collector.json';
export const COLLECTOR_LAUNCHER_FILE_NAME = 'launcher.mjs';
export const COLLECTOR_INSTALL_STATE_FILE_NAME = 'install.json';
export const COLLECTOR_BUNDLE_FILE_NAME = 'yori-collector.mjs';
export const COLLECTOR_MANIFEST_FILE_NAME = 'collector-manifest.json';
export const COLLECTOR_VERSION_DIR_NAME = 'versions';
export const COLLECTOR_INSTALL_ROOT_PARTS = ['.local', 'share', 'yori', 'collector'] as const;

// production binaryの絶対path。PATH解決はせず、明示されたtest/development overrideだけを受ける。
export const DEFAULT_SECURITY_BIN = '/usr/bin/security';
export const DEFAULT_GIT_BIN = '/usr/bin/git';

export type CollectorAgent = 'codex' | 'claude_code';

// collector commandはmacOSのKeychain前提のため、対応platformをdarwinだけに固定する。
// 判定は純粋関数にして、testが実platformを変えずに真理値表を検証できるようにする。
export function isSupportedCollectorPlatform(platform: string): boolean {
  return platform === 'darwin';
}

export interface CollectorCommandOutput {
  status: string;
  version: string | null;
  agents: CollectorAgent[];
  // 秘密やpathを含めないboolean診断だけを返す。
  checks: Record<string, boolean>;
}

// 既知の失敗はadmin CLIと同じ固定codeへ縮退させ、raw errorを外へ出さない。
export class CollectorFailure extends Error {
  constructor(readonly code: AdminErrorCode) {
    super(code);
    this.name = 'CollectorFailure';
  }
}
