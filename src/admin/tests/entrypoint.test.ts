import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPool } from '../../db/pool.js';
import { applyTestSchema, countRows, parseSuccessJson, resetDatabase, testDatabaseUrl, withInputFile, REPO_ROOT, type AdminRun } from './support.js';

const pool = createPool(testDatabaseUrl());

before(async () => {
  await applyTestSchema(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
});

after(async () => {
  await pool.end();
});

// 公開packageのbinは node_modules/.bin/<name> からsymlink経由で起動される。
// npx実行でもCLIが本体として動くことを、symlink経由の起動で検証する。
async function runThroughSymlink(linkPath: string, args: string[]): Promise<AdminRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: testDatabaseUrl() };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', linkPath, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('bin entrypoint', () => {
  it('公開packageの実行コマンドをyoriだけに固定する', async () => {
    const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(packageJson.bin, { yori: 'dist/admin/cli.js' });
    assert.equal(packageJson.scripts.yori, 'tsx src/admin/cli.ts');
    assert.equal(packageJson.scripts.cli, undefined);
    assert.equal(packageJson.scripts.admin, undefined);
  });

  it('symlink経由で起動してもCLIとして実行される', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'yori-cli-bin-'));
    try {
      const linkPath = path.join(directory, 'yori');
      await symlink(path.join(REPO_ROOT, 'src', 'admin', 'cli.ts'), linkPath);
      const run = await withInputFile('company.json', { name: 'bin-entry' }, (filePath) =>
        runThroughSymlink(linkPath, ['company:create', filePath]),
      );
      const output = parseSuccessJson(run);
      assert.equal(output.status, 'created');
      assert.equal(output.name, 'bin-entry');
      assert.equal(await countRows(pool, 'companies'), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('symlink経由の失敗も固定codeだけをstderrへ出す', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'yori-cli-bin-'));
    try {
      const linkPath = path.join(directory, 'yori');
      await symlink(path.join(REPO_ROOT, 'src', 'admin', 'cli.ts'), linkPath);
      const run = await runThroughSymlink(linkPath, []);
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: invalid_arguments\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
