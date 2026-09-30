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

const BACKFILL_BUNDLE = `
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ status: args.includes('--dry-run') ? 'dry_run' : 'completed', args, token_present: process.env.YORI_COLLECTOR_TOKEN === '${DEFAULT_TOKEN}' }) + '\\n');
`;

describe('collector:backfill', () => {
  it('起動時cwdをrepository変数としてlauncherへ渡し、source省略・指定とdry-runを扱う', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, BACKFILL_BUNDLE);
      const repositoryPath = await realpath(fixture.gitRoot);

      const allSources = parseCollectorSuccess(await runRootCli(fixture, ['collector:backfill', '--dry-run']));
      assert.equal(allSources.status, 'dry_run');
      assert.equal(allSources.token_present, true);
      assert.deepEqual(allSources.args, [
        'backfill',
        '--repository',
        repositoryPath,
        '--config',
        `${fixture.home}/.yori-collector.json`,
        '--dry-run',
      ]);

      const deepseek = parseCollectorSuccess(
        await runRootCli(fixture, ['collector:backfill', '--source', 'deepseek_harness']),
      );
      assert.equal(deepseek.status, 'completed');
      assert.deepEqual(deepseek.args, [
        'backfill',
        '--repository',
        repositoryPath,
        '--config',
        `${fixture.home}/.yori-collector.json`,
        '--source',
        'deepseek_harness',
      ]);
    });
  });

  it('不正source・repository引数・未installを固定codeで拒否する', async () => {
    await withCollectorFixture(async (fixture) => {
      await installCollectorWithoutSetup(fixture, BACKFILL_BUNDLE);
      for (const args of [
        ['collector:backfill', '--source', 'other'],
        ['collector:backfill', '--source', 'cursor'],
        ['collector:backfill', '--repository', '/tmp/other'],
        ['collector:backfill', '--dry-run', 'extra'],
      ]) {
        const run = await runRootCli(fixture, args);
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, 'admin: collector_invalid_request\n');
      }
    });

    await withCollectorFixture(async (fixture) => {
      const run = await runRootCli(fixture, ['collector:backfill', '--dry-run']);
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: collector_not_installed\n');
    });
  });
});
