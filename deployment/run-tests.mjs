#!/usr/bin/env node
// 管理CLIのテストを一括実行する。
// テスト専用ComposeでDBを起動し、ホストの node --test からloopback経由で実PostgreSQLへ接続する。
// dockerは標準のcontext/configを使い、このマシン固有のsocket・config・symlinkは指定しない。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// テストは常に専用compose fileを使う。volumeはnameを指定せずCompose projectスコープで隔離する。
const COMPOSE_FILE = path.join(REPO_ROOT, 'deployment', 'compose.test.yaml');
// yori本体の開発用project (yori) と開発データを共有しないテスト専用のproject。
const TEST_PROJECT_NAME = process.env.YORI_CLI_TEST_PROJECT ?? 'yori-cli-test';
if (TEST_PROJECT_NAME === 'yori') {
  console.error('YORI_CLI_TEST_PROJECT=yori はyori本体のproject・volumeを共有するため許可しません');
  process.exit(1);
}
// 開発用DBと衝突しないloopback port。ホストのテストはこのportのDBだけを見る。
const TEST_DB_PORT = process.env.YORI_CLI_TEST_DB_PORT ?? '55432';
const TEST_ENV = {
  ...process.env,
  DATABASE_URL: `postgres://yori:yori@127.0.0.1:${TEST_DB_PORT}/yori`,
};

function run(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env });
    child.on('error', (error) => {
      console.error(`[test] 起動失敗: ${command} ${args.join(' ')}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const compose = (...args) => run('docker', ['compose', '-p', TEST_PROJECT_NAME, '--file', COMPOSE_FILE, ...args], TEST_ENV);

const steps = [];
steps.push(['compose up -d --wait db', await compose('up', '-d', '--wait', 'db')]);
steps.push(['npm test (host)', await run('npm', ['test'], TEST_ENV)]);

// 失敗時もcleanupを実行し、down自体の失敗もexit codeへ反映する。
const teardown = await compose('down', '--remove-orphans');
if (teardown !== 0) {
  console.error(
    `[test] compose down に失敗しました。docker compose -p ${TEST_PROJECT_NAME} -f deployment/compose.test.yaml down --remove-orphans を実行してください。`,
  );
}
steps.push(['compose down --remove-orphans', teardown]);

console.log('---- test summary ----');
for (const [name, code] of steps) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name}`);
}
const failedCount = steps.filter(([, code]) => code !== 0).length;
if (failedCount > 0) {
  console.error(`${failedCount} ステップが失敗しました`);
  process.exit(1);
}
console.log('全ステップ成功');
