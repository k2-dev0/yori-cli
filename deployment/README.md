# yori-cli deployment

管理CLI (`yori-admin`) の実行経路。DB schemaの正本は `yori` 本体の `src/db/migrations/0001_init.sql` で、このリポジトリはmigrationを持たない。

| file | 役割 |
|---|---|
| `compose.yaml` | `admin` service (tools profile)。yori本体のCompose networkへ参加して共有DBへ接続する |
| `compose.test.yaml` | テスト専用DB。loopbackのみへ公開し、yori本体のproject・volumeと共有しない |
| `run-tests.mjs` | テスト専用DBを起動 → ホストの `npm test` → 破棄 |

## 1. 前提

- yori本体のmigration適用済みDBがあること（`companies` / `employees` / `projects` / `project_members` / `auth_tokens`）。
- admin serviceはyori本体のCompose project `yori` が作るnetwork `yori_default` へ参加する。別名の場合は `YORI_ADMIN_NETWORK` を指定する。
- 接続先の既定は `postgres://yori:yori@db:5432/yori`。変更する場合は `YORI_ADMIN_DATABASE_URL` を指定する。

## 2. 初期導線（migration適用後、worker起動前に1回だけ）

```sh
# 1. yori本体 (別リポジトリ) でmigrationを適用する
docker compose -p yori -f deployment/compose.yaml --profile tools run --rm migrate

# 2. 空DBへ最小構成を1 transactionで登録する
docker compose -f deployment/compose.yaml --profile tools run --rm \
  -v "$PWD/bootstrap.json:/input/bootstrap.json:ro" admin bootstrap /input/bootstrap.json

# 3. 返ったIDを `inspect` で照合する
docker compose -f deployment/compose.yaml --profile tools run --rm admin inspect <company-uuid>
```

- `bootstrap` は1回だけ実行する。会社が既に存在する場合は `bootstrap_already_completed` で何も変更しない。
- 生tokenは `bootstrap` の成功stdoutに1度だけ現れる。本番ではstdoutを共有ログへ流さず、管理者が直接受け取る。保存・配布方法は別の秘密情報作成手順で決める。
- 入力fileはcontainer内のpathで渡す。リポジトリ外のfileは `-v` でmountする。

## 3. 日常の管理操作

clone せずに実行する場合は、公開packageを `npx` から使う（DBへ到達できるホストで実行する）。

```sh
export DATABASE_URL='postgres://yori:yori@<host>:5432/yori'
npx --yes yori-cli inspect <company-uuid>
```

Compose tools profile から実行する場合:

```sh
# 会社・社員・案件の追加
docker compose -f deployment/compose.yaml --profile tools run --rm \
  -v "$PWD/company.json:/input/company.json:ro" admin company:create /input/company.json

# 案件メンバーの追加・解除
docker compose -f deployment/compose.yaml --profile tools run --rm \
  -v "$PWD/member.json:/input/member.json:ro" admin member:add /input/member.json

# tokenの発行（生tokenはこの成功出力にだけ現れる）と失効
docker compose -f deployment/compose.yaml --profile tools run --rm \
  -v "$PWD/token.json:/input/token.json:ro" admin token:issue /input/token.json
docker compose -f deployment/compose.yaml --profile tools run --rm \
  -v "$PWD/revoke.json:/input/revoke.json:ro" admin token:revoke /input/revoke.json

# 会社scopeの構成確認（生token・token hashは返さない）
docker compose -f deployment/compose.yaml --profile tools run --rm admin inspect <company-uuid>
```

入力JSONの形式、出力例、会社scopeの判定、固定エラーコードは [docs/admin.md](../docs/admin.md) を参照。

## 4. ロールアウトと復旧

1. 隔離テストDBで全コマンドを検証する（`npm run test:db`）。
2. ステージングDBを空にした状態で `bootstrap` を実行し、返ったIDと `inspect` を照合する。
3. 発行tokenで合成イベントを送信し、API認証と案件認可を確認する。
4. tokenを失効し、同じtokenが拒否されることを確認する。
5. 本番migration適用後、worker起動前に `bootstrap` を1回だけ実行する。

途中失敗時はtransaction rollbackが正本で、自動補償処理は行わない。成功か不明な場合は再実行せず、まず `inspect` でDB状態を確認する。誤登録を取り消す物理削除コマンドは無い。

## 5. テスト

```sh
# テスト専用DBを起動 → 実PostgreSQLテスト → 破棄
npm run test:db

# 既にテストDBがある場合（既定 127.0.0.1:55432）
npm test
```

- テスト専用project名は既定で `yori-cli-test`。`yori` を指定すると開発DBを共有するため拒否する。
- DB portは `YORI_CLI_TEST_DB_PORT`（既定 `55432`）で変更できる。
- `src/admin/tests/schema.sql` は `yori` の `0001_init.sql:6-45` と同じ契約をテスト用に再現したもの。schemaの正本は `yori` 側にある。
