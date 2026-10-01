import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_API_URL,
  DEFAULT_COLLECTOR_BUNDLE,
  DEFAULT_COLLECTOR_GIT_SHA,
  DEFAULT_COLLECTOR_VERSION,
  DEFAULT_SETUP_RESPONSE,
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
  hookCommandFor,
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
import { REPO_ROOT } from './support.js';

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
      assert.equal(requests.length, 2, `互換性probe＋setup APIの呼出し回数が違う: ${JSON.stringify(requests)}`);
      assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/collector/setup`);
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].authorization, null, '互換性probeへtokenを送っている');
      assert.deepEqual(JSON.parse(String(requests[0].body)), { repository: 'github.com/yori/collector-compatibility-probe' });
      assert.equal(requests[1].url, `${DEFAULT_API_URL}/v1/collector/setup`);
      assert.equal(requests[1].method, 'POST');
      assert.equal(requests[1].authorization, `Bearer ${DEFAULT_TOKEN}`);
      assert.deepEqual(JSON.parse(String(requests[1].body)), { repository: 'github.com/example/repo' });

      // version directoryへbundleとchecksum付きmanifestを置く。
      const versionDir = collectorVersionDir(fixture, DEFAULT_COLLECTOR_VERSION);
      const installedFiles = await listFilesRecursively(versionDir);
      assert.ok(installedFiles.includes('yori-collector.mjs'), `version配置がない: ${JSON.stringify(installedFiles)}`);
      assert.equal(await readText(path.join(versionDir, 'yori-collector.mjs')), DEFAULT_COLLECTOR_BUNDLE);
      const manifest = JSON.parse(await readText(path.join(versionDir, 'collector-manifest.json'))) as Record<string, unknown>;
      assert.equal(manifest.checksum, sha256Hex(DEFAULT_COLLECTOR_BUNDLE));
      assert.equal(manifest.git_sha, DEFAULT_COLLECTOR_GIT_SHA);

      // 2 agentのhooksを更新し、無関係設定と既存hookを保持する。
      for (const agent of ['codex', 'claude_code'] as const) {
        const hookJson = JSON.parse(await readText(hookPath(fixture, agent))) as { unrelated_setting?: unknown };
        assert.deepEqual(hookJson.unrelated_setting, { keep: true }, `${agent}の無関係設定を保持していない`);
        const commands = await collectorCommandsFor(fixture, agent);
        assert.equal(
          commands.filter((command) => command.includes(' notify ') && !command.includes('notify-late')).length,
          1,
          `${agent}の同期notifyが1件ではない: ${JSON.stringify(commands)}`,
        );
        assert.equal(
          commands.filter((command) => command.includes('notify-late')).length,
          1,
          `${agent}のnotify-lateが1件ではない: ${JSON.stringify(commands)}`,
        );
        assert.equal(
          commands.filter((command) => command.includes('collect') && !command.includes('notify')).length,
          1,
          `${agent}のcollectが1件ではない: ${JSON.stringify(commands)}`,
        );
        for (const command of commands) {
          assertUsesStableLauncher(fixture, command, agent);
          assert.ok(command.includes(process.execPath), `${agent}のhook commandがprocess.execPathを使っていない: ${command}`);
        }
        assert.ok(JSON.stringify(hookJson).includes('echo unrelated-prompt'), `${agent}の既存hookを消している`);
        assert.ok(JSON.stringify(hookJson).includes('echo unrelated-stop'), `${agent}の既存hookを消している`);

        // 3秒fast pathのnotifyは同期、late通知だけをasyncにし、collectも同期のまま維持する。
        const hookSections = (hookJson as { hooks?: Record<string, { hooks?: { command?: unknown; async?: unknown }[] }[]> }).hooks ?? {};
        const flattenHooks = (section: string) => (hookSections[section] ?? []).flatMap((entry) => entry.hooks ?? []);
        const notifyEntry = flattenHooks('UserPromptSubmit').find(
          (hook) => typeof hook.command === 'string' && hook.command.includes(' notify ') && !hook.command.includes('notify-late'),
        );
        const notifyLateEntry = flattenHooks('UserPromptSubmit').find(
          (hook) => typeof hook.command === 'string' && hook.command.includes('notify-late'),
        );
        const collectEntry = flattenHooks('Stop').find(
          (hook) => typeof hook.command === 'string' && hook.command.includes('collect') && !hook.command.includes('notify'),
        );
        assert.ok(notifyEntry !== undefined && !('async' in notifyEntry), `${agent}のnotify entryにasyncが付いている`);
        assert.equal(notifyLateEntry?.async, true, `${agent}のnotify-late entryがasync:trueではない`);
        assert.ok(collectEntry !== undefined && !('async' in collectEntry), `${agent}のcollect entryにasyncが付いている`);
      }

      // stable launcherは現在のversionを実行し、npx/latestへ依存しない。
      const codexCommands = await collectorCommandsFor(fixture, 'codex');
      const collectCommand = codexCommands.find((command) => command.includes('collect') && !command.includes('notify'));
      assert.ok(collectCommand !== undefined, 'Stopのcollect commandがない');
      // hook launcher実行にもYORI_SECURITY_BIN/YORI_GIT_BINを渡し、実バイナリへ触れない。
      const launched = runShellCommand(fixture, collectCommand);
      assert.equal(launched.status, 0, `launcher実行が失敗した: ${launched.stderr}`);
      assert.ok(launched.stdout.includes('collector-fixture-v1'), `launcherが現在versionを実行していない: ${launched.stdout}`);
      // launcherはconfig.api_urlのKeychain tokenを内部captureし、子collector envへだけ渡す。
      assert.ok(!launched.stdout.includes(DEFAULT_TOKEN), 'launcher stdoutへtokenが出ている');
      assert.ok(!launched.stderr.includes(DEFAULT_TOKEN), 'launcher stderrへtokenが出ている');
      const launcherFindCalls = (await readSecurityCalls(fixture)).filter((args) => args[0] === 'find-generic-password');
      assert.ok(launcherFindCalls.length >= 2, `launcherがsecurity findを呼んでいない: ${JSON.stringify(launcherFindCalls)}`);
      for (const args of launcherFindCalls) {
        assert.equal(args[args.indexOf('-s') + 1], KEYCHAIN_SERVICE);
        assert.equal(args[args.indexOf('-a') + 1], DEFAULT_API_URL);
        assert.equal(args.at(-1), '-w');
        assert.ok(!args.includes(DEFAULT_TOKEN), `launcher argvへtokenが出ている: ${JSON.stringify(args)}`);
      }
      // install.jsonはversion情報だけを持ち、token・rules・override pathを含まない。
      const installStateText = await readText(path.join(collectorInstallRoot(fixture), 'install.json'));
      const installState = JSON.parse(installStateText) as Record<string, unknown>;
      const packageJson = JSON.parse(await readText(path.join(REPO_ROOT, 'package.json'))) as { version: string };
      assert.deepEqual(
        Object.keys(installState).sort(),
        ['checksum', 'collector_version', 'git_sha', 'installer_version', 'mcp_checksum', 'policy_version'],
        `install.jsonのfieldが違う: ${installStateText}`,
      );
      assert.equal(installState.installer_version, packageJson.version);
      assert.equal(installState.collector_version, DEFAULT_COLLECTOR_VERSION);
      assert.equal(installState.git_sha, DEFAULT_COLLECTOR_GIT_SHA);
      assert.equal(installState.checksum, sha256Hex(DEFAULT_COLLECTOR_BUNDLE));
      assert.equal(installState.policy_version, 3);
      assert.ok(!installStateText.includes(DEFAULT_TOKEN), 'install.jsonへtokenが出ている');
      assert.ok(!installStateText.includes(fixture.artifactDir), 'install.jsonへoverride pathが出ている');

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
      assert.equal(commands.length, 3, `claude_codeのhookが3件ではない: ${JSON.stringify(commands)}`);
      for (const command of commands) {
        assertUsesStableLauncher(fixture, command, 'claude_code');
      }
      assert.equal(existsSync(hookPath(fixture, 'codex')), false, '存在しないcodex設定を作成している');
    });
  });

  it('~/.codexが存在すればhooks.json未作成でもCodexを検出して安全なJSONから作成する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: ['claude_code'] });
      await mkdir(path.join(fixture.home, '.codex'), { recursive: true });
      const run = await runRootCli(fixture, ['collector:install']);
      const output = parseCollectorSuccess(run);
      assert.deepEqual(output.agents, ['codex', 'claude_code']);
      const hookJson = JSON.parse(await readText(hookPath(fixture, 'codex'))) as Record<string, unknown>;
      assert.deepEqual(Object.keys(hookJson), ['hooks']);
      assert.equal((await collectorCommandsFor(fixture, 'codex')).length, 3);
    });
  });

  it('0バイトのCodex hooks.jsonを空objectとして修復する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: ['claude_code'] });
      await mkdir(path.dirname(hookPath(fixture, 'codex')), { recursive: true });
      await writeFile(hookPath(fixture, 'codex'), '', 'utf8');
      parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      assert.equal((await collectorCommandsFor(fixture, 'codex')).length, 3);
    });
  });

  it('~/.claudeが存在すればsettings.json未作成でもClaude Codeを検出して安全なJSONから作成する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: [] });
      await mkdir(path.join(fixture.home, '.claude'), { recursive: true });
      const run = await runRootCli(fixture, ['collector:install']);
      const output = parseCollectorSuccess(run);
      assert.deepEqual(output.agents, ['claude_code']);
      const settings = JSON.parse(await readText(hookPath(fixture, 'claude_code'))) as Record<string, unknown>;
      assert.ok('hooks' in settings, '新規settings.jsonへhooksを書いていない');
      assert.equal((await collectorCommandsFor(fixture, 'claude_code')).length, 3);
      assert.equal(existsSync(hookPath(fixture, 'codex')), false, '存在しないcodex設定を作成している');
    });
  });

  it('~/.claudeがsymlinkならClaude Codeを検出しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: [] });
      const target = path.join(fixture.root, 'claude-target');
      await mkdir(target, { recursive: true });
      await symlink(target, path.join(fixture.home, '.claude'));
      const run = await runRootCli(fixture, ['collector:install']);
      assert.equal(run.stderr, 'admin: agent_not_found\n');
      assert.deepEqual(await listFilesRecursively(target), []);
    });
  });

  it('新規作成予定のClaude Code settings.jsonはAPI失敗時に作成しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: ['codex'] });
      await mkdir(path.join(fixture.home, '.claude'), { recursive: true });
      await writeApiSpec(fixture, [{ status: 401, body: { error: { code: 'unauthorized' } } }]);
      const run = await runRootCli(fixture, ['collector:install']);
      assert.equal(run.stderr, 'admin: collector_unauthorized\n');
      assert.equal(existsSync(hookPath(fixture, 'claude_code')), false, 'API失敗でClaude Code settings.jsonを残している');
    });
  });

  it('新規作成予定のCodex hooks.jsonはAPI失敗時に作成しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: ['claude_code'] });
      await mkdir(path.join(fixture.home, '.codex'), { recursive: true });
      await writeApiSpec(fixture, [{ status: 401, body: { error: { code: 'unauthorized' } } }]);
      const run = await runRootCli(fixture, ['collector:install']);
      assert.equal(run.stderr, 'admin: collector_unauthorized\n');
      assert.equal(existsSync(hookPath(fixture, 'codex')), false, 'API失敗でCodex hooks.jsonを残している');
    });
  });

  it('後続hook書込み失敗時は新規Codex hooks.jsonを不存在へrollbackする', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { agents: ['claude_code'], tokenRegistered: false });
      await mkdir(path.join(fixture.home, '.codex'), { recursive: true });
      const claudeDirectory = path.dirname(hookPath(fixture, 'claude_code'));
      await chmod(claudeDirectory, 0o500);
      try {
        const run = await runRootCli(fixture, ['collector:install'], { input: `${DEFAULT_TOKEN}\n` });
        assert.equal(run.code, 1);
        assert.equal(run.stderr, 'admin: collector_hook_error\n');
        assert.equal(existsSync(hookPath(fixture, 'codex')), false, '失敗後に新規Codex hooks.jsonを残している');
        assert.equal(await keychainToken(fixture), null, '失敗後に新規Keychain itemを残している');
      } finally {
        await chmod(claudeDirectory, 0o700);
      }
    });
  });

  it('token登録済みならpromptせず、再installしても冪等にする', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE, DEFAULT_SETUP_RESPONSE]);
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
      assert.equal((await readApiRequests(fixture)).length, 4, '同version再installで互換性probeまたはsetup APIを省略している');
      assert.equal(await readText(collectorConfigPath(fixture)), configAfterFirst, '再installでconfigが変化した');
      for (const agent of ['codex', 'claude_code'] as const) {
        assert.equal(await readText(hookPath(fixture, agent)), hooksAfterFirst.get(agent), `${agent}のhookが冪等ではない`);
        assert.equal((await collectorCommandsFor(fixture, agent)).length, 3, `${agent}のhookが重複した`);
      }
    });
  });

  it('APIの400/401/404/500を相互に異なる固定codeへmapし、無変更で失敗する', async () => {
    const codes = new Set<string>();
    for (const status of [400, 401, 404, 500]) {
      await withCollectorFixture(async (fixture) => {
        await prepareCollectorInstall(fixture, { agents: ['codex', 'claude_code'] });
        const errorCode = status === 400 ? 'invalid_request' : status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'internal_error';
        await writeApiSpec(fixture, [{ status, body: { error: { code: errorCode } } }]);
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
        // 既存Keychain itemは失敗時も削除しない。
        assert.equal(
          (await readSecurityCalls(fixture)).filter((args) => args[0] === 'delete-generic-password').length,
          0,
          `既存Keychain itemを削除している (status=${status})`,
        );
        assert.equal(await keychainToken(fixture), DEFAULT_TOKEN);
      });
    }
    assert.equal(codes.size, 4, `400/401/404/500が異なる固定codeになっていない: ${[...codes].join(' / ')}`);
  });

  it('互換性probeまたはsetupのFastify route-not-foundをcollector_server_incompatibleへ変換する', async () => {
    const fastify404 = {
      status: 404,
      body: { message: 'Route POST:/v1/collector/setup not found', error: 'Not Found', statusCode: 404 },
    };
    for (const phase of ['probe', 'setup'] as const) {
      await withCollectorFixture(async (fixture) => {
        await prepareCollectorInstall(fixture, { tokenRegistered: true });
        await writeApiSpec(
          fixture,
          phase === 'probe' ? [fastify404] : [{ status: 401, body: { error: { code: 'unauthorized' } } }, fastify404],
          { includeCompatibilityProbe: false },
        );
        const run = await runRootCli(fixture, ['collector:install']);
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, 'admin: collector_server_incompatible\n');
        assert.ok(!run.stderr.includes('Route POST'), 'Fastify本文を出力している');
      });
    }
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

  it('Keychain itemが消えていれば再installでpromptしrepairする', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      await rm(fixture.keychainPath, { force: true });
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      const run = await runRootCli(fixture, ['collector:install'], { input: `${DEFAULT_TOKEN}\n` });
      parseCollectorSuccess(run);
      const addCalls = (await readSecurityCalls(fixture)).filter((args) => args[0] === 'add-generic-password');
      assert.equal(addCalls.length, 1, `Keychain消失時にpromptしていない: ${JSON.stringify(addCalls)}`);
      assert.equal(await keychainToken(fixture), DEFAULT_TOKEN);
    });
  });

  it('異versionの再installは検証後切替し、旧versionを維持する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      const hookBefore = await Promise.all((['codex', 'claude_code'] as const).map((agent) => readText(hookPath(fixture, agent))));
      const v2Version = '9.9.9-test2';
      await writeCollectorArtifact(fixture, {
        version: v2Version,
        content: "if (!process.env.YORI_COLLECTOR_TOKEN) { process.exit(3); }\nconsole.log(\"collector-fixture-v2\");\n",
      });
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      const output = parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      assert.equal(output.version, v2Version, '異versionの再installが切替えていない');
      assert.ok(existsSync(path.join(collectorVersionDir(fixture, DEFAULT_COLLECTOR_VERSION), 'yori-collector.mjs')), '旧versionを削除している');
      const launched = runShellCommand(fixture, await hookCommandFor(fixture, 'codex', 'collect'));
      assert.equal(launched.status, 0, `launcher実行が失敗した: ${launched.stderr}`);
      assert.ok(launched.stdout.includes('collector-fixture-v2'), `launcherが新versionを実行していない: ${launched.stdout}`);
      for (const [index, agent] of (['codex', 'claude_code'] as const).entries()) {
        assert.equal(await readText(hookPath(fixture, agent)), hookBefore[index], 'installでhookを書き換えている');
      }
    });
  });

  it('api_urlはhttpsまたはloopback httpだけを許可し、失敗時に値を出さない', async () => {
    const invalidUrls = [
      'https://user:URL_SECRET_MARKER@yori-pilot.online',
      'https://yori-pilot.online/?query=1',
      'https://yori-pilot.online/#fragment',
      'http://evil.example',
      'file:///tmp/collector',
    ];
    for (const apiUrl of invalidUrls) {
      await withCollectorFixture(async (fixture) => {
        await prepareCollectorInstall(fixture, { tokenRegistered: true });
        const configText = `${JSON.stringify({ api_url: apiUrl, token_env: 'YORI_COLLECTOR_TOKEN', state_dir: path.join(fixture.home, '.yori-collector') }, null, 2)}\n`;
        await writeFile(collectorConfigPath(fixture), configText, 'utf8');
        assert.equal(
          assertCollectorFailure(await runRootCli(fixture, ['collector:install']), [DEFAULT_TOKEN, 'URL_SECRET_MARKER', 'evil.example']),
          'admin: collector_config_invalid\n',
        );
        assert.equal(await readText(collectorConfigPath(fixture)), configText, 'invalid api_urlのconfigを書き換えている');
        assert.deepEqual(await readApiRequests(fixture), []);
        assert.equal(existsSync(collectorInstallRoot(fixture)), false);
        assert.equal((await readSecurityCalls(fixture)).filter((args) => args[0] === 'add-generic-password').length, 0);
      });
    }
  });

  it('API transport errorをcollector_internal_errorへ縮退し、本文やtokenを出さない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      await writeApiSpec(fixture, [{ status: 0, networkError: true }]);
      const run = await runRootCli(fixture, ['collector:install']);
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: collector_internal_error\n');
      assert.equal(existsSync(collectorConfigPath(fixture)), false);
      assert.equal(existsSync(collectorInstallRoot(fixture)), false);
    });
  });

  it('2つ目のhook writeが失敗したら全成果物をrollbackする', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      const codexBefore = await readText(hookPath(fixture, 'codex'));
      const claudeBefore = await readText(hookPath(fixture, 'claude_code'));
      const codexModeBefore = (await stat(hookPath(fixture, 'codex'))).mode & 0o777;
      const claudeDir = path.dirname(hookPath(fixture, 'claude_code'));
      await chmod(claudeDir, 0o500);
      try {
        const run = await runRootCli(fixture, ['collector:install']);
        assertCollectorFailure(run, [DEFAULT_TOKEN]);
        assert.equal(run.stderr, 'admin: collector_hook_error\n');
        assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore, 'rollbackでcodex hookを戻していない');
        assert.equal((await stat(hookPath(fixture, 'codex'))).mode & 0o777, codexModeBefore, 'rollbackでhook modeが変わっている');
        assert.equal(await readText(hookPath(fixture, 'claude_code')), claudeBefore, 'rollbackでclaude hookを変更している');
        assert.equal(existsSync(collectorConfigPath(fixture)), false, 'rollbackでconfigを残している');
        assert.equal(existsSync(collectorInstallRoot(fixture)), false, 'rollbackでinstall rootを残している');
        assert.deepEqual(await filesContaining(fixture.home, DEFAULT_TOKEN), []);
      } finally {
        await chmod(claudeDir, 0o700);
      }
    });
  });

  it('spaceとquoteを含むHOMEでもhook commandを実行・冪等に扱う', async () => {
    await withCollectorFixture(async (fixture) => {
      fixture.home = path.join(fixture.root, "home with space and 'quote'");
      await mkdir(fixture.home, { recursive: true });
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      const hookAfterFirst = await readText(hookPath(fixture, 'codex'));
      assert.ok(hookAfterFirst.includes('--source codex'));
      const launched = runShellCommand(fixture, await hookCommandFor(fixture, 'codex', 'collect'));
      assert.equal(launched.status, 0, `space/quote HOMEでlauncher実行が失敗した: ${launched.stderr}`);
      assert.ok(launched.stdout.includes('collector-fixture-v1'), `markerが出ていない: ${launched.stdout}`);
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      assert.equal(await readText(hookPath(fixture, 'codex')), hookAfterFirst, 'space/quote HOMEでhookが冪等ではない');
    });
  });

  it('hook commandはPATHのnodeではなくprocess.execPathの絶対pathでartifactを起動する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: true });
      parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      const fakeDir = path.join(fixture.root, 'fake-node');
      await mkdir(fakeDir, { recursive: true });
      const fakeNode = path.join(fakeDir, 'node');
      await writeFile(fakeNode, '#!/bin/sh\necho FAKE_NODE_INVOKED\nexit 42\n', 'utf8');
      await chmod(fakeNode, 0o755);
      const launched = runShellCommand(fixture, await hookCommandFor(fixture, 'codex', 'collect'), {
        PATH: `${fakeDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      });
      assert.equal(launched.status, 0, `PATHの偽nodeを起動した: ${launched.stderr}`);
      assert.ok(!launched.stdout.includes('FAKE_NODE_INVOKED'), 'PATHのnodeを起動している');
      assert.ok(launched.stdout.includes('collector-fixture-v1'), `実artifactが起動していない: ${launched.stdout}`);
    });
  });

  it('tokenを新規作成したAPI 404失敗ではKeychain itemをrollbackする', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: false });
      await writeApiSpec(fixture, [{ status: 404, body: { error: { code: 'not_found' } } }]);
      const run = await runRootCli(fixture, ['collector:install'], { input: `${DEFAULT_TOKEN}\n` });
      assert.equal(run.code, 1);
      assert.equal(run.stderr, 'admin: project_not_found\n');
      assert.equal(await keychainToken(fixture), null, '新規作成したKeychain itemを残している');
      const deleteCalls = (await readSecurityCalls(fixture)).filter((args) => args[0] === 'delete-generic-password');
      assert.equal(deleteCalls.length, 1, `delete-generic-passwordを呼んでいない: ${JSON.stringify(deleteCalls)}`);
      for (const args of deleteCalls) {
        assert.equal(args[args.indexOf('-s') + 1], KEYCHAIN_SERVICE);
        assert.equal(args[args.indexOf('-a') + 1], DEFAULT_API_URL);
        assert.ok(!args.includes(DEFAULT_TOKEN), `delete argvへtokenが出ている: ${JSON.stringify(args)}`);
      }
    });
  });

  it('tokenを新規作成したhook write失敗でもKeychain itemをrollbackする', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, { tokenRegistered: false });
      const codexBefore = await readText(hookPath(fixture, 'codex'));
      const claudeDir = path.dirname(hookPath(fixture, 'claude_code'));
      await chmod(claudeDir, 0o500);
      try {
        const run = await runRootCli(fixture, ['collector:install'], { input: `${DEFAULT_TOKEN}\n` });
        assertCollectorFailure(run, [DEFAULT_TOKEN]);
        assert.equal(run.stderr, 'admin: collector_hook_error\n');
        assert.equal(await keychainToken(fixture), null, 'hook失敗時に新規Keychain itemを残している');
        assert.equal(
          (await readSecurityCalls(fixture)).filter((args) => args[0] === 'delete-generic-password').length,
          1,
          'hook失敗時にdelete-generic-passwordを呼んでいない',
        );
        assert.equal(await readText(hookPath(fixture, 'codex')), codexBefore);
        assert.equal(existsSync(collectorConfigPath(fixture)), false);
        assert.equal(existsSync(collectorInstallRoot(fixture)), false);
      } finally {
        await chmod(claudeDir, 0o700);
      }
    });
  });

  it('setup応答のfield/term/suspicion_mode/detector_versionを0010契約で検証し、policy値を失敗出力へ出さない', async () => {
    const base = { version: 1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' };
    interface InvalidSetup {
      policy: Record<string, unknown>;
      repository?: string;
      project_id?: string;
    }
    const invalidSetups: InvalidSetup[] = [
      { policy: { ...base, fields: ['1bad'] } },
      { policy: { ...base, fields: ['has space'] } },
      { policy: { ...base, fields: ['redacted'] } },
      { policy: { ...base, fields: ['REDACTED'] } },
      { policy: { ...base, fields: [''] } },
      { policy: { ...base, fields: [1] } },
      { policy: { ...base, fields: ['x'.repeat(129)] } },
      { policy: { ...base, fields: ['dup-field-marker', 'DUP-FIELD-MARKER'] } },
      { policy: { ...base, terms: [''] } },
      { policy: { ...base, terms: ['REDACTED'] } },
      { policy: { ...base, terms: ['[REDACTED:jwt]'] } },
      { policy: { ...base, terms: ['business_value'] } },
      { policy: { ...base, terms: ['known_secret'] } },
      { policy: { ...base, terms: ['x'.repeat(513)] } },
      { policy: { ...base, terms: ['dup-term-marker', 'dup-term-marker'] } },
      {
        policy: {
          ...base,
          fields: Array.from({ length: 50 }, (_, index) => `field_${index}`),
          terms: Array.from({ length: 51 }, (_, index) => `term-${index}`),
        },
      },
      { policy: { ...base, suspicion_mode: 'warn' } },
      { policy: { ...base, detector_version: 'initial-v2' } },
      { policy: { ...base, extra: true } },
      { policy: { ...base, rules: [{ type: 'literal', value: 'old-literal' }] } },
      { policy: { ...base, fields: 'not-array' } },
      { policy: { version: 1, terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' } },
      { policy: { version: 1, fields: [], terms: [] } },
      { policy: { version: 1 } },
      { policy: base, repository: 'github.com/example/other' },
      { policy: base, project_id: 'not-a-uuid' },
    ];
    for (const invalid of invalidSetups) {
      await withCollectorFixture(async (fixture) => {
        await prepareCollectorInstall(fixture, { tokenRegistered: true });
        await writeApiSpec(fixture, [{
          status: 200,
          body: {
            project_id: invalid.project_id ?? '01930000-0000-7000-8000-000000000001',
            repository: invalid.repository ?? 'github.com/example/repo',
            redaction_policy: invalid.policy,
          },
        }]);
        const run = await runRootCli(fixture, ['collector:install']);
        assertCollectorFailure(run, [
          DEFAULT_TOKEN,
          'dup-field-marker',
          'dup-term-marker',
          '[REDACTED:jwt]',
          'business_value',
          'old-literal',
        ]);
        assert.equal(run.stderr, 'admin: collector_internal_error\n', `policy契約違反がcollector_internal_errorではない: ${run.stderr}`);
        assert.equal(existsSync(collectorConfigPath(fixture)), false);
        assert.equal(existsSync(collectorInstallRoot(fixture)), false);
      });
    }
  });

  it('setup応答のfield/term/suspicion_modeを受理してinstallし、policy値をinstall stateへ保存しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture, {
        tokenRegistered: true,
        setupResponse: {
          status: 200,
          body: {
            project_id: '01930000-0000-7000-8000-000000000001',
            repository: 'github.com/example/repo',
            redaction_policy: {
              version: 5,
              fields: ['Pass_Key', 'pass.key'],
              terms: ['Case', 'case'],
              suspicion_mode: 'block',
              detector_version: 'initial-v1',
            },
          },
        },
      });
      const output = parseCollectorSuccess(await runRootCli(fixture, ['collector:install']));
      assert.equal(output.status, 'installed');
      assert.equal(existsSync(collectorConfigPath(fixture)), true);
      const installState = JSON.parse(await readText(path.join(collectorInstallRoot(fixture), 'install.json'))) as Record<string, unknown>;
      assert.equal(installState.policy_version, 5);
      assert.ok(!JSON.stringify(installState).includes('Pass_Key'), 'install.jsonへpolicy ruleを保存している');
      assert.ok(!JSON.stringify(installState).includes('pass.key'), 'install.jsonへpolicy ruleを保存している');
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
