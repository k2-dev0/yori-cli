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
- `~/.codex`が存在すれば、`hooks.json`が未作成または0バイトでも安全な空objectから作成・修復します。Claude Codeも`~/.claude`が存在すれば、`settings.json`が未作成または0バイトでも同じく空objectから作成・修復し、`UserPromptSubmit`へ同期notifyと非同期notify-late、`Stop`へ同期collectを追加します。notifyは現在入力を最大3秒待ち、未完了結果はnotify-lateまたは次回入力で一度だけ配信します。どちらも検出できない場合は`agent_not_found`で終了します。
- hookは固定のlocal artifact（`~/.local/share/yori/collector/versions/<version>/`）をstable launcher経由で呼び、npxやlatestへ依存しません。manifestとinstall stateはcollector version・Git SHA・SHA-256 checksumを保持し、同一versionで識別情報が違うartifactは拒否します。
- 設定は`~/.yori-collector.json`、stateは`~/.yori-collector`、token環境変数は`YORI_COLLECTOR_TOKEN`。
- `project:add`はcwdのGit remoteを社員tokenの会社へ登録し、新規は`done`、登録済みは`already`を返します。同じ会社の社員は登録済みprojectを共通利用します。
- `me`は通常tokenで本人・会社・現在token・会社projectを表示します。`company:show`、`employee:add`、`employee:rename`、API版token管理は別Keychain service `online.yori.admin`のcompany admin tokenを使い、通常collector tokenを上書きしません。

### yori MCPの登録

`collector:install`と`collector:update`は、検索結果の原文を取得するためのyori MCPをCodexとClaude Codeへ登録します。MCP導入前にinstallした端末は`collector:update`を1回実行すれば登録されます。

| 対象 | 書き込む場所 | 内容 |
|---|---|---|
| Codex | `~/.codex/config.toml`の`[mcp_servers.yori]` | Node.jsとMCP launcherの絶対path、toolごとの`approval_mode` |
| Claude Code | `~/.claude.json`の`mcpServers.yori` | Node.jsとMCP launcherの絶対path |
| Claude Code | `~/.claude/settings.json`の`permissions.allow` | 読み取りtool 3件の許可rule（`mcp__yori__<tool>`） |

- 公開toolは`search_history`・`get_search_result`・`get_evidence`・`record_case`・`link_session`の5件です。
- 読み取り系（`get_search_result`・`get_evidence`・`search_history`）は確認なしで実行できます。書き込み系（`record_case`・`link_session`）は実行前に確認が出ます。Codexは`approval_mode`を読み取り系`approve`・書き込み系`prompt`にし、Claude Codeは書き込み系の許可ruleを書きません。
- 追加・更新・削除するのはyoriの項目だけです。他のMCP server、hook、設定、`config.toml`のコメントと書式は変更しません。何度実行しても結果は同じで、登録内容が既に正しければfileを書き換えません。
- `config.toml`でyoriがインラインテーブルなど別の書き方で定義されている場合は、何も変更せず`collector_hook_conflict`で終了します。該当の定義を手で削除してから再実行してください。
- MCP本体は`~/.local/share/yori/collector/versions/<version>/yori-mcp.mjs`に置き、collectorと同じくversion・Git SHA・SHA-256 checksumを検証します。npxやlatestへは依存しません。
- 登録後は実行中のCodex・Claude Codeを再起動してください。`codex mcp list`と`claude mcp list`に`yori`が表示されれば登録されています。

tokenの扱い:

- tokenの保存先はcollectorと同じKeychain item（service `online.yori.collector`）だけです。`config.toml`・`~/.claude.json`・`settings.json`・コマンド引数・ログへは書きません。
- MCP launcher（`~/.local/share/yori/collector/mcp-launcher.mjs`）が起動のたびにKeychainからtokenを読み、接続先URLとともに子MCPの環境変数（`YORI_API_URL`・`YORI_API_TOKEN`）へだけ渡します。`mcp-config.json`にはこの環境変数の名前だけを書きます。
- 接続先は`~/.yori-collector.json`の`api_url`です。HTTPSだけを許可し、開発時に限りloopback（localhost・127.0.0.1・`::1`）のHTTPを使用できます。
- Keychainにtokenが無い、または設定を読めない場合、launcherはMCPを起動せず標準エラーへ`mcp: launcher_error`だけを出して終了します。

継続運用:

| コマンド | 用途 |
|---|---|
| `npx yori-cli collector:update` | 配布artifactをchecksum検証してから切り替え、旧versionを残す。hookとyori MCPの登録を現在の内容へ揃える。Keychainとstateは変更しない |
| `npx yori-cli collector:doctor` | 秘密を含まない診断（install状態、Keychain、setup APIのcurrent policy version、権限、yori MCPの登録）を表示し、状態を変更しない |
| `npx yori-cli collector:backfill [--dry-run] [--source codex\|claude_code\|deepseek_harness]` | 起動時のrepositoryから過去のroot会話を自動発見する。dry-runは本文・pathを出さず件数とversionだけを表示する |
| `npx yori-cli collector:uninstall` | 追加したhook・yori MCPの登録と許可rule・config・install rootだけを削除する。Keychainと`~/.yori-collector`は保持し、再installでpromptは出ない |

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
- `inspect`・`usage` は会社IDを引数で渡します。
- `inspect`・`usage`・`redaction:list`・`redaction:replace`は`DATABASE_URL`未設定時にSSH alias `yori-production`経由で実行できます。
- 成功時はstdoutへindent付きのJSONを出力し、終了コード `0` で終了します。
- 失敗時はstderrへ `admin: <error-code>` を出力し、終了コード `1` で終了します。

## コマンド

| コマンド | 内容 |
|---|---|
| `bootstrap <file.json>` | 会社、社員、案件、案件メンバー、認証トークンをまとめて初期登録する |
| `company:create <file.json>` | 会社を登録する |
| `employee:create <file.json>` | 指定した会社に社員を登録する |
| `project:create <file.json>` | 指定した会社に案件を登録する |
| `project:add` | cwdのrepositoryを社員tokenの会社へ登録する（JSON・`DATABASE_URL`不要） |
| `project:remove` | cwdのrepositoryの案件を、確認後にcompany admin tokenで収集済みデータごと物理削除する（復元不可。JSON・`DATABASE_URL`不要） |
| `project:remove <file.json>` | 旧DB管理用。案件を収集済みデータごと物理削除する（確認なし。詳細は[docs/admin.md](docs/admin.md)） |
| `employee:add <display-name> [--issue-token]` | company admin tokenで会社へ社員を追加し、option指定時はemployee tokenも続けて発行する（JSON・`DATABASE_URL`不要） |
| `employee:rename <employee-id> <new-display-name>` | company admin tokenで既存社員の表示名を変更する（JSON・`DATABASE_URL`不要） |
| `member:add <file.json>` | 旧DB管理用。案件に社員を追加する |
| `member:remove <file.json>` | 案件から社員を外す |
| `token:issue <file.json>` | 指定した社員の認証トークンを発行する |
| `token:issue <employee-id> --scope employee\|company_admin` | company admin tokenで社員tokenを発行する。生tokenは成功時に一度だけ表示する |
| `token:revoke <file.json>` | 認証トークンを失効させる |
| `token:revoke <token-id>` | company admin tokenでtokenを失効する |
| `me` | 本人・会社・現在token metadata・会社projectを表示する |
| `company:show` | company admin tokenで会社・社員・project・token metadataを表示する |
| `inspect <company-uuid>` | 指定した会社の社員、案件、案件メンバー、認証トークンを表示する |
| `usage <company-uuid> [--days <n>]` | 指定した会社の外部API（Jev・Voyage）の費用と所要時間、jobの待ち・処理時間、自動検索の所要時間を集計する |
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

### `project:remove`

```text
入力:     なし（cwdのGit remoteから案件を解決し、確認へ y と答えたときだけ削除する）
成功出力: { "status": "done", "project_id": "<uuid>" }
```

### `project:remove <file.json>`

```text
入力:     { "company_id": "<uuid>", "project_id": "<uuid>" }
成功出力: { "status": "removed", "project_id": "<uuid>" }
```

### `employee:add`

```text
入力:     employee:add "akiyama"
成功出力: { "status": "done", "employee_id": "<uuid>", "display_name": "akiyama", "created_at": "<timestamp>" }

入力:     employee:add "akiyama" --issue-token
成功出力: { "status": "done", "employee_id": "<uuid>", "display_name": "akiyama", "token_id": "<uuid>", "scope": "employee", "token": "yori_<secret>" }
```

`--issue-token`なしではtokenを発行しない。指定時は社員作成の成功後に既存token APIをemployee scopeで呼び、生tokenを成功出力へ一度だけ含める。token発行だけが失敗した場合、社員は作成済みなので`company:show`でemployee IDを確認し、`token:issue <employee-id> --scope employee`を再実行する。同じ会社のprojectは全社員が共通利用するため、projectごとの所属追加は不要。

### `employee:rename`

```text
入力:     employee:rename <employee-id> "Alicia"
成功出力: { "status": "done", "employee_id": "<uuid>", "display_name": "Alicia" }
```

社員レコードの表示名だけを変更する。既存token・会話履歴・project accessは維持する。

### `member:add <file.json>`

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
入力:     { "company_id": "<uuid>", "employee_id": "<uuid>", "scope": "employee|company_admin" }
成功出力: { "status": "created", "token_id": "<uuid>", "employee_id": "<uuid>", "scope": "employee|company_admin", "token": "yori_<secret>" }
```

`scope`は省略時`employee`。最初の`company_admin` tokenだけは、DBへ接続できる管理環境でこの形式を使って発行する。

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

### `usage`

```text
入力: yori usage <company-uuid> [--days <n>]
```

- 直近`n`日（既定7日、1〜90日）を集計します。日付はUTCです。原文とtokenは読みません。
- 費用は入力token数×単価で、単価はCLIに固定した2026-10-03時点の値です（入力100万tokenあたりJev 0.042ドル、Voyage voyage-4-lite 0.02ドル。Jevの出力は無料）。単価の無いproviderの`cost_usd`は`null`です。
- `jobs`の待ちは作成から最後の開始まで、処理は開始から完了までです。`jev_cost_usd_per_job`はjobに紐付くJevの呼出しだけを数えます。Voyageの呼出しはjobに紐付かないため含みません。
- `auto_search.within_notify_wait_ratio`は、入力時のhookが待つ上限（10秒）以内に完了した自動検索の割合です。
- yori本体のmigration `0021_job_timing_usage_job.sql`の適用前は`internal_error`で終了します。それより前のJevの所要時間はヘッダー受信までの値で、以後は本文受信までの値です。

成功出力:

```json
{
  "status": "ok",
  "company_id": "<uuid>",
  "days": 7,
  "since": "<timestamp>",
  "usd_per_million_input_tokens": { "jev": 0.042, "voyage_direct": 0.02 },
  "daily": [{ "utc_date": "2026-10-03", "provider": "jev", "calls": 120, "failed": 1, "input_tokens": 4200000, "cost_usd": 0.1764 }],
  "operations": [{ "provider": "jev", "operation": "execute_search", "calls": 40, "failed": 0, "input_tokens": 2600000, "cost_usd": 0.1092, "duration_ms_p50": 900, "duration_ms_p90": 1800 }],
  "jobs": [{ "kind": "execute_search", "completed": 20, "jev_cost_usd_per_job": 0.00546, "wait_ms_p50": 0, "wait_ms_p90": 40, "run_ms_p50": 1700, "run_ms_p90": 2400 }],
  "auto_search": { "completed": 20, "within_notify_wait_ratio": 1, "duration_ms_p50": 1800, "duration_ms_p90": 3000 }
}
```

エラーコードを含む詳細な仕様は [docs/admin.md](docs/admin.md) を参照してください。
