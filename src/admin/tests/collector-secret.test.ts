import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
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
});
