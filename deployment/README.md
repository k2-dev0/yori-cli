# yori-cli deployment

yori の管理CLIを、yori本体がmigrationを適用したPostgreSQLへ接続するための手順。このrepositoryはmigrationを持たず、schemaの正本はyori本体の `src/db/migrations/*.sql` と `schema_migrations` である。

| file | 役割 |
|---|---|
| `compose.yaml` | `cli` service（tools profile）。yori本体のexternal networkへ参加する |
| `compose.npx.yaml` | public npmの固定versionを秘密を限定したcontainerで実行する |
| `compose.test.yaml` | repository test専用DB。loopback以外へportを公開しない |
| `run-tests.mjs` | test専用DBを起動し、repository test後に破棄する |
| `run-production-integration-smoke.mjs` | yori本体のtest Composeと実migrationを使う合成smoke |

## 1. 本番接続契約

- yori本体が `db` serviceを起動し、migrationを完了していること。CLIはmigrationを実行しない。
- CLIはyori本体のexternal Docker networkだけへ参加する。既定は `yori_default`、別project名なら `YORI_ADMIN_NETWORK` を指定する。
- PostgreSQL hostはnetwork内のservice名 `db`、portは `5432`。CLI側もDB側も本番DB portをhostへ公開しない。
- `YORI_POSTGRES_USER`、`YORI_POSTGRES_PASSWORD`、`YORI_POSTGRES_DB` は未設定・空値を許可しない。固定資格情報へのfallbackはない。
- CLI containerの `DATABASE_URL` は3値からCompose内で構成する。完成済みURLを別のenvへ二重保存しない。
- 3値はyori本体と同じ `/etc/yori/yori.env` から `--env-file` で読む。

`/etc/yori/yori.env` はrepository外に置き、rootまたは運用管理者だけが読める権限にする。値はここへ転記しない。

```dotenv
YORI_POSTGRES_USER=<same-as-yori>
YORI_POSTGRES_PASSWORD=<same-as-yori>
YORI_POSTGRES_DB=<same-as-yori>
```

```sh
sudo chown root:root /etc/yori/yori.env
sudo chmod 600 /etc/yori/yori.env
```

以降の本番コマンド例は、`sudo -i` で開始したrootの対話shell上で実行する前提である。これにより `0600` のenv fileとinput fileを読める。共有session recorderとshell traceは無効にする。

現在のURL組立契約は値をpercent-encodeしない。DB資格情報にはURL予約文字を使わないか、yori本体と同じ事前encode済み値を設定する。

## 2. npm releaseとserver配置

`yori-cli` はpublic npm registryへpublishし、npxの利用者は承認済みversionを固定する。本番Composeは `deployment/compose.yaml` を使うため、serverには対応するreview済みtag / commitのsourceも配置する。source cloneはnpm releaseの代替ではない。配置先は次で固定する。

```text
/srv/yori
/srv/yori-cli
/etc/yori/yori.env
/etc/yori/bootstrap.json
/etc/yori/provider-approvals/
```

1. review済みcommitからversion / tagを固定し、testとpackage dry-run後にpublic npmへpublishする。
2. `npm view yori-cli@<version> dist.integrity` で公開artifactを確認する。
3. yoriとyori-cliのprivate repositoryごとに別のDeploy Keyを作る。
4. GitHub側では両方ともread-onlyで登録する。write accessを有効にしない。
5. serverへ個人GitHub鍵を置かず、2つのDeploy Keyを共有しない。
6. `/srv/yori-cli` へclone後、npmで公開したversionと同じrelease tag / commit SHAをcheckoutする。
7. 更新前のSHAを記録し、`git pull` で無審査のbranch先端へ進めない。

```sh
cd /srv/yori-cli
git rev-parse HEAD
git fetch --tags origin
git checkout --detach <reviewed-commit-sha>
git rev-parse HEAD
```

clone URLとDeploy Keyの選択はserverのSSH configで管理する。秘密鍵、実秘密をrepository、npm package、image、Compose fileへ埋め込まない。

## 3. migration後にbootstrapする

yori本体側で `db` 起動とmigrationを先に完了する。migration未適用、または `schema_migrations` に `0001_init.sql` がないDBをCLIは成功扱いしない。

```sh
cd /srv/yori
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml up -d db
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm migrate

docker network inspect yori_default >/dev/null
```

別のCompose project名を使う場合だけ、`/etc/yori/yori.env` に実network名を追加する。

```dotenv
YORI_ADMIN_NETWORK=<actual-external-network>
```

### 3.1 public npm packageをnpxで実行する

本番DBはhostへport公開しないため、host上のnpxからは接続できない。`compose.npx.yaml` の一時Node containerをyoriのinternal networkへ参加させ、公開npmの承認済みversionを実行する。Composeが `/etc/yori/yori.env` をdotenvとしてparseし、containerへは構成済み `DATABASE_URL` だけを渡す。JevやVoyage等のAPI秘密はcontainerへ渡さない。DB URLはcommand引数やhostのshell historyへ残さない。

```sh
cd /srv/yori-cli
docker compose --env-file /etc/yori/yori.env -f deployment/compose.npx.yaml --profile tools config --quiet
docker compose --env-file /etc/yori/yori.env -f deployment/compose.npx.yaml --profile tools run --rm \
  --volume /etc/yori/bootstrap.json:/input/bootstrap.json:ro \
  cli <reviewed-version> bootstrap /input/bootstrap.json
```

network名が異なる場合は `/etc/yori/yori.env` の `YORI_ADMIN_NETWORK` に実際の外部network名を設定する。`inspect`は末尾のcommand引数を `<reviewed-version> inspect <company-uuid>` へ置き換える。生tokenが出るcommandは後述のtoken取扱いに従う。

### 3.2 source checkoutのCompose serviceを使う

Compose検証は `--quiet` を使う。通常の `docker compose config` は解決済み `DATABASE_URL` をstdoutへ表示するため、共有logや作業記録では実行しない。

```sh
cd /srv/yori-cli
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools config --quiet
```

`bootstrap.json` はrepository外に置き、read-only mountする。API key、DB password、既存tokenを入力fileへ書かない。社員名を含むため管理者限定にする。

```sh
sudo chown root:root /etc/yori/bootstrap.json
sudo chmod 600 /etc/yori/bootstrap.json

cd /srv/yori-cli
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm \
  --volume /etc/yori/bootstrap.json:/input/bootstrap.json:ro \
  cli bootstrap /input/bootstrap.json
```

bootstrapは1回だけ実行する。再実行は `bootstrap_already_completed` で失敗し、既存データを変更しない。成功か不明なら再実行せず、先に `inspect` する。

```sh
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm \
  cli inspect <company-uuid>
```

## 4. token取扱い

- 生tokenは `bootstrap` / `token:issue` 成功時のstdoutに1度だけ現れる。
- 実行は管理者の対話端末で行い、session recorder、CI、共有terminal、`tee`、redirect、shell traceを使わない。
- 管理者は出力から会社指定password managerへ直ちに移す。repository、server file、image、共有logへ保存しない。
- tokenをargvへ渡さない。入力JSONにも既存tokenを書かないため、shell historyへtokenを残さない。
- `docker inspect`、container内 `env`、通常のCompose config出力を共有しない。これらは解決済みDB接続情報を含み得る。
- `inspect` はtoken metadataだけを返し、生tokenとtoken hashを返さない。

## 5. 日常の管理操作

入力JSONは `/etc/yori` 等のrepository外に置き、すべてread-only mountする。

```sh
# 会社作成
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm \
  --volume /etc/yori/company.json:/input/company.json:ro \
  cli company:create /input/company.json

# 案件メンバー追加
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm \
  --volume /etc/yori/member.json:/input/member.json:ro \
  cli member:add /input/member.json

# token発行。出力をfileや共有logへ流さない
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm \
  --volume /etc/yori/token.json:/input/token.json:ro \
  cli token:issue /input/token.json

# token失効
docker compose --env-file /etc/yori/yori.env -f deployment/compose.yaml --profile tools run --rm \
  --volume /etc/yori/revoke.json:/input/revoke.json:ro \
  cli token:revoke /input/revoke.json
```

入力JSONの形式、会社scope、固定エラーコードは [管理コマンド契約](../docs/admin.md) を参照。

## 6. 検証

repository testは専用DBだけを使う。

```sh
npm run test:db
node --test deployment/compose-config.test.mjs
```

yori本体の実migrationとの互換性は合成smokeで検査する。yori本体の `deployment/compose.test.yaml` を固有project・固有volumeで使い、migration前拒否、migration、bootstrap、再実行拒否、inspect非露出を確認してvolumeごと破棄する。通常のyori本番・開発volume、実AWS、実社員データ、実秘密は使わない。

```sh
YORI_REPOSITORY=/srv/yori node deployment/run-production-integration-smoke.mjs
```

本番反映前は、review済みSHAでこの検証を完了し、合成tokenによるyori APIイベント受付は隔離環境で確認する。実Lightsail bootstrapは別の承認済み作業として実施する。
