# yori 管理CLI (`yori`)

会社・社員・案件・案件メンバー・認証トークンを管理するyori-cliのcommand契約。package名は `yori-cli`、実行コマンドは `yori` である。

- DB schemaの正本は `yori` 本体の `src/db/migrations/*.sql` と `schema_migrations`。このrepositoryはmigrationを持たない。
- 会社・社員・案件を物理削除するコマンドは無い。破壊的操作は案件メンバー解除とtoken失効だけ。
- 生の認証トークンは `bootstrap` / `token:issue` の成功時に1度だけstdoutへ出る。DBにはSHA-256だけを保存する。

## 1. 実行方法

### 本番試運転

public npm registryへpublishした `yori-cli` の承認済みversionを固定し、`yori` binをnpxから実行する。

```sh
npx --yes --package=yori-cli@<reviewed-version> yori inspect <company-uuid>
```

`DATABASE_URL` をcommand行へ書かない。本番ではyoriのinternal Docker networkへ参加する一時Node container内でnpxを起動し、`/etc/yori/yori.env` の3値からcontainer内でURLを構成する。migration順序、review済みsource配置、read-only input mount、token非記録は [deployment手順](../deployment/README.md) を正本とする。

`DATABASE_URL` はargvで受け取らない。未設定・空の場合、`inspect` / `usage` / `redaction:replace` / `redaction:list`は本番server `yori-production` の `/srv/yori` で `docker compose -p yori --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm --no-deps -T` を実行し、固定package version（`yori-cli@<package version>`）へ `/usr/bin/ssh`（test/開発時は `YORI_SSH_BIN`）で委ねる。それ以外のDB commandは`invalid_admin_config`で終了する。policy JSONは0600の一時fileだけへ置いてtrapで削除し、containerへread-only mountしてargv・stdout/stderrへ出さない。remoteの既知admin codeだけをそのまま返し、未知code・ssh transport failure・応答契約違反は `internal_error` へ縮退する。本番Composeはyori本体と同じDBの3値からURLを構成する。

`collector:install` / `collector:update` / `collector:doctor` / `collector:backfill` / `collector:export` / `collector:uninstall` / `collector:secret:*` はDBを使わず、`DATABASE_URL` を要求しない。macOS専用で、他platformでは `unsupported_platform` で端末を変更せずに終了する。導入手順と保持するfileは [README](../README.md) を参照。

`project:add`もDBへ直接接続せず、KeychainのYori tokenでHTTPS APIを呼ぶ。cwdのcanonical repositoryをtokenの会社へ登録し、新規は`done`、登録済みは`already`として終了コード0を返す。同じ会社の社員は登録済みprojectを共通利用する。

`me`は通常tokenで本人・会社・現在token metadata・会社projectを取得する。`company:show`、`employee:add <display-name>`、`employee:rename <employee-id> <new-display-name>`、`token:issue <employee-id> --scope employee|company_admin`、`token:revoke <token-id>`はcompany admin tokenをKeychain service `online.yori.admin`へ通常tokenと分離して保存し、HTTPS APIを呼ぶ。会社・token一覧はmetadataだけを返し、生tokenは発行成功時に一度だけstdoutへ出す。token hashは返さない。

### リポジトリ内（開発時）

```sh
DATABASE_URL='<test-or-development-database-url>' npm run --silent yori -- inspect <company-uuid>
```

`npm run` のbannerをstdoutへ混ぜないため `--silent` を使う。

### Compose (tools profile)

yori本体のmigration完了後、本番server `yori-production` の `/srv/yori` でtools profileの `migrate` serviceを一時Node環境として借りる。remote composeに `cli` serviceは無いため、migrationは実行せず `migrate` のentrypointとcommandだけを `npx` へ上書きする。`DATABASE_URL` 未設定時の `inspect` / `usage` / `redaction:replace` / `redaction:list` がssh transportで組み立てるcommandも同じ形である。composeは`YORI_RELEASE_SHA`を必須にしているが、`sudo`は既定で環境変数を引き継がないため、`export`ではなく`sudo env`でsudoの内側から渡す。

```sh
cd /srv/yori
YORI_RELEASE_SHA="$(git rev-parse --verify 'HEAD^{commit}')"
sudo env YORI_RELEASE_SHA="$YORI_RELEASE_SHA" docker compose -p yori --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm --no-deps -T \
  --entrypoint npx migrate --yes --package=yori-cli@<package version> yori inspect <company-uuid>
```

- `YORI_POSTGRES_USER`、`YORI_POSTGRES_PASSWORD`、`YORI_POSTGRES_DB` は必須。固定URLへのfallbackはない。containerの `DATABASE_URL` はyori本体と同じ3値から構成する。
- `yori-cli` は固定package versionをexact指定し、依存はnpxが取得する。`PATH` 解決やlatestへ依存しない。
- `--no-deps -T` で他serviceを起動せず、非対話で1回だけ実行する。

## 2. 入出力の契約

- 入力は常にJSON file。引数の順序誤りとshell履歴への値の露出を避けるため、コマンドライン引数では値を受けない。
- 入力JSONはrepository外のpathでもよく、file pathだけを引数へ渡す。内容はstdout/stderrへ出さない。
- JSON file契約はDBを扱うadmin commandのもの。collector command（`collector:install`等）はJSON fileを要求せず、`collector:secret:add`の値だけはsecurityの非表示promptまたは`--from-env`から受ける。
- 入力JSONはunknown fieldを拒否する (`invalid_input`)。
- 成功時はindent付きのJSON objectだけをstdoutへ出し、終了コード0で終わる。本書の成功出力例は1行に詰めて示す。
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

### `project:remove`

cwdのrepositoryの案件を物理削除する。DBへ直接接続せず、Keychainのcompany admin tokenでHTTPS APIを呼ぶ（JSON・`DATABASE_URL`不要）。

1. cwdのGit remoteをcanonical repositoryへ解決し、`POST /v1/collector/setup` で案件IDを引く。primary repositoryとaliasのどちらからでも同じ案件へ解決する。
2. 削除対象のrepositoryと案件ID、復元できない旨の警告（端末では赤文字）をstderrへ出し、`Are you sure you want to delete it? [y/N]` を英語で尋ねる。
3. stdinの1行目が `y`（大文字小文字は区別しない）のときだけ `DELETE /v1/projects/{project_id}` を呼ぶ。それ以外の入力・入力なしは `project_remove_cancelled` で中止し、何も削除しない。

```json
{"status":"done","project_id":"<uuid>"}
```

- 所属・repository alias・収集済みの会話・検索文書・検索履歴は外部キーの `ON DELETE CASCADE` で同時に消え、復元できない。社員・token・会社のredaction policyは変更しない。
- 社員tokenは `forbidden`。未登録repository・他社の案件は `project_not_found`。
- 削除後はそのrepositoryを案件へ解決できず、新規収集は止まる。社員端末に残る未送信分はAPIが403で拒否し、collectorは恒久失敗として保持する。

### `project:remove <file.json>`

```json
{ "company_id": "<uuid>", "project_id": "<uuid>" }
```

```json
{"status":"removed","project_id":"<uuid>"}
```

引数ありはDBへ直接接続する形で、`DATABASE_URL` が必要。本番server内のCompose実行用であり、確認promptは出さない。削除範囲は引数なしの形と同じ。案件は入力会社のscope内で解決し、他社・存在しない・削除済みの案件は `project_not_found`。

### `employee:add <display-name> [--issue-token]`

```text
employee:add "akiyama"

employee:add "akiyama" --issue-token
```

```json
{"status":"done","employee_id":"<uuid>","display_name":"akiyama","created_at":"2026-09-30T00:00:00.000Z"}

{"status":"done","employee_id":"<uuid>","display_name":"akiyama","token_id":"<uuid>","scope":"employee","token":"yori_<secret>"}
```

company admin tokenで`POST /v1/employees`を呼び、認証tokenの会社へ社員を作成する。会社IDは引数やrequest bodyから受けない。`--issue-token`指定時だけ、作成したemployee IDへ既存のtoken発行APIをemployee scopeで続けて呼び、生tokenを成功出力へ一度だけ含める。token発行だけが失敗した場合は社員が残るため、`company:show`でemployee IDを確認して`token:issue <employee-id> --scope employee`を再実行する。会社内の全社員が会社projectを共通利用するため、project所属の追加は不要。

### `employee:rename <employee-id> <new-display-name>`

```text
employee:rename <employee-id> "Alicia"
```

```json
{"status":"done","employee_id":"<uuid>","display_name":"Alicia"}
```

company admin tokenで`PATCH /v1/employees/:employee_id`を呼び、認証tokenと同じ会社の社員の表示名だけを変更する。既存token・会話履歴・project accessは変更しない。

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
{ "company_id": "<uuid>", "employee_id": "<uuid>", "scope": "company_admin" }
```

```json
{"status":"created","token_id":"<uuid>","employee_id":"<uuid>","scope":"company_admin","token":"yori_<secret>"}
```

`scope`は`employee`または`company_admin`で、省略時は`employee`。最初の`company_admin` tokenは、DBへ接続できる管理環境でこのコマンドを使って発行する。以後はcompany admin tokenを使うHTTPS API版`token:issue <employee-id> --scope ...`で発行できる。同じ社員が複数の未失効tokenを持てる。token hashの一意衝突は新しいtokenで最大5回まで再生成し、それでも衝突する場合は `internal_error`（他のDB障害は再生成しない）。

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
`DATABASE_URL`が未設定・空の場合はSSH transportへ委ね、remote応答をstrict検証する。

```json
{"status":"ok","company":{"company_id":"<uuid>","name":"example","created_at":"2026-09-25T00:00:00.000Z"},"employees":[{"employee_id":"<uuid>","display_name":"Alice","created_at":"2026-09-25T00:00:00.000Z"}],"projects":[{"project_id":"<uuid>","repository_identifier":"github.com/example/project-a","created_at":"2026-09-25T00:00:00.000Z"}],"members":[{"project_id":"<uuid>","employee_id":"<uuid>","created_at":"2026-09-25T00:00:00.000Z"}],"tokens":[{"token_id":"<uuid>","employee_id":"<uuid>","created_at":"2026-09-25T00:00:00.000Z","revoked_at":null}]}
```

### `redaction:replace <file.json>`

会社のcustom伏せ字policy（fields/terms/suspicion_mode）をversion CASで置換する。yori migration `0010_custom_redaction.sql` を適用済みのDBだけが対象で、markerが無ければ `internal_error`。`DATABASE_URL` が未設定・空の場合はSSH transportへ委ねる。

```json
{
  "company_id": "<uuid>",
  "expected_version": 0,
  "fields": ["Pass_Key", "pass.key"],
  "terms": ["example-term", "Example-Term"],
  "suspicion_mode": "observe"
}
```

- `fields` は代入keyの伏せ字対象。ASCII identifier（`^[A-Za-z_][A-Za-z0-9_.-]*$`）・128 code points以内・`redacted` 禁止。case-insensitiveに重複判定する。
- `terms` は本文の完全一致伏せ字対象。1〜512 code points・exact・case-sensitiveに重複判定する。空文字・`REDACTED`・placeholder構文（`[`・`]`・`:`）・placeholder種類名（`jwt`・`business_value`・`known_secret`等）は `invalid_input`。
- `fields` と `terms` の合計は最大100件。null byte・単独surrogate・非string・未知key・欠落key・旧shape（`values`・`rules`・`assignment_keys`・`keys`）は `invalid_input`。
- `suspicion_mode` は `observe`（送信継続）または `block`（message全体を保存させない）。省略は `invalid_input`、`detector_version` keyは受け付けない（現行は `initial-v1` 固定）。
- `expected_version` が0のときだけpolicy行を作りversionは1になる。既存policyへは一致時だけ全置換しversionを1増やす。不一致は `redaction_policy_conflict`、会社が無ければ `company_not_found`。
- 検証はDB接続前に行い、失敗時はversion・fields・terms・suspicion_modeを一切変更しない。delete+insert+version incrementは1 transactionで行い、途中失敗時はrollbackする。
- 入力JSONはrepository外のpathでもよく、値をargvへ出さない。

成功出力例: `{"status":"replaced","company_id":"<uuid>","version":1}`

### `redaction:list <company-id>`

会社のcurrent policyを返す。policy未登録の会社はversion 0・field/term空・`observe` / `initial-v1` を返す。`DATABASE_URL` が未設定・空の場合はSSH transportへ委ねる。

```json
{"version":1,"fields":["Pass_Key"],"terms":["example-term"],"suspicion_mode":"observe","detector_version":"initial-v1"}
```

生token・token hash・DB URLは返さない。

### `project:repository:add` / `project:repository:remove <file.json>`

案件のprimary repositoryとは別にcanonical repository aliasを追加・削除する。

```json
{ "company_id": "<uuid>", "project_id": "<uuid>", "repository": "https://github.com/example/project-a.git" }
```

- repositoryは `project:create` と同じ規則でcanonical化し、変換不能値は `invalid_input`。
- 案件は入力会社のscope内で解決し、他社・存在しない案件は `project_not_found`。
- `project:repository:add` は重複alias・他案件のprimary/aliasとの衝突を `repository_conflict` で拒否する。
- `project:repository:remove` はprimary repositoryを削除できず `repository_conflict`、未登録aliasは `repository_not_found`。
- 追加・削除は1 transactionで行い、yori migration `0010_custom_redaction.sql` が必要。

成功出力例: `{"status":"created","project_id":"<uuid>","repository_identifier":"github.com/example/project-a"}`、removeは `{"status":"removed",...}`。

### `collector:secret:add` / `collector:secret:list` / `collector:secret:remove`

collectorへ渡すknown secretをmacOS Keychain（service `online.yori.collector.secret`）のlabel別itemとして管理する。値はKeychainだけへ置き、argv・index・log・stdout/stderrへ出さない。`DATABASE_URL` は不要。

```sh
yori collector:secret:add <label>                 # securityの非表示promptで値を保存
yori collector:secret:add <label> --from-env ENV  # 環境変数の値をsecurityのstdin経由で保存
yori collector:secret:list                        # labelだけを昇順で表示
yori collector:secret:remove <label>              # Keychain itemとindex entryを削除
```

- indexは `~/.yori-collector/secrets.json` のlabels-only JSON array。labelは1〜128 code points、厳密な昇順・重複なし・最大100件で、modeは0600。
- 値は8〜4096 code points・最大100件・exact重複なし。label違いの同値も拒否する。100件を超えるaddも同様。保存後の検証・index書き込みに失敗した場合はKeychain itemを元の値へ戻して拒否し、rollback自体に失敗した場合は `collector_rollback_failed` になる。
- 成功出力は `{"status":"stored","label":"<label>"}` / `{"labels":["<label>",...]}` / `{"status":"removed","label":"<label>"}`。
- stable launcherはindexのlabel順にKeychain値だけを合成し、子collectorの `YORI_KNOWN_SECRETS_JSON` としてだけ渡す（親envの同名値は上書き）。index不正・item欠落・値の制限違反は子を起動せず `collector: launcher_error` でfail-closedする。

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
| `project:remove` | 案件は入力会社のscope内で解決し、他社・存在しない案件は `project_not_found` |
| `member:add` / `member:remove` | 案件は入力会社のscope内で解決し、他社・存在しない案件は `project_not_found`。社員はIDで解決し、存在しなければ `employee_not_found`、会社が違えば `company_scope_mismatch` |
| `token:issue` | 社員はIDで解決し、存在しなければ `employee_not_found`、会社が違えば `company_scope_mismatch` |
| `token:revoke` | tokenはIDで解決し、存在しなければ `token_not_found`、token会社または社員会社が違えば `company_scope_mismatch` |
| `redaction:replace` / `redaction:list` | 入力会社が無ければ `company_not_found`。policyは会社scopeで解決する |
| `project:repository:add` / `project:repository:remove` | 案件は入力会社のscope内で解決し、他社・存在しない案件は `project_not_found` |

## 6. tokenの紛失と失効

1. 生tokenを紛失した場合は `token:issue` で新しいtokenを発行する。
2. `inspect <company-uuid>` で失効させる `token_id` を確認する。
3. `token:revoke` で紛失したtokenを失効させる。

失効後は同じtokenでAPI認証できない。作成成功後に出力を紛失した場合は同じコマンドを盲目的に再実行せず、まず `inspect` で状態を確認する。

## 7. 固定エラーコード

| code | 意味 |
|---|---|
| `invalid_arguments` | 引数の数・command名・`inspect`のUUID形式が不正 |
| `invalid_admin_config` | SSH対応外のDB commandで`DATABASE_URL`が未設定または空 |
| `invalid_input_file` | 入力fileが読めない、またはJSONとして不正 |
| `invalid_input` | 入力がcontract違反（unknown field、UUID形式、空文字、NUL、単独surrogate、上限超過、repository変換不能、ref重複） |
| `bootstrap_already_completed` | 会社が既に存在する |
| `company_not_found` | 指定会社が存在しない |
| `employee_not_found` | 指定社員が存在しない |
| `project_not_found` | 指定案件が入力会社のscope内に存在しない、またはcollector setup APIが404を返した |
| `project_remove_cancelled` | 引数なしの `project:remove` の確認へ `y` 以外を答えた、または入力が無かった |
| `token_not_found` | 指定tokenが存在しない |
| `company_scope_mismatch` | 対象が別会社に属する |
| `repository_conflict` | 同じ会社に同じcanonical identifierの案件が存在する、またはprimary repository・既存aliasと衝突する |
| `repository_not_found` | 解除対象のrepository aliasが案件scope内に存在しない |
| `redaction_policy_conflict` | `expected_version` がcurrent policy versionと一致しない |
| `member_already_exists` | 所属が既に存在する |
| `member_not_found` | 解除対象の所属が存在しない |
| `token_already_revoked` | 対象tokenが失効済み |
| `internal_error` | migration marker欠落・DB接続障害・予期しない例外・token hash再生成の上限到達 |
| `agent_not_found` | collector導入先のagent設定（Codex / Claude Code）が1件も存在しない |
| `unsupported_platform` | collector commandをmacOS以外で実行した |
| `collector_artifact_invalid` | collector / MCP artifactまたはmanifestの欠落・checksum不一致、MCPとcollectorのversion不一致 |
| `collector_config_invalid` | collector configのapi_urlがhttps/loopback http以外、またはuserinfo・query・fragment付き |
| `collector_hook_invalid` | hook設定またはMCP登録先（`~/.codex/config.toml`・`~/.claude.json`）がsymlink・不正JSON・不正TOML・非object |
| `collector_hook_conflict` | 既存hookに所有entryと競合するcollector設定がある。`config.toml`でyori MCPが別の書き方で定義済み、または書き込み直前に他processが設定を変更した場合も含む |
| `collector_hook_error` | hook書き込みに失敗し、全成果物をrollbackした |
| `collector_keychain_error` | Keychain token / known secretの登録・取得・削除に失敗した |
| `collector_repository_not_found` | cwdのgit originをcanonical repositoryへ解決できない |
| `collector_invalid_request` / `collector_unauthorized` | setup APIが400 / 401を返した。collector:secretのlabel・値・上限・未登録label違反も `collector_invalid_request` |
| `launcher_error`（collector stderr） | stable launcherがindex不正・Keychain item欠落・known secret制限違反を検出し、子collectorを起動しなかった |
| `launcher_error`（mcp stderr） | MCP launcherが設定・install状態を読めない、またはKeychainにtokenが無く、子MCPを起動しなかった |
| `collector_internal_error` | setup APIの500・transport error・応答契約違反。collector:secret indexの破損も含む |
| `collector_not_installed` | `collector:update` / `collector:backfill` / `collector:export` の対象となるinstall状態が無い |
| `collector_backfill_error` | 配布collectorのbackfillが固定契約外の出力または失敗を返した |
| `collector_export_error` | 配布collectorのexportが中央へ届かない・保存に失敗した・固定契約外の出力を返した。launcherがKeychainのtokenを読めない場合も含む |
| `collector_export_output_exists` | 書き出し先に同名のCSVが既にある。上書きしないので、移動か削除をしてから再実行する |
| `forbidden` / `employee_not_found`（`collector:export`） | 社員のtokenで他の社員を指定した / 指定した社員が同じ会社に居ない。中央が書き出しの経路を持たない古い版の場合も `employee_not_found` になる |
| `collector_install_error` | 端末側fileへの書き込みに失敗し、全成果物をrollbackした |
| `collector_rollback_failed` | 失敗時のrollback自体に失敗した |

## 8. テスト

```sh
# テスト専用DBを起動して実行し、終了後に破棄する
npm run test:db
node --test deployment/compose-config.test.mjs
node deployment/run-production-integration-smoke.mjs

# 既にテストDBがある場合（既定は 127.0.0.1:55432）
npm test
```

repository testは `src/admin/tests/schema.sql` で管理対象table契約を高速に検査する。加えてintegration smokeがyori本体の実migratorと全migrationを専用DBへ適用し、migration前拒否とbootstrap / inspectを検査する。

## 9. 対象外

- 秘密情報を誰が・どこで・どのsecret managerへ作成・配布・ローテーションするかの運用。
- `.env`、API key、DB password、社員端末の環境変数の作成手順。
- OpenAPI生成、管理Web UI、SSO、管理者アカウント、RBAC。
- 会社・社員の物理削除、表示名やrepository identifierの更新、監査table。
- provider policy承認（`yori` 本体の `provider:approve` / `provider:revoke` を使う）。
