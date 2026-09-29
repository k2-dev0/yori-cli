# yori-cli

`yori-cli` は、yoriで使う会社・社員・案件・案件メンバー・認証トークンを管理するためのCLIです。インストール後は `yori` コマンドで実行します。管理者操作に加え、社員端末へ会話collectorを導入する `collector:*` を提供します。

## 社員端末へのcollector導入（macOS）

対象repositoryのrootで、引数なしで実行します。

```sh
npx yori-cli collector:install
```

- 動作環境はmacOS、Node.js 24以降、`git`。APIは既定で `https://yori-pilot.online`。
- 初回だけKeychain登録の非表示promptが出ます。tokenはKeychainとcollector専用環境変数以外へ保存せず、config・hook・logへ出しません。
- cwdの`git remote.origin.url`から対象repositoryをcanonical化し、`POST /v1/collector/setup`で案件とcurrent伏せ字policyを照合します。
- `~/.codex/hooks.json`と`~/.claude/settings.json`の存在するfile双方へ、`UserPromptSubmit`（notify）と`Stop`（collect）のhookを追加します。どちらも無い場合は`agent_not_found`で終了し、何も変更しません。
- hookは固定のlocal artifact（`~/.local/share/yori/collector/versions/<version>/`）をstable launcher経由で呼び、npxやlatestへ依存しません。
- 設定は`~/.yori-collector.json`、stateは`~/.yori-collector`、token環境変数は`YORI_COLLECTOR_TOKEN`。

継続運用:

| コマンド | 用途 |
|---|---|
| `npx yori-cli collector:update` | 配布artifactをchecksum検証してから切り替え、旧versionを残す。Keychainとstateは変更しない |
| `npx yori-cli collector:doctor` | 秘密を含まない診断（install状態、Keychain、setup APIのcurrent policy version、権限）を表示し、状態を変更しない |
| `npx yori-cli collector:uninstall` | 追加したhook・config・install rootだけを削除する。Keychainと`~/.yori-collector`は保持し、再installでpromptは出ない |

## 実行方法

```sh
DATABASE_URL='<database-url>' yori <command> [argument]
```

リポジトリ内で実行する場合:

```sh
DATABASE_URL='<database-url>' npm run --silent yori -- <command> [argument]
```

## 入出力

- `bootstrap` から `token:revoke` までは、入力をJSONファイルで渡します。
- `inspect` は会社IDを引数で渡します。
- 成功時はstdoutへ1行のJSONを出力し、終了コード `0` で終了します。
- 失敗時はstderrへ `admin: <error-code>` を出力し、終了コード `1` で終了します。

## コマンド

| コマンド | 内容 |
|---|---|
| `bootstrap <file.json>` | 会社、社員、案件、案件メンバー、認証トークンをまとめて初期登録する |
| `company:create <file.json>` | 会社を登録する |
| `employee:create <file.json>` | 指定した会社に社員を登録する |
| `project:create <file.json>` | 指定した会社に案件を登録する |
| `member:add <file.json>` | 案件に社員を追加する |
| `member:remove <file.json>` | 案件から社員を外す |
| `token:issue <file.json>` | 指定した社員の認証トークンを発行する |
| `token:revoke <file.json>` | 認証トークンを失効させる |
| `inspect <company-uuid>` | 指定した会社の社員、案件、案件メンバー、認証トークンを表示する |
| `redaction:replace <file.json>` | 会社のcustom伏せ字policyをtyped ruleで置換する（詳細は[docs/admin.md](docs/admin.md)） |
| `redaction:list <company-uuid>` | 会社のcustom伏せ字policyをtyped ruleで表示する（詳細は[docs/admin.md](docs/admin.md)） |
| `project:repository:add <file.json>` | 案件へcanonical repository aliasを追加する（詳細は[docs/admin.md](docs/admin.md)） |
| `project:repository:remove <file.json>` | 案件からrepository aliasを削除する（詳細は[docs/admin.md](docs/admin.md)） |
| `collector:install` | 社員端末へcollectorを導入する（`DATABASE_URL`不要） |
| `collector:update` | collector artifactを検証して切り替える（`DATABASE_URL`不要） |
| `collector:doctor` | collector導入状態を秘密なしで診断する（`DATABASE_URL`不要） |
| `collector:uninstall` | collectorの所有entry・config・install rootを削除する（`DATABASE_URL`不要） |

## コマンドごとの入出力

### `bootstrap`

入力:

```json
{
  "company": { "name": "example" },
  "employees": [
    { "ref": "alice", "display_name": "Alice", "issue_token": true }
  ],
  "projects": [
    {
      "ref": "project-a",
      "repository": "github.com/example/project-a",
      "member_refs": ["alice"]
    }
  ]
}
```

成功出力:

```json
{
  "status": "created",
  "company": { "company_id": "<uuid>", "name": "example" },
  "employees": [{ "ref": "alice", "employee_id": "<uuid>", "display_name": "Alice" }],
  "projects": [{ "ref": "project-a", "project_id": "<uuid>", "repository_identifier": "github.com/example/project-a" }],
  "members": [{ "project_id": "<uuid>", "employee_id": "<uuid>" }],
  "tokens": [{ "ref": "alice", "token_id": "<uuid>", "employee_id": "<uuid>", "token": "yori_<secret>" }]
}
```

### `company:create`

```text
入力:     { "name": "example" }
成功出力: { "status": "created", "company_id": "<uuid>", "name": "example" }
```

### `employee:create`

```text
入力:     { "company_id": "<uuid>", "display_name": "Alice" }
成功出力: { "status": "created", "employee_id": "<uuid>", "company_id": "<uuid>", "display_name": "Alice" }
```

### `project:create`

```text
入力:     { "company_id": "<uuid>", "repository": "git@github.com:example/project-a.git" }
成功出力: { "status": "created", "project_id": "<uuid>", "company_id": "<uuid>", "repository_identifier": "github.com/example/project-a" }
```

### `member:add`

```text
入力:     { "company_id": "<uuid>", "project_id": "<uuid>", "employee_id": "<uuid>" }
成功出力: { "status": "created", "project_id": "<uuid>", "employee_id": "<uuid>" }
```

### `member:remove`

```text
入力:     { "company_id": "<uuid>", "project_id": "<uuid>", "employee_id": "<uuid>" }
成功出力: { "status": "removed", "project_id": "<uuid>", "employee_id": "<uuid>" }
```

### `token:issue`

```text
入力:     { "company_id": "<uuid>", "employee_id": "<uuid>" }
成功出力: { "status": "created", "token_id": "<uuid>", "employee_id": "<uuid>", "token": "yori_<secret>" }
```

### `token:revoke`

```text
入力:     { "company_id": "<uuid>", "token_id": "<uuid>" }
成功出力: { "status": "revoked", "token_id": "<uuid>" }
```

### `inspect`

```text
入力: yori inspect <company-uuid>
```

成功出力:

```json
{
  "status": "ok",
  "company": { "company_id": "<uuid>", "name": "example", "created_at": "<timestamp>" },
  "employees": [{ "employee_id": "<uuid>", "display_name": "Alice", "created_at": "<timestamp>" }],
  "projects": [{ "project_id": "<uuid>", "repository_identifier": "github.com/example/project-a", "created_at": "<timestamp>" }],
  "members": [{ "project_id": "<uuid>", "employee_id": "<uuid>", "created_at": "<timestamp>" }],
  "tokens": [{ "token_id": "<uuid>", "employee_id": "<uuid>", "created_at": "<timestamp>", "revoked_at": null }]
}
```

エラーコードを含む詳細な仕様は [docs/admin.md](docs/admin.md) を参照してください。
