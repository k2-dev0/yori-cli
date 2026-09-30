import { execFileSync, spawnSync } from 'node:child_process';
import { ADMIN_KEYCHAIN_SERVICE, COLLECTOR_KEYCHAIN_SERVICE, DEFAULT_SECURITY_BIN, CollectorFailure } from './contract.js';

// test/development overrideは絶対pathの明示指定だけを受ける。secret管理も同じ解決を使う。
export function securityBin(env: NodeJS.ProcessEnv): string {
  const override = env.YORI_SECURITY_BIN;
  return override !== undefined && override.length > 0 ? override : DEFAULT_SECURITY_BIN;
}

// find -wの出力は内部captureだけに使い、stdout/stderrへ出さない。
function findKeychainToken(bin: string, service: string, account: string): string | null {
  try {
    const token = execFileSync(bin, ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// doctor/launcherなどprompt不可の経路はfindだけを行い、未登録はnullとして扱う。
export function readKeychainToken(env: NodeJS.ProcessEnv, account: string): string | null {
  return findKeychainToken(securityBin(env), COLLECTOR_KEYCHAIN_SERVICE, account);
}

export interface KeychainTokenResult {
  token: string;
  created: boolean;
}

// token未登録時だけ値なし末尾-wのpromptをsecurityへ委ねる。tokenはargvへ渡さない。
// created=trueはこのrunで新規作成したitemであり、失敗時のrollback対象になる。
function ensureServiceToken(env: NodeJS.ProcessEnv, service: string, account: string, promptLabel: string): KeychainTokenResult {
  const bin = securityBin(env);
  const existing = findKeychainToken(bin, service, account);
  if (existing !== null) {
    return { token: existing, created: false };
  }
  if (process.stderr.isTTY) {
    process.stderr.write(`${promptLabel}を2回入力してください。\n`);
  }
  const added = spawnSync(bin, ['add-generic-password', '-U', '-a', account, '-s', service, '-w'], {
    stdio: 'inherit',
  });
  if (added.status !== 0) {
    throw new CollectorFailure('collector_keychain_error');
  }
  const token = findKeychainToken(bin, service, account);
  if (token === null) {
    throw new CollectorFailure('collector_keychain_error');
  }
  return { token, created: true };
}

export function ensureKeychainToken(env: NodeJS.ProcessEnv, account: string): KeychainTokenResult {
  return ensureServiceToken(env, COLLECTOR_KEYCHAIN_SERVICE, account, 'Yori token');
}

export function ensureAdminKeychainToken(env: NodeJS.ProcessEnv, account: string): KeychainTokenResult {
  return ensureServiceToken(env, ADMIN_KEYCHAIN_SERVICE, account, 'Yori company admin token');
}

// このrunで作成したitemだけを削除する。既存itemへは呼出元が一切使わない。
function deleteServiceToken(env: NodeJS.ProcessEnv, service: string, account: string): void {
  const deleted = spawnSync(
    securityBin(env),
    ['delete-generic-password', '-s', service, '-a', account],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  if (deleted.status !== 0) {
    throw new CollectorFailure('collector_rollback_failed');
  }
}

export function deleteKeychainToken(env: NodeJS.ProcessEnv, account: string): void {
  deleteServiceToken(env, COLLECTOR_KEYCHAIN_SERVICE, account);
}

export function deleteAdminKeychainToken(env: NodeJS.ProcessEnv, account: string): void {
  deleteServiceToken(env, ADMIN_KEYCHAIN_SERVICE, account);
}
