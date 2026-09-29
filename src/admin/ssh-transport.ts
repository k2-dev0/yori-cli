import { spawn } from 'node:child_process';
import { z } from 'zod';
import { readInstallerVersion } from '../collector/install-state.js';
import {
  ADMIN_ERROR_CODES,
  type AdminErrorCode,
  type AdminResult,
  type RedactionListOutput,
  type RedactionReplaceInput,
  type RedactionReplaceOutput,
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
    'sudo docker compose',
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
  return ['set -eu', `cd ${REMOTE_DIR}`, remoteCliInvocation(version, [], ['redaction:list', companyId]), ''].join('\n');
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
