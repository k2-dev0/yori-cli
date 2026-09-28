# yori-cli

yori の会社・社員・案件・案件メンバー・認証トークンを初期登録・管理するCLI。package名は `yori-cli`、install後の実行コマンドは `yori` である。

- DB schemaの正本はyori本体の `src/db/migrations/*.sql`。このpackageはmigrationを持たない。
- yori本体の `schema_migrations` に `0001_init.sql` がなければ成功扱いしない。
- 生の認証tokenは `bootstrap` / `token:issue` 成功時に1度だけstdoutへ出す。DBにはSHA-256だけを保存する。
- 会社・社員・案件を物理削除するコマンドはない。破壊的操作は案件メンバー解除とtoken失効だけである。

## 配布と本番試運転

`yori-cli` をpublic npm registryへpublishし、レビュー済みの固定versionをnpxから実行する。`latest`の無条件利用ではなく、本番では承認済みversionを指定する。Compose運用ではyori本体と同じ `/etc/yori/yori.env` とinternal Docker networkを使う。

固定DB資格情報、host公開DB port、完成済みDB URLの二重管理は使わない。公開package単体で再現できる安全なnpx手順を下に記載する。source配置、migration、token取扱いの詳細はrepositoryの `deployment/README.md` を使う。

## 実行コマンド

repository内の開発実行:

```sh
DATABASE_URL='<test-or-development-database-url>' npm run --silent yori -- inspect <company-uuid>
```

npm registryの固定versionをnpxで実行:

```sh
npx --yes --package=yori-cli@<reviewed-version> yori inspect <company-uuid>
```

`DATABASE_URL` はこのcommand行に書かず、保護された実行環境から渡す。本番DBはhost port非公開のため、npxもyoriのinternal Docker networkへ参加する一時container内で実行する。

### 公開packageだけで本番npx実行

次を `/etc/yori/yori-cli-npx.yaml` へ保存する。Composeが共通env fileをdotenvとしてparseし、containerへは構成済み `DATABASE_URL` とnpm log設定だけを渡す。JevやVoyage等のAPI秘密は渡さない。

```yaml
name: yori-cli-published
services:
  cli:
    image: node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
    profiles: [tools]
    networks: [yori]
    environment:
      DATABASE_URL: postgres://${YORI_POSTGRES_USER:?required}:${YORI_POSTGRES_PASSWORD:?required}@db:5432/${YORI_POSTGRES_DB:?required}
      NPM_CONFIG_LOGLEVEL: error
    entrypoint:
      - sh
      - -eu
      - -c
      - |
        version="$1"
        shift
        exec npx --yes --package="yori-cli@$${version}" yori "$$@"
      - --
networks:
  yori:
    name: ${YORI_ADMIN_NETWORK:-yori_default}
    external: true
```

yori本体のmigration完了後、承認済みversionを固定して実行する。`bootstrap.json` はrepository外の管理者限定fileとし、read-only mountする。

```sh
docker compose --env-file /etc/yori/yori.env -f /etc/yori/yori-cli-npx.yaml --profile tools config --quiet
docker compose --env-file /etc/yori/yori.env -f /etc/yori/yori-cli-npx.yaml --profile tools run --rm \
  --volume /etc/yori/bootstrap.json:/input/bootstrap.json:ro \
  cli <reviewed-version> bootstrap /input/bootstrap.json
```

`inspect`は末尾を `<reviewed-version> inspect <company-uuid>` へ置き換える。生tokenを返す `bootstrap` / `token:issue` は管理者の対話端末で実行し、`tee`、redirect、CI、共有session recorderへ出力しない。

`DATABASE_URL` はargvで受け取らない。未設定・空なら `invalid_admin_config` で終了する。入力はすべてJSON fileで渡す。本番では完成済みURLを直接管理せず、Composeが `YORI_POSTGRES_USER`、`YORI_POSTGRES_PASSWORD`、`YORI_POSTGRES_DB` から構成する。

## コマンド

| command | 用途 |
|---|---|
| `bootstrap <file.json>` | 空DBへ会社1件・社員1件以上・案件1件以上・所属・初回tokenを1 transactionで登録 |
| `company:create <file.json>` | 会社を登録 |
| `employee:create <file.json>` | 指定会社へ社員を登録 |
| `project:create <file.json>` | repository identifierを正規化して指定会社へ案件を登録 |
| `member:add <file.json>` | 同一会社の案件と社員に限り所属を追加 |
| `member:remove <file.json>` | 案件メンバーを解除 |
| `token:issue <file.json>` | 指定会社の社員へtokenを発行し、生tokenを1度だけ返す |
| `token:revoke <file.json>` | 指定会社に属するtokenを失効 |
| `inspect <company-uuid>` | 会社・社員・案件・所属・token metadataを返す。生tokenとhashは返さない |

## 出力と終了コード

- 成功: stdoutへ1行のJSON objectだけを出し、終了コード0。
- 既知の失敗: stderrへ `admin: <固定code>` だけを出し、終了コード1。
- SQL、接続文字列、入力file本文、生token、token hash、DB error本文は失敗出力へ出さない。

入力JSON、出力例、固定エラーコード、会社scopeは [管理コマンド契約](docs/admin.md) を参照。

## 開発と検証

```sh
npm ci
npm run test:db
node --test deployment/compose-config.test.mjs
node deployment/run-production-integration-smoke.mjs
npm run typecheck
npm run lint
npm run build
```

- `npm run test:db` は専用PostgreSQLをloopbackだけへ公開し、test後に破棄する。
- Compose契約testは必須DB env、外部network、no ports、固定fallback不在を検証する。
- integration smokeは隣接するyori repositoryのtest Composeと実migrationを使い、固有project・固有volumeを破棄する。実AWS、実社員データ、実秘密は使わない。

## 配布

public npm registryの `yori-cli` を正式配布先とする。releaseはレビュー済みcommitからversionを固定し、test、typecheck、lint、build、`npm pack --dry-run`の成功後に行う。
公開packageのnpx実行で依存解決結果が後日変わらないよう、CLIとruntime dependenciesはrelease時に単一bundleへ固定し、公開packageのruntime dependenciesを0件にする。依存更新は別commitでレビューし、新しいpackage versionとしてreleaseする。

```sh
npm publish --access public
```

publish権限は2FAを必須とし、releaseごとにversionとregistry上のintegrityを確認する。source repositoryをpublic化し、npm対応のOIDC CIからpublishする構成を導入するまで `--provenance` は使わない。現在のpackageは `UNLICENSED` で、公開配布しても再利用許諾を与えない。licenseを変更する場合は別の明示的な決定とレビューが必要である。

packageに含むのは `README.md`、`dist/yori.cjs`、`dist/yori.cjs.map`、`package.json` で、binは `yori` → `dist/yori.cjs` である。
