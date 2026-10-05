import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  DEFAULT_TOKEN,
  installCollectorWithoutSetup,
  parseCollectorSuccess,
  runRootCli,
  withCollectorFixture,
} from './collector-support.js';

const EMPLOYEE_ID = '01a0e6fa-872c-72ac-abb0-2dfb7dc78f06';

// 配布collectorの代わり。受けた引数・cwd・tokenの有無を返し、YORI_TEST_EXPORT_FAILUREがあればその固定codeで失敗する。
const EXPORT_BUNDLE = `
const args = process.argv.slice(2);
const failure = process.env.YORI_TEST_EXPORT_FAILURE;
if (failure) {
  process.stderr.write(failure);
  process.exit(1);
}
process.stdout.write(process.env.YORI_TEST_EXPORT_STDOUT ?? JSON.stringify({ path: process.cwd() + '/yori-export.csv', messages: 2, args, cwd: process.cwd(), token_present: process.env.YORI_COLLECTOR_TOKEN === '${DEFAULT_TOKEN}' }) + '\\n');
`;

describe('collector:export', () => {
  it('起動時cwdのままlauncherへ設定fileと期間・社員を渡し、Keychainのtokenで実行する', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, EXPORT_BUNDLE);
      const cwd = await realpath(fixture.gitRoot);
      const config = `${fixture.home}/.yori-collector.json`;

      const oneDay = parseCollectorSuccess(await runRootCli(fixture, ['collector:export', '--from', '2026-10-05']));
      assert.deepEqual(oneDay.args, ['export', '--config', config, '--from', '2026-10-05']);
      assert.equal(oneDay.cwd, cwd, 'CSVを置くcwdが起動時のdirectoryと違う');
      assert.equal(oneDay.token_present, true);
      assert.equal(oneDay.messages, 2);

      const ranged = parseCollectorSuccess(
        await runRootCli(fixture, ['collector:export', '--employee', EMPLOYEE_ID, '--from', '2026-10-01', '--to', '2026-10-05']),
      );
      assert.deepEqual(ranged.args, ['export', '--config', config, '--employee', EMPLOYEE_ID, '--from', '2026-10-01', '--to', '2026-10-05']);
    });
  });

  it('開始日なし・未知の引数・重複・値なし・未installを固定codeで拒否する', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, EXPORT_BUNDLE);
      for (const args of [
        ['collector:export'],
        ['collector:export', '--to', '2026-10-05'],
        ['collector:export', '--from'],
        ['collector:export', '--from', '--to'],
        ['collector:export', '--from', '2026-10-05', '--from', '2026-10-06'],
        ['collector:export', '--from', '2026-10-05', '--config', '/tmp/other.json'],
        ['collector:export', '--from', '2026-10-05', '--token', 'secret'],
        ['collector:export', '--from', '2026-10-05', 'extra'],
      ]) {
        const run = await runRootCli(fixture, args);
        assert.equal(run.code, 1, args.join(' '));
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, 'admin: collector_invalid_request\n', args.join(' '));
      }
    });

    await withCollectorFixture(async (fixture) => {
      const run = await runRootCli(fixture, ['collector:export', '--from', '2026-10-05']);
      assert.equal(run.code, 1);
      assert.equal(run.stderr, 'admin: collector_not_installed\n');
    });
  });

  it('配布collectorの失敗を、利用者が区別できる固定codeへ振り分ける', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, EXPORT_BUNDLE);
      const cases: Array<[string, string]> = [
        ['collector: invalid_arguments\n', 'collector_invalid_request'],
        ['collector: unauthorized\n', 'collector_unauthorized'],
        ['collector: forbidden\n', 'forbidden'],
        ['collector: employee_not_found\n', 'employee_not_found'],
        ['collector: output_exists\n', 'collector_export_output_exists'],
        ['collector: export_unavailable\n', 'collector_export_error'],
        ['collector: constructor\n', 'collector_export_error'],
        ['raw error with /Users/someone/path\n', 'collector_export_error'],
      ];
      for (const [failure, code] of cases) {
        const run = await runRootCli(fixture, ['collector:export', '--from', '2026-10-05'], { env: { YORI_TEST_EXPORT_FAILURE: failure } });
        assert.equal(run.code, 1, failure);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, `admin: ${code}\n`, failure);
      }
    });
  });

  it('配布collectorの出力がJSONのobjectでなければcollector_export_errorにする', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, EXPORT_BUNDLE);
      for (const stdout of ['not json\n', '[]\n', 'null\n', '']) {
        const run = await runRootCli(fixture, ['collector:export', '--from', '2026-10-05'], { env: { YORI_TEST_EXPORT_STDOUT: stdout } });
        assert.equal(run.code, 1, JSON.stringify(stdout));
        assert.equal(run.stderr, 'admin: collector_export_error\n', JSON.stringify(stdout));
      }
    });
  });
});
