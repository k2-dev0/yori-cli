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
import { readSshInvocations, withSshFixture } from './support.js';

// collector commandは端末側で完結し、DATABASE_URLもadmin用SSH transportも要求しない。
// 既存admin commandのDB transport契約は admin-ssh-transport.test.ts が検証する。
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

  it('DATABASE_URL欠落とSSH transport overrideがあってもcollector commandはsshを起動しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await withSshFixture(async (ssh) => {
        await prepareCollectorInstall(fixture);
        const run = await runRootCli(fixture, ['collector:install'], {
          env: { YORI_SSH_BIN: ssh.binPath, YORI_TEST_SSH_DIR: ssh.root },
        });
        parseCollectorSuccess(run);
        assert.deepEqual(await readSshInvocations(ssh), [], 'collector commandがadmin用ssh transportを起動している');
      });
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
      const run = await runRootCli(fixture, ['collector:unknown'], { cwd: fixture.gitRoot });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: invalid_arguments\n');
    });
  });
});
