import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_TOKEN,
  installCollectorWithoutSetup,
  parseCollectorSuccess,
  runRootCli,
  withCollectorFixture,
} from './collector-support.js';

const EXPIRES_AT = '2026-11-13T00:00:00.000Z';

// 配布collectorの代わり。受けた引数をYORI_TEST_RENEW_ARGS_FILEへ書き、YORI_TEST_RENEW_FAILUREがあればそれをstderrへ出して失敗する。
// 成功時の出力にはtokenを混ぜ、yori-cliがstatusとexpires_atだけを返すことを確かめる。
const RENEW_BUNDLE = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.YORI_TEST_RENEW_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const failure = process.env.YORI_TEST_RENEW_FAILURE;
if (failure) {
  process.stderr.write(failure);
  process.exit(1);
}
process.stdout.write(process.env.YORI_TEST_RENEW_STDOUT ?? JSON.stringify({ status: 'renewed', expires_at: '${EXPIRES_AT}', token: process.env.YORI_COLLECTOR_TOKEN }) + '\\n');
`;

describe('collector:renew', () => {
  it('launcherへrenewと設定fileを渡し、statusと期限だけを返してtokenを出さない', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, RENEW_BUNDLE);
      const argsFile = path.join(fixture.root, 'renew-args.json');
      const run = await runRootCli(fixture, ['collector:renew'], { env: { YORI_TEST_RENEW_ARGS_FILE: argsFile } });
      assert.deepEqual(parseCollectorSuccess(run), { status: 'renewed', expires_at: EXPIRES_AT });
      assert.ok(!run.stdout.includes(DEFAULT_TOKEN) && !run.stderr.includes(DEFAULT_TOKEN), 'tokenを出力している');
      assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), ['renew', '--config', `${fixture.home}/.yori-collector.json`]);
    });
  });

  it('引数つき・未installを固定codeで拒否する', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, RENEW_BUNDLE);
      for (const args of [['collector:renew', '--force'], ['collector:renew', '--config', '/tmp/other.json']]) {
        const run = await runRootCli(fixture, args, { env: { YORI_TEST_RENEW_ARGS_FILE: path.join(fixture.root, 'renew-args.json') } });
        assert.equal(run.code, 1, args.join(' '));
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, 'admin: collector_invalid_request\n', args.join(' '));
      }
    });

    await withCollectorFixture(async (fixture) => {
      const run = await runRootCli(fixture, ['collector:renew']);
      assert.equal(run.code, 1);
      assert.equal(run.stderr, 'admin: collector_not_installed\n');
    });
  });

  it('配布collectorの失敗を、利用者が区別できる固定codeへ振り分ける', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, RENEW_BUNDLE);
      const cases: Array<[string, string]> = [
        ['collector: renew_rejected\n管理者に新しい token の発行を依頼してください。\n', 'collector_renew_rejected'],
        ['collector: renew_unavailable\n', 'collector_renew_unavailable'],
        ['collector: renew_in_progress\n', 'collector_renew_in_progress'],
        ['collector: missing_token\n', 'collector_missing_token'],
        ['collector: credential_unavailable\n', 'collector_credential_unavailable'],
        ['collector: launcher_error\n', 'collector_renew_error'],
        ['collector: constructor\n', 'collector_renew_error'],
        ['raw error with /Users/someone/path\n', 'collector_renew_error'],
      ];
      for (const [failure, code] of cases) {
        const env = { YORI_TEST_RENEW_ARGS_FILE: path.join(fixture.root, 'renew-args.json'), YORI_TEST_RENEW_FAILURE: failure };
        const run = await runRootCli(fixture, ['collector:renew'], { env });
        assert.equal(run.code, 1, failure);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, `admin: ${code}\n`, failure);
      }
    });
  });

  it('配布collectorの出力が再発行済みのJSONでなければcollector_renew_errorにする', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, RENEW_BUNDLE);
      for (const stdout of ['not json\n', '[]\n', 'null\n', '', '{"status":"failed","expires_at":"2026-11-13T00:00:00.000Z"}\n', '{"status":"renewed"}\n']) {
        const env = { YORI_TEST_RENEW_ARGS_FILE: path.join(fixture.root, 'renew-args.json'), YORI_TEST_RENEW_STDOUT: stdout };
        const run = await runRootCli(fixture, ['collector:renew'], { env });
        assert.equal(run.code, 1, JSON.stringify(stdout));
        assert.equal(run.stderr, 'admin: collector_renew_error\n', JSON.stringify(stdout));
      }
    });
  });
});
