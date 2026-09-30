import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  DEFAULT_API_URL,
  DEFAULT_TOKEN,
  adminKeychainToken,
  parseCollectorSuccess,
  readApiRequests,
  runRootCli,
  withCollectorFixture,
  writeApiSpec,
} from './collector-support.js';

const COMPANY_ID = '01930000-0000-7000-8000-000000000081';
const EMPLOYEE_ID = '01930000-0000-7000-8000-000000000082';
const TOKEN_ID = '01930000-0000-7000-8000-000000000083';
const PROJECT_ID = '01930000-0000-7000-8000-000000000084';
const NEW_EMPLOYEE_ID = '01930000-0000-7000-8000-000000000085';
const CREATED_AT = '2026-09-30T00:00:00.000Z';
const ADMIN_TOKEN = 'yori_fixture_admin_token_7f3d2a';

const meResponse = {
  company: { company_id: COMPANY_ID, name: 'example' },
  employee: { employee_id: EMPLOYEE_ID, display_name: 'Alice', created_at: CREATED_AT },
  token: { token_id: TOKEN_ID, scope: 'employee', created_at: CREATED_AT, revoked_at: null },
  projects: [{ project_id: PROJECT_ID, repository: 'github.com/example/repo', created_at: CREATED_AT }],
};

const companyResponse = {
  company: { company_id: COMPANY_ID, name: 'example' },
  employees: [{ employee_id: EMPLOYEE_ID, display_name: 'Alice', created_at: CREATED_AT }],
  projects: [{ project_id: PROJECT_ID, repository: 'github.com/example/repo', created_at: CREATED_AT }],
  tokens: [{ token_id: TOKEN_ID, employee_id: EMPLOYEE_ID, scope: 'company_admin', created_at: CREATED_AT, revoked_at: null }],
};

describe('社員・会社・token API CLI', () => {
  it('meとcompany:showはKeychain tokenでstrict metadataを取得する', async () => {
    for (const command of [
      { args: ['me'], path: '/v1/me', body: meResponse, token: DEFAULT_TOKEN, admin: false },
      { args: ['company:show'], path: '/v1/company', body: companyResponse, token: ADMIN_TOKEN, admin: true },
    ]) {
      await withCollectorFixture(async (fixture) => {
        await writeFile(command.admin ? fixture.adminKeychainPath : fixture.keychainPath, command.token, 'utf8');
        await writeApiSpec(fixture, [{ status: 200, body: command.body }], { includeCompatibilityProbe: false });
        assert.deepEqual(parseCollectorSuccess(await runRootCli(fixture, command.args)), command.body);
        const requests = await readApiRequests(fixture);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, `${DEFAULT_API_URL}${command.path}`);
        assert.equal(requests[0].method, 'GET');
        assert.equal(requests[0].authorization, `Bearer ${command.token}`);
        assert.equal(requests[0].body, null);
      });
    }
  });

  it('token:issueは社員UUIDとscopeをAPIへ送り、生tokenを一度だけ返す', async () => {
    for (const scope of ['employee', 'company_admin'] as const) {
      await withCollectorFixture(async (fixture) => {
        await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
        const issued = { status: 'done', token_id: TOKEN_ID, employee_id: EMPLOYEE_ID, scope, token: 'yori_synthetic-issued-token' };
        await writeApiSpec(fixture, [{ status: 201, body: issued }], { includeCompatibilityProbe: false });
        const output = parseCollectorSuccess(
          await runRootCli(fixture, ['token:issue', EMPLOYEE_ID.toUpperCase(), '--scope', scope]),
        );
        assert.deepEqual(output, issued);
        const requests = await readApiRequests(fixture);
        assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/employees/${EMPLOYEE_ID}/tokens`);
        assert.equal(requests[0].method, 'POST');
        assert.equal(requests[0].authorization, `Bearer ${ADMIN_TOKEN}`);
        assert.deepEqual(JSON.parse(String(requests[0].body)), { scope });
      });
    }
  });

  it('employee:addは表示名を管理APIへ送り、会社の社員を作成する', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
      const created = {
        status: 'done',
        employee_id: NEW_EMPLOYEE_ID,
        display_name: 'akiyama',
        created_at: CREATED_AT,
      };
      await writeApiSpec(fixture, [{ status: 201, body: created }], { includeCompatibilityProbe: false });

      assert.deepEqual(parseCollectorSuccess(await runRootCli(fixture, ['employee:add', 'akiyama'])), created);

      const requests = await readApiRequests(fixture);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/employees`);
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].authorization, `Bearer ${ADMIN_TOKEN}`);
      assert.deepEqual(JSON.parse(String(requests[0].body)), { display_name: 'akiyama' });
    });
  });

  it('employee:add --issue-tokenは社員作成後にemployee tokenを発行し、社員情報と生tokenを一度だけ返す', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
      const created = {
        status: 'done',
        employee_id: NEW_EMPLOYEE_ID,
        display_name: 'akiyama',
        created_at: CREATED_AT,
      };
      const issued = {
        status: 'done',
        token_id: TOKEN_ID,
        employee_id: NEW_EMPLOYEE_ID,
        scope: 'employee',
        token: 'yori_synthetic-issued-token',
      };
      await writeApiSpec(
        fixture,
        [
          { status: 201, body: created },
          { status: 201, body: issued },
        ],
        { includeCompatibilityProbe: false },
      );

      assert.deepEqual(parseCollectorSuccess(await runRootCli(fixture, ['employee:add', 'akiyama', '--issue-token'])), {
        status: 'done',
        employee_id: NEW_EMPLOYEE_ID,
        display_name: 'akiyama',
        token_id: TOKEN_ID,
        scope: 'employee',
        token: 'yori_synthetic-issued-token',
      });

      const requests = await readApiRequests(fixture);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/employees`);
      assert.equal(requests[0].method, 'POST');
      assert.deepEqual(JSON.parse(String(requests[0].body)), { display_name: 'akiyama' });
      assert.equal(requests[1].url, `${DEFAULT_API_URL}/v1/employees/${NEW_EMPLOYEE_ID}/tokens`);
      assert.equal(requests[1].method, 'POST');
      assert.deepEqual(JSON.parse(String(requests[1].body)), { scope: 'employee' });
      assert.ok(requests.every((request) => request.authorization === `Bearer ${ADMIN_TOKEN}`));
    });
  });

  it('employee:add --issue-tokenのtoken発行失敗は固定errorにし、社員作成を再実行せず生tokenを出さない', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
      await writeApiSpec(
        fixture,
        [
          {
            status: 201,
            body: { status: 'done', employee_id: NEW_EMPLOYEE_ID, display_name: 'akiyama', created_at: CREATED_AT },
          },
          { status: 500, body: { error: { code: 'internal_error' } } },
        ],
        { includeCompatibilityProbe: false },
      );

      const run = await runRootCli(fixture, ['employee:add', 'akiyama', '--issue-token']);
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: internal_error\n');
      assert.ok(!run.stderr.includes('yori_'));
      const requests = await readApiRequests(fixture);
      assert.equal(requests.length, 2, 'token発行失敗後に社員作成を再実行している');
      assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/employees`);
      assert.equal(requests[1].url, `${DEFAULT_API_URL}/v1/employees/${NEW_EMPLOYEE_ID}/tokens`);
    });
  });

  it('member:addの文字列引数を社員作成APIとして扱わない', async () => {
    await withCollectorFixture(async (fixture) => {
      const run = await runRootCli(fixture, ['member:add', 'akiyama']);
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: invalid_input_file\n');
      assert.deepEqual(await readApiRequests(fixture), []);
    });
  });

  it('token:revokeのUUID引数はAPI DELETEへ送り、done/alreadyを返す', async () => {
    for (const status of ['done', 'already'] as const) {
      await withCollectorFixture(async (fixture) => {
        await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
        await writeApiSpec(fixture, [{ status: 200, body: { status, token_id: TOKEN_ID } }], { includeCompatibilityProbe: false });
        assert.deepEqual(parseCollectorSuccess(await runRootCli(fixture, ['token:revoke', TOKEN_ID.toUpperCase()])), {
          status,
          token_id: TOKEN_ID,
        });
        const requests = await readApiRequests(fixture);
        assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/tokens/${TOKEN_ID}`);
        assert.equal(requests[0].method, 'DELETE');
        assert.equal(requests[0].authorization, `Bearer ${ADMIN_TOKEN}`);
        assert.equal(requests[0].body, null);
      });
    }
  });

  it('新形式の引数違反はKeychain・APIより先にinvalid_argumentsで拒否する', async () => {
    for (const args of [
      ['me', 'extra'],
      ['company:show', 'extra'],
      ['employee:add'],
      ['employee:add', ''],
      ['employee:add', 'akiyama', 'extra'],
      ['employee:add', 'akiyama', '--issue-token', 'extra'],
      ['employee:add', 'akiyama', '--scope', 'employee'],
      ['token:issue', 'not-a-uuid', '--scope', 'employee'],
      ['token:issue', EMPLOYEE_ID, '--scope', 'owner'],
      ['token:issue', EMPLOYEE_ID, 'employee'],
      ['token:revoke', 'not-a-uuid'],
    ]) {
      await withCollectorFixture(async (fixture) => {
        const run = await runRootCli(fixture, args);
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, 'admin: invalid_arguments\n');
        assert.deepEqual(await readApiRequests(fixture), []);
      });
    }
  });

  it('権限・不存在・最後のadmin・契約外応答を固定codeへ縮退し、生tokenを出さない', async () => {
    for (const fixtureCase of [
      { args: ['company:show'], status: 401, body: { error: { code: 'unauthorized' } }, code: 'collector_unauthorized' },
      { args: ['company:show'], status: 403, body: { error: { code: 'forbidden' } }, code: 'forbidden' },
      { args: ['employee:add', 'akiyama'], status: 403, body: { error: { code: 'forbidden' } }, code: 'forbidden' },
      { args: ['employee:add', 'akiyama'], status: 400, body: { error: { code: 'invalid_request' } }, code: 'collector_invalid_request' },
      { args: ['token:issue', EMPLOYEE_ID, '--scope', 'employee'], status: 404, body: { error: { code: 'not_found' } }, code: 'employee_not_found' },
      { args: ['token:revoke', TOKEN_ID], status: 404, body: { error: { code: 'not_found' } }, code: 'token_not_found' },
      { args: ['token:revoke', TOKEN_ID], status: 409, body: { error: { code: 'conflict' } }, code: 'last_company_admin' },
      { args: ['me'], status: 500, body: { error: { code: 'internal_error' }, marker: 'RAW_MARKER' }, code: 'collector_server_incompatible' },
    ]) {
      await withCollectorFixture(async (fixture) => {
        const adminCommand = fixtureCase.args[0] !== 'me';
        await writeFile(adminCommand ? fixture.adminKeychainPath : fixture.keychainPath, adminCommand ? ADMIN_TOKEN : DEFAULT_TOKEN, 'utf8');
        await writeApiSpec(fixture, [{ status: fixtureCase.status, body: fixtureCase.body }], { includeCompatibilityProbe: false });
        const run = await runRootCli(fixture, fixtureCase.args);
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, `admin: ${fixtureCase.code}\n`);
        assert.ok(!run.stderr.includes(DEFAULT_TOKEN));
        assert.ok(!run.stderr.includes(ADMIN_TOKEN));
        assert.ok(!run.stderr.includes('RAW_MARKER'));
      });
    }
  });

  it('company:showは通常tokenではなく管理tokenを別Keychain serviceへ登録する', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeFile(fixture.keychainPath, DEFAULT_TOKEN, 'utf8');
      await writeApiSpec(fixture, [{ status: 200, body: companyResponse }], { includeCompatibilityProbe: false });
      parseCollectorSuccess(await runRootCli(fixture, ['company:show'], { input: `${ADMIN_TOKEN}\n` }));
      assert.equal(await adminKeychainToken(fixture), ADMIN_TOKEN);
      assert.equal(await readFile(fixture.keychainPath, 'utf8'), DEFAULT_TOKEN);
    });
  });

  it('管理用Keychainのtokenがforbiddenなら削除して次回入力を可能にする', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeFile(fixture.adminKeychainPath, DEFAULT_TOKEN, 'utf8');
      await writeApiSpec(fixture, [{ status: 403, body: { error: { code: 'forbidden' } } }], { includeCompatibilityProbe: false });

      const run = await runRootCli(fixture, ['company:show']);
      assert.equal(run.code, 1);
      assert.equal(run.stderr, 'admin: forbidden\n');
      assert.equal(await adminKeychainToken(fixture), null);
    });
  });
});
