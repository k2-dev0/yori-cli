import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

// テストはCLIを別processとして起動し、stdout・stderr・終了コードの契約をそのまま検証する。
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_PATH = path.join(REPO_ROOT, 'src', 'admin', 'cli.ts');
const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

// 認証経路の契約確認に使う独立実装。production側のhash関数とは別にnode:cryptoから直接計算する。
export function sha256Utf8(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function testDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    assert.fail('テストには DATABASE_URL が必要です（npm run test:db か deployment/compose.test.yaml のDBを指定してください）');
  }
  return value;
}

// yori本体の migration が作る管理対象tableと同じ契約をテストDBへ適用する。
export async function applyTestSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(SCHEMA_PATH, 'utf8'));
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE auth_tokens, project_members, projects, employees, companies CASCADE');
}

export interface AdminRun {
  code: number;
  stdout: string;
  stderr: string;
}

// CLIを子processとして実行する。envへundefinedを渡すとその変数を子から取り除く。
export async function runAdmin(args: string[], options: { env?: Record<string, string | undefined> } = {}): Promise<AdminRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: testDatabaseUrl(), ...options.env };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) {
      delete env[key];
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], { cwd: REPO_ROOT, env });
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

// 一時directoryへ入力fileを書き、CLIへ渡す。file本文がstderrへ漏れないことの検証にも使う。
export async function withInputFile<T>(name: string, content: unknown, run: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'yori-cli-test-'));
  try {
    const filePath = path.join(directory, name);
    await writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    return await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 成功時は1行JSONだけをstdoutへ出す契約を検証しつつparseする。
export function parseSuccessJson(run: AdminRun): Record<string, unknown> {
  assert.equal(run.code, 0, `終了コードが0ではない: ${run.code} stderr=${run.stderr}`);
  assert.equal(run.stderr, '', `成功時にstderrへ出力している: ${run.stderr}`);
  const lines = run.stdout.split('\n');
  assert.equal(lines.at(-1), '', 'stdoutが改行で終わっていない');
  assert.equal(lines.length, 2, `stdoutが1行JSONではない: ${JSON.stringify(run.stdout)}`);
  const parsed: unknown = JSON.parse(lines[0]);
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed !== null && !Array.isArray(parsed), 'stdout JSONがobjectではない');
  return parsed as Record<string, unknown>;
}

// 既知の失敗は `admin: <code>` だけをstderrへ出し、終了コード1とする契約を検証する。
export function expectFail(run: AdminRun, code: string): void {
  assert.equal(run.code, 1, `終了コードが1ではない: ${run.code} stdout=${run.stdout}`);
  assert.equal(run.stdout, '', `失敗時にstdoutへ出力している: ${run.stdout}`);
  assert.equal(run.stderr, `admin: ${code}\n`, `失敗出力が固定codeだけではない: ${JSON.stringify(run.stderr)}`);
}

// yori API (src/api/events.ts:20-34) と同じ照合SQL。失効や会社不一致はnullになる。
export async function authenticateWithToken(pool: Pool, token: string): Promise<{ companyId: string; employeeId: string } | null> {
  const result = await pool.query<{ company_id: string; employee_id: string }>(
    `SELECT t.company_id, t.employee_id
       FROM auth_tokens t
       JOIN employees e ON e.id = t.employee_id AND e.company_id = t.company_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [sha256Utf8(token)],
  );
  const row = result.rows[0];
  return row ? { companyId: row.company_id, employeeId: row.employee_id } : null;
}

export async function countRows(pool: Pool, table: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0].count);
}

export async function insertAuthToken(pool: Pool, companyId: string, employeeId: string, token: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO auth_tokens (id, company_id, employee_id, token_hash) VALUES ($1, $2, $3, $4)', [
    id,
    companyId,
    employeeId,
    sha256Utf8(token),
  ]);
  return id;
}
