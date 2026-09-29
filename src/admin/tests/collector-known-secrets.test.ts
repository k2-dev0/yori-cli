import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_SECRETS_BUNDLE,
  KNOWN_SECRETS_MARKER_BUNDLE,
  SECRET_KEYCHAIN_SERVICE,
  hookCommandFor,
  installCollectorWithoutSetup,
  readSecurityCalls,
  runShellCommand,
  withCollectorFixture,
  writeKeychainSecret,
  writeSecretIndexLabels,
  writeSecretsIndexJson,
  type CollectorFixture,
} from './collector-support.js';

// stable launcherは ~/.yori-collector/secrets.json のlabels-only indexを読み、
// 各labelのKeychain値だけからYORI_KNOWN_SECRETS_JSONを組み立てて子collectorへ渡す。
// index欠落は[]、index不正・item欠落・値がknown-secret制限違反なら子を起動せずlauncher_errorでfail-closedする。
const LABEL_ALPHA = 'label-alpha';
const LABEL_ZETA = 'label-zeta';
const VALID_VALUE_ALPHA = 'synthetic-secret-alpha-11112222';
const VALID_VALUE_ZETA = 'synthetic-secret-zeta-33334444';

// setup APIのpolicy契約を経由せず、現行のstable launcherを直接installしてhook commandを得る。
async function installWithBundle(fixture: CollectorFixture, content: string): Promise<string> {
  await installCollectorWithoutSetup(fixture, content);
  return hookCommandFor(fixture, 'codex', 'collect');
}

describe('launcherのknown secret環境', () => {
  it('index未作成または空配列なら子collectorへ[]を渡し、親envの値で上書きしない', async () => {
    await withCollectorFixture(async (fixture) => {
      const command = await installWithBundle(fixture, KNOWN_SECRETS_BUNDLE);

      const missing = runShellCommand(fixture, command, {
        YORI_KNOWN_SECRETS_JSON: JSON.stringify(['stale-parent-secret']),
      });
      assert.equal(missing.status, 0, `launcher実行が失敗した: ${missing.stderr}`);
      assert.ok(missing.stdout.includes('known-secrets:[]'), `index欠落時に[]を渡していない: ${missing.stdout}`);
      assert.ok(!missing.stdout.includes('stale-parent-secret'), '親envのknown secretをそのまま渡している');
      assert.ok(!missing.stderr.includes('stale-parent-secret'));

      await writeSecretIndexLabels(fixture, []);
      const empty = runShellCommand(fixture, command);
      assert.equal(empty.status, 0, `launcher実行が失敗した: ${empty.stderr}`);
      assert.ok(empty.stdout.includes('known-secrets:[]'), `空index時に[]を渡していない: ${empty.stdout}`);
    });
  });

  it('indexのlabel順にKeychain値だけを合成し、index外のKeychain itemを渡さない', async () => {
    await withCollectorFixture(async (fixture) => {
      const command = await installWithBundle(fixture, KNOWN_SECRETS_BUNDLE);
      await writeSecretIndexLabels(fixture, [LABEL_ALPHA, LABEL_ZETA]);
      await writeKeychainSecret(fixture, LABEL_ALPHA, VALID_VALUE_ALPHA);
      await writeKeychainSecret(fixture, LABEL_ZETA, VALID_VALUE_ZETA);
      await writeKeychainSecret(fixture, 'label-unindexed', 'synthetic-secret-unindexed-55556666');

      const launched = runShellCommand(fixture, command);
      assert.equal(launched.status, 0, `launcher実行が失敗した: ${launched.stderr}`);
      const marker = launched.stdout.match(/known-secrets:(.*)\n/);
      assert.ok(marker !== null, `YORI_KNOWN_SECRETS_JSONのmarkerがない: ${launched.stdout}`);
      const composed: unknown = JSON.parse(marker[1] === 'UNSET' ? 'null' : marker[1]);
      assert.ok(Array.isArray(composed), `YORI_KNOWN_SECRETS_JSONが配列ではない: ${launched.stdout}`);
      assert.deepEqual(
        [...(composed as string[])].sort(),
        [VALID_VALUE_ALPHA, VALID_VALUE_ZETA].sort(),
        `Keychain値からYORI_KNOWN_SECRETS_JSONを合成していない: ${launched.stdout}`,
      );
      assert.ok(!launched.stdout.includes('synthetic-secret-unindexed-55556666'), 'index外のKeychain値を渡している');

      const secretFinds = (await readSecurityCalls(fixture)).filter(
        (args) => args[0] === 'find-generic-password' && args[args.indexOf('-s') + 1] === SECRET_KEYCHAIN_SERVICE,
      );
      assert.deepEqual(
        [...secretFinds.map((args) => args[args.indexOf('-a') + 1])].sort(),
        [LABEL_ALPHA, LABEL_ZETA].sort(),
        `indexのlabelに対応するKeychain findを呼んでいない: ${JSON.stringify(secretFinds)}`,
      );
      for (const args of secretFinds) {
        assert.equal(args.at(-1), '-w', `値付き-wでsecretをargvへ渡している: ${JSON.stringify(args)}`);
        assert.ok(!args.includes(VALID_VALUE_ALPHA) && !args.includes(VALID_VALUE_ZETA), `argvへsecretが出ている: ${JSON.stringify(args)}`);
      }
    });
  });

  it('indexのlabelに対応するKeychain itemが無ければlauncher_errorで子を起動しない', async () => {
    await withCollectorFixture(async (fixture) => {
      const command = await installWithBundle(fixture, KNOWN_SECRETS_MARKER_BUNDLE);
      await writeSecretIndexLabels(fixture, [LABEL_ALPHA, LABEL_ZETA]);
      await writeKeychainSecret(fixture, LABEL_ALPHA, VALID_VALUE_ALPHA);

      const launched = runShellCommand(fixture, command);
      assert.equal(launched.status, 1, `欠落itemで失敗していない: ${launched.stderr}`);
      assert.equal(launched.stdout, '', '欠落itemでも子collectorを起動している');
      assert.equal(launched.stderr, 'collector: launcher_error\n');
      assert.ok(!launched.stderr.includes(VALID_VALUE_ALPHA), 'launcher失敗出力へsecretが出ている');
    });
  });

  it('Keychain値がknown-secretの長さ・重複制限に反すれば子を起動しない', async () => {
    await withCollectorFixture(async (fixture) => {
      const command = await installWithBundle(fixture, KNOWN_SECRETS_MARKER_BUNDLE);
      await writeSecretIndexLabels(fixture, [LABEL_ALPHA]);
      await writeKeychainSecret(fixture, LABEL_ALPHA, 'short12');

      const short = runShellCommand(fixture, command);
      assert.equal(short.status, 1, `短すぎる値で失敗していない: ${short.stderr}`);
      assert.equal(short.stdout, '');
      assert.equal(short.stderr, 'collector: launcher_error\n');

      await writeKeychainSecret(fixture, LABEL_ALPHA, VALID_VALUE_ALPHA);
      await writeSecretIndexLabels(fixture, [LABEL_ALPHA, LABEL_ZETA]);
      await writeKeychainSecret(fixture, LABEL_ZETA, VALID_VALUE_ALPHA);
      const duplicate = runShellCommand(fixture, command);
      assert.equal(duplicate.status, 1, `重複値で失敗していない: ${duplicate.stderr}`);
      assert.equal(duplicate.stdout, '', '重複valueでも子collectorを起動している');
      assert.equal(duplicate.stderr, 'collector: launcher_error\n');
      assert.ok(!duplicate.stderr.includes(VALID_VALUE_ALPHA));
    });
  });

  it('labels-only・昇順・重複なしでないindexはlauncher_errorで拒否し、子を起動しない', async () => {
    const invalidIndexes: { label: string; content: unknown }[] = [
      { label: '非JSON', content: 'not-json' },
      { label: '非配列', content: { labels: [LABEL_ALPHA] } },
      { label: '非文字列要素', content: [1] },
      { label: '非ソート', content: [LABEL_ZETA, LABEL_ALPHA] },
      { label: '重複label', content: [LABEL_ALPHA, LABEL_ALPHA] },
    ];
    for (const invalid of invalidIndexes) {
      await withCollectorFixture(async (fixture) => {
        const command = await installWithBundle(fixture, KNOWN_SECRETS_MARKER_BUNDLE);
        await writeKeychainSecret(fixture, LABEL_ALPHA, VALID_VALUE_ALPHA);
        await writeSecretsIndexJson(fixture, invalid.content);
        const launched = runShellCommand(fixture, command);
        assert.equal(launched.status, 1, `${invalid.label} で失敗していない: ${launched.stderr}`);
        assert.equal(launched.stdout, '', `${invalid.label} でも子collectorを起動している`);
        assert.equal(launched.stderr, 'collector: launcher_error\n', `${invalid.label} の固定codeが違う`);
        assert.ok(!launched.stderr.includes(VALID_VALUE_ALPHA));
      });
    }
  });
});
