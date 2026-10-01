// yori MCPの端末側launcherと、Codex・Claude Codeへの登録。token本文は設定file・引数へ書かず、launcherが子MCPのenvへだけ渡す。
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import * as contract from './contract.js';
import { type CollectorAgent, CollectorFailure, COLLECTOR_MCP_CONFIG_FILE_NAME, COLLECTOR_MCP_LAUNCHER_FILE_NAME } from './contract.js';
import { writeFileAtomic } from './fs.js';
import type { CollectorHookUpdate } from './hooks.js';
import { collectorHookPath, collectorInstallRoot } from './layout.js';

export function collectorMcpLauncherPath(home: string): string {
  return path.join(collectorInstallRoot(home), COLLECTOR_MCP_LAUNCHER_FILE_NAME);
}

export function collectorMcpConfigPath(home: string): string {
  return path.join(collectorInstallRoot(home), COLLECTOR_MCP_CONFIG_FILE_NAME);
}

// stdoutはMCP protocol専用。失敗は固定文言だけをstderrへ出し、子MCPを起動しない。
const MCP_LAUNCHER_HEAD = [
  '// yori MCP stable launcher: Keychain tokenと接続先を子MCPのenvへだけ渡す。',
  "import { execFileSync, spawn } from 'node:child_process';",
  "import { readFileSync } from 'node:fs';",
  "import { homedir } from 'node:os';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "function fail() { process.stderr.write('mcp: launcher_error\\n'); process.exit(1); }",
  'function readJson(filePath) { try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return fail(); } }',
  'const root = path.dirname(fileURLToPath(import.meta.url));',
  `const config = readJson(path.join(process.env.HOME || homedir(), ${JSON.stringify(contract.COLLECTOR_CONFIG_FILE_NAME)}));`,
  'if (typeof config?.api_url !== "string" || config.api_url.length === 0) { fail(); }',
];

// collectorと同じKeychain item（accountは接続先URL）からtokenを読む。未登録なら子を起動しない。
const MCP_LAUNCHER_TOKEN = [
  `const security = process.env.YORI_SECURITY_BIN || ${JSON.stringify(contract.DEFAULT_SECURITY_BIN)};`,
  `const find = ['find-generic-password', '-s', ${JSON.stringify(contract.COLLECTOR_KEYCHAIN_SERVICE)}, '-a', config.api_url, '-w'];`,
  'let token = "";',
  "try { token = execFileSync(security, find, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { fail(); }",
  'if (!token) { fail(); }',
];

// install.jsonが指す現在versionのbundleを引数なしで起動する。URLとtokenは子のenvにだけ載せる。
const MCP_LAUNCHER_SPAWN = [
  `const state = readJson(path.join(root, ${JSON.stringify(contract.COLLECTOR_INSTALL_STATE_FILE_NAME)}));`,
  `const versionDir = path.join(root, ${JSON.stringify(contract.COLLECTOR_VERSION_DIR_NAME)}, String(state?.collector_version));`,
  `const secrets = { ${contract.COLLECTOR_MCP_API_URL_ENV}: config.api_url, ${contract.COLLECTOR_MCP_API_TOKEN_ENV}: token };`,
  `const env = { ...process.env, ...secrets, YORI_MCP_CONFIG: path.join(root, ${JSON.stringify(COLLECTOR_MCP_CONFIG_FILE_NAME)}) };`,
  `const child = spawn(process.execPath, [path.join(versionDir, ${JSON.stringify(contract.COLLECTOR_MCP_BUNDLE_FILE_NAME)})], { stdio: 'inherit', env });`,
  // hostがlauncherを止めたとき、子MCPを取り残さない。
  "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) { process.on(signal, () => child.kill(signal)); }",
  "child.on('error', fail);",
  "child.on('exit', (code) => process.exit(typeof code === 'number' ? code : 1));",
  '',
];

const SERVER = contract.COLLECTOR_MCP_SERVER_NAME;
// 読み取り系は確認なし、書き込み系は確認ありにする。
const READ_TOOLS = ['get_search_result', 'get_evidence', 'search_history'];
const WRITE_TOOLS = ['record_case', 'link_session'];
const CODEX_APPROVAL_WITHOUT_PROMPT = 'approve';
const CODEX_APPROVAL_WITH_PROMPT = 'prompt';
type McpAction = 'install' | 'uninstall';
// 現在の本文から書き換え後の本文を返す。変更不要ならnull。
type McpRender = (text: string) => string | null;

// 非objectは空objectとして読む。呼出元は複製へ書くため、元の値を変更しない。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function parseJsonObject(text: string): Record<string, unknown> {
  const json: unknown = text.trim().length === 0 ? {} : JSON.parse(text);
  return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : failInvalid();
}

function failInvalid(): never {
  throw new CollectorFailure('collector_hook_invalid');
}

function formatJson(json: Record<string, unknown>): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

// ~/.claude.jsonのmcpServersからyoriだけを置換・除去する。内容が同じなら書かない。
function claudeMcpServersRender(launcherPath: string, action: McpAction): McpRender {
  const entry = { type: 'stdio', command: process.execPath, args: [launcherPath], env: {} };
  return (text) => {
    const json = parseJsonObject(text);
    const { [SERVER]: current, ...others } = asRecord(json.mcpServers);
    if (action === 'install' ? isDeepStrictEqual(current, entry) : current === undefined) {
      return null;
    }
    json.mcpServers = action === 'install' ? { ...others, [SERVER]: entry } : others;
    return formatJson(json);
  };
}

// ~/.claude/settings.jsonのpermissions.allowへ読み取りtoolの許可ruleだけを足す。書き込みtoolは既定の確認に任せる。
function claudePermissionsRender(action: McpAction): McpRender {
  const rules: unknown[] = READ_TOOLS.map((tool) => `mcp__${SERVER}__${tool}`);
  return (text) => {
    const json = parseJsonObject(text);
    const permissions = asRecord(json.permissions);
    const allow: unknown[] = Array.isArray(permissions.allow) ? permissions.allow : [];
    const others = allow.filter((rule) => !rules.includes(rule));
    const next = action === 'install' ? [...others, ...rules] : others;
    if (isDeepStrictEqual(next, allow)) {
      return null;
    }
    json.permissions = { ...permissions, allow: next };
    return formatJson(json);
  };
}

const CODEX_TABLE = `mcp_servers.${SERVER}`;
const TOML_TABLE_HEADER = /^\s*\[{1,2}([^[\]]+)\]{1,2}\s*(?:#.*)?$/;

// yoriのtable見出しから次のtable見出しまでの行だけを除く。他の行はコメント・書式ごと残す。
function removeCodexMcpSections(text: string): string {
  let owned = false;
  const kept = text.split('\n').filter((line) => {
    const header = TOML_TABLE_HEADER.exec(line);
    if (header !== null) {
      const table = header[1].replace(/["'\s]/g, '');
      owned = table === CODEX_TABLE || table.startsWith(`${CODEX_TABLE}.`);
    }
    return !owned;
  });
  return kept.join('\n').trimEnd();
}

interface CodexMcpEntry {
  command: string;
  args: string[];
  tools: Record<string, { approval_mode: string }>;
}

// JSONの文字列・配列表記はTOMLのbasic string・arrayとしてそのまま有効。
function codexMcpBlock(entry: CodexMcpEntry): string {
  const lines = [`[${CODEX_TABLE}]`, `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args)}`];
  for (const [tool, { approval_mode }] of Object.entries(entry.tools)) {
    lines.push('', `[${CODEX_TABLE}.tools.${tool}]`, `approval_mode = ${JSON.stringify(approval_mode)}`);
  }
  return lines.join('\n');
}

// Codex設定をyoriの項目とそれ以外に分ける。書き換え前後で「それ以外」が変わらないことの照合に使う。
function splitCodexConfig(text: string): { yori: unknown; rest: Record<string, unknown> } {
  // parserはprototypeなしのobjectを返す。期待値と厳密比較できるよう、JSON経由で通常のobjectへ揃える。
  const config = JSON.parse(JSON.stringify(parseToml(text))) as Record<string, unknown>;
  const { [SERVER]: yori, ...servers } = asRecord(config.mcp_servers);
  return { yori, rest: { ...config, mcp_servers: servers } };
}

function attemptCodexSplit(text: string): ReturnType<typeof splitCodexConfig> | null {
  try {
    return splitCodexConfig(text);
  } catch {
    return null;
  }
}

function codexMcpRender(launcherPath: string, action: McpAction): McpRender {
  const approvals = [
    ...READ_TOOLS.map((tool) => [tool, { approval_mode: CODEX_APPROVAL_WITHOUT_PROMPT }]),
    ...WRITE_TOOLS.map((tool) => [tool, { approval_mode: CODEX_APPROVAL_WITH_PROMPT }]),
  ];
  const entry: CodexMcpEntry = { command: process.execPath, args: [launcherPath], tools: Object.fromEntries(approvals) };
  const expected = action === 'install' ? entry : undefined;
  return (text) => renderCodexConfig(text, expected);
}

// yoriのsectionだけを差し替える。expectedがundefinedなら除去だけを行う。
function renderCodexConfig(text: string, expected: CodexMcpEntry | undefined): string | null {
  const before = splitCodexConfig(text);
  if (isDeepStrictEqual(before.yori, expected)) {
    return null;
  }
  const kept = removeCodexMcpSections(text);
  const blocks = expected === undefined ? [kept] : [kept, codexMcpBlock(expected)];
  const body = blocks.filter((block) => block.length > 0).join('\n\n');
  const next = body.length > 0 ? `${body}\n` : '';
  // 別の書き方のyori定義は行単位で除けない。結果をparserで照合し、合わなければ書かずに拒否する。
  const after = attemptCodexSplit(next);
  if (after === null || !isDeepStrictEqual(after.rest, before.rest) || !isDeepStrictEqual(after.yori, expected)) {
    throw new CollectorFailure('collector_hook_conflict');
  }
  return next;
}

// 未作成のfileは空本文として読む。symlink・通常file以外は変更前に拒否する。
async function loadMcpFile(filePath: string): Promise<CollectorHookUpdate> {
  const stats = await lstat(filePath).catch(() => null);
  if (stats === null) {
    return { path: filePath, content: '', original: null, mode: 0o600 };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return failInvalid();
  }
  const original = await readFile(filePath);
  return { path: filePath, content: original.toString('utf8'), original, mode: stats.mode & 0o777 };
}

function mcpTargets(home: string, agent: CollectorAgent, launcherPath: string, action: McpAction): { path: string; render: McpRender }[] {
  if (agent === 'codex') {
    return [{ path: path.join(home, '.codex', 'config.toml'), render: codexMcpRender(launcherPath, action) }];
  }
  const servers = { path: path.join(home, '.claude.json'), render: claudeMcpServersRender(launcherPath, action) };
  return [servers, { path: collectorHookPath(home, agent), render: claudePermissionsRender(action) }];
}

// 不正なJSON・TOMLは固定codeへ縮退させ、parserのerror本文を外へ出さない。
function renderMcpFile(render: McpRender, text: string): string | null {
  try {
    return render(text);
  } catch (error) {
    if (error instanceof CollectorFailure) {
      throw error;
    }
    return failInvalid();
  }
}

// hookの書き換え計画へMCP登録を合流させる。同じfile（Claude Codeのsettings.json）は1回の書き込みへまとめ、
// hookと同じhash照合・rollbackに乗せる。
export async function planCollectorMcp(
  home: string,
  agents: readonly CollectorAgent[],
  action: McpAction,
  hookUpdates: readonly CollectorHookUpdate[],
): Promise<CollectorHookUpdate[]> {
  const updates = hookUpdates.map((update) => ({ ...update }));
  const launcherPath = collectorMcpLauncherPath(home);
  for (const target of agents.flatMap((agent) => mcpTargets(home, agent, launcherPath, action))) {
    const planned = updates.find((update) => update.path === target.path);
    const base = planned ?? (await loadMcpFile(target.path));
    const content = renderMcpFile(target.render, base.content);
    if (content === null) {
      continue;
    }
    if (planned === undefined) {
      updates.push({ ...base, content });
    } else {
      planned.content = content;
    }
  }
  return updates;
}

export async function writeCollectorMcpLauncher(home: string): Promise<void> {
  const source = [...MCP_LAUNCHER_HEAD, ...MCP_LAUNCHER_TOKEN, ...MCP_LAUNCHER_SPAWN].join('\n');
  await writeFileAtomic(collectorMcpLauncherPath(home), source, 0o500);
  const config = { api_url_env: contract.COLLECTOR_MCP_API_URL_ENV, api_token_env: contract.COLLECTOR_MCP_API_TOKEN_ENV };
  await writeFileAtomic(collectorMcpConfigPath(home), `${JSON.stringify(config, null, 2)}\n`, 0o600);
}
