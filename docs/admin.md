# yori 管理CLI (`yori-admin`)

会社・社員・案件・案件メンバー・認証トークンを管理する独立CLI。`yori` 本体のworker CLIとは別process・別entry pointで動く。

- DB schemaの正本は `yori` 本体の `src/db/migrations/0001_init.sql`。このリポジトリはmigrationを持たない。
- 会社・社員・案件を物理削除するコマンドは無い。破壊的操作は案件メンバー解除とtoken失効だけ。
- 生の認証トークンは `bootstrap` / `token:issue` の成功時に1度だけstdoutへ出る。DBにはSHA-256だけを保存する。

## 1. 実行方法

### ホスト

```sh
export DATABASE_URL='postgres://yori:yori@<host>:5432/yori'
npm run --silent admin -- inspect <company-uuid>
```

`npm run` のbannerをstdoutへ混ぜないため `--silent` を使う。`DATABASE_URL` が未設定・空の場合は `invalid_admin_config` で終了する。

### Compose (tools profile)

yori本体のCompose project (`yori`) が作るnetworkへ参加し、その `db` サービスへ接続する。先にyori本体のDBを起動しておくこと。

```sh
# yori本体 (別リポジトリ) 側
docker compose -p yori -f deployment/compose.yaml up -d db

# yori-cli側
docker compose -f deployment/compose.yaml --profile tools run --rm admin inspect <company-uuid>
```

- network名は既定で `yori_default`。別名を使う場合は `YORI_ADMIN_NETWORK` を指定する。
- 接続先は既定で `postgres://yori:yori@db:5432/yori`。変更する場合は `YORI_ADMIN_DATABASE_URL` を指定する。
- 初回実行時はcontainer内で `npm ci` が走る。

## 2. 入出力の契約

- 入力は常にJSON file。引数の順序誤りとshell履歴への値の露出を避けるため、コマンドライン引数では値を受けない。
- 入力JSONはunknown fieldを拒否する (`invalid_input`)。
- 成功時は1行のJSON objectだけをstdoutへ出し、終了コード0で終わる。
- 既知の失敗は `admin: <code>` だけをstderrへ出し、終了コード1で終わる。
- SQL・接続文字列・入力file本文・token・token hash・DB error本文は、stdout/stderrのどちらにも出さない。

## 3. コマンド

### `bootstrap <file.json>`

空のDBへ会社1件・社員1件以上・案件1件以上・所属・初回tokenを1 transactionで登録する。

```json
{
  "company": { "name": "example" },
  "employees": [
    { "ref": "alice", "display_name": "Alice", "issue_token": true },
    { "ref": "bob", "display_name": "Bob", "issue_token": true }
  ],
  "projects": [
    { "ref": "project-a", "repository": "github.com/example/project-a", "member_refs": ["alice", "bob"] }
  ]
}
```

- `ref` は同じfile内だけで参照する一時識別子。DBへは保存しない。
- `ref` の重複、案件`ref`の重複、`member_refs`の重複、未知の`member_refs`は `invalid_input`。
- `issue_token` が `true` の社員だけ初回tokenを発行する（既定 `false`）。
- 会社が1件でも存在するDBでは `bootstrap_already_completed` を返し、何も変更しない。
- 同時bootstrapはtransaction advisory lockで直列化し、片方だけが成功する。
- 途中の制約違反・token生成失敗では、先行insertを含めて全体をrollbackする。

成功出力:

```json
{"status":"created","company":{"company_id":"<uuid>","name":"example"},"employees":[{"ref":"alice","employee_id":"<uuid>","display_name":"Alice"}],"projects":[{"ref":"project-a","project_id":"<uuid>","repository_identifier":"github.com/example/project-a"}],"members":[{"project_id":"<uuid>","employee_id":"<uuid>"}],"tokens":[{"ref":"alice","token_id":"<uuid>","employee_id":"<uuid>","token":"yori_<secret>"}]}
```

### `company:create <file.json>`

```json
{ "name": "example" }
```

```json
{"status":"created","company_id":"<uuid>","name":"example"}
```

### `employee:create <file.json>`

```json
{ "company_id": "<uuid>", "display_name": "Alice" }
```

```json
{"status":"created","employee_id":"<uuid>","company_id":"<uuid>","display_name":"Alice"}
```

### `project:create <file.json>`

```json
{ "company_id": "<uuid>", "repository": "git@github.com:example/project-a.git" }
```

```json
{"status":"created","project_id":"<uuid>","company_id":"<uuid>","repository_identifier":"github.com/example/project-a"}
```

同じ会社で同じcanonical identifierの案件が既にある場合は `repository_conflict`。既存案件は変更しない。

### `member:add` / `member:remove <file.json>`

```json
{ "company_id": "<uuid>", "project_id": "<uuid>", "employee_id": "<uuid>" }
```

```json
{"status":"created","project_id":"<uuid>","employee_id":"<uuid>"}
```

`member:remove` の成功出力は `{"status":"removed",...}`。既存所属の追加は `member_already_exists`、存在しない所属の解除は `member_not_found`。

### `token:issue <file.json>`

```json
{ "company_id": "<uuid>", "employee_id": "<uuid>" }
```

```json
{"status":"created","token_id":"<uuid>","employee_id":"<uuid>","token":"yori_<secret>"}
```

同じ社員が複数の未失効tokenを持てる。token hashの一意衝突は新しいtokenで最大5回まで再生成し、それでも衝突する場合は `internal_error`（他のDB障害は再生成しない）。

### `token:revoke <file.json>`

```json
{ "company_id": "<uuid>", "token_id": "<uuid>" }
```

```json
{"status":"revoked","token_id":"<uuid>"}
```

物理削除はせず `revoked_at` を設定する。失効済みtokenの再失効は `token_already_revoked`。

### `inspect <company-uuid>`

会社scopeの構成とtoken metadataを返す。生tokenとtoken hashは返さない。

```json
{"status":"ok","company":{"company_id":"<uuid>","name":"example","created_at":"2026-09-25T00:00:00.000Z"},"employees":[{"employee_id":"<uuid>","display_name":"Alice","created_at":"2026-09-25T00:00:00.000Z"}],"projects":[{"project_id":"<uuid>","repository_identifier":"github.com/example/project-a","created_at":"2026-09-25T00:00:00.000Z"}],"members":[{"project_id":"<uuid>","employee_id":"<uuid>","created_at":"2026-09-25T00:00:00.000Z"}],"tokens":[{"token_id":"<uuid>","employee_id":"<uuid>","created_at":"2026-09-25T00:00:00.000Z","revoked_at":null}]}
```

## 4. repository identifierの正規化

`yori` 本体のcollector (`src/collector/remote.ts`) と同じ規則でcanonical化した値を保存する。collectorと違うidentifierを作らない。

| 入力 | 保存される値 |
|---|---|
| `github.com/Org/Repo` | `github.com/Org/Repo` |
| `GitHub.com/Org/Repo.git` | `github.com/Org/Repo` |
| `https://user:password@github.com/Org/Repo.git` | `github.com/Org/Repo` |
| `ssh://git@github.com:22/Org/Repo.git` | `github.com/Org/Repo` |
| `git@github.com:Org/Repo.git` | `github.com/Org/Repo` |
| `https://github.com:8443/Org/Repo` | `github.com:8443/Org/Repo` |
| `git@github.com:2222/Org/Repo.git` | `github.com/2222/Org/Repo` |
| `/local/path`、`not a repository`、空文字 | 拒否 (`invalid_input`) |

repositoryはUTF-8で1024バイト以内。host小文字・先頭slashなし・末尾`.git`なし・path大小文字維持。

## 5. 会社scopeの判定

すべてのコマンドは入力の `company_id` をscopeとしてDB正本で再確認する。

| コマンド | 判定 |
|---|---|
| `employee:create` / `project:create` | 入力会社が無ければ `company_not_found` |
| `inspect` | 入力会社が無ければ `company_not_found` |
| `member:add` / `member:remove` | 案件は入力会社のscope内で解決し、他社・存在しない案件は `project_not_found`。社員はIDで解決し、存在しなければ `employee_not_found`、会社が違えば `company_scope_mismatch` |
| `token:issue` | 社員はIDで解決し、存在しなければ `employee_not_found`、会社が違えば `company_scope_mismatch` |
| `token:revoke` | tokenはIDで解決し、存在しなければ `token_not_found`、token会社または社員会社が違えば `company_scope_mismatch` |

## 6. tokenの紛失と失効

1. 生tokenを紛失した場合は `token:issue` で新しいtokenを発行する。
2. `inspect <company-uuid>` で失効させる `token_id` を確認する。
3. `token:revoke` で紛失したtokenを失効させる。

失効後は同じtokenでAPI認証できない。作成成功後に出力を紛失した場合は同じコマンドを盲目的に再実行せず、まず `inspect` で状態を確認する。

## 7. 固定エラーコード

| code | 意味 |
|---|---|
| `invalid_arguments` | 引数の数・command名・`inspect`のUUID形式が不正 |
| `invalid_admin_config` | `DATABASE_URL` が未設定または空 |
| `invalid_input_file` | 入力fileが読めない、またはJSONとして不正 |
| `invalid_input` | 入力がcontract違反（unknown field、UUID形式、空文字、NUL、単独surrogate、上限超過、repository変換不能、ref重複） |
| `bootstrap_already_completed` | 会社が既に存在する |
| `company_not_found` | 指定会社が存在しない |
| `employee_not_found` | 指定社員が存在しない |
| `project_not_found` | 指定案件が入力会社のscope内に存在しない |
| `token_not_found` | 指定tokenが存在しない |
| `company_scope_mismatch` | 対象が別会社に属する |
| `repository_conflict` | 同じ会社に同じcanonical identifierの案件が存在する |
| `member_already_exists` | 所属が既に存在する |
| `member_not_found` | 解除対象の所属が存在しない |
| `token_already_revoked` | 対象tokenが失効済み |
| `internal_error` | DB接続障害・予期しない例外・token hash再生成の上限到達 |

## 8. テスト

```sh
# テスト専用DBを起動して実行し、終了後に破棄する
npm run test:db

# 既にテストDBがある場合（既定は 127.0.0.1:55432）
npm test
```

テストは実PostgreSQLへ接続し、`src/admin/tests/schema.sql` で `yori` の管理対象tableと同じ契約を適用する。schemaの正本は `yori` の `0001_init.sql`。

## 9. 対象外

- 秘密情報を誰が・どこで・どのsecret managerへ作成・配布・ローテーションするかの運用。
- `.env`、API key、DB password、社員端末の環境変数の作成手順。
- OpenAPI生成、管理Web UI、SSO、管理者アカウント、RBAC。
- 会社・社員・案件の物理削除、表示名やrepository identifierの更新、監査table。
- provider policy承認（`yori` 本体の `provider:approve` / `provider:revoke` を使う）。
