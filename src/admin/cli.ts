import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createPool } from '../db/pool.js';
import {
  bootstrapInputSchema,
  companyCreateInputSchema,
  employeeCreateInputSchema,
  memberInputSchema,
  projectCreateInputSchema,
  tokenIssueInputSchema,
  tokenRevokeInputSchema,
  type AdminErrorCode,
  type AdminResult,
} from './contract.js';
import {
  addMember,
  createCompany,
  createEmployee,
  createProject,
  inspectCompany,
  issueToken,
  removeMember,
  revokeToken,
  runBootstrap,
} from './service.js';

// 既知の失敗は固定codeだけをstderrへ出し、終了コード1とする。
// SQL・接続文字列・入力file本文・token・token hash・DB error本文は出さない。
function fail(code: AdminErrorCode): number {
  process.stderr.write(`admin: ${code}\n`);
  return 1;
}

// 成功時は1行のJSON objectだけをstdoutへ出す。
function succeed(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

// JSON fileを読み、contractのschemaで検証する。読み込み・parse失敗と契約違反を区別する。
function readInput<TSchema extends z.ZodType>(schema: TSchema, filePath: string): AdminResult<z.output<TSchema>> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { ok: false, code: 'invalid_input_file' };
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'invalid_input' };
}

function databaseUrl(env: NodeJS.ProcessEnv): string | null {
  const value = env.DATABASE_URL;
  return value !== undefined && value.length > 0 ? value : null;
}

// 引数検証→入力検証→DATABASE_URL確認の順に進め、契約違反はDB接続前に拒否する。
async function runInputCommand<TSchema extends z.ZodType, TOutput>(
  env: NodeJS.ProcessEnv,
  schema: TSchema,
  rest: string[],
  execute: (pool: Pool, input: z.output<TSchema>) => Promise<AdminResult<TOutput>>,
): Promise<number> {
  if (rest.length !== 1) {
    return fail('invalid_arguments');
  }
  const input = readInput(schema, rest[0]);
  if (!input.ok) {
    return fail(input.code);
  }
  const url = databaseUrl(env);
  if (url === null) {
    return fail('invalid_admin_config');
  }
  const pool = createPool(url);
  try {
    const result = await execute(pool, input.value);
    return result.ok ? succeed(result.value) : fail(result.code);
  } finally {
    await pool.end();
  }
}

async function runInspect(env: NodeJS.ProcessEnv, rest: string[]): Promise<number> {
  if (rest.length !== 1) {
    return fail('invalid_arguments');
  }
  const parsed = z.uuid().safeParse(rest[0]);
  if (!parsed.success) {
    return fail('invalid_arguments');
  }
  const url = databaseUrl(env);
  if (url === null) {
    return fail('invalid_admin_config');
  }
  const pool = createPool(url);
  try {
    const result = await inspectCompany(pool, parsed.data.toLowerCase());
    return result.ok ? succeed(result.value) : fail(result.code);
  } finally {
    await pool.end();
  }
}

// 管理CLIの入口。argvのcommandだけを解釈し、入力はJSON fileから受ける。
export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'bootstrap':
        return await runInputCommand(env, bootstrapInputSchema, rest, (pool, input) => runBootstrap(pool, input));
      case 'company:create':
        return await runInputCommand(env, companyCreateInputSchema, rest, (pool, input) => createCompany(pool, input));
      case 'employee:create':
        return await runInputCommand(env, employeeCreateInputSchema, rest, (pool, input) => createEmployee(pool, input));
      case 'project:create':
        return await runInputCommand(env, projectCreateInputSchema, rest, (pool, input) => createProject(pool, input));
      case 'member:add':
        return await runInputCommand(env, memberInputSchema, rest, (pool, input) => addMember(pool, input));
      case 'member:remove':
        return await runInputCommand(env, memberInputSchema, rest, (pool, input) => removeMember(pool, input));
      case 'token:issue':
        return await runInputCommand(env, tokenIssueInputSchema, rest, (pool, input) => issueToken(pool, input));
      case 'token:revoke':
        return await runInputCommand(env, tokenRevokeInputSchema, rest, (pool, input) => revokeToken(pool, input));
      case 'inspect':
        return await runInspect(env, rest);
      default:
        return fail('invalid_arguments');
    }
  } catch {
    // 予期しない例外も固定codeへ縮退し、raw errorを標準出力・標準エラーへ出さない。
    return fail('internal_error');
  }
}

// tsxから直接起動された時だけ実行する。テストはrunCliをimportして呼ぶ。
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
