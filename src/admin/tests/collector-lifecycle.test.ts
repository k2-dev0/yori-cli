import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_COLLECTOR_BUNDLE,
  DEFAULT_COLLECTOR_GIT_SHA,
  DEFAULT_COLLECTOR_VERSION,
  DEFAULT_SETUP_RESPONSE,
  DEFAULT_TOKEN,
  agentHookFixture,
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
  writeHookJson,
  type CollectorAgent,
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

// dotfiles管理の再現: 設定fileをhome配下の~/.config/<agent>へ移し、元のpathをそこを指すsymlinkにする。
// 実体のmodeは既定と違う値にし、書き換え後もmodeを保つことを検証できるようにする。
async function linkHookIntoConfigDir(fixture: CollectorFixture, agent: CollectorAgent): Promise<string> {
  const link = hookPath(fixture, agent);
  const target = path.join(fixture.home, '.config', agent, path.basename(link));
  await mkdir(path.dirname(target), { recursive: true });
  await rename(link, target);
  await chmod(target, 0o640);
  await symlink(target, link);
  return target;
}

async function assertLinkKept(fixture: CollectorFixture, agent: CollectorAgent, target: string): Promise<void> {
  const link = hookPath(fixture, agent);
  assert.ok((await lstat(link)).isSymbolicLink(), `${agent}のsymlinkを通常fileへ置き換えている`);
  assert.equal(await readlink(link), target, `${agent}のsymlinkの参照先を変えている`);
  assert.equal((await stat(target)).mode & 0o777, 0o640, `${agent}の実体のmodeを保っていない`);
}

// 成功時にstdoutが空か、改行で終わるJSON objectであることを確認する（UNIX的な無出力も許容）。
function assertSuccess(run: CollectorRun): void {
  assert.equal(run.code, 0, `終了コードが0ではない: code=${run.code} stderr=${run.stderr}`);
  assert.equal(run.stderr, '', `成功時にstderrへ出力している: ${run.stderr}`);
  if (run.stdout.length > 0) {
    assert.ok(run.stdout.endsWith('\n'), `stdoutが改行で終わっていない: ${JSON.stringify(run.stdout)}`);
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
      const updateOutput = parseCollectorSuccess(updated);
      const updateSteps = updateOutput.next_steps as string[] | undefined;
      assert.ok(updateSteps?.some((step) => step.includes('新しいsession')), `updateが新しいsessionを始める案内を返していない: ${updated.stdout}`);
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
      assert.deepEqual(Object.keys(installState).sort(), ['checksum', 'collector_version', 'git_sha', 'installer_version', 'mcp_checksum', 'policy_version']);
      assert.equal(installState.installer_version, packageJson.version);
      assert.equal(installState.collector_version, V2_VERSION);
      assert.equal(installState.git_sha, DEFAULT_COLLECTOR_GIT_SHA);
      assert.equal(installState.checksum, sha256Hex(V2_BUNDLE));
      assert.equal(installState.policy_version, 3);
    });
  });

  it('旧async notifyだけの設定を同期notify・async notify-late・collectへ更新する', async () => {
    await withCollectorFixture(async (fixture) => {
      await installV1(fixture);
      for (const agent of AGENTS) {
        const filePath = hookPath(fixture, agent);
        const json = JSON.parse(await readText(filePath)) as {
          hooks: Record<string, Array<{ hooks?: Array<{ command?: string; async?: boolean }> }>>;
        };
        const promptEntries = json.hooks.UserPromptSubmit ?? [];
        for (const entry of promptEntries) {
          entry.hooks = (entry.hooks ?? []).filter((hook) => !hook.command?.includes('notify-late'));
          for (const hook of entry.hooks) {
            if (hook.command?.includes(' notify ')) {
              hook.async = true;
            }
          }
        }
        json.hooks.UserPromptSubmit = promptEntries.filter((entry) => (entry.hooks?.length ?? 0) > 0);
        await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      }

      await writeCollectorArtifact(fixture, { version: V2_VERSION, content: V2_BUNDLE });
      parseCollectorSuccess(await runRootCli(fixture, ['collector:update']));

      for (const agent of AGENTS) {
        const commands = await collectorCommandsFor(fixture, agent);
        assert.equal(commands.length, 3, `${agent}のhookを3本へ移行していない: ${JSON.stringify(commands)}`);
        const json = JSON.parse(await readText(hookPath(fixture, agent))) as {
          hooks: Record<string, Array<{ hooks?: Array<{ command?: string; async?: boolean }> }>>;
        };
        const promptHooks = (json.hooks.UserPromptSubmit ?? []).flatMap((entry) => entry.hooks ?? []);
        const notify = promptHooks.find((hook) => hook.command?.includes(' notify '));
        const notifyLate = promptHooks.find((hook) => hook.command?.includes('notify-late'));
        assert.ok(notify !== undefined && !('async' in notify), `${agent}のnotifyを同期化していない`);
        assert.equal(notifyLate?.async, true, `${agent}のnotify-lateをasyncにしていない`);
      }
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

  it('同一versionでGit SHAまたはchecksumが異なるartifactを通常更新として扱わない', async () => {
    for (const [label, artifact] of [
      ['Git SHA', { version: DEFAULT_COLLECTOR_VERSION, content: DEFAULT_COLLECTOR_BUNDLE, gitSha: '2'.repeat(40) }],
      ['checksum', { version: DEFAULT_COLLECTOR_VERSION, content: V2_BUNDLE, gitSha: DEFAULT_COLLECTOR_GIT_SHA }],
    ] as const) {
      await withCollectorFixture(async (fixture) => {
        await installV1(fixture);
        const stateBefore = await readText(path.join(collectorInstallRoot(fixture), 'install.json'));
        const bundlePath = path.join(collectorVersionDir(fixture, DEFAULT_COLLECTOR_VERSION), 'yori-collector.mjs');
        const bundleBefore = await readText(bundlePath);
        await writeCollectorArtifact(fixture, artifact);
        const run = await runRootCli(fixture, ['collector:update']);
        assert.equal(run.code, 1, `${label}不一致を成功扱いしている`);
        assert.equal(run.stderr, 'admin: collector_artifact_invalid\n');
        assert.equal(await readText(bundlePath), bundleBefore, `${label}不一致でbundleを書き換えている`);
        assert.equal(await readText(path.join(collectorInstallRoot(fixture), 'install.json')), stateBefore, `${label}不一致でstateを書き換えている`);
      });
    }
  });

  it('設定fileがhome配下の実体を指すsymlinkなら、symlinkを残して実体へhookとMCP登録を書き、modeを保つ', async () => {
    await withCollectorFixture(async (fixture) => {
      await installV1(fixture);
      const targets = new Map<CollectorAgent, string>();
      for (const agent of AGENTS) {
        // collector entryを外し、updateで実体への書き込みが起きるようにする。
        await writeHookJson(fixture, agent, agentHookFixture());
        targets.set(agent, await linkHookIntoConfigDir(fixture, agent));
      }

      await writeCollectorArtifact(fixture, { version: V2_VERSION, content: V2_BUNDLE });
      parseCollectorSuccess(await runRootCli(fixture, ['collector:update']));

      for (const agent of AGENTS) {
        const target = targets.get(agent) as string;
        await assertLinkKept(fixture, agent, target);
        assert.equal((await collectorCommandsFor(fixture, agent)).length, 3, `${agent}の実体へhookを入れていない`);
        assert.ok((await readText(target)).includes('echo unrelated-prompt'), `${agent}の無関係なhookを消している`);
      }
      assert.ok((await readText(targets.get('claude_code') as string)).includes('mcp__yori__get_evidence'), '実体へ読み取りtoolの許可ruleを入れていない');

      // 許す条件を満たすsymlinkは、doctorでも異常にしない。
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      const checks = parseCollectorSuccess(await runRootCli(fixture, ['collector:doctor'])).checks as Record<string, boolean>;
      assert.equal(checks.hooks, true, 'doctorがsymlinkのhookを異常にしている');
      assert.equal(checks.mcp, true, 'doctorがsymlinkのMCP登録を異常にしている');
    });
  });

  it('symlinkの先がhomeの外・壊れている・directoryなら、何も書かずに失敗する', async () => {
    const cases: [string, (fixture: CollectorFixture) => Promise<string>][] = [
      [
        'homeの外',
        async (fixture) => {
          const target = path.join(fixture.root, 'outside-settings.json');
          await writeFile(target, '{"keep":true}\n', 'utf8');
          return target;
        },
      ],
      ['壊れたsymlink', async (fixture) => path.join(fixture.home, '.config', 'claude', 'missing.json')],
      [
        'directory',
        async (fixture) => {
          const target = path.join(fixture.home, '.config', 'claude');
          await mkdir(target, { recursive: true });
          return target;
        },
      ],
    ];
    for (const [label, prepareTarget] of cases) {
      await withCollectorFixture(async (fixture) => {
        await installV1(fixture);
        const link = hookPath(fixture, 'claude_code');
        const target = await prepareTarget(fixture);
        await rm(link);
        await symlink(target, link);
        const targetBefore = await readText(target).catch(() => null);
        const codexBefore = await readText(hookPath(fixture, 'codex'));
        const stateBefore = await readText(path.join(collectorInstallRoot(fixture), 'install.json'));

        await writeCollectorArtifact(fixture, { version: V2_VERSION, content: V2_BUNDLE });
        const run = await runRootCli(fixture, ['collector:update']);
        assertCollectorFailure(run, [DEFAULT_TOKEN]);
        assert.equal(run.stderr, 'admin: collector_hook_symlink_invalid\n', `${label}のsymlinkを理由の分かるcodeで拒否していない`);

        assert.ok((await lstat(link)).isSymbolicLink(), `${label}: symlinkを置き換えている`);
        assert.equal(await readlink(link), target, `${label}: symlinkの参照先を変えている`);
        assert.equal(await readText(target).catch(() => null), targetBefore, `${label}: symlinkの先を変更している`);
        assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore, `${label}: codex側を変更している`);
        assert.equal(await readText(path.join(collectorInstallRoot(fixture), 'install.json')), stateBefore, `${label}: versionを切り替えている`);
        assert.equal(existsSync(collectorVersionDir(fixture, V2_VERSION)), false, `${label}: 新versionを配置している`);
      });
    }
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
      assert.equal((await collectorCommandsFor(fixture, 'codex')).length, 3);
    });
  });

  it('設定fileがhome配下の実体を指すsymlinkなら、symlinkを残して実体からyoriの登録だけを消す', async () => {
    await withCollectorFixture(async (fixture) => {
      await installV1(fixture);
      const targets = new Map<CollectorAgent, string>();
      for (const agent of AGENTS) {
        targets.set(agent, await linkHookIntoConfigDir(fixture, agent));
      }

      assertSuccess(await runRootCli(fixture, ['collector:uninstall']));

      for (const agent of AGENTS) {
        const target = targets.get(agent) as string;
        await assertLinkKept(fixture, agent, target);
        assert.deepEqual(await collectorCommandsFor(fixture, agent), [], `${agent}の実体にcollector entryが残っている`);
        const text = await readText(target);
        assert.ok(text.includes('echo unrelated-prompt') && text.includes('echo unrelated-stop'), `${agent}の無関係なhookを消している`);
      }
      assert.ok(!(await readText(targets.get('claude_code') as string)).includes('mcp__yori__'), '実体に読み取りtoolの許可ruleが残っている');
    });
  });
});
