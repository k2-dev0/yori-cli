import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { COLLECTOR_CONFIG_FILE_NAME, type CollectorAgent, CollectorFailure } from './contract.js';
import { writeFileAtomic } from './fs.js';
import { collectorHookPath, collectorSource } from './layout.js';

type CollectorHookAction = 'install' | 'uninstall';
type CollectorHookKind = 'notify' | 'collect';

export interface CollectorHookState {
  agent: CollectorAgent;
  path: string;
  text: string;
  original: Buffer;
  json: Record<string, unknown>;
  mode: number;
}

export interface CollectorHookUpdate {
  path: string;
  content: string;
  original: Buffer;
  mode: number;
}

const HOOK_SPECS: readonly { section: string; kind: CollectorHookKind }[] = [
  { section: 'UserPromptSubmit', kind: 'notify' },
  { section: 'Stop', kind: 'collect' },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

// shellのsingle quoteで包み、quote自体は '\'' へ変換してPOSIX安全にする。
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// hook entry配下のcommand文字列だけを列挙する。他の設定値は変更判定に使わない。
function visitEntryCommands(entry: unknown, visit: (command: string) => void): void {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
    return;
  }
  for (const hook of entry.hooks) {
    if (isPlainObject(hook) && typeof hook.command === 'string') {
      visit(hook.command);
    }
  }
}

// 所有entryはstable launcherとconfig pathを持つexact expected commandだけで識別する。
// NodeはPATHの`node`ではなくinstall実行中のprocess.execPath絶対pathを固定する。
function collectorHookCommand(agent: CollectorAgent, kind: CollectorHookKind, launcherPath: string, configPath: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(launcherPath)} ${kind} --source ${collectorSource(agent)} --config ${shellQuote(configPath)}`;
}

// 検出はlstatだけで行い、symlinkや不正JSONの判定はload側へ任せる。
export async function detectCollectorAgents(home: string): Promise<CollectorAgent[]> {
  const agents: CollectorAgent[] = [];
  for (const agent of ['codex', 'claude_code'] as const) {
    try {
      await lstat(collectorHookPath(home, agent));
      agents.push(agent);
    } catch {
      // 存在しないagent設定は対象外にする。
    }
  }
  return agents;
}

// 既存hookを読み、symlink・不正JSON・非objectを変更前に拒否する。
export async function loadCollectorHook(home: string, agent: CollectorAgent): Promise<CollectorHookState | null> {
  const filePath = collectorHookPath(home, agent);
  let stats;
  try {
    stats = await lstat(filePath);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CollectorFailure('collector_hook_invalid');
  }
  const original = await readFile(filePath);
  let json: unknown;
  try {
    json = JSON.parse(original.toString('utf8'));
  } catch {
    throw new CollectorFailure('collector_hook_invalid');
  }
  if (!isPlainObject(json)) {
    throw new CollectorFailure('collector_hook_invalid');
  }
  return {
    agent,
    path: filePath,
    text: original.toString('utf8'),
    original,
    json,
    mode: stats.mode & 0o777,
  };
}

// exact所有entryを置換・除去したhook本文を返す。install時だけ非所有の競合entryを拒否する。
export function renderCollectorHook(
  state: CollectorHookState,
  launcherPath: string,
  configPath: string,
  action: CollectorHookAction,
): string {
  const json = JSON.parse(JSON.stringify(state.json)) as Record<string, unknown>;
  const hooks = isPlainObject(json.hooks) ? json.hooks : (json.hooks = {});
  for (const spec of HOOK_SPECS) {
    const current = hooks[spec.section];
    if (!Array.isArray(current)) {
      if (action === 'uninstall') {
        // 所有entryが存在し得ないsectionはuninstallで新設しない。
        continue;
      }
      hooks[spec.section] = [];
    }
    const list = hooks[spec.section] as unknown[];
    const expected = collectorHookCommand(state.agent, spec.kind, launcherPath, configPath);
    const kept: unknown[] = [];
    for (const entry of list) {
      let owned = false;
      visitEntryCommands(entry, (command) => {
        if (command === expected) {
          owned = true;
          return;
        }
        const referencesCollector = command.includes(COLLECTOR_CONFIG_FILE_NAME) || command.includes(launcherPath);
        if (referencesCollector && action === 'install') {
          throw new CollectorFailure('collector_hook_conflict');
        }
      });
      if (!owned) {
        kept.push(entry);
      }
    }
    if (action === 'install') {
      const hook = spec.kind === 'notify' ? { type: 'command', command: expected, async: true } : { type: 'command', command: expected };
      kept.push({ hooks: [hook] });
    }
    hooks[spec.section] = kept;
  }
  return `${JSON.stringify(json, null, 2)}\n`;
}

// 変更が必要なhook fileだけをplanする。APIやwriteの前に全fileのvalidationを完了させる。
export async function planCollectorHooks(
  home: string,
  agents: readonly CollectorAgent[],
  launcherPath: string,
  configPath: string,
  action: CollectorHookAction,
): Promise<CollectorHookUpdate[]> {
  const updates: CollectorHookUpdate[] = [];
  for (const agent of agents) {
    const state = await loadCollectorHook(home, agent);
    if (state === null) {
      continue;
    }
    const content = renderCollectorHook(state, launcherPath, configPath, action);
    if (content !== state.text) {
      updates.push({ path: state.path, content, original: state.original, mode: state.mode });
    }
  }
  return updates;
}

// 書き込み直前にhash照合し、他processの変更を検知したら無変更で失敗する。
// 2 fileの片側が失敗した場合は、先に書いたfileを元のbytes・modeへ戻す。
export async function commitCollectorHooks(updates: readonly CollectorHookUpdate[]): Promise<void> {
  for (const update of updates) {
    const current = await readFile(update.path).catch(() => null);
    if (current === null || sha256(current) !== sha256(update.original)) {
      throw new CollectorFailure('collector_hook_conflict');
    }
  }
  const written: CollectorHookUpdate[] = [];
  try {
    for (const update of updates) {
      await writeFileAtomic(update.path, update.content, update.mode);
      written.push(update);
    }
  } catch {
    const rollbackFailed = await restoreHookFiles(written);
    if (rollbackFailed) {
      throw new CollectorFailure('collector_rollback_failed');
    }
    throw new CollectorFailure('collector_hook_error');
  }
}

// 元bytes・元modeへ戻す。戻せなかった場合はtrueを返し、呼出元が固定codeへ縮退する。
async function restoreHookFiles(updates: readonly CollectorHookUpdate[]): Promise<boolean> {
  let failed = false;
  for (const update of [...updates].reverse()) {
    try {
      await writeFileAtomic(update.path, update.original, update.mode);
    } catch {
      failed = true;
    }
  }
  return failed;
}

export async function restoreCollectorHooks(updates: readonly CollectorHookUpdate[]): Promise<void> {
  if (await restoreHookFiles(updates)) {
    throw new CollectorFailure('collector_rollback_failed');
  }
}

// doctor用: 現在のhookが所有entryを持つ期待形かだけを読み取りで判定する。
export async function collectorHookIsCurrent(
  home: string,
  agent: CollectorAgent,
  launcherPath: string,
  configPath: string,
): Promise<boolean> {
  const state = await loadCollectorHook(home, agent).catch(() => null);
  if (state === null) {
    return false;
  }
  try {
    return renderCollectorHook(state, launcherPath, configPath, 'install') === state.text;
  } catch {
    return false;
  }
}
