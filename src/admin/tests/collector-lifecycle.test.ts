import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_COLLECTOR_BUNDLE,
  DEFAULT_COLLECTOR_VERSION,
  DEFAULT_SETUP_RESPONSE,
  DEFAULT_TOKEN,
  assertCollectorFailure,
  collectorCommandsFor,
  collectorConfigPath,
  collectorInstallRoot,
  collectorVersionDir,
  hookCommandFor,
  hookPath,
  keychainToken,
  listFilesRecursively,
  parseCollectorSuccess,
  prepareCollectorInstall,
  readSecurityCalls,
  runRootCli,
  runShellCommand,
  sha256Hex,
  withCollectorFixture,
  writeApiSpec,
  writeCollectorArtifact,
  type CollectorFixture,
  type CollectorRun,
} from './collector-support.js';
import { REPO_ROOT } from './support.js';

// collector:update / doctor / uninstallの契約。installで作った隔離環境だけを使う。
const V2_VERSION = '9.9.9-test2';
const V3_VERSION = '9.9.9-test3';
const V2_BUNDLE =
  "if (!process.env.YORI_COLLECTOR_TOKEN) { process.exit(3); }\nconsole.log(\"collector-fixture-v2\");\n";
const AGENTS = ['codex', 'claude_code'] as const;

async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

// directory配下でneedleを含むfileの相対pathを返す。override pathの非保存検証に使う。
async function filesContaining(directory: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const relative of await listFilesRecursively(directory)) {
    const content = await readFile(path.join(directory, relative)).catch(() => null);
    if (content !== null && content.includes(needle)) {
      hits.push(relative);
    }
  }
  return hits;
}

async function installV1(fixture: CollectorFixture): Promise<void> {
  await prepareCollectorInstall(fixture);
  parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
}

// directory内fileの内容snapshot。doctorが状態を書き換えないことの検証に使う。
async function snapshot(directory: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const relative of await listFilesRecursively(directory)) {
    const content = await readFile(path.join(directory, relative)).catch(() => null);
    if (content !== null) {
      entries.set(relative, content.toString('base64'));
    }
  }
  return entries;
}

// 成功時にstdoutが空か、1行JSON objectであることを確認する（UNIX的な無出力も許容）。
function assertSuccess(run: CollectorRun): void {
  assert.equal(run.code, 0, `終了コードが0ではない: code=${run.code} stderr=${run.stderr}`);
  assert.equal(run.stderr, '', `成功時にstderrへ出力している: ${run.stderr}`);
  if (run.stdout.length > 0) {
    assert.equal(run.stdout.split('\n').length, 2, `stdoutが1行JSONではない: ${JSON.stringify(run.stdout)}`);
    const parsed: unknown = JSON.parse(run.stdout);
    assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  }
}

describe('collector:update', () => {
  it('検証済みの新versionだけへ切り替え、旧versionとhooks・configを維持する', async () => {
    await withCollectorFixture(async (fixture) => {
      await installV1(fixture);
      const configBefore = await readText(collectorConfigPath(fixture));
      const hookBefore = await Promise.all(AGENTS.map((agent) => readText(hookPath(fixture, agent))));

      await writeCollectorArtifact(fixture, { version: V2_VERSION, content: V2_BUNDLE });
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      const updated = await runRootCli(fixture, ['collector:update']);
      parseCollectorSuccess(updated);
      // test/development overrideのartifact pathはupdate後のconfig・manifest・hooksへ保存しない。
      assert.ok(!updated.stdout.includes(fixture.artifactDir));
      assert.deepEqual(await filesContaining(fixture.home, fixture.artifactDir), [], 'updateでoverride pathを保存している');

      const v1Bundle = path.join(collectorVersionDir(fixture, DEFAULT_COLLECTOR_VERSION), 'yori-collector.mjs');
      const v2Bundle = path.join(collectorVersionDir(fixture, V2_VERSION), 'yori-collector.mjs');
      assert.ok(existsSync(v1Bundle), 'updateで旧versionを削除している');
      assert.equal(await readText(v1Bundle), DEFAULT_COLLECTOR_BUNDLE);
      assert.equal(await readText(v2Bundle), V2_BUNDLE);

      // hooksはstable launcherのまま変更せず、launcherの実行先だけが新versionへ変わる。
      for (const [index, agent] of AGENTS.entries()) {
        assert.equal(await readText(hookPath(fixture, agent)), hookBefore[index], `updateで${agent}のhookを書き換えている`);
      }
      const launched = runShellCommand(fixture, await hookCommandFor(fixture, 'codex', 'collect'));
      assert.equal(launched.status, 0, `launcher実行に失敗した: ${launched.stderr}`);
      assert.ok(launched.stdout.includes('collector-fixture-v2'), `launcherが新versionを実行していない: ${launched.stdout}`);
      assert.equal(await readText(collectorConfigPath(fixture)), configBefore);
      assert.equal(await keychainToken(fixture), DEFAULT_TOKEN);

      // update後のinstall.jsonは新collector versionとchecksumへ切り替わり、初回setup policy_versionを保持する。
      const installState = JSON.parse(await readText(path.join(collectorInstallRoot(fixture), 'install.json'))) as Record<string, unknown>;
      const packageJson = JSON.parse(await readText(path.join(REPO_ROOT, 'package.json'))) as { version: string };
      assert.deepEqual(Object.keys(installState).sort(), ['checksum', 'collector_version', 'installer_version', 'policy_version']);
      assert.equal(installState.installer_version, packageJson.version);
      assert.equal(installState.collector_version, V2_VERSION);
      assert.equal(installState.checksum, sha256Hex(V2_BUNDLE));
      assert.equal(installState.policy_version, 3);
    });
  });

  it('checksum不一致の新versionでは切り替えず、旧versionを実行し続ける', async () => {
    await withCollectorFixture(async (fixture) => {
      await installV1(fixture);
      await writeCollectorArtifact(fixture, { version: V2_VERSION, content: V2_BUNDLE });
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      parseCollectorSuccess(await runRootCli(fixture, ['collector:update']));

      const configBefore = await readText(collectorConfigPath(fixture));
      const hookBefore = await Promise.all(AGENTS.map((agent) => readText(hookPath(fixture, agent))));
      await writeCollectorArtifact(fixture, {
        version: V3_VERSION,
        content: 'console.log("collector-fixture-v3");\n',
        checksum: sha256Hex('different-content'),
      });
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      assertCollectorFailure(await runRootCli(fixture, ['collector:update']), [DEFAULT_TOKEN]);

      assert.equal(existsSync(collectorVersionDir(fixture, V3_VERSION)), false, '検証前のversionを配置している');
      const launched = runShellCommand(fixture, await hookCommandFor(fixture, 'codex', 'collect'));
      assert.equal(launched.status, 0, `launcher実行に失敗した: ${launched.stderr}`);
      assert.ok(launched.stdout.includes('collector-fixture-v2'), `launcherが旧versionへ戻っていない: ${launched.stdout}`);
      assert.equal(await readText(collectorConfigPath(fixture)), configBefore);
      for (const [index, agent] of AGENTS.entries()) {
        assert.equal(await readText(hookPath(fixture, agent)), hookBefore[index]);
      }
    });
  });
});

describe('collector:doctor', () => {
  it('DATABASE_URLなしで秘密を含まない診断を返し、状態を変更しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await installV1(fixture);
      const before = await snapshot(fixture.home);
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      const run = await runRootCli(fixture, ['collector:doctor']);
      const output = parseCollectorSuccess(run);
      assert.equal(output.policy_version, 3, `doctorがcurrent policy versionを返していない: ${run.stdout}`);
      assert.equal(typeof output.version, 'string');
      const checks = output.checks as Record<string, boolean>;
      for (const name of ['installed', 'artifact', 'launcher', 'config', 'hooks', 'keychain', 'setup', 'platform', 'git', 'permissions']) {
        assert.equal(checks[name], true, `doctor check ${name} がtrueではない: ${run.stdout}`);
      }
      for (const text of [run.stdout, run.stderr]) {
        assert.ok(!text.includes(DEFAULT_TOKEN), 'doctor出力へtokenが出ている');
        assert.ok(!text.includes('Bearer'), 'doctor出力へAuthorizationが出ている');
        assert.ok(!text.includes('fixture-term'), 'doctor出力へpolicy valueが出ている');
      }
      // doctorはKeychain promptをせず、状態も変更しない。
      assert.equal((await readSecurityCalls(fixture)).filter((args) => args[0] === 'add-generic-password').length, 0);
      assert.deepEqual(await snapshot(fixture.home), before, 'doctorが状態を変更している');
    });
  });
});

describe('collector:uninstall', () => {
  it('所有hook entryだけを削除し、Keychainと無関係設定を保持する', async () => {
    await withCollectorFixture(async (fixture) => {
      await installV1(fixture);
      // state directoryはuninstall対象外であることをmarkerで確認する。
      const stateMarker = path.join(fixture.home, '.yori-collector', 'keep');
      await mkdir(path.dirname(stateMarker), { recursive: true });
      await writeFile(stateMarker, 'state', 'utf8');
      const run = await runRootCli(fixture, ['collector:uninstall']);
      assertSuccess(run);
      assert.ok(!run.stdout.includes(DEFAULT_TOKEN));

      for (const agent of AGENTS) {
        const hookJson = await readText(hookPath(fixture, agent));
        assert.ok(existsSync(hookPath(fixture, agent)), `${agent}の設定file自体を削除している`);
        assert.ok(hookJson.includes('echo unrelated-prompt'), `${agent}の無関係なUserPromptSubmitを削除している`);
        assert.ok(hookJson.includes('echo unrelated-stop'), `${agent}の無関係なStopを削除している`);
        assert.deepEqual(await collectorCommandsFor(fixture, agent), [], `${agent}のcollector entryが残っている: ${hookJson}`);
      }

      assert.equal(await keychainToken(fixture), DEFAULT_TOKEN, 'uninstallでKeychain tokenを削除している');
      // config・install rootは削除し、state directoryは保持する。
      assert.equal(existsSync(collectorConfigPath(fixture)), false, 'uninstallでconfigを残している');
      assert.equal(existsSync(collectorInstallRoot(fixture)), false, 'uninstallでinstall rootを残している');
      assert.equal(await readText(stateMarker), 'state', 'uninstallでstate directoryを削除している');

      // Keychainを保持するため、再installはpromptなしで成功する。
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      const addCalls = (await readSecurityCalls(fixture)).filter((args) => args[0] === 'add-generic-password');
      assert.equal(addCalls.length, 0, '再installでKeychain promptをやり直している');
      assert.equal((await collectorCommandsFor(fixture, 'codex')).length, 2);
    });
  });
});
