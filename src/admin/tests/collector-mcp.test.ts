import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseTomlRaw } from 'smol-toml';
import {
  DEFAULT_API_URL,
  DEFAULT_COLLECTOR_VERSION,
  DEFAULT_TOKEN,
  assertCollectorFailure,
  collectorInstallRoot,
  collectorVersionDir,
  hookPath,
  listFilesRecursively,
  parseCollectorSuccess,
  prepareCollectorInstall,
  runRootCli,
  withCollectorFixture,
  writeApiSpec,
  writeMcpArtifact,
  DEFAULT_SETUP_RESPONSE,
  type CollectorFixture,
} from './collector-support.js';

// collector:install/update/uninstallによるyori MCP登録の契約。実HOME・実Keychain・実APIへは触れない。
// Codexは~/.codex/config.tomlの[mcp_servers.yori]、Claude Codeは~/.claude.jsonのmcpServers.yoriと
// ~/.claude/settings.jsonのpermissions.allowを対象にし、yoriの項目だけを追加・更新・削除する。
// smol-tomlはprototypeなしのobjectを返すため、deepEqualできる通常のobjectへ揃える。
function parseToml(text: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(parseTomlRaw(text))) as Record<string, unknown>;
}

const READ_TOOLS = ['get_search_result', 'get_evidence', 'search_history'];
const WRITE_TOOLS = ['record_case', 'link_session'];
const CLAUDE_READ_RULES = READ_TOOLS.map((tool) => `mcp__yori__${tool}`);

const EXISTING_CODEX_TOML = `# 利用者のコメントは保持する
model = "gpt-test"

[mcp_servers.other]
command = "other-server"
args = ["--flag"] # 行末コメント

[projects."/Users/example/repo"]
trust_level = "trusted"
`;

function codexConfigPath(fixture: CollectorFixture): string {
  return path.join(fixture.home, '.codex', 'config.toml');
}

function claudeConfigPath(fixture: CollectorFixture): string {
  return path.join(fixture.home, '.claude.json');
}

function mcpLauncherPath(fixture: CollectorFixture): string {
  return path.join(collectorInstallRoot(fixture), 'mcp-launcher.mjs');
}

async function readText(filePath: string): Promise<string | null> {
  return readFile(filePath, 'utf8').catch(() => null);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse((await readText(filePath)) ?? '{}') as Record<string, unknown>;
}

// MCP登録が触る3 fileの本文。冪等性は本文の完全一致で検証する。
async function mcpFileTexts(fixture: CollectorFixture): Promise<(string | null)[]> {
  return Promise.all([readText(codexConfigPath(fixture)), readText(claudeConfigPath(fixture)), readText(hookPath(fixture, 'claude_code'))]);
}

async function runOk(fixture: CollectorFixture, command: string): Promise<Record<string, unknown>> {
  await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
  return parseCollectorSuccess(await runRootCli(fixture, [command]));
}

interface CodexMcpServer {
  command: string;
  args: string[];
  tools: Record<string, { approval_mode: string }>;
}

async function codexServers(fixture: CollectorFixture): Promise<Record<string, CodexMcpServer>> {
  const parsed = parseToml((await readText(codexConfigPath(fixture))) ?? '') as { mcp_servers?: Record<string, CodexMcpServer> };
  return parsed.mcp_servers ?? {};
}

async function assertRegistered(fixture: CollectorFixture): Promise<void> {
  const launcher = mcpLauncherPath(fixture);
  const codex = (await codexServers(fixture)).yori;
  assert.ok(codex, 'Codexへyori MCPが登録されていない');
  assert.equal(codex.command, process.execPath, 'CodexのcommandがPATHのnodeを使っている');
  assert.deepEqual(codex.args, [launcher]);
  for (const tool of READ_TOOLS) {
    assert.equal(codex.tools[tool]?.approval_mode, 'approve', `Codexの読み取りtool ${tool} が確認なしになっていない`);
  }
  for (const tool of WRITE_TOOLS) {
    assert.equal(codex.tools[tool]?.approval_mode, 'prompt', `Codexの書き込みtool ${tool} が確認ありになっていない`);
  }
  const toml = (await readText(codexConfigPath(fixture))) ?? '';
  assert.equal(toml.split('\n').filter((line) => line.trim() === '[mcp_servers.yori]').length, 1, 'Codexのyori sectionが重複している');

  const claude = (await readJson(claudeConfigPath(fixture))).mcpServers as Record<string, unknown>;
  assert.deepEqual(claude.yori, { type: 'stdio', command: process.execPath, args: [launcher], env: {} });

  const settings = await readJson(hookPath(fixture, 'claude_code'));
  const allow = (settings.permissions as { allow: string[] }).allow;
  for (const rule of CLAUDE_READ_RULES) {
    assert.equal(allow.filter((value) => value === rule).length, 1, `Claude Codeの許可rule ${rule} が1件ではない`);
  }
  for (const tool of WRITE_TOOLS) {
    assert.ok(!allow.includes(`mcp__yori__${tool}`), `書き込みtool ${tool} を確認なしにしている`);
  }
}

// token本文がhome配下のどのfileにも現れないことを検証する。Keychain fixtureはhome外にある。
async function assertNoTokenInHome(fixture: CollectorFixture): Promise<void> {
  for (const relative of await listFilesRecursively(fixture.home)) {
    const content = await readFile(path.join(fixture.home, relative)).catch(() => null);
    assert.ok(content === null || !content.includes(DEFAULT_TOKEN), `tokenがfileへ書かれている: ${relative}`);
  }
}

async function writeExistingSettings(fixture: CollectorFixture): Promise<void> {
  await mkdir(path.dirname(codexConfigPath(fixture)), { recursive: true });
  await writeFile(codexConfigPath(fixture), EXISTING_CODEX_TOML, 'utf8');
  await writeFile(
    claudeConfigPath(fixture),
    JSON.stringify({ numStartups: 7, mcpServers: { other: { type: 'stdio', command: 'other-server', args: [], env: {} } } }),
    'utf8',
  );
  const settingsPath = hookPath(fixture, 'claude_code');
  const settings = await readJson(settingsPath);
  settings.permissions = { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'] };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

describe('collector MCP登録', () => {
  it('新規環境でinstall→update→updateしてもyori MCPを1件だけ登録し、tokenをfileへ書かない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      const installed = await runOk(fixture, 'collector:install');
      assert.equal((installed.checks as Record<string, boolean>).mcp, true);
      await assertRegistered(fixture);
      const afterInstall = await mcpFileTexts(fixture);

      for (const round of [1, 2]) {
        const updated = await runOk(fixture, 'collector:update');
        assert.equal((updated.checks as Record<string, boolean>).mcp, true);
        assert.deepEqual(await mcpFileTexts(fixture), afterInstall, `update ${round}回目で設定本文が変わった`);
      }
      await assertRegistered(fixture);
      await assertNoTokenInHome(fixture);

      const versionFiles = await listFilesRecursively(collectorVersionDir(fixture, DEFAULT_COLLECTOR_VERSION));
      assert.ok(versionFiles.includes('yori-mcp.mjs') && versionFiles.includes('mcp-manifest.json'), `MCP artifactが配置されていない: ${JSON.stringify(versionFiles)}`);
    });
  });

  it('既存設定がある環境でinstall→update→updateしても無関係な設定を保持し、重複させない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      await writeExistingSettings(fixture);
      await runOk(fixture, 'collector:install');
      const afterInstall = await mcpFileTexts(fixture);
      await runOk(fixture, 'collector:update');
      await runOk(fixture, 'collector:update');
      assert.deepEqual(await mcpFileTexts(fixture), afterInstall, 'updateの繰り返しで設定本文が変わった');
      await assertRegistered(fixture);

      // 既存本文はコメント・書式ごと先頭に残り、yoriのsectionだけが追加される。
      const toml = (await readText(codexConfigPath(fixture))) ?? '';
      assert.ok(toml.startsWith(EXISTING_CODEX_TOML), `Codexの既存本文を書き換えている: ${toml}`);
      assert.deepEqual((await codexServers(fixture)).other, { command: 'other-server', args: ['--flag'] });

      const claude = await readJson(claudeConfigPath(fixture));
      assert.equal(claude.numStartups, 7);
      assert.deepEqual((claude.mcpServers as Record<string, unknown>).other, { type: 'stdio', command: 'other-server', args: [], env: {} });

      const settings = await readJson(hookPath(fixture, 'claude_code'));
      const permissions = settings.permissions as { allow: string[]; deny: string[] };
      assert.equal(permissions.allow[0], 'Bash(ls:*)');
      assert.deepEqual(permissions.deny, ['Read(./.env)']);
      assert.deepEqual(settings.unrelated_setting, { keep: true });
    });
  });

  it('古いyoriの登録内容は重複させずに現在の内容へ置き換える', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      await mkdir(path.dirname(codexConfigPath(fixture)), { recursive: true });
      await writeFile(
        codexConfigPath(fixture),
        `${EXISTING_CODEX_TOML}\n[mcp_servers.yori]\ncommand = "old-node"\nargs = ["old.mjs"]\n\n[mcp_servers.yori.tools.record_case]\napproval_mode = "approve"\n\n[tail]\nkeep = true\n`,
        'utf8',
      );
      await writeFile(claudeConfigPath(fixture), JSON.stringify({ mcpServers: { yori: { type: 'stdio', command: 'old-node', args: [] } } }), 'utf8');
      await runOk(fixture, 'collector:install');
      await assertRegistered(fixture);
      const parsed = parseToml((await readText(codexConfigPath(fixture))) ?? '') as { tail?: unknown };
      assert.deepEqual(parsed.tail, { keep: true }, 'yori sectionの後ろにある無関係なtableを失った');
    });
  });

  it('uninstallはyoriのMCP項目だけを削除し、無関係な設定を元のまま残す', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      await writeExistingSettings(fixture);
      const claudeBefore = await readJson(claudeConfigPath(fixture));
      await runOk(fixture, 'collector:install');
      parseCollectorSuccess(await runRootCli(fixture, ['collector:uninstall']));

      assert.equal(await readText(codexConfigPath(fixture)), EXISTING_CODEX_TOML, 'Codexの設定が元の本文へ戻っていない');
      assert.deepEqual(await readJson(claudeConfigPath(fixture)), claudeBefore);
      const settings = await readJson(hookPath(fixture, 'claude_code'));
      assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'] });
    });
  });

  it('Codex設定でyoriが別の書き方で定義済みなら、何も変更せずに失敗する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      await mkdir(path.dirname(codexConfigPath(fixture)), { recursive: true });
      await writeFile(codexConfigPath(fixture), 'mcp_servers = { yori = { command = "inline" } }\n', 'utf8');
      const before = await mcpFileTexts(fixture);
      const stderr = assertCollectorFailure(await runRootCli(fixture, ['collector:install']), [DEFAULT_TOKEN]);
      assert.equal(stderr, 'admin: collector_hook_conflict\n');
      assert.deepEqual(await mcpFileTexts(fixture), before, '失敗時に設定を変更している');
      assert.deepEqual(await listFilesRecursively(collectorInstallRoot(fixture)), [], '失敗時にinstall rootを作っている');
    });
  });

  it('MCP artifactのchecksum不一致・collectorとのversion不一致をinstallで拒否する', async () => {
    for (const artifact of [
      { version: DEFAULT_COLLECTOR_VERSION, content: 'console.log("bad");\n', checksum: '0'.repeat(64) },
      { version: '0.0.0-other', content: 'console.log("other-version");\n' },
    ]) {
      await withCollectorFixture(async (fixture) => {
        await prepareCollectorInstall(fixture);
        await writeMcpArtifact(fixture, artifact);
        const stderr = assertCollectorFailure(await runRootCli(fixture, ['collector:install']), [DEFAULT_TOKEN]);
        assert.equal(stderr, 'admin: collector_artifact_invalid\n');
        assert.equal(await readText(codexConfigPath(fixture)), null, '失敗時にCodex設定を作っている');
      });
    }
  });

  it('MCP launcherはKeychainのtokenと接続先をenvだけで子MCPへ渡し、設定fileには環境変数名だけを書く', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      await runOk(fixture, 'collector:install');
      const run = spawnSync(process.execPath, [mcpLauncherPath(fixture)], {
        encoding: 'utf8',
        env: {
          HOME: fixture.home,
          YORI_SECURITY_BIN: path.join(fixture.binDir, 'security'),
          YORI_TEST_SECURITY_LOG: fixture.securityLogPath,
          YORI_TEST_KEYCHAIN_FILE: fixture.keychainPath,
        },
      });
      assert.equal(run.status, 0, `launcherが失敗した: ${run.stderr}`);
      const report = JSON.parse(run.stdout) as { marker: string; config: Record<string, string>; api_url: string; token_length: number; argv: string[] };
      assert.equal(report.marker, 'mcp-fixture-v1');
      assert.deepEqual(Object.keys(report.config).sort(), ['api_token_env', 'api_url_env']);
      assert.equal(report.api_url, DEFAULT_API_URL);
      assert.equal(report.token_length, DEFAULT_TOKEN.length);
      assert.deepEqual(report.argv, [], '子MCPへ引数を渡している');
      assert.ok(!run.stdout.includes(DEFAULT_TOKEN) && !run.stderr.includes(DEFAULT_TOKEN), 'tokenを出力している');
    });
  });

  it('Keychainにtokenが無ければ子MCPを起動せずlauncher_errorで終了する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      await runOk(fixture, 'collector:install');
      const run = spawnSync(process.execPath, [mcpLauncherPath(fixture)], {
        encoding: 'utf8',
        env: {
          HOME: fixture.home,
          YORI_SECURITY_BIN: path.join(fixture.binDir, 'security'),
          YORI_TEST_SECURITY_LOG: fixture.securityLogPath,
          YORI_TEST_KEYCHAIN_FILE: path.join(fixture.root, 'missing-keychain.txt'),
        },
      });
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '', '子MCPを起動している');
      assert.equal(run.stderr, 'mcp: launcher_error\n');
    });
  });
});
