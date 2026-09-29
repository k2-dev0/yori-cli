import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  COLLECTOR_SECRET_KEYCHAIN_SERVICE,
  CollectorFailure,
  MAX_KNOWN_SECRETS,
  MAX_KNOWN_SECRET_CODE_POINTS,
  MAX_KNOWN_SECRET_LABEL_CODE_POINTS,
  MIN_KNOWN_SECRET_CODE_POINTS,
} from './contract.js';
import { writeFileAtomic } from './fs.js';
import { securityBin } from './keychain.js';
import { collectorHome, collectorSecretsIndexPath } from './layout.js';

export interface CollectorSecretOutput {
  status: 'stored' | 'removed';
  label: string;
}

export interface CollectorSecretListOutput {
  labels: string[];
}

function codePointLength(value: string): number {
  return [...value].length;
}

// labelは1〜128 code points。index・Keychain accountはargvへ載るためNULを拒否する。
function isSecretLabel(label: string): boolean {
  const length = codePointLength(label);
  return length >= 1 && length <= MAX_KNOWN_SECRET_LABEL_CODE_POINTS && !label.includes('\u0000');
}

// known secretの値は8〜4096 code points。表示しない値は一度もerror本文へ載せない。
function isSecretValue(value: string): boolean {
  const length = codePointLength(value);
  return length >= MIN_KNOWN_SECRET_CODE_POINTS && length <= MAX_KNOWN_SECRET_CODE_POINTS;
}

// security -wは値へ改行を足して返す。値の空白は保持し、security出力の末尾改行だけを落とす。
function stripSecurityOutputNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

// indexはlabels-onlyの厳密な昇順arrayだけを受理する。欠落は空配列、壊れたindexはfail-closedで拒否する。
async function readSecretLabels(filePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new CollectorFailure('collector_internal_error');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CollectorFailure('collector_internal_error');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_KNOWN_SECRETS) {
    throw new CollectorFailure('collector_internal_error');
  }
  const labels: string[] = [];
  let previous: string | undefined;
  for (const value of parsed) {
    if (typeof value !== 'string' || !isSecretLabel(value) || (previous !== undefined && previous >= value)) {
      throw new CollectorFailure('collector_internal_error');
    }
    previous = value;
    labels.push(value);
  }
  return labels;
}

function writeSecretLabels(filePath: string, labels: readonly string[]): Promise<void> {
  return writeFileAtomic(filePath, JSON.stringify(labels), 0o600);
}

// find -wの出力は内部の重複判定・rollbackにだけ使い、stdout/stderrへ出さない。
function findSecret(bin: string, label: string): string | null {
  try {
    const value = execFileSync(bin, ['find-generic-password', '-s', COLLECTOR_SECRET_KEYCHAIN_SERVICE, '-a', label, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stripSecurityOutputNewline(value);
  } catch {
    return null;
  }
}

// promptはsecurity自身へ委ね、ttyを継承する。値はargvへ渡さない。
function storeSecretInteractively(bin: string, label: string): void {
  const added = spawnSync(bin, ['add-generic-password', '-U', '-a', label, '-s', COLLECTOR_SECRET_KEYCHAIN_SERVICE, '-w'], {
    stdio: 'inherit',
  });
  if (added.status !== 0) {
    throw new CollectorFailure('collector_keychain_error');
  }
}

// --from-envの値はargvへ載せず、securityのstdinだけから渡す。
function storeSecretFromStdin(bin: string, label: string, value: string): void {
  const added = spawnSync(bin, ['add-generic-password', '-U', '-a', label, '-s', COLLECTOR_SECRET_KEYCHAIN_SERVICE, '-w'], {
    input: `${value}\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (added.status !== 0) {
    throw new CollectorFailure('collector_keychain_error');
  }
}

function deleteSecret(bin: string, label: string): void {
  const deleted = spawnSync(bin, ['delete-generic-password', '-s', COLLECTOR_SECRET_KEYCHAIN_SERVICE, '-a', label], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (deleted.status !== 0) {
    throw new CollectorFailure('collector_keychain_error');
  }
}

// 部分失敗ではKeychain itemを元へ戻す。元値が無い新規labelは作成したitemを消す。
function restoreSecret(bin: string, label: string, previousValue: string | null): void {
  try {
    if (previousValue === null) {
      deleteSecret(bin, label);
    } else {
      storeSecretFromStdin(bin, label, previousValue);
    }
  } catch {
    throw new CollectorFailure('collector_rollback_failed');
  }
}

// valueはKeychainだけへ保存し、indexはlabelを昇順で追加する。値・件数違反では何も変更しない。
// value=nullはsecurityの非表示prompt、stringは--from-envの値をstdin経由で保存する。
export async function storeCollectorSecret(
  env: NodeJS.ProcessEnv,
  label: string,
  value: string | null,
): Promise<CollectorSecretOutput> {
  if (!isSecretLabel(label)) {
    throw new CollectorFailure('collector_invalid_request');
  }
  if (value !== null && !isSecretValue(value)) {
    throw new CollectorFailure('collector_invalid_request');
  }
  const bin = securityBin(env);
  const filePath = collectorSecretsIndexPath(collectorHome(env));
  const labels = await readSecretLabels(filePath);
  const indexed = labels.includes(label);
  if (!indexed && labels.length >= MAX_KNOWN_SECRETS) {
    throw new CollectorFailure('collector_invalid_request');
  }
  // 他labelの値とrollback用の元値を、Keychainを変更する前に確保する。
  const otherValues: string[] = [];
  for (const existingLabel of labels) {
    if (existingLabel === label) {
      continue;
    }
    const existingValue = findSecret(bin, existingLabel);
    if (existingValue === null) {
      throw new CollectorFailure('collector_keychain_error');
    }
    otherValues.push(existingValue);
  }
  const previousValue = indexed ? findSecret(bin, label) : null;
  if (indexed && previousValue === null) {
    throw new CollectorFailure('collector_keychain_error');
  }
  if (value !== null && otherValues.includes(value)) {
    throw new CollectorFailure('collector_invalid_request');
  }
  if (value === null) {
    storeSecretInteractively(bin, label);
  } else {
    storeSecretFromStdin(bin, label, value);
  }
  const stored = findSecret(bin, label);
  if (stored === null) {
    // item自体が無い場合はindexを変えておらず、戻す対象もない。
    if (previousValue !== null) {
      restoreSecret(bin, label, previousValue);
    }
    throw new CollectorFailure('collector_keychain_error');
  }
  if (!isSecretValue(stored) || otherValues.includes(stored)) {
    // prompt保存後の値が制限違反なら、上書き前のitemへ戻してから拒否する。
    restoreSecret(bin, label, previousValue);
    throw new CollectorFailure('collector_invalid_request');
  }
  if (!indexed) {
    try {
      await writeSecretLabels(filePath, [...labels, label].sort());
    } catch {
      restoreSecret(bin, label, previousValue);
      throw new CollectorFailure('collector_internal_error');
    }
  }
  return { status: 'stored', label };
}

// index未作成は空配列を返す。値は一切読まず、labelだけを返す。
export async function listCollectorSecrets(env: NodeJS.ProcessEnv): Promise<CollectorSecretListOutput> {
  const labels = await readSecretLabels(collectorSecretsIndexPath(collectorHome(env)));
  return { labels };
}

// indexに無いlabelは変更せず拒否する。Keychain削除が成功した後だけindexから外し、
// index書き込み失敗時は削除したitemを元の値へ戻す。
export async function removeCollectorSecret(env: NodeJS.ProcessEnv, label: string): Promise<CollectorSecretOutput> {
  if (!isSecretLabel(label)) {
    throw new CollectorFailure('collector_invalid_request');
  }
  const bin = securityBin(env);
  const filePath = collectorSecretsIndexPath(collectorHome(env));
  const labels = await readSecretLabels(filePath);
  if (!labels.includes(label)) {
    throw new CollectorFailure('collector_invalid_request');
  }
  const previousValue = findSecret(bin, label);
  if (previousValue === null) {
    throw new CollectorFailure('collector_keychain_error');
  }
  deleteSecret(bin, label);
  try {
    await writeSecretLabels(filePath, labels.filter((existing) => existing !== label));
  } catch {
    restoreSecret(bin, label, previousValue);
    throw new CollectorFailure('collector_internal_error');
  }
  return { status: 'removed', label };
}
