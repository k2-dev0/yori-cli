import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETUP_RESPONSE,
  parseCollectorSuccess,
  prepareCollectorInstall,
  runRootCli,
  withCollectorFixture,
  writeApiSpec,
} from './collector-support.js';
import { isSupportedCollectorPlatform } from '../../collector/contract.js';
import { REPO_ROOT } from './support.js';

// collector commandはDBを必要としない。既存admin commandのDATABASE_URL契約は回帰として維持する。
const UNREACHABLE_DATABASE_URL = 'postgres://yori:yori@127.0.0.1:1/yori';

describe('collector commandのDB非依存', () => {
  it('installとdoctorはDATABASE_URLなし（installは到達不能URL）で成功する', async () => {
    await withCollectorFixture(async (fixture) => {
      await prepareCollectorInstall(fixture);
      parseCollectorSuccess(
        await runRootCli(fixture, ['collector:install'], { env: { DATABASE_URL: UNREACHABLE_DATABASE_URL } }),
      );
      await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);
      const doctor = await runRootCli(fixture, ['collector:doctor']);
      parseCollectorSuccess(doctor);
      assert.ok(!doctor.stdout.includes('invalid_admin_config'), 'doctorがDATABASE_URL不足で失敗している');
    });
  });

  it('既存admin commandはDATABASE_URL欠落をinvalid_admin_configで拒否し続ける', async () => {
    await withCollectorFixture(async (fixture) => {
      const run = await runRootCli(fixture, ['inspect', '01930000-0000-7000-8000-000000000099'], { cwd: REPO_ROOT });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: invalid_admin_config\n');
    });
  });

  it('collector commandのplatform scopeはdarwinだけに固定する', () => {
    assert.equal(isSupportedCollectorPlatform('darwin'), true);
    for (const platform of ['linux', 'win32', 'freebsd', 'aix']) {
      assert.equal(isSupportedCollectorPlatform(platform), false, `${platform}を対応platformとして扱っている`);
    }
  });

  it('未知commandはinvalid_argumentsのままcollector commandと混同しない', async () => {
    await withCollectorFixture(async (fixture) => {
      const run = await runRootCli(fixture, ['collector:unknown'], { cwd: REPO_ROOT });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: invalid_arguments\n');
    });
  });
});
