# yori-cli

`yori-cli` は、yoriで使う会社・社員・案件・案件メンバー・認証トークンを管理するためのCLIです。インストール後は `yori` コマンドで実行します。管理者操作に加え、社員端末へ会話collectorを導入する `collector:*` を提供します。

## 社員端末へのcollector導入（macOS）

対象repositoryのrootで、引数なしで実行します。

```sh
npx yori-cli project:add
npx yori-cli collector:install
```

- 動作環境はmacOS、Node.js 24以降、`git`。APIは既定で `https://yori-pilot.online`。
- 初回だけ「Yori tokenを2回入力」と案内してからKeychainの非表示promptを開きます。tokenはKeychainとcollector専用環境変数以外へ保存せず、config・hook・logへ出しません。
- cwdの`git remote.origin.url`から対象repositoryをcanonical化します。認証なしsetup probeの正規401でAPI互換性を確認してから、Bearer付き`POST /v1/collector/setup`で案件とcurrent伏せ字policyを照合します。旧APIのroute-not-foundは`collector_server_incompatible`です。
- `~/.codex`が存在すれば、`hooks.json`が未作成または0バイトでも安全な空objectから作成・修復します。Claude Codeは既存`~/.claude/settings.json`を対象にし、`UserPromptSubmit`へ同期notifyと非同期notify-late、`Stop`へ同期collectを追加します。notifyは現在入力を最大3秒待ち、未完了結果はnotify-lateまたは次回入力で一度だけ配信します。どちらも検出できない場合は`agent_not_found`で終了します。
- hookは固定のlocal artifact（`~/.local/share/yori/collector/versions/<version>/`）をstable launcher経由で呼び、npxやlatestへ依存しません。manifestとinstall stateはcollector version・Git SHA・SHA-256 checksumを保持し、同一versionで識別情報が違うartifactは拒否します。
- 設定は`~/.yori-collector.json`、stateは`~/.yori-collector`、token環境変数は`YORI_COLLECTOR_TOKEN`。
- `project:add`はcwdのGit remoteを社員tokenの会社へ登録し、新規は`done`、登録済みは`already`を返します。同じ会社の社員は登録済みprojectを共通利用します。
- `me`は通常tokenで本人・会社・現在token・会社projectを表示します。`company:show`とAPI版token管理は別Keychain service `online.yori.admin`のcompany admin tokenを使い、通常collector tokenを上書きしません。

継続運用:

| コマンド | 用途 |
|---|---|
| `npx yori-cli collector:update` | 配布artifactをchecksum検証してから切り替え、旧versionを残す。Keychainとstateは変更しない |
| `npx yori-cli collector:doctor` | 秘密を含まない診断（install状態、Keychain、setup APIのcurrent policy version、権限）を表示し、状態を変更しない |
| `npx yori-cli collector:backfill [--dry-run] [--source codex\|claude_code\|deepseek_harness]` | 起動時のrepositoryから過去のroot会話を自動発見する。dry-runは本文・pathを出さず件数とversionだけを表示する |
| `npx yori-cli collector:uninstall` | 追加したhook・config・install rootだけを削除する。Keychainと`~/.yori-collector`は保持し、再installでpromptは出ない |

過去履歴は対象repositoryのrootで実行します。repository pathの引数は不要です。

```sh
# Codex・Claude Code・DeepSeek Harnessの対象件数だけを確認する
npx yori-cli collector:backfill --dry-run

# 確認後に既存の伏せ字・policy・revision・冪等送信を使って登録する
npx yori-cli collector:backfill

# 1 sourceだけを対象にする
npx yori-cli collector:backfill --source deepseek_harness --dry-run
```

- Codexは通常sessionsとarchived_sessionsの`source=cli` root threadだけを対象にし、`response_item`とsubagentを除外します。
- Claude Codeはrepository完全一致のroot transcriptだけを対象にし、sidechain・meta・tool resultを除外します。
- DeepSeek Harnessはversion 3・`delegationDepth=0`・非seeded sessionだけを対象にし、user本文とcompleted turn最後のassistant本文だけを扱います。reasoning・tool call・tool result・system messageは収集しません。
- Cursorは公式hookによる今後の会話収集だけを対象とし、過去履歴のbackfillには対応しません。`--source cursor`は拒否し、Cursorの非公開DBや未検証transcriptを探索しません。
- `--dry-run`はHTTP送信とcollector state更新を行いません。成功出力には本文、repository path、session IDを含めません。

known secret（会話本文で完全一致させて伏せたい値）は`collector:secret:*`で管理します。

| コマンド | 用途 |
|---|---|
| `npx yori-cli collector:secret:add <label>` | securityの非表示promptの値をKeychain（service `online.yori.collector.secret`）へ保存する。`--from-env <ENV_NAME>`は環境変数の値をsecurityのstdin経由で渡す |
| `npx yori-cli collector:secret:list` | indexにあるlabelだけを昇順で表示する。値は表示しない |
| `npx yori-cli collector:secret:remove <label>` | 指定labelのKeychain itemとindex entryだけを削除する |

- indexは`~/.yori-collector/secrets.json`のlabels-only JSON array（labelは1〜128 code points、厳密な昇順、0600）。値はKeychainだけへ置き、argv・stdout/stderr・logへ出しません。
- known secretは8〜4096 code points・最大100件・exact重複なし。保存後の検証・index書き込みに失敗した場合はKeychain itemを元へ戻して拒否します。
- stable launcherはindexのlabel順にKeychain値だけを合成し、子collectorへ`YORI_KNOWN_SECRETS_JSON`としてだけ渡します（親envの同名値は上書き）。index不正・item欠落・値の制限違反は子を起動せず`collector: launcher_error`でfail-closedします。

## 実行方法

```sh
DATABASE_URL='<database-url>' yori <command> [argument]
```

リポジトリ内で実行する場合:

```sh
DATABASE_URL='<database-url>' npm run --silent yori -- <command> [argument]
```

## 入出力

- DB直結の従来管理コマンドは入力をJSONファイルで渡します。社員向けHTTPS APIコマンドはJSONファイルを要求しません。
- `inspect` は会社IDを引数で渡します。
- `inspect`・`redaction:list`・`redaction:replace`は`DATABASE_URL`未設定時にSSH alias `yori-production`経由で実行できます。
- 成功時はstdoutへ1行のJSONを出力し、終了コード `0` で終了します。
- 失敗時はstderrへ `admin: <error-code>` を出力し、終了コード `1` で終了します。

## コマンド

| コマンド | 内容 |
|---|---|
| `bootstrap <file.json>` | 会社、社員、案件、案件メンバー、認証トークンをまとめて初期登録する |
| `company:create <file.json>` | 会社を登録する |
| `employee:create <file.json>` | 指定した会社に社員を登録する |
| `project:create <file.json>` | 指定した会社に案件を登録する |
| `project:add` | cwdのrepositoryを社員tokenの会社へ登録する（JSON・`DATABASE_URL`不要） |
| `member:add <file.json>` | 案件に社員を追加する |
| `member:remove <file.json>` | 案件から社員を外す |
| `token:issue <file.json>` | 指定した社員の認証トークンを発行する |
| `token:issue <employee-id> --scope employee\|company_admin` | company admin tokenで社員tokenを発行する。生tokenは成功時に一度だけ表示する |
| `token:revoke <file.json>` | 認証トークンを失効させる |
| `token:revoke <token-id>` | company admin tokenでtokenを失効する |
| `me` | 本人・会社・現在token metadata・会社projectを表示する |
| `company:show` | company admin tokenで会社・社員・project・token metadataを表示する |
| `inspect <company-uuid>` | 指定した会社の社員、案件、案件メンバー、認証トークンを表示する |
| `redaction:replace <file.json>` | 会社のcustom伏せ字fields/terms policyを置換する（詳細は[docs/admin.md](docs/admin.md)） |
| `redaction:list <company-uuid>` | 会社のcustom伏せ字fields/terms policyを表示する（詳細は[docs/admin.md](docs/admin.md)） |
| `project:repository:add <file.json>` | 案件へcanonical repository aliasを追加する（詳細は[docs/admin.md](docs/admin.md)） |
| `project:repository:remove <file.json>` | 案件からrepository aliasを削除する（詳細は[docs/admin.md](docs/admin.md)） |
| `collector:install` | 社員端末へcollectorを導入する（`DATABASE_URL`不要） |
| `collector:update` | collector artifactを検証して切り替える（`DATABASE_URL`不要） |
| `collector:doctor` | collector導入状態を秘密なしで診断する（`DATABASE_URL`不要） |
| `collector:backfill [--dry-run] [--source codex\|claude_code\|deepseek_harness]` | cwdのrepositoryから過去のroot会話を回収する（`DATABASE_URL`不要） |
| `collector:uninstall` | collectorの所有entry・config・install rootを削除する（`DATABASE_URL`不要） |
| `collector:secret:add <label>` | known secretをKeychainへ保存する（`--from-env <ENV_NAME>`、`DATABASE_URL`不要） |
| `collector:secret:list` | known secretのlabelだけを昇順で表示する（`DATABASE_URL`不要） |
| `collector:secret:remove <label>` | 指定labelのKeychain itemとindex entryだけを削除する（`DATABASE_URL`不要） |

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
