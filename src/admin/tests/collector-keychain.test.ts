import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureAdminKeychainToken, ensureKeychainToken } from '../../collector/keychain.js';

test('対話端末ではKeychain prompt前にYori tokenを2回入力すると説明し、tokenをargvへ出さない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yori-keychain-prompt-'));
  const bin = path.join(root, 'security');
  const item = path.join(root, 'item');
  const log = path.join(root, 'args');
  const token = 'yori_prompt_fixture_token';
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  find-generic-password) [ -f "${item}" ] && cat "${item}" || exit 44 ;;
  add-generic-password) printf '%s' '${token}' > "${item}" ;;
  *) exit 1 ;;
esac
`,
    'utf8',
  );
  await chmod(bin, 0o755);

  const originalIsTty = process.stderr.isTTY;
  const originalWrite = process.stderr.write;
  let displayed = '';
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    displayed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = ensureKeychainToken({ YORI_SECURITY_BIN: bin }, 'https://yori-pilot.online');
    assert.deepEqual(result, { token, created: true });
    assert.equal(displayed, 'Yori tokenを2回入力してください。\n');
    assert.ok(!(await readFile(log, 'utf8')).includes(token), 'security argvへtokenを出している');
  } finally {
    process.stderr.write = originalWrite;
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: originalIsTty });
    await rm(root, { recursive: true, force: true });
  }
});

test('管理操作のKeychain promptはcompany admin tokenを要求すると明示する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yori-admin-keychain-prompt-'));
  const bin = path.join(root, 'security');
  const item = path.join(root, 'item');
  const token = 'yori_admin_prompt_fixture_token';
  await writeFile(
    bin,
    `#!/bin/sh
case "$1" in
  find-generic-password) [ -f "${item}" ] && cat "${item}" || exit 44 ;;
  add-generic-password) printf '%s' '${token}' > "${item}" ;;
  *) exit 1 ;;
esac
`,
    'utf8',
  );
  await chmod(bin, 0o755);

  const originalIsTty = process.stderr.isTTY;
  const originalWrite = process.stderr.write;
  let displayed = '';
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    displayed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.deepEqual(ensureAdminKeychainToken({ YORI_SECURITY_BIN: bin }, 'https://yori-pilot.online'), {
      token,
      created: true,
    });
    assert.equal(displayed, 'Yori company admin tokenを2回入力してください。\n');
  } finally {
    process.stderr.write = originalWrite;
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: originalIsTty });
    await rm(root, { recursive: true, force: true });
  }
});
