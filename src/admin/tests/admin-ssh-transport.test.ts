import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  parseSuccessJson,
  readSshInvocations,
  runAdmin,
  withInputFile,
  withSshFixture,
  writeSshResponse,
  type AdminRun,
  type SshResponse,
} from './support.js';

// DATABASE_URLなしのredaction:replace / redaction:listだけが /usr/bin/ssh yori-production bash -s へ委ね、
// 合成したbash scriptだけをstdinへ渡す。実ssh・実host・実networkへは接続しない。
// remote composeにcli serviceは無いため、tools profileのmigrate serviceを--entrypoint npxで
// 一時Node環境として上書きし、migrationは実行しない。
// inspectも同じSSH transportへ委ね、company:create等の書込みcommandはDATABASE_URL欠落を拒否する。
// policy text等の入力は0600の一時fileを含むstdin script内だけに置き、argv・エラー出力・logへ出さない。
const SSH_HOST = 'yori-production';
const COMPANY_ID = '01930000-0000-7000-8000-000000000042';
const OTHER_COMPANY_ID = '01930000-0000-7000-8000-000000000099';

function cliVersion(): string {
  const parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
  return parsed.version;
}

interface TransportRun {
  run: AdminRun;
  args: string[];
  stdin: string;
  invocationCount: number;
}

async function runTransport(
  args: string[],
  options: {
    input?: { name: string; content: unknown };
    response?: SshResponse;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<TransportRun> {
  return withSshFixture(async (fixture) => {
    await writeSshResponse(fixture, options.response ?? {});
    const env: Record<string, string | undefined> = {
      DATABASE_URL: undefined,
      YORI_SSH_BIN: fixture.binPath,
      YORI_TEST_SSH_DIR: fixture.root,
      ...options.env,
    };
    const run = options.input
      ? await withInputFile(options.input.name, options.input.content, (filePath) => runAdmin([...args, filePath], { env }))
      : await runAdmin(args, { env });
    const invocations = await readSshInvocations(fixture);
    return { run, args: invocations[0]?.args ?? [], stdin: invocations[0]?.stdin ?? '', invocationCount: invocations.length };
  });
}

// 生成scriptが存在しないpath/serviceを参照していたら失敗させる。
// remote composeにcli serviceは無いため、docker compose runのserviceはmigrateだけを許可する。
function assertRemoteReferencesExist(stdin: string): void {
  const composeLines = stdin.split('\n').filter((line) => line.includes('docker compose'));
  assert.equal(composeLines.length, 1, `docker compose commandが1つではない: ${JSON.stringify(stdin)}`);
  const composeLine = composeLines[0] as string;
  assert.match(
    composeLine,
    /^sudo docker compose -p yori --env-file \/etc\/yori\/yori\.env -f deployment\/compose\.yaml --profile tools run --rm --no-deps -T /,
    `既知のcompose commandではない: ${JSON.stringify(composeLine)}`,
  );
  const afterRun = composeLine.replace(/^.*run --rm --no-deps -T /, '');
  const withoutMount = afterRun.replace(/^--volume "\$input:\/input\/redaction\.json:ro" /, '');
  assert.match(
    withoutMount,
    /^--entrypoint npx migrate(?: |$)/,
    `service migrateのnpx起動ではない: ${JSON.stringify(composeLine)}`,
  );
  assert.ok(!/(?:^|\s)cli(?:\s|$)/.test(afterRun), `存在しないcli serviceを参照している: ${JSON.stringify(composeLine)}`);
  for (const missing of ['/srv/yori-cli', 'compose.npx.yaml']) {
    assert.ok(!stdin.includes(missing), `存在しないpathを参照している: ${missing}`);
  }
}

// 本番serverの配置 (/srv/yori)・env file・project yori・deployment/compose.yaml・
// tools profileのmigrate serviceをnpxで上書きする1回だけのcompose runを検査する。
function assertComposeContract(stdin: string): void {
  assert.ok(stdin.includes('cd /srv/yori'), `cd /srv/yoriがない: ${JSON.stringify(stdin)}`);
  const cdIndex = stdin.indexOf('cd /srv/yori');
  const releaseShaIndex = stdin.indexOf('export YORI_RELEASE_SHA="$(git rev-parse --verify \'HEAD^{commit}\')"');
  const composeIndex = stdin.indexOf('sudo docker compose');
  assert.ok(releaseShaIndex > cdIndex, `repository移動後のYORI_RELEASE_SHA解決がない: ${JSON.stringify(stdin)}`);
  assert.ok(composeIndex > releaseShaIndex, `YORI_RELEASE_SHA解決前にcomposeを起動している: ${JSON.stringify(stdin)}`);
  assert.ok(stdin.includes('/etc/yori/yori.env'), `env fileがない: ${JSON.stringify(stdin)}`);
  assert.ok(stdin.includes('deployment/compose.yaml'), `deployment/compose.yamlがない: ${JSON.stringify(stdin)}`);
  assert.ok(!stdin.includes('compose.npx.yaml'), '旧compose.npx.yamlを使っている');
  assert.ok(!stdin.includes('/srv/yori-cli'), '旧/srv/yori-cli配置を使っている');
  assert.match(stdin, /docker compose -p yori /, `project yoriがない: ${JSON.stringify(stdin)}`);
  assert.match(stdin, /--profile tools run --rm --no-deps -T/, `tools run --rm --no-deps -Tがない: ${JSON.stringify(stdin)}`);
  assert.ok(!stdin.includes('run --rm --no-deps -T migrate'), `migrationを先に実行している: ${JSON.stringify(stdin)}`);
  assertRemoteReferencesExist(stdin);
}

// replaceだけがpolicy JSONを0600の一時fileへ置き、trapで削除してread-only mountし、
// CLIへはcontainer pathだけを渡す（host temp pathをargvへ出さない）。
function assertReplaceTempInputContract(stdin: string): void {
  assert.match(stdin, /input=\$\(mktemp\)/, `mktempがない: ${JSON.stringify(stdin)}`);
  assert.match(stdin, /chmod 600 "\$input"/, `0600指定がない: ${JSON.stringify(stdin)}`);
  assert.match(stdin, /trap 'rm -f "\$input"' EXIT/, `trap cleanupがない: ${JSON.stringify(stdin)}`);
  assert.match(stdin, /--volume "\$input:\/input\/redaction\.json:ro"/, `read-only input mountがない: ${JSON.stringify(stdin)}`);
  assert.match(stdin, /'redaction:replace' '\/input\/redaction\.json'/, `temp inputのcontainer pathをCLIへ渡していない: ${JSON.stringify(stdin)}`);
  assert.ok(!stdin.includes(`'redaction:replace' "$input"`), 'host temp pathをCLI引数へ渡している');
  assert.ok(!stdin.includes(`'redaction:replace' '$input'`), 'host temp pathをCLI引数へ渡している');
}

describe('admin commandのmacOS SSH transport', () => {
  it('DATABASE_URLなしのcompany:createはssh transportへ委ねずinvalid_admin_configで拒否する', async () => {
    const create = await runTransport(['company:create'], { input: { name: 'company.json', content: { name: 'example' } } });
    assert.equal(create.run.code, 1, `company:createが失敗していない: stdout=${create.run.stdout} stderr=${create.run.stderr}`);
    assert.equal(create.run.stdout, '');
    assert.equal(create.run.stderr, 'admin: invalid_admin_config\n');
    assert.equal(create.invocationCount, 0, 'company:createがadmin用ssh transportを起動している');

    // inspectの引数検証はSSH起動より先に行う。
    const invalidArguments = await runTransport(['inspect', 'not-a-uuid']);
    assert.equal(invalidArguments.run.code, 1);
    assert.equal(invalidArguments.run.stdout, '');
    assert.equal(invalidArguments.run.stderr, 'admin: invalid_arguments\n');
    assert.equal(invalidArguments.invocationCount, 0, 'inspectが引数検証より先にsshを起動している');
  });

  it('inspectをSSHへ委ね、会社scopeのproject一覧を含むstrictな応答だけを返す', async () => {
    const remote = {
      status: 'ok',
      company: { company_id: COMPANY_ID, name: 'example', created_at: '2026-09-30T00:00:00.000Z' },
      employees: [{ employee_id: '01930000-0000-7000-8000-000000000043', display_name: 'employee', created_at: '2026-09-30T00:00:00.000Z' }],
      projects: [{ project_id: '01930000-0000-7000-8000-000000000044', repository_identifier: 'github.com/example/repo', created_at: '2026-09-30T00:00:00.000Z' }],
      members: [{ project_id: '01930000-0000-7000-8000-000000000044', employee_id: '01930000-0000-7000-8000-000000000043', created_at: '2026-09-30T00:00:00.000Z' }],
      tokens: [{ token_id: '01930000-0000-7000-8000-000000000045', employee_id: '01930000-0000-7000-8000-000000000043', created_at: '2026-09-30T00:00:00.000Z', revoked_at: null }],
    };
    const { run, stdin, invocationCount } = await runTransport(['inspect', COMPANY_ID], {
      response: { stdout: `${JSON.stringify(remote)}\n` },
    });
    assert.equal(run.code, 0, `inspect SSHが失敗した: ${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), remote);
    assert.equal(invocationCount, 1);
    assertComposeContract(stdin);
    assert.ok(stdin.includes(`'inspect' '${COMPANY_ID}'`), `remote inspect invocationがない: ${stdin}`);
    assert.ok(!run.stdout.includes('token_hash') && !run.stdout.includes('yori_'), 'token秘密を返している');

    const invalid = await runTransport(['inspect', COMPANY_ID], {
      response: { stdout: `${JSON.stringify({ ...remote, unexpected: true })}\n` },
    });
    assert.equal(invalid.run.code, 1);
    assert.equal(invalid.run.stderr, 'admin: internal_error\n');
    assert.equal(invalid.run.stdout, '');
  });

  it('redaction:replaceのpolicy textは0600一時fileとssh stdin scriptだけへ置き、argv・stdout・stderrへ出さない', async () => {
    const input = {
      company_id: COMPANY_ID,
      expected_version: 0,
      fields: ['synthetic-field-marker'],
      terms: ['synthetic-term-marker'],
      suspicion_mode: 'block',
    };
    const { run, args, stdin, invocationCount } = await runTransport(['redaction:replace'], {
      input: { name: 'redaction.json', content: input },
      response: { stdout: `{"status":"replaced","company_id":"${COMPANY_ID}","version":1}\n` },
    });

    assert.equal(run.code, 0, `終了コードが0ではない: stderr=${run.stderr}`);
    assert.equal(invocationCount, 1);
    assert.deepEqual(args, [SSH_HOST, 'bash', '-s'], `ssh argvが変わっている: ${JSON.stringify(args)}`);
    assertComposeContract(stdin);
    assertReplaceTempInputContract(stdin);
    assert.ok(
      stdin.includes(`'--package=yori-cli@${cliVersion()}'`),
      `固定package versionのexact指定がない: ${JSON.stringify(stdin)}`,
    );
    assert.ok(stdin.includes('synthetic-field-marker') && stdin.includes('synthetic-term-marker'), 'policy textがssh stdin scriptへない');
    for (const forbidden of ['synthetic-field-marker', 'synthetic-term-marker']) {
      assert.ok(!args.join(' ').includes(forbidden), `ssh argvへpolicy textが出ている: ${forbidden}`);
      assert.ok(!run.stdout.includes(forbidden), `stdoutへpolicy textが出ている: ${forbidden}`);
      assert.ok(!run.stderr.includes(forbidden), `stderrへpolicy textが出ている: ${forbidden}`);
    }
  });

  it('redaction:listをssh scriptへ委ね、company UUIDを渡してremote JSONを検証・昇順化して返す', async () => {
    const remoteStdout = `{"version":2,"fields":["pass_key","Pass"],"terms":["beta-term","alpha-term"],"suspicion_mode":"block","detector_version":"initial-v1"}\n`;
    const { run, stdin, invocationCount } = await runTransport(['redaction:list', COMPANY_ID], {
      response: { stdout: remoteStdout },
    });

    assert.equal(run.code, 0, `終了コードが0ではない: stderr=${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), {
      version: 2,
      fields: ['Pass', 'pass_key'],
      terms: ['alpha-term', 'beta-term'],
      suspicion_mode: 'block',
      detector_version: 'initial-v1',
    });
    assert.equal(invocationCount, 1);
    assertComposeContract(stdin);
    assert.ok(stdin.includes(`'${COMPANY_ID}'`), `company UUIDをCLIへ渡していない: ${JSON.stringify(stdin)}`);
    assert.ok(!stdin.includes('mktemp'), 'listが一時fileを作成している');
    assert.ok(
      stdin.includes(`'--package=yori-cli@${cliVersion()}'`),
      `固定package versionのexact指定がない: ${JSON.stringify(stdin)}`,
    );
    assert.ok(!stdin.includes('postgres://'), 'ssh stdin scriptへDB URLを出している');
  });

  it('redaction:replaceのremote応答は契約外のJSONをinternal_errorで拒否する', async () => {
    const input = { company_id: COMPANY_ID, expected_version: 0, fields: [], terms: [], suspicion_mode: 'observe' };
    const invalidOutputs: { label: string; stdout: string }[] = [
      { label: 'extra key', stdout: JSON.stringify({ status: 'replaced', company_id: COMPANY_ID, version: 1, extra: true }) },
      { label: 'version欠落', stdout: JSON.stringify({ status: 'replaced', company_id: COMPANY_ID }) },
      { label: 'status違い', stdout: JSON.stringify({ status: 'ok', company_id: COMPANY_ID, version: 1 }) },
      { label: '別会社', stdout: JSON.stringify({ status: 'replaced', company_id: OTHER_COMPANY_ID, version: 1 }) },
      { label: 'version不一致', stdout: JSON.stringify({ status: 'replaced', company_id: COMPANY_ID, version: 2 }) },
      { label: '非object', stdout: JSON.stringify(['replaced', COMPANY_ID, 1]) },
    ];
    for (const invalid of invalidOutputs) {
      const { run, invocationCount } = await runTransport(['redaction:replace'], {
        input: { name: 'redaction.json', content: input },
        response: { stdout: `${invalid.stdout}\n` },
      });
      assert.equal(invocationCount, 1, `${invalid.label} でssh回数が違う`);
      assert.equal(run.code, 1, `${invalid.label} が成功している: stdout=${run.stdout}`);
      assert.equal(run.stdout, '', `${invalid.label} の応答をstdoutへ出している`);
      assert.equal(run.stderr, 'admin: internal_error\n', `${invalid.label} の固定codeが違う: ${run.stderr}`);
      assert.ok(!run.stdout.includes(COMPANY_ID) && !run.stderr.includes(COMPANY_ID), `${invalid.label} の応答値を出している`);
    }
  });

  it('redaction:listのremote応答は契約外のJSONをinternal_errorで拒否する', async () => {
    const valid = { version: 0, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' };
    const invalidOutputs: { label: string; stdout: string }[] = [
      { label: 'extra key', stdout: JSON.stringify({ ...valid, extra: true }) },
      { label: 'detector_version欠落', stdout: JSON.stringify({ version: 0, fields: [], terms: [], suspicion_mode: 'observe' }) },
      { label: 'detector_version違い', stdout: JSON.stringify({ ...valid, detector_version: 'v2' }) },
      { label: 'suspicion_mode違い', stdout: JSON.stringify({ ...valid, suspicion_mode: 'warn' }) },
      { label: 'fields非配列', stdout: JSON.stringify({ ...valid, fields: 'none' }) },
      { label: 'version非整数', stdout: JSON.stringify({ ...valid, version: 0.5 }) },
      { label: 'field identifier', stdout: JSON.stringify({ ...valid, fields: ['1bad'] }) },
      { label: 'field 129cp', stdout: JSON.stringify({ ...valid, fields: ['a'.repeat(129)] }) },
      { label: 'field case重複', stdout: JSON.stringify({ ...valid, fields: ['dup_field_MARKER', 'DUP_FIELD_MARKER'] }) },
      { label: 'term placeholder', stdout: JSON.stringify({ ...valid, terms: ['[REDACTED:jwt]'] }) },
      { label: 'term business_value', stdout: JSON.stringify({ ...valid, terms: ['business_value'] }) },
      { label: 'term colon', stdout: JSON.stringify({ ...valid, terms: ['a:b'] }) },
      { label: 'term重複', stdout: JSON.stringify({ ...valid, terms: ['dup-term-marker', 'dup-term-marker'] }) },
      {
        label: 'rules 101件',
        stdout: JSON.stringify({ ...valid, fields: Array.from({ length: 101 }, (_, index) => `field_${String(index).padStart(3, '0')}`) }),
      },
      { label: 'JSON以外', stdout: 'admin: not-json\n' },
    ];
    for (const invalid of invalidOutputs) {
      const { run, invocationCount } = await runTransport(['redaction:list', COMPANY_ID], { response: { stdout: `${invalid.stdout}\n` } });
      assert.equal(invocationCount, 1, `${invalid.label} でssh回数が違う`);
      assert.equal(run.code, 1, `${invalid.label} が成功している: stdout=${run.stdout}`);
      assert.equal(run.stdout, '', `${invalid.label} の応答をstdoutへ出している`);
      assert.equal(run.stderr, 'admin: internal_error\n', `${invalid.label} の固定codeが違う: ${run.stderr}`);
    }
  });

  it('remoteの固定admin codeをそのまま返し、raw error本文を出さない', async () => {
    const input = { company_id: COMPANY_ID, expected_version: 2, fields: [], terms: [], suspicion_mode: 'observe' };
    const { run, invocationCount } = await runTransport(['redaction:replace'], {
      input: { name: 'redaction.json', content: input },
      response: { exitCode: 1, stderr: 'admin: redaction_policy_conflict\n' },
    });

    assert.equal(invocationCount, 1);
    assert.equal(run.code, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'admin: redaction_policy_conflict\n');
  });

  it('remoteの未知codeやssh自体の失敗はinternal_errorへ縮退し、raw textを出さない', async () => {
    const unknownCode = await runTransport(['redaction:list', COMPANY_ID], {
      response: { exitCode: 1, stderr: 'admin: not_a_real_code\n' },
    });
    assert.equal(unknownCode.run.code, 1);
    assert.equal(unknownCode.run.stdout, '');
    assert.equal(unknownCode.run.stderr, 'admin: internal_error\n', '未知codeを固定codeとして透過している');

    const sshFailure = await runTransport(['redaction:list', COMPANY_ID], {
      response: {
        exitCode: 255,
        stderr: `ssh: connect to host ${SSH_HOST} port 22: CONNECTION_REFUSED_MARKER`,
      },
    });
    assert.equal(sshFailure.run.code, 1);
    assert.equal(sshFailure.run.stdout, '');
    assert.equal(sshFailure.run.stderr, 'admin: internal_error\n');
    assert.ok(!sshFailure.run.stderr.includes('CONNECTION_REFUSED_MARKER'), 'ssh raw errorをstderrへ出している');
    assert.ok(!sshFailure.run.stderr.includes(SSH_HOST), 'ssh host名をstderrへ出している');
  });

  it('DATABASE_URLが設定されている場合はssh transportを起動しない', async () => {
    await withSshFixture(async (fixture) => {
      await writeSshResponse(fixture, { exitCode: 1, stderr: 'admin: internal_error\n' });
      const run = await withInputFile('company.json', { name: 'ssh-not-used' }, (filePath) =>
        runAdmin(['company:create', filePath], {
          env: { YORI_SSH_BIN: fixture.binPath, YORI_TEST_SSH_DIR: fixture.root },
        }),
      );
      parseSuccessJson(run);
      assert.deepEqual(await readSshInvocations(fixture), [], 'DATABASE_URL設定時にsshを起動している');
    });
  });

  it('空文字DATABASE_URLは未設定と同じssh transportへ委ねる', async () => {
    const { run, invocationCount } = await runTransport(['redaction:list', COMPANY_ID], {
      env: { DATABASE_URL: '' },
      response: { stdout: `{"version":0,"fields":[],"terms":[],"suspicion_mode":"observe","detector_version":"initial-v1"}\n` },
    });
    assert.equal(run.code, 0, `終了コードが0ではない: stderr=${run.stderr}`);
    assert.equal(invocationCount, 1, '空文字DATABASE_URLでsshを起動していない');
    assert.equal(run.stderr, '');
  });

  it('ローカルの引数・入力検証はssh起動前に固定codeで拒否する', async () => {
    const cases: { args: string[]; input?: { name: string; content: unknown }; code: string }[] = [
      { args: ['redaction:list', 'not-a-uuid'], code: 'invalid_arguments' },
      { args: ['redaction:replace', '/nonexistent/redaction-input.json'], code: 'invalid_input_file' },
      { args: ['redaction:replace'], input: { name: 'broken.json', content: '{ not json' }, code: 'invalid_input_file' },
      {
        args: ['redaction:replace'],
        input: { name: 'legacy.json', content: { company_id: COMPANY_ID, expected_version: 0, values: ['old-literal'] } },
        code: 'invalid_input',
      },
    ];
    for (const testCase of cases) {
      const { run, invocationCount } = await runTransport(testCase.args, { input: testCase.input });
      assert.equal(run.code, 1, `失敗していない: ${JSON.stringify(testCase)}`);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, `admin: ${testCase.code}\n`, `固定codeが違う: ${run.stderr}`);
      assert.equal(invocationCount, 0, `ローカル検証前にsshを起動している: ${JSON.stringify(testCase)}`);
    }
  });

  it('sshの起動失敗は固定codeへ縮退し、pathやENOENTをstderrへ出さない', async () => {
    await withSshFixture(async (fixture) => {
      const run = await runAdmin(['redaction:list', COMPANY_ID], {
        env: {
          DATABASE_URL: undefined,
          YORI_SSH_BIN: path.join(fixture.root, 'missing-ssh'),
          YORI_TEST_SSH_DIR: fixture.root,
        },
      });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^admin: [a-z_]+\n$/, `固定codeではない: ${JSON.stringify(run.stderr)}`);
      for (const forbidden of ['ENOENT', 'missing-ssh', fixture.root]) {
        assert.ok(!run.stderr.includes(forbidden), `起動失敗の詳細がstderrへ出ている: ${forbidden}`);
      }
    });
  });
});
