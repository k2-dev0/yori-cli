# yori-cli

yori の会社・社員・案件・案件メンバー・認証トークンを初期登録・管理するCLI。package名は `yori-cli`、install後の実行コマンドは `yori` である。

- DB schemaの正本はyori本体の `src/db/migrations/*.sql`。このpackageはmigrationを持たない。
- yori本体の `schema_migrations` に `0001_init.sql` がなければ成功扱いしない。
- 生の認証tokenは `bootstrap` / `token:issue` 成功時に1度だけstdoutへ出す。DBにはSHA-256だけを保存する。
- 会社・社員・案件を物理削除するコマンドはない。破壊的操作は案件メンバー解除とtoken失効だけである。

## 本番試運転

npm publishは行わない。private repositoryを `/srv/yori-cli` へread-only Deploy Keyでcloneし、レビュー済みcommit SHAをcheckoutしてComposeの `cli` serviceから実行する。yori本体と同じ `/etc/yori/yori.env` を使い、同じinternal Docker network上のPostgreSQLへ接続する。

固定DB資格情報、host公開DB port、完成済みDB URLの二重管理は使わない。配置、migration、read-only bootstrap mount、token取扱いは [deployment手順](deployment/README.md) を正本とする。

## 実行コマンド

repository内の開発実行:

```sh
DATABASE_URL='<test-or-development-database-url>' npm run --silent cli -- inspect <company-uuid>
```

将来、review済みpackage artifactをinstallする場合のbin名:

```sh
yori inspect <company-uuid>
```

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

試運転はprivate cloneを使い、npm publishを要件にしない。現在のpackageは `UNLICENSED` である。registry配布はlicense、公開範囲、package名所有、署名・provenance、versioning、publish権限、2FAを別途決定してから行う。

package化した場合に含むのは `README.md`、`files: ["dist"]` の対象、`package.json` で、binは `yori` → `dist/admin/cli.js` である。
