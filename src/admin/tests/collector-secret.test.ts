import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertCollectorFailure,
  collectorSecretsIndexPath,
  listFilesRecursively,
  parseCollectorSuccess,
  readKeychainSecret,
  readKeychainSecretLabels,
  readSecurityCalls,
  readSecretIndexLabels,
  runRootCli,
  withCollectorFixture,
  writeKeychainSecret,
  writeSecretIndexLabels,
  type CollectorFixture,
} from './collector-support.js';

// collector:secret:* はmacOS Keychainのlabel別itemとしてknown secretを管理する。
// index ~/.yori-collector/secrets.json はlabels-only・厳密な昇順で0600、値はKeychainだけへ置き、
// argv・index・log・stdout/stderrへ出さない。
const SECRET_SERVICE = 'online.yori.collector.secret';
const LABEL_ALPHA = 'label-alpha';
const LABEL_BETA = 'label-beta';
const VALUE_ALPHA = 'synthetic-secret-alpha-0f8a2b1c';
const VALUE_BETA = 'synthetic-secret-beta-5c3d9e2f';
const VALUE_ENV = 'YORI_TEST_SECRET_VALUE';

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

async function secretIndexMode(fixture: CollectorFixture): Promise<number | null> {
  try {
    return (await stat(collectorSecretsIndexPath(fixture))).mode & 0o777;
  } catch {
    return null;
  }
}

describe('collector:secret:add / list / remove', () => {
  it('addは非表示promptの値をKeychainだけへ保存し、labels-only indexを0600・昇順で更新する', async () => {
    await withCollectorFixture(async (fixture) => {
      const run = await runRootCli(fixture, ['collector:secret:add', LABEL_BETA], { input: `${VALUE_BETA}\n` });
      const output = parseCollectorSuccess(run);
      assert.deepEqual(output, { status: 'stored', label: LABEL_BETA });
      assert.deepEqual(Object.keys(output).sort(), ['label', 'status']);

      const calls = await readSecurityCalls(fixture);
      const adds = calls.filter((args) => args[0] === 'add-generic-password');
      assert.equal(adds.length, 1, `add-generic-passwordの回数が違う: ${JSON.stringify(calls)}`);
      assert.equal(adds[0][adds[0].indexOf('-s') + 1], SECRET_SERVICE);
      assert.equal(adds[0][adds[0].indexOf('-a') + 1], LABEL_BETA);
      assert.equal(adds[0].at(-1), '-w', `値付き-wでargvへsecretを渡している: ${JSON.stringify(adds[0])}`);
      for (const args of calls) {
        assert.ok(!args.includes(VALUE_BETA), `security argvへsecretが出ている: ${JSON.stringify(args)}`);
      }

      assert.equal(await readKeychainSecret(fixture, LABEL_BETA), VALUE_BETA, 'Keychainへsecretが保存されていない');
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_BETA]);
      const indexText = await readFile(collectorSecretsIndexPath(fixture), 'utf8');
      assert.ok(!indexText.includes(VALUE_BETA), 'indexへsecretを保存している');
      assert.equal(await secretIndexMode(fixture), 0o600, 'indexのmodeが0600ではない');
      for (const text of [run.stdout, run.stderr]) {
        assert.ok(!text.includes(VALUE_BETA), 'stdout/stderrへsecretが出ている');
      }
      assert.deepEqual(await filesContaining(fixture.home, VALUE_BETA), [], 'home配下のfileへsecretが残っている');
    });
  });

  it('add --from-envは環境変数の値だけをKeychainへ保存し、argvへ値を出さない', async () => {
    await withCollectorFixture(async (fixture) => {
      const alpha = parseCollectorSuccess(
        await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${VALUE_ALPHA}\n` }),
      );
      assert.deepEqual(alpha, { status: 'stored', label: LABEL_ALPHA });

      const beta = parseCollectorSuccess(
        await runRootCli(fixture, ['collector:secret:add', LABEL_BETA, '--from-env', VALUE_ENV], { env: { [VALUE_ENV]: VALUE_BETA } }),
      );
      assert.deepEqual(beta, { status: 'stored', label: LABEL_BETA });

      assert.equal(await readKeychainSecret(fixture, LABEL_BETA), VALUE_BETA);
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_ALPHA, LABEL_BETA], 'indexが昇順ではない');
      assert.equal(await secretIndexMode(fixture), 0o600);
      for (const args of await readSecurityCalls(fixture)) {
        for (const value of [VALUE_ALPHA, VALUE_BETA]) {
          assert.ok(!args.includes(value), `security argvへsecretが出ている: ${JSON.stringify(args)}`);
        }
      }
      assert.deepEqual(await filesContaining(fixture.home, VALUE_BETA), []);
      assert.deepEqual(await filesContaining(fixture.home, VALUE_ALPHA), []);
    });
  });

  it('add --from-envは元の環境変数を削除してからsecurityを起動し、子processへ継承させない', async () => {
    await withCollectorFixture(async (fixture) => {
      const probeLogPath = path.join(fixture.root, 'security-env-probe.log');
      const probeBin = path.join(fixture.binDir, 'security-env-probe');
      // security子process自身のenvを確認してから既存shimへ委譲するsynthetic probe。
      await writeFile(
        probeBin,
        [
          '#!/bin/sh',
          `if [ -n "\${${VALUE_ENV}:-}" ]; then`,
          `  printf 'inherited\\n' >> "\${YORI_TEST_SECURITY_ENV_LOG:?}"`,
          'else',
          `  printf 'absent\\n' >> "\${YORI_TEST_SECURITY_ENV_LOG:?}"`,
          'fi',
          'exec "${YORI_TEST_REAL_SECURITY_BIN:?}" "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      await chmod(probeBin, 0o755);

      const run = await runRootCli(fixture, ['collector:secret:add', LABEL_BETA, '--from-env', VALUE_ENV], {
        env: {
          [VALUE_ENV]: VALUE_BETA,
          YORI_SECURITY_BIN: probeBin,
          YORI_TEST_SECURITY_ENV_LOG: probeLogPath,
          YORI_TEST_REAL_SECURITY_BIN: path.join(fixture.binDir, 'security'),
        },
      });

      assert.deepEqual(parseCollectorSuccess(run), { status: 'stored', label: LABEL_BETA });
      const probes = (await readFile(probeLogPath, 'utf8')).trim().split('\n');
      assert.ok(probes.length >= 2, `securityの呼出し回数が足りない: ${JSON.stringify(probes)}`);
      assert.deepEqual([...new Set(probes)], ['absent'], `${VALUE_ENV}がsecurity子processへ継承されている`);
      assert.equal(await readKeychainSecret(fixture, LABEL_BETA), VALUE_BETA);
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_BETA]);
    });
  });

  it('listはindexのlabelだけをソートして返し、index未作成なら空配列を返す', async () => {
    await withCollectorFixture(async (fixture) => {
      const empty = parseCollectorSuccess(await runRootCli(fixture, ['collector:secret:list']));
      assert.deepEqual(empty, { labels: [] });

      await runRootCli(fixture, ['collector:secret:add', LABEL_BETA], { input: `${VALUE_BETA}\n` });
      await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${VALUE_ALPHA}\n` });
      const listed = parseCollectorSuccess(await runRootCli(fixture, ['collector:secret:list']));
      assert.deepEqual(listed, { labels: [LABEL_ALPHA, LABEL_BETA] });
      assert.ok(!JSON.stringify(listed).includes(VALUE_ALPHA) && !JSON.stringify(listed).includes(VALUE_BETA), 'listへ値を出している');
      const indexText = await readFile(collectorSecretsIndexPath(fixture), 'utf8');
      assert.deepEqual(JSON.parse(indexText), [LABEL_ALPHA, LABEL_BETA], 'indexがlabels-onlyではない');
    });
  });

  it('removeはlabelのKeychain itemとindex entryだけを消し、値や他labelを変更しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${VALUE_ALPHA}\n` });
      await runRootCli(fixture, ['collector:secret:add', LABEL_BETA], { input: `${VALUE_BETA}\n` });

      const removed = parseCollectorSuccess(await runRootCli(fixture, ['collector:secret:remove', LABEL_ALPHA]));
      assert.deepEqual(removed, { status: 'removed', label: LABEL_ALPHA });
      assert.equal(await readKeychainSecret(fixture, LABEL_ALPHA), null, 'Keychain itemを削除していない');
      assert.equal(await readKeychainSecret(fixture, LABEL_BETA), VALUE_BETA, '他labelのKeychain itemを変更している');
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_BETA]);
      assert.equal(await secretIndexMode(fixture), 0o600);
      assert.ok(!JSON.stringify(removed).includes(VALUE_ALPHA), 'remove出力へsecretが出ている');

      const missing = await runRootCli(fixture, ['collector:secret:remove', 'label-missing']);
      assertCollectorFailure(missing, [VALUE_ALPHA, VALUE_BETA]);
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_BETA], '存在しないlabelのremoveでindexを変更している');
      assert.equal(await readKeychainSecret(fixture, LABEL_BETA), VALUE_BETA);
    });
  });

  it('yori known-secretの長さ・件数・exact重複制限を超える値は無変更で拒否する', async () => {
    await withCollectorFixture(async (fixture) => {
      const tooShort = 'short12';
      const tooLong = 'x'.repeat(4097);
      for (const value of [tooShort, tooLong]) {
        const run = await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${value}\n` });
        assertCollectorFailure(run, [value]);
        assert.equal(await readKeychainSecret(fixture, LABEL_ALPHA), null, `不正値を保存している (${value.length}cp)`);
        assert.deepEqual(await readSecretIndexLabels(fixture), null, '不正値でindexを作成している');
      }

      // exact重複はlabelが違っても拒否する。
      await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${VALUE_ALPHA}\n` });
      const duplicate = await runRootCli(fixture, ['collector:secret:add', LABEL_BETA], { input: `${VALUE_ALPHA}\n` });
      assertCollectorFailure(duplicate, [VALUE_ALPHA]);
      assert.equal(await readKeychainSecret(fixture, LABEL_BETA), null, '重複値を保存している');
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_ALPHA]);
    });
  });

  it('100件の上限を超えるlabel追加を拒否し、既存indexを変更しない', async () => {
    await withCollectorFixture(async (fixture) => {
      const labels = Array.from({ length: 100 }, (_, index) => `bulk-${String(index).padStart(3, '0')}`);
      await writeSecretIndexLabels(fixture, labels);
      for (const [index, label] of labels.entries()) {
        await writeKeychainSecret(fixture, label, `synthetic-bulk-value-${String(index).padStart(3, '0')}`);
      }
      const run = await runRootCli(fixture, ['collector:secret:add', 'overflow-label'], { input: `${'overflow-secret-value'}\n` });
      assertCollectorFailure(run, ['overflow-secret-value']);
      assert.deepEqual(await readSecretIndexLabels(fixture), labels, '上限超過でindexを変更している');
      assert.equal(await readKeychainSecret(fixture, 'overflow-label'), null, '上限超過でKeychain itemを作成している');
      assert.deepEqual(await readKeychainSecretLabels(fixture), labels);
    });
  });
  it('security出力の末尾改行だけを落とし、値の前後空白を保持する', async () => {
    await withCollectorFixture(async (fixture) => {
      const padded = '  padded secret value  ';
      const stored = parseCollectorSuccess(
        await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${padded}\n` }),
      );
      assert.deepEqual(stored, { status: 'stored', label: LABEL_ALPHA });
      assert.equal(await readKeychainSecret(fixture, LABEL_ALPHA), padded, 'Keychain値の空白が変わっている');
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_ALPHA]);

      // trimmed値と同一視すると、prompt保存後の重複判定が空白違いを通してしまう。
      const duplicate = await runRootCli(fixture, ['collector:secret:add', LABEL_BETA], { input: `${padded}\n` });
      assertCollectorFailure(duplicate, [padded, padded.trim()]);
      assert.equal(await readKeychainSecret(fixture, LABEL_BETA), null, '重複値のitemが残っている');
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_ALPHA]);
    });
  });

  it('labelは1〜128 code pointsだけを許可し、境界外はKeychainとindexを変更しない', async () => {
    await withCollectorFixture(async (fixture) => {
      const invalidLabels = ['', 'a'.repeat(129), '😀'.repeat(129)];
      for (const label of invalidLabels) {
        const run = await runRootCli(fixture, ['collector:secret:add', label], { input: `${VALUE_ALPHA}\n` });
        assertCollectorFailure(run, [VALUE_ALPHA, ...(label === '' ? [] : [label])]);
        assert.deepEqual(await readSecretIndexLabels(fixture), null, `不正label (${label.length} UTF-16 units) でindexを作成している`);
      }
      // サロゲートペアを1 code pointとして数え、128 code pointsのlabelを受理する。
      const astral128 = '😀'.repeat(128);
      await writeSecretIndexLabels(fixture, [astral128]);
      const listed = parseCollectorSuccess(await runRootCli(fixture, ['collector:secret:list']));
      assert.deepEqual(listed, { labels: [astral128] });
    });
  });

  it('labelの境界値128 code pointsを受け入れ、129 code pointsを拒否する', async () => {
    await withCollectorFixture(async (fixture) => {
      const label128 = 'a'.repeat(128);
      const stored = parseCollectorSuccess(
        await runRootCli(fixture, ['collector:secret:add', label128], { input: `${VALUE_ALPHA}\n` }),
      );
      assert.deepEqual(stored, { status: 'stored', label: label128 });
      assert.deepEqual(await readSecretIndexLabels(fixture), [label128]);
      assert.equal(await readKeychainSecret(fixture, label128), VALUE_ALPHA);

      const removed = parseCollectorSuccess(await runRootCli(fixture, ['collector:secret:remove', label128]));
      assert.deepEqual(removed, { status: 'removed', label: label128 });
      assert.deepEqual(await readSecretIndexLabels(fixture), []);
    });
  });

  it('index書き込みが失敗したadd/removeはKeychainをrollbackし、indexを変更しない', async () => {
    await withCollectorFixture(async (fixture) => {
      await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${VALUE_ALPHA}\n` });
      const stateDir = path.dirname(collectorSecretsIndexPath(fixture));
      await chmod(stateDir, 0o500);
      try {
        const add = await runRootCli(fixture, ['collector:secret:add', LABEL_BETA], { input: `${VALUE_BETA}\n` });
        assert.equal(assertCollectorFailure(add, [VALUE_BETA]), 'admin: collector_internal_error\n');
        assert.equal(await readKeychainSecret(fixture, LABEL_BETA), null, 'add失敗で新規itemをrollbackしていない');

        const remove = await runRootCli(fixture, ['collector:secret:remove', LABEL_ALPHA]);
        assert.equal(assertCollectorFailure(remove, [VALUE_ALPHA]), 'admin: collector_internal_error\n');
        assert.equal(await readKeychainSecret(fixture, LABEL_ALPHA), VALUE_ALPHA, 'remove失敗で削除itemを復元していない');
        assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_ALPHA], '失敗でindexを変更している');
      } finally {
        await chmod(stateDir, 0o700);
      }
    });
  });

  it('prompt保存後の値が制限違反なら、上書き前のKeychain値を復元して拒否する', async () => {
    await withCollectorFixture(async (fixture) => {
      await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${VALUE_ALPHA}\n` });
      const short = 'short12';
      const run = await runRootCli(fixture, ['collector:secret:add', LABEL_ALPHA], { input: `${short}\n` });
      assertCollectorFailure(run, [short, VALUE_ALPHA]);
      assert.equal(await readKeychainSecret(fixture, LABEL_ALPHA), VALUE_ALPHA, '上書きしたitemを元の値へ戻していない');
      assert.deepEqual(await readSecretIndexLabels(fixture), [LABEL_ALPHA]);
    });
  });
});
