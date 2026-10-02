import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  DEFAULT_API_URL,
  DEFAULT_COMPATIBILITY_RESPONSE,
  DEFAULT_SETUP_RESPONSE,
  DEFAULT_TOKEN,
  keychainToken,
  parseCollectorSuccess,
  readApiRequests,
  runRootCli,
  withCollectorFixture,
  writeApiSpec,
} from './collector-support.js';

const PROJECT_ID = '01930000-0000-7000-8000-000000000071';
const EMPLOYEE_ID = '01930000-0000-7000-8000-000000000072';
const REPOSITORY = 'github.com/example/repo';
const ADMIN_TOKEN = 'yori_fixture_admin_token_7f3d2a';
const REMOVAL_WARNING =
  'This permanently deletes all collected conversations, search documents, and search history from the database. This cannot be undone.';

describe('社員向けproject API CLI', () => {
  it('project:addはcwdのrepositoryをBearer付きで登録し、done/alreadyをそのまま返す', async () => {
    for (const status of ['done', 'already'] as const) {
      await withCollectorFixture(async (fixture) => {
        await writeFile(fixture.keychainPath, DEFAULT_TOKEN, 'utf8');
        await writeApiSpec(
          fixture,
          [{ status: status === 'done' ? 201 : 200, body: { status, project_id: PROJECT_ID, repository: REPOSITORY } }],
          { includeCompatibilityProbe: false },
        );

        const output = parseCollectorSuccess(await runRootCli(fixture, ['project:add']));
        assert.deepEqual(output, { status, project_id: PROJECT_ID, repository: REPOSITORY });
        const requests = await readApiRequests(fixture);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, `${DEFAULT_API_URL}/v1/projects`);
        assert.equal(requests[0].method, 'POST');
        assert.equal(requests[0].authorization, `Bearer ${DEFAULT_TOKEN}`);
        assert.deepEqual(JSON.parse(String(requests[0].body)), { repository: REPOSITORY });
      });
    }
  });

  it('project:addはtoken未登録ならKeychainへ保存してから登録する', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeApiSpec(
        fixture,
        [{ status: 201, body: { status: 'done', project_id: PROJECT_ID, repository: REPOSITORY } }],
        { includeCompatibilityProbe: false },
      );
      parseCollectorSuccess(await runRootCli(fixture, ['project:add'], { input: `${DEFAULT_TOKEN}\n` }));
      assert.equal(await keychainToken(fixture), DEFAULT_TOKEN);
    });
  });

  it('引数違反はKeychain・APIより先にinvalid_argumentsで拒否する', async () => {
    for (const args of [
      ['project:add', REPOSITORY],
      ['project:member:add', PROJECT_ID, EMPLOYEE_ID],
      ['project:member:add'],
      ['project:member:add', 'not-a-uuid', EMPLOYEE_ID],
      ['project:member:add', PROJECT_ID, 'not-a-uuid'],
      ['project:member:add', PROJECT_ID, EMPLOYEE_ID, 'extra'],
    ]) {
      await withCollectorFixture(async (fixture) => {
        const run = await runRootCli(fixture, args);
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, 'admin: invalid_arguments\n');
        assert.deepEqual(await readApiRequests(fixture), []);
        assert.equal(await keychainToken(fixture), null);
      });
    }
  });

  it('API失敗を固定codeへmapし、tokenとraw bodyを出さない', async () => {
    for (const fixtureCase of [
      { status: 401, body: { error: { code: 'unauthorized' } }, code: 'collector_unauthorized' },
      { status: 403, body: { error: { code: 'forbidden' } }, code: 'forbidden' },
      { status: 404, body: { error: { code: 'not_found' } }, code: 'project_not_found' },
      { status: 409, body: { error: { code: 'repository_conflict' } }, code: 'repository_conflict' },
      {
        status: 500,
        body: { error: { code: 'internal_error' }, marker: 'RAW_MARKER' },
        code: 'collector_server_incompatible',
      },
    ]) {
      await withCollectorFixture(async (fixture) => {
        await writeFile(fixture.keychainPath, DEFAULT_TOKEN, 'utf8');
        await writeApiSpec(fixture, [{ status: fixtureCase.status, body: fixtureCase.body }], { includeCompatibilityProbe: false });
        const run = await runRootCli(fixture, ['project:add']);
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, `admin: ${fixtureCase.code}\n`);
        assert.ok(!run.stderr.includes(DEFAULT_TOKEN));
        assert.ok(!run.stderr.includes('RAW_MARKER'));
      });
    }
  });
});

describe('project:remove（API経由）', () => {
  const setupProjectId = String((DEFAULT_SETUP_RESPONSE.body as { project_id: string }).project_id);
  const setupRepository = String((DEFAULT_SETUP_RESPONSE.body as { repository: string }).repository);
  const prompt = `Target: ${setupRepository} (${setupProjectId})\n${REMOVAL_WARNING}\nAre you sure you want to delete it? [y/N]: `;

  it('yの確認後にcwdのrepositoryの案件をcompany admin tokenでDELETEする', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
      await writeApiSpec(
        fixture,
        [DEFAULT_COMPATIBILITY_RESPONSE, DEFAULT_SETUP_RESPONSE, { status: 200, body: { status: 'done', project_id: setupProjectId } }],
        { includeCompatibilityProbe: false },
      );

      const run = await runRootCli(fixture, ['project:remove'], { input: 'y\n' });
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { status: 'done', project_id: setupProjectId });
      assert.equal(run.stderr, prompt);
      const requests = await readApiRequests(fixture);
      assert.equal(requests.length, 3);
      assert.equal(requests[1].url, `${DEFAULT_API_URL}/v1/collector/setup`);
      assert.equal(requests[1].authorization, `Bearer ${ADMIN_TOKEN}`);
      assert.equal(requests[2].url, `${DEFAULT_API_URL}/v1/projects/${setupProjectId}`);
      assert.equal(requests[2].method, 'DELETE');
      assert.equal(requests[2].authorization, `Bearer ${ADMIN_TOKEN}`);
      assert.equal(requests[2].body, null);
    });
  });

  it('y以外の入力と入力なしはDELETEを送らずproject_remove_cancelledで中止する', async () => {
    for (const input of ['n\n', '\n', 'yes\n', '']) {
      await withCollectorFixture(async (fixture) => {
        await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
        await writeApiSpec(fixture, [DEFAULT_SETUP_RESPONSE]);

        const run = await runRootCli(fixture, ['project:remove'], { input });
        assert.equal(run.code, 1);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr, `${prompt}admin: project_remove_cancelled\n`);
        const requests = await readApiRequests(fixture);
        assert.equal(requests.length, 2, 'setup以外のrequestを送っている');
        assert.ok(requests.every((request) => request.method !== 'DELETE'));
      });
    }
  });

  it('未登録repositoryは確認を出さずproject_not_foundで終了する', async () => {
    await withCollectorFixture(async (fixture) => {
      await writeFile(fixture.adminKeychainPath, ADMIN_TOKEN, 'utf8');
      await writeApiSpec(fixture, [{ status: 404, body: { error: { code: 'not_found' } } }]);

      const run = await runRootCli(fixture, ['project:remove'], { input: 'y\n' });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, 'admin: project_not_found\n');
    });
  });
});
