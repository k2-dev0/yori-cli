import { spawn } from 'node:child_process';
import { z } from 'zod';
import { readInstallerVersion } from '../collector/install-state.js';
import {
  ADMIN_ERROR_CODES,
  type AdminErrorCode,
  type AdminResult,
  type InspectOutput,
  type RedactionListOutput,
  type RedactionReplaceInput,
  type RedactionReplaceOutput,
  type UsageOutput,
} from './contract.js';
import { validateRedactionPolicy } from './redaction-rules.js';

// DATABASE_URLなしのredaction:replace / redaction:listだけを、本番server上の
// 固定package version・固定source配置へ委ねる。実ssh・実hostへは接続せず、
// 合成したbash scriptだけをstdinへ渡す（testはYORI_SSH_BIN overrideで検査する）。
const SSH_HOST = 'yori-production';
const DEFAULT_SSH_BIN = '/usr/bin/ssh';
const REMOTE_DIR = '/srv/yori';
const REMOTE_ENV_FILE = '/etc/yori/yori.env';
const REMOTE_COMPOSE_PROJECT = 'yori';
const REMOTE_COMPOSE_FILE = 'deployment/compose.yaml';
// remote composeにcli serviceは無い。tools profileのmigrate serviceを一時Node環境として借りる。
const REMOTE_SERVICE = 'migrate';
const REMOTE_INPUT_PATH = '/input/redaction.json';
// sudoは既定で環境変数を引き継がないため、exportせずshell変数に取り、composeRunがsudoの内側でenvとして渡す。
// exportを付けない代入なので、git rev-parseの失敗はset -eでその場で止まる。
const REMOTE_RELEASE_SHA = 'YORI_RELEASE_SHA="$(git rev-parse --verify \'HEAD^{commit}\')"';

// remoteの成功応答はunknown key・欠落key・型違いを拒否し、契約外JSONをそのまま返さない。
const replaceOutputSchema = z.strictObject({
  status: z.literal('replaced'),
  company_id: z.uuid(),
  version: z.number().int().min(1),
});
const listOutputSchema = z.strictObject({
  version: z.number().int().min(0),
  fields: z.array(z.string()),
  terms: z.array(z.string()),
  suspicion_mode: z.enum(['observe', 'block']),
  detector_version: z.literal('initial-v1'),
});
const timestampSchema = z.iso.datetime({ offset: true });
const inspectOutputSchema = z.strictObject({
  status: z.literal('ok'),
  company: z.strictObject({ company_id: z.uuid(), name: z.string(), created_at: timestampSchema }),
  employees: z.array(z.strictObject({ employee_id: z.uuid(), display_name: z.string(), created_at: timestampSchema })),
  projects: z.array(
    z.strictObject({ project_id: z.uuid(), repository_identifier: z.string(), created_at: timestampSchema }),
  ),
  members: z.array(z.strictObject({ project_id: z.uuid(), employee_id: z.uuid(), created_at: timestampSchema })),
  tokens: z.array(
    z.strictObject({
      token_id: z.uuid(),
      employee_id: z.uuid(),
      created_at: timestampSchema,
      revoked_at: timestampSchema.nullable(),
    }),
  ),
});

const nullableNumberSchema = z.number().nullable();
const usageCallsShape = {
  provider: z.string(),
  calls: z.number().int().min(0),
  failed: z.number().int().min(0),
  input_tokens: z.number().min(0),
  cost_usd: nullableNumberSchema,
};
const usageOutputSchema = z.strictObject({
  status: z.literal('ok'),
  company_id: z.uuid(),
  days: z.number().int().min(1),
  since: timestampSchema,
  usd_per_million_input_tokens: z.record(z.string(), z.number()),
  daily: z.array(z.strictObject({ utc_date: z.string(), ...usageCallsShape })),
  operations: z.array(z.strictObject({ ...usageCallsShape, operation: z.string(), duration_ms_p50: nullableNumberSchema, duration_ms_p90: nullableNumberSchema })),
  jobs: z.array(
    z.strictObject({
      kind: z.string(),
      completed: z.number().int().min(0),
      jev_cost_usd_per_job: z.number(),
      wait_ms_p50: nullableNumberSchema,
      wait_ms_p90: nullableNumberSchema,
      run_ms_p50: nullableNumberSchema,
      run_ms_p90: nullableNumberSchema,
    }),
  ),
  auto_search: z.strictObject({ completed: z.number().int().min(0), within_notify_wait_ratio: nullableNumberSchema, duration_ms_p50: nullableNumberSchema, duration_ms_p90: nullableNumberSchema }),
});

type ListOutput = z.infer<typeof listOutputSchema>;

// test/development overrideは絶対pathの明示指定だけを受ける。
function sshBin(env: NodeJS.ProcessEnv): string {
  const override = env.YORI_SSH_BIN;
  return override !== undefined && override.length > 0 ? override : DEFAULT_SSH_BIN;
}

// POSIX shellのsingle quoteで包み、quote自体は '\'' へ変換する。
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// 本番serverのdocker compose project/fileはyori本体と揃える。
// migrationは別途実行せず、migrate serviceのentrypointだけをnpxへ上書きした1回のrunに委ねる。
function composeRun(parts: readonly string[]): string {
  return [
    // yori本体のdeploy.shと同じく、release SHAはsudoの内側でcomposeへ渡す。
    'sudo env YORI_RELEASE_SHA="$YORI_RELEASE_SHA" docker compose',
    `-p ${REMOTE_COMPOSE_PROJECT}`,
    `--env-file ${REMOTE_ENV_FILE}`,
    `-f ${REMOTE_COMPOSE_FILE}`,
    '--profile tools',
    'run --rm --no-deps -T',
    ...parts,
  ].join(' ');
}

// published packageの固定versionをexact指定し、yori binをnpxで実行する。
function remoteCliInvocation(version: string, options: readonly string[], args: readonly string[]): string {
  const npxArgs = ['--yes', `--package=yori-cli@${version}`, 'yori', ...args];
  return composeRun([...options, '--entrypoint npx', REMOTE_SERVICE, ...npxArgs.map(shellQuote)]);
}

// replaceのpolicy textは0600の一時fileだけに置き、trapで必ず削除する。
// containerへはread-only mountし、CLIへはcontainer pathだけを渡す（host temp pathをargvへ出さない）。
function replaceScript(version: string, input: RedactionReplaceInput): string {
  return [
    'set -eu',

    `cd ${REMOTE_DIR}`,
    REMOTE_RELEASE_SHA,
    'input=$(mktemp)',
    'trap \'rm -f "$input"\' EXIT',
    'chmod 600 "$input"',
    "cat > \"$input\" <<'YORI_INPUT'",
    JSON.stringify(input),
    'YORI_INPUT',
    remoteCliInvocation(version, [`--volume "$input:${REMOTE_INPUT_PATH}:ro"`], ['redaction:replace', REMOTE_INPUT_PATH]),
    '',
  ].join('\n');
}

// listは会社UUIDだけを固定versionのCLIへ渡す。
function listScript(version: string, companyId: string): string {
  return ['set -eu', `cd ${REMOTE_DIR}`, REMOTE_RELEASE_SHA, remoteCliInvocation(version, [], ['redaction:list', companyId]), ''].join('\n');
}

// inspectは会社UUIDだけを固定versionのCLIへ渡す。
function inspectScript(version: string, companyId: string): string {
  return ['set -eu', `cd ${REMOTE_DIR}`, REMOTE_RELEASE_SHA, remoteCliInvocation(version, [], ['inspect', companyId]), ''].join('\n');
}

// usageは会社UUIDと集計日数だけを固定versionのCLIへ渡す。
function usageScript(version: string, companyId: string, days: number): string {
  const args = ['usage', companyId, '--days', String(days)];
  return ['set -eu', `cd ${REMOTE_DIR}`, REMOTE_RELEASE_SHA, remoteCliInvocation(version, [], args), ''].join('\n');
}

interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

// ssh自体の失敗はraw stderrを外へ出さず、固定codeへ縮退させる。
function runSsh(bin: string, script: string): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [SSH_HOST, 'bash', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(script);
  });
}

// remoteの既知admin codeだけを透過し、未知code・ssh失敗・応答契約違反はinternal_errorへ縮退する。
async function runRemote<TOutput>(
  env: NodeJS.ProcessEnv,
  script: string,
  schema: z.ZodType<TOutput>,
): Promise<AdminResult<TOutput>> {
  let result: SshResult;
  try {
    result = await runSsh(sshBin(env), script);
  } catch {
    return { ok: false, code: 'internal_error' };
  }
  if (result.code !== 0) {
    const match = /^admin: ([a-z_]+)\n$/.exec(result.stderr);
    const code = match?.[1];
    if (code !== undefined && (ADMIN_ERROR_CODES as readonly string[]).includes(code)) {
      return { ok: false, code: code as AdminErrorCode };
    }
    return { ok: false, code: 'internal_error' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, code: 'internal_error' };
  }
  const validated = schema.safeParse(parsed);
  return validated.success ? { ok: true, value: validated.data } : { ok: false, code: 'internal_error' };
}

async function cliVersion(): Promise<string | null> {
  try {
    return await readInstallerVersion();
  } catch {
    // 固定package versionを解決できない場合は、どのversionを実行するか曖昧なままsshしない。
    return null;
  }
}

// remote list出力もDB経路と同じ最終policy契約で検証し、fields/termsを昇順へ正規化する。
// 契約外ruleを隠した部分的成功にしないため、1件でも不正ならnullを返す。
function validatedListOutput(value: ListOutput): RedactionListOutput | null {
  try {
    const policy = validateRedactionPolicy(value);
    return { ...policy, fields: [...policy.fields].sort(), terms: [...policy.terms].sort() };
  } catch {
    return null;
  }
}

export async function replaceRedactionPolicyOverSsh(
  env: NodeJS.ProcessEnv,
  input: RedactionReplaceInput,
): Promise<AdminResult<RedactionReplaceOutput>> {
  const version = await cliVersion();
  if (version === null) {
    return { ok: false, code: 'internal_error' };
  }
  const result = await runRemote(env, replaceScript(version, input), replaceOutputSchema);
  if (!result.ok) {
    return result;
  }
  // remoteが要求と違う会社・versionを返した場合は、それを成功として扱わない。
  if (result.value.company_id !== input.company_id || result.value.version !== input.expected_version + 1) {
    return { ok: false, code: 'internal_error' };
  }
  return { ok: true, value: result.value };
}

export async function listRedactionPolicyOverSsh(
  env: NodeJS.ProcessEnv,
  companyId: string,
): Promise<AdminResult<RedactionListOutput>> {
  const version = await cliVersion();
  if (version === null) {
    return { ok: false, code: 'internal_error' };
  }
  const result = await runRemote(env, listScript(version, companyId), listOutputSchema);
  if (!result.ok) {
    return result;
  }
  const policy = validatedListOutput(result.value);
  return policy === null ? { ok: false, code: 'internal_error' } : { ok: true, value: policy };
}

export async function inspectCompanyOverSsh(env: NodeJS.ProcessEnv, companyId: string): Promise<AdminResult<InspectOutput>> {
  const version = await cliVersion();
  if (version === null) {
    return { ok: false, code: 'internal_error' };
  }
  return await runRemote(env, inspectScript(version, companyId), inspectOutputSchema);
}

export async function reportCompanyUsageOverSsh(env: NodeJS.ProcessEnv, companyId: string, days: number): Promise<AdminResult<UsageOutput>> {
  const version = await cliVersion();
  if (version === null) {
    return { ok: false, code: 'internal_error' };
  }
  const result = await runRemote(env, usageScript(version, companyId, days), usageOutputSchema);
  // remoteが要求と違う会社・期間を返した場合は、それを成功として扱わない。
  return result.ok && (result.value.company_id !== companyId || result.value.days !== days) ? { ok: false, code: 'internal_error' } : result;
}
