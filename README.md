# yori-cli (`yori-admin`)

yori の管理CLI。会社・社員・案件・案件メンバー・認証トークンの初期登録と日常管理を行う。
yori 本体（API・worker）とは別packageで、リポジトリを clone せず `npx` から実行できる。

- DB schema の正本は yori 本体の `src/db/migrations/0001_init.sql`。このpackageはmigrationを持たない。
- 生の認証トークンは `bootstrap` / `token:issue` の成功時に1度だけstdoutへ出る。DBにはSHA-256だけを保存する。
- 会社・社員・案件を物理削除するコマンドは無い。破壊的操作は案件メンバー解除とtoken失効だけ。

## 実行

```sh
export DATABASE_URL='postgres://yori:yori@<host>:5432/yori'
npx --yes yori-cli inspect <company-uuid>
```

package名ではなくbin名で実行する場合:

```sh
npx --yes --package=yori-cli yori-admin inspect <company-uuid>
```

常時使う場合はグローバルinstall:

```sh
npm install -g yori-cli
yori-admin inspect <company-uuid>
```

`DATABASE_URL` はargvで受け取らない（shell履歴へ値を残さないため）。未設定・空の場合は `invalid_admin_config` で終了する。入力はすべてJSON fileで渡す。

## コマンド

| command | 用途 |
|---|---|
| `bootstrap <file.json>` | 空のDBへ会社1件・社員1件以上・案件1件以上・所属・初回tokenを1 transactionで登録 |
| `company:create <file.json>` | 会社を登録 |
| `employee:create <file.json>` | 指定会社へ社員を登録 |
| `project:create <file.json>` | repository identifierを正規化して指定会社へ案件を登録 |
| `member:add` / `member:remove <file.json>` | 同一会社の案件と社員に限り所属を追加・解除 |
| `token:issue <file.json>` | 指定会社の社員へtokenを発行し、生tokenを1度だけ返す |
| `token:revoke <file.json>` | 指定会社に属するtokenを失効 |
| `inspect <company-uuid>` | 会社・社員・案件・所属・token metadataをJSONで返す（生tokenとhashは返さない） |

## 出力と終了コード

- 成功: stdoutへ1行のJSON objectだけを出し、終了コード0。
- 既知の失敗: stderrへ `admin: <固定code>` だけを出し、終了コード1。SQL・接続文字列・入力file本文・token・token hash・DB error本文は出さない。

入力JSONの形式、出力例、固定エラーコード一覧、会社scopeの判定は [docs/admin.md](docs/admin.md) を参照。Compose tools profileからの実行手順は [deployment/README.md](deployment/README.md) を参照。

## 開発

```sh
npm ci
npm run test:db    # テスト専用DBを起動 → 実PostgreSQLテスト → 破棄
npm run typecheck
npm run lint
npm run build
npm run --silent admin -- <command>   # リポジトリ内から実行
```

`npm test` は `DATABASE_URL`（既定 `postgres://yori:yori@127.0.0.1:55432/yori`）の実PostgreSQLへ接続する。

## 公開

```sh
npm pack       # prepackでdistをビルドし、tarballを作る
npm publish    # 公開npmレジストリ
```

公開されるのは `files: ["dist"]` と `package.json` だけ。`bin` は `yori-admin` → `dist/admin/cli.js`。

- `license` は `UNLICENSED`。公開レジストリへ配布する前に、社内方針に合わせて指定し直すこと。
- `engines` は `node >= 24`。
