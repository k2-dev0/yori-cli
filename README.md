# yori-cli

`yori-cli` は、yoriで使う会社・社員・案件・案件メンバー・認証トークンを管理するためのCLIです。インストール後は `yori` コマンドで実行します。

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
