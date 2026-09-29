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
// inspect・company:create等の他のadmin commandはDATABASE_URL欠落をinvalid_admin_configのまま拒否する。
// policy text等の入力はstdin script内だけに置き、argv・エラー出力・logへ出さない。
const SSH_HOST = 'yori-production';
const COMPANY_ID = '01930000-0000-7000-8000-000000000042';

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

function assertRemoteScript(stdin: string, fragments: string[]): void {
  for (const fragment of fragments) {
    assert.ok(stdin.includes(fragment), `ssh stdin scriptへ ${fragment} がない: ${JSON.stringify(stdin)}`);
  }
  assert.match(stdin, /--profile[= ]tools/, `tools profile指定がない: ${JSON.stringify(stdin)}`);
  assert.ok(/docker compose/.test(stdin), `docker composeがない: ${JSON.stringify(stdin)}`);
  assert.ok(stdin.includes('migrate'), `tools profileのmigrate serviceがない: ${JSON.stringify(stdin)}`);
  assert.match(stdin, /run\s+--rm\s+--no-deps\s+-T/, `run --rm --no-deps -Tがない: ${JSON.stringify(stdin)}`);
}

describe('admin commandのmacOS SSH transport', () => {
  it('DATABASE_URLなしのinspectとcompany:createはssh transportへ委ねずinvalid_admin_configで拒否する', async () => {
    const inspect = await runTransport(['inspect', COMPANY_ID]);
    assert.equal(inspect.run.code, 1, `inspectが失敗していない: stdout=${inspect.run.stdout} stderr=${inspect.run.stderr}`);
    assert.equal(inspect.run.stdout, '');
    assert.equal(inspect.run.stderr, 'admin: invalid_admin_config\n');
    assert.equal(inspect.invocationCount, 0, 'inspectがadmin用ssh transportを起動している');

    const create = await runTransport(['company:create'], { input: { name: 'company.json', content: { name: 'example' } } });
    assert.equal(create.run.code, 1, `company:createが失敗していない: stdout=${create.run.stdout} stderr=${create.run.stderr}`);
    assert.equal(create.run.stdout, '');
    assert.equal(create.run.stderr, 'admin: invalid_admin_config\n');
    assert.equal(create.invocationCount, 0, 'company:createがadmin用ssh transportを起動している');

    // 引数検証はDATABASE_URL確認より先で、inspectはsshへ委ねない。
    const invalidArguments = await runTransport(['inspect', 'not-a-uuid']);
    assert.equal(invalidArguments.run.code, 1);
    assert.equal(invalidArguments.run.stdout, '');
    assert.equal(invalidArguments.run.stderr, 'admin: invalid_arguments\n');
    assert.equal(invalidArguments.invocationCount, 0, 'inspectが引数検証より先にsshを起動している');
  });

  it('redaction:replaceのpolicy textはssh stdin scriptだけへ置き、argv・stdout・stderrへ出さない', async () => {
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
    assertRemoteScript(stdin, [`yori-cli@${cliVersion()}`, 'redaction:replace', 'synthetic-field-marker', 'synthetic-term-marker', 'block']);
    for (const forbidden of ['synthetic-field-marker', 'synthetic-term-marker']) {
      assert.ok(!args.join(' ').includes(forbidden), `ssh argvへpolicy textが出ている: ${forbidden}`);
      assert.ok(!run.stdout.includes(forbidden), `stdoutへpolicy textが出ている: ${forbidden}`);
      assert.ok(!run.stderr.includes(forbidden), `stderrへpolicy textが出ている: ${forbidden}`);
    }
  });

  it('redaction:listをssh scriptへ委ね、remote JSONをそのまま返す', async () => {
    const remoteStdout = `{"version":2,"fields":["Pass_Key"],"terms":["alpha-term"],"suspicion_mode":"block","detector_version":"initial-v1"}\n`;
    const { run, stdin, invocationCount } = await runTransport(['redaction:list', COMPANY_ID], {
      response: { stdout: remoteStdout },
    });

    assert.equal(run.code, 0, `終了コードが0ではない: stderr=${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), JSON.parse(remoteStdout));
    assert.equal(invocationCount, 1);
    assertRemoteScript(stdin, [`yori-cli@${cliVersion()}`, '/srv/yori', '/etc/yori/yori.env', 'redaction:list', COMPANY_ID]);
    assert.ok(!stdin.includes('postgres://'), 'ssh stdin scriptへDB URLを出している');
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
