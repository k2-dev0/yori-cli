import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_API_URL,
  DEFAULT_COLLECTOR_BUNDLE,
  DEFAULT_COLLECTOR_VERSION,
  DEFAULT_TOKEN,
  HOOK_FILES,
  KEYCHAIN_SERVICE,
  agentHookFixture,
  assertCollectorFailure,
  collectorCommandsFor,
  collectorConfigPath,
  collectorInstallRoot,
  collectorVersionDir,
  commandPathsUnder,
  hookPath,
  keychainToken,
  listFilesRecursively,
  parseCollectorSuccess,
  prepareCollectorInstall,
  readApiRequests,
  readSecurityCalls,
  runRootCli,
  runShellCommand,
  sha256Hex,
  withCollectorFixture,
  writeApiSpec,
  writeCollectorArtifact,
  writeHookJson,
  type CollectorAgent,
} from './collector-support.js';

// root CLI経由のcollector:install契約。実HOME・実Keychain・実API・実gitへは触れない。
// 未実装の間はunknown commandとしてinvalid_argumentsへ落ちるため、各testがbehaviorでRedになる。

// directory配下でneedleを含むfileの相対pathを返す。秘密がhomeへ残っていないことの検証に使う。
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

async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

function assertUsesStableLauncher(fixture: { home: string }, command: string, agent: CollectorAgent): void {
  assert.ok(!command.includes('npx'), `hookがnpxを呼んでいる: ${command}`);
  assert.ok(!command.includes('@latest'), `hookがlatestを呼んでいる: ${command}`);
  assert.ok(!command.includes(DEFAULT_TOKEN), `hookへtokenが埋め込まれている: ${command}`);
  assert.ok(command.includes('.yori-collector.json'), `hookがcollector設定を参照していない: ${command}`);
  assert.match(command, new RegExp(`--source[= ]${HOOK_FILES[agent].source}(\\s|$)`), `hookのsourceが違う: ${command}`);
  const paths = commandPathsUnder(command, path.join(fixture.home, '.local', 'share', 'yori', 'collector'));
  assert.ok(paths.length >= 1, `hookが配置rootのlauncherを参照していない: ${command}`);
  for (const candidate of paths) {
    assert.ok(existsSync(candidate), `hookが参照するlauncherが存在しない: ${candidate}`);
  }
}

describe('collector:install', () => {
  it('token未登録時にKeychain prompt・setup API・config・hooks・version配置を一度で行う', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: false });
      const run = await runRootCli(fixture, ['collector:install'], {
        // 2行目はproject-id/api-url/agentを標準入力から読まないことの検証用。読み捨てられる。
        input: `${DEFAULT_TOKEN}\n${JSON.stringify({ project_id: 'stdin-project', api_url: 'http://127.0.0.1:9/evil', agent: 'stdin-agent' })}\n`,
        // collector commandがDB接続へ依存しないことを示すため、到達不能なURLを渡す。
        env: { DATABASE_URL: 'postgres://yori:yori@127.0.0.1:1/yori' },
      });
      const output = parseCollectorSuccess(run);
      assert.equal(typeof output, 'object');

      // ~/.yori-collector.jsonはapi_url/token_env/state_dirだけを持ち、projectsを持たない。
      const config = JSON.parse(await readText(collectorConfigPath(fixture))) as Record<string, unknown>;
      assert.deepEqual(Object.keys(config).sort(), ['api_url', 'state_dir', 'token_env']);
      assert.equal(config.api_url, DEFAULT_API_URL);
      assert.equal(config.state_dir, path.join(fixture.home, '.yori-collector'));
      assert.equal(typeof config.token_env, 'string');
      assert.ok((config.token_env as string).length > 0);
      assert.ok(!('projects' in config), 'configへprojectsを書いている');

      // token未登録時だけadd-generic-passwordを値なし末尾-wで呼び、argvへtokenを渡さない。
      const calls = await readSecurityCalls(fixture);
      const findCalls = calls.filter((args) => args[0] === 'find-generic-password');
      const addCalls = calls.filter((args) => args[0] === 'add-generic-password');
      assert.equal(addCalls.length, 1, `add-generic-passwordの回数が1ではない: ${JSON.stringify(calls)}`);
      assert.ok(findCalls.length >= 1, `find-generic-passwordを呼んでいない: ${JSON.stringify(calls)}`);
      for (const args of [findCalls[0], addCalls[0]]) {
        assert.equal(args[args.indexOf('-s') + 1], KEYCHAIN_SERVICE);
        assert.equal(args[args.indexOf('-a') + 1], DEFAULT_API_URL);
      }
      const addArgs = addCalls[0];
      assert.equal(addArgs.at(-1), '-w', `add-generic-passwordが値なし末尾-wではない: ${JSON.stringify(addArgs)}`);
      for (const args of calls) {
        assert.ok(!args.includes(DEFAULT_TOKEN), `security argvへtokenが出ている: ${JSON.stringify(args)}`);
      }
      assert.equal(await keychainToken(fixture), DEFAULT_TOKEN);

      // setup APIはBearer付きPOST /v1/collector/setupでcanonical repositoryだけを送る。
      const requests = await readApiRequests(fixture);
      assert.equal(requests.length, 1, `setup APIの呼出し回数が違う: ${JSON.stringify(requests)}`);
      assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/collector/setup`);
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].authorization, `Bearer ${DEFAULT_TOKEN}`);
      assert.deepEqual(JSON.parse(String(requests[0].body)), { repository: 'github.com/example/repo' });

      // version directoryへbundleとchecksum付きmanifestを置く。
      const versionDir = collectorVersionDir(fixture, DEFAULT_COLLECTOR_VERSION);
      const installedFiles = await listFilesRecursively(versionDir);
      assert.ok(installedFiles.includes('yori-collector.mjs'), `version配置がない: ${JSON.stringify(installedFiles)}`);
      assert.equal(await readText(path.join(versionDir, 'yori-collector.mjs')), DEFAULT_COLLECTOR_BUNDLE);
      const manifest = JSON.parse(await readText(path.join(versionDir, 'collector-manifest.json'))) as Record<string, unknown>;
      assert.equal(manifest.checksum, sha256Hex(DEFAULT_COLLECTOR_BUNDLE));

      // 2 agentのhooksを更新し、無関係設定と既存hookを保持する。
      for (const agent of ['codex', 'claude_code'] as const) {
        const hookJson = JSON.parse(await readText(hookPath(fixture, agent))) as { unrelated_setting?: unknown };
        assert.deepEqual(hookJson.unrelated_setting, { keep: true }, `${agent}の無関係設定を保持していない`);
        const commands = await collectorCommandsFor(fixture, agent);
        assert.equal(commands.filter((command) => command.includes('notify')).length, 1, `${agent}のnotifyが1件ではない: ${JSON.stringify(commands)}`);
        assert.equal(
          commands.filter((command) => command.includes('collect') && !command.includes('notify')).length,
          1,
          `${agent}のcollectが1件ではない: ${JSON.stringify(commands)}`,
        );
        for (const command of commands) {
          assertUsesStableLauncher(fixture, command, agent);
        }
        assert.ok(JSON.stringify(hookJson).includes('echo unrelated-prompt'), `${agent}の既存hookを消している`);
        assert.ok(JSON.stringify(hookJson).includes('echo unrelated-stop'), `${agent}の既存hookを消している`);
      }

      // stable launcherは現在のversionを実行し、npx/latestへ依存しない。
      const codexCommands = await collectorCommandsFor(fixture, 'codex');
      const collectCommand = codexCommands.find((command) => command.includes('collect') && !command.includes('notify'));
      assert.ok(collectCommand !== undefined, 'Stopのcollect commandがない');
      // hook launcher実行にもYORI_SECURITY_BIN/YORI_GIT_BINを渡し、実バイナリへ触れない。
      const launched = runShellCommand(fixture, collectCommand);
      assert.equal(launched.status, 0, `launcher実行が失敗した: ${launched.stderr}`);
      assert.ok(launched.stdout.includes('collector-fixture-v1'), `launcherが現在versionを実行していない: ${launched.stdout}`);

      // tokenはconfig・hooks・配置物・stdout/stderrへ残さない。
      assert.deepEqual(await filesContaining(fixture.home, DEFAULT_TOKEN), []);
      assert.ok(!run.stdout.includes(DEFAULT_TOKEN));
      assert.ok(!run.stderr.includes(DEFAULT_TOKEN));

      // test/development overrideのartifact pathも標準成果物へ保存しない。
      assert.ok(!run.stdout.includes(fixture.artifactDir), 'install出力へartifact override pathを保存している');
      assert.ok(!run.stderr.includes(fixture.artifactDir));
      assert.deepEqual(
        await filesContaining(fixture.home, fixture.artifactDir),
        [],
        'config・manifest・hooksへartifact override pathを保存している',
      );
    });
  });

  it('agent設定が0件ならagent_not_foundで何も作らない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: [], tokenRegistered: false });
      const run = await runRootCli(fixture, ['collector:install'], { input: `${DEFAULT_TOKEN}\n` });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: agent_not_found\n');
      assert.deepEqual(await listFilesRecursively(fixture.home), []);
      assert.deepEqual(await readApiRequests(fixture), []);
      assert.equal(await keychainToken(fixture), null);
    });
  });

  it('agent設定が1件ならそのfileだけを更新する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: ['claude_code'] });
      const run = await runRootCli(fixture, ['collector:install']);
      parseCollectorSuccess(run);
      const commands = await collectorCommandsFor(fixture, 'claude_code');
      assert.equal(commands.length, 2, `claude_codeのhookが2件ではない: ${JSON.stringify(commands)}`);
      for (const command of commands) {
        assertUsesStableLauncher(fixture, command, 'claude_code');
      }
      assert.equal(existsSync(hookPath(fixture, 'codex')), false, '存在しないcodex設定を作成している');
    });
  });

  it('token登録済みならpromptせず、再installしても冪等にする', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      const first = await runRootCli(fixture, ['collector:install']);
      parseCollectorSuccess(first);
      const configAfterFirst = await readText(collectorConfigPath(fixture));
      const hooksAfterFirst = new Map<CollectorAgent, string>(
        await Promise.all(
          (['codex', 'claude_code'] as const).map(async (agent) => [agent, await readText(hookPath(fixture, agent))] as const),
        ),
      );

      const second = await runRootCli(fixture, ['collector:install']);
      parseCollectorSuccess(second);

      const addCalls = (await readSecurityCalls(fixture)).filter((args) => args[0] === 'add-generic-password');
      assert.equal(addCalls.length, 0, `token登録済みなのにpromptしている: ${JSON.stringify(addCalls)}`);
      assert.equal(await readText(collectorConfigPath(fixture)), configAfterFirst, '再installでconfigが変化した');
      for (const agent of ['codex', 'claude_code'] as const) {
        assert.equal(await readText(hookPath(fixture, agent)), hooksAfterFirst.get(agent), `${agent}のhookが冪等ではない`);
        assert.equal((await collectorCommandsFor(fixture, agent)).length, 2, `${agent}のhookが重複した`);
      }
    });
  });

  it('APIの400/401/404/500を相互に異なる固定codeへmapし、無変更で失敗する', async () => {
    const codes = new Set<string>();
    for (const status of [400, 401, 404, 500]) {
      await withCollectorFixture(async (fixture) => {
        await prepareCollectorInstall(fixture, { agents: ['codex', 'claude_code'] });
        await writeApiSpec(fixture, [{ status, body: { error: 'fixture_error', marker: 'API_BODY_MARKER' } }]);
        const codexBefore = await readText(hookPath(fixture, 'codex'));
        const claudeBefore = await readText(hookPath(fixture, 'claude_code'));
        const run = await runRootCli(fixture, ['collector:install']);
        codes.add(assertCollectorFailure(run, [DEFAULT_TOKEN, 'API_BODY_MARKER', 'fixture_error']));
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(existsSync(collectorConfigPath(fixture)), false, `API失敗でconfigを作成している (status=${status})`);
        assert.equal(existsSync(path.join(fixture.home, '.local')), false, `API失敗で配置を作成している (status=${status})`);
        assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore, `API失敗でhookを変更している (status=${status})`);
        assert.equal(await readText(hookPath(fixture, 'claude_code')), claudeBefore, `API失敗でhookを変更している (status=${status})`);
      });
    }
    assert.equal(codes.size, 4, `400/401/404/500が異なる固定codeになっていない: ${[...codes].join(' / ')}`);
  });

  it('checksum不一致のartifactをinstallで拒否し、無変更で失敗する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: false });
      // manifestは正しい本文のchecksumのまま、bundleだけを差し替えて不一致にする。
      await writeCollectorArtifact(fixture, { version: DEFAULT_COLLECTOR_VERSION, content: DEFAULT_COLLECTOR_BUNDLE });
      await writeFile(path.join(fixture.artifactDir, 'yori-collector.mjs'), 'console.log("tampered");\n', 'utf8');
      const codexBefore = await readText(hookPath(fixture, 'codex'));
      const run = await runRootCli(fixture, ['collector:install'], { input: `${DEFAULT_TOKEN}\n` });
      assertCollectorFailure(run, [DEFAULT_TOKEN]);
      assert.equal(existsSync(collectorConfigPath(fixture)), false, 'checksum不一致でconfigを作成している');
      assert.equal(existsSync(collectorInstallRoot(fixture)), false, 'checksum不一致で配置を作成している');
      assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore);
      assert.deepEqual(await filesContaining(fixture.home, DEFAULT_TOKEN), []);
    });
  });

  it('片側のhookが不正JSONなら両方を変更せず失敗する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      const codexBefore = await readText(hookPath(fixture, 'codex'));
      await writeFile(hookPath(fixture, 'claude_code'), '{ not json', 'utf8');
      const claudeBefore = await readText(hookPath(fixture, 'claude_code'));
      const run = await runRootCli(fixture, ['collector:install']);
      assertCollectorFailure(run, [DEFAULT_TOKEN]);
      assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore, '不正JSONのclaude設定でcodex側を変更している');
      assert.equal(await readText(hookPath(fixture, 'claude_code')), claudeBefore);
      assert.equal(existsSync(collectorConfigPath(fixture)), false);
    });
  });

  it('hook設定がsymlinkなら参照先を変更せず失敗する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      const decoyPath = path.join(fixture.root, 'decoy-settings.json');
      await writeFile(decoyPath, '{"keep":true}\n', 'utf8');
      await rm(hookPath(fixture, 'claude_code'));
      await symlink(decoyPath, hookPath(fixture, 'claude_code'));
      const codexBefore = await readText(hookPath(fixture, 'codex'));
      const run = await runRootCli(fixture, ['collector:install']);
      assertCollectorFailure(run, [DEFAULT_TOKEN]);
      assert.equal(await readText(decoyPath), '{"keep":true}\n', 'symlinkの参照先を変更している');
      assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore, 'symlink検出時にcodex側を変更している');
      assert.equal(existsSync(collectorConfigPath(fixture)), false);
    });
  });

  it('既存hookが競合するcollector entryを含むなら無変更で失敗する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      const conflicting = agentHookFixture() as { hooks: { UserPromptSubmit: unknown[] } };
      conflicting.hooks.UserPromptSubmit.push({
        hooks: [{ type: 'command', command: 'npx yori-cli@latest collector notify --config ~/.yori-collector.json' }],
      });
      await writeHookJson(fixture, 'codex', conflicting);
      const codexBefore = await readText(hookPath(fixture, 'codex'));
      const claudeBefore = await readText(hookPath(fixture, 'claude_code'));
      const run = await runRootCli(fixture, ['collector:install']);
      assertCollectorFailure(run, [DEFAULT_TOKEN]);
      assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore);
      assert.equal(await readText(hookPath(fixture, 'claude_code')), claudeBefore);
      assert.equal(existsSync(collectorConfigPath(fixture)), false);
    });
  });

  it('書き込み不能なHOMEでは無変更で失敗する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      const codexBefore = await readText(hookPath(fixture, 'codex'));
      const claudeBefore = await readText(hookPath(fixture, 'claude_code'));
      await chmod(hookPath(fixture, 'codex'), 0o444);
      await chmod(hookPath(fixture, 'claude_code'), 0o444);
      await chmod(fixture.home, 0o500);
      try {
        const run = await runRootCli(fixture, ['collector:install']);
        assertCollectorFailure(run, [DEFAULT_TOKEN]);
        assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore);
        assert.equal(await readText(hookPath(fixture, 'claude_code')), claudeBefore);
        assert.equal(existsSync(collectorConfigPath(fixture)), false);
      } finally {
        await chmod(fixture.home, 0o700);
        await chmod(hookPath(fixture, 'codex'), 0o644);
        await chmod(hookPath(fixture, 'claude_code'), 0o644);
      }
    });
  });
});
