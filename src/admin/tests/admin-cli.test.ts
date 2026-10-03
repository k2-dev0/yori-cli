import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { createPool } from '../../db/pool.js';
import { TOKEN_HASH_RETRY_LIMIT } from '../contract.js';
import { issueToken, isTokenHashConflict } from '../service.js';
import {
  applyTestSchema,
  authenticateWithToken,
  countRows,
  expectFail,
  insertAuthToken,
  parseSuccessJson,
  resetDatabase,
  runAdmin,
  sha256Utf8,
  testDatabaseUrl,
  withInputFile,
  type AdminRun,
} from './support.js';

const pool = createPool(testDatabaseUrl());

// 実在しないUUID。UUID形式は正しいがDBに存在しない値として使う。
const companyMissingUuid = '01930000-0000-7000-8000-000000000000';

before(async () => {
  await applyTestSchema(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
});

after(async () => {
  await pool.end();
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `objectではない: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), `配列ではない: ${JSON.stringify(value)}`);
  return value;
}

function str(value: unknown): string {
  assert.equal(typeof value, 'string', `文字列ではない: ${JSON.stringify(value)}`);
  return value as string;
}

function assertUuidV7(value: unknown): string {
  const id = str(value);
  assert.ok(isUuid(id), `UUID形式ではない: ${id}`);
  assert.equal(uuidVersion(id), 7, `UUIDv7ではない: ${id}`);
  return id;
}

function bootstrapInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: { name: 'example' },
    employees: [
      { ref: 'alice', display_name: 'Alice', issue_token: true },
      { ref: 'bob', display_name: 'Bob', issue_token: true },
    ],
    projects: [
      { ref: 'project-a', repository: 'github.com/example/project-a', member_refs: ['alice', 'bob'] },
      { ref: 'project-b', repository: 'https://github.com/example/project-b.git', member_refs: ['alice'] },
    ],
    ...overrides,
  };
}

async function runWithFile(command: string, name: string, content: unknown, env?: Record<string, string | undefined>): Promise<AdminRun> {
  return withInputFile(name, content, (filePath) => runAdmin([command, filePath], env === undefined ? {} : { env }));
}

async function createCompany(name = 'example'): Promise<string> {
  const run = await runWithFile('company:create', 'company.json', { name });
  return assertUuidV7(parseSuccessJson(run).company_id);
}

async function createEmployee(companyId: string, displayName: string): Promise<string> {
  const run = await runWithFile('employee:create', 'employee.json', { company_id: companyId, display_name: displayName });
  return assertUuidV7(parseSuccessJson(run).employee_id);
}

async function createProject(companyId: string, repository: string): Promise<Record<string, unknown>> {
  const run = await runWithFile('project:create', 'project.json', { company_id: companyId, repository });
  return parseSuccessJson(run);
}

async function addMember(companyId: string, projectId: string, employeeId: string): Promise<AdminRun> {
  return runWithFile('member:add', 'member.json', { company_id: companyId, project_id: projectId, employee_id: employeeId });
}

async function issueTokenViaCli(
  companyId: string,
  employeeId: string,
  scope?: 'employee' | 'company_admin',
): Promise<Record<string, unknown>> {
  const run = await runWithFile('token:issue', 'token.json', {
    company_id: companyId,
    employee_id: employeeId,
    ...(scope === undefined ? {} : { scope }),
  });
  return parseSuccessJson(run);
}

describe('bootstrap', () => {
  it('空DBのbootstrapで会社・社員・案件・所属・初回tokenを一括作成する', async () => {
    const run = await withInputFile('bootstrap.json', bootstrapInput(), (filePath) => runAdmin(['bootstrap', filePath]));
    const output = parseSuccessJson(run);

    assert.equal(output.status, 'created');
    const company = record(output.company);
    const companyId = assertUuidV7(company.company_id);
    assert.equal(company.name, 'example');

    const employees = list(output.employees).map(record);
    assert.deepEqual(
      employees.map((employee) => employee.ref),
      ['alice', 'bob'],
    );
    assert.deepEqual(
      employees.map((employee) => employee.display_name),
      ['Alice', 'Bob'],
    );
    for (const employee of employees) {
      assertUuidV7(employee.employee_id);
    }

    const projects = list(output.projects).map(record);
    assert.deepEqual(
      projects.map((project) => project.repository_identifier),
      ['github.com/example/project-a', 'github.com/example/project-b'],
    );
    for (const project of projects) {
      assertUuidV7(project.project_id);
    }

    const members = list(output.members).map(record);
    assert.equal(members.length, 3);

    const tokens = list(output.tokens).map(record);
    assert.equal(tokens.length, 2);
    for (const token of tokens) {
      assertUuidV7(token.token_id);
      assert.ok(str(token.token).startsWith('yori_'), '生tokenの形式が違う');
    }

    assert.equal(await countRows(pool, 'companies'), 1);
    assert.equal(await countRows(pool, 'employees'), 2);
    assert.equal(await countRows(pool, 'projects'), 2);
    assert.equal(await countRows(pool, 'project_members'), 3);
    assert.equal(await countRows(pool, 'auth_tokens'), 2);

    const stored = await pool.query<{ repository_identifier: string }>('SELECT repository_identifier FROM projects ORDER BY repository_identifier');
    assert.deepEqual(
      stored.rows.map((row) => row.repository_identifier),
      ['github.com/example/project-a', 'github.com/example/project-b'],
    );
    assert.equal(companyId, str(company.company_id));
  });

  it('発行tokenはAPIと同じ照合SQLで正しい会社・社員へ解決する', async () => {
    const run = await withInputFile('bootstrap.json', bootstrapInput(), (filePath) => runAdmin(['bootstrap', filePath]));
    const output = parseSuccessJson(run);
    const companyId = str(record(output.company).company_id);
    const employeeIds = new Map(
      list(output.employees)
        .map(record)
        .map((employee) => [str(employee.ref), str(employee.employee_id)]),
    );

    for (const token of list(output.tokens).map(record)) {
      const auth = await authenticateWithToken(pool, str(token.token));
      assert.ok(auth !== null, '発行直後のtokenが認証できない');
      assert.equal(auth.companyId, companyId);
      assert.equal(auth.employeeId, employeeIds.get(str(token.ref)));
    }
  });

  it('repositoryのHTTPS・SSH・SCP・canonical表記を同じidentifierへ正規化する', async () => {
    const repositories = [
      { ref: 'p1', repository: 'https://github.com/example/repo.git', member_refs: [] },
      { ref: 'p2', repository: 'ssh://git@github.com/example/repo-ssh.git', member_refs: [] },
      { ref: 'p3', repository: 'git@github.com:example/repo-scp.git', member_refs: [] },
      { ref: 'p4', repository: 'GitHub.com/example/Repo-Canonical.git', member_refs: [] },
    ];
    const input = bootstrapInput({ employees: [{ ref: 'alice', display_name: 'Alice' }], projects: repositories });
    const run = await withInputFile('bootstrap.json', input, (filePath) => runAdmin(['bootstrap', filePath]));
    const output = parseSuccessJson(run);
    assert.deepEqual(
      list(output.projects)
        .map(record)
        .map((project) => project.repository_identifier),
      ['github.com/example/repo', 'github.com/example/repo-ssh', 'github.com/example/repo-scp', 'github.com/example/Repo-Canonical'],
    );
  });

  it('issue_tokenがtrueの社員だけに初回tokenを発行する', async () => {
    const input = bootstrapInput({
      employees: [
        { ref: 'alice', display_name: 'Alice', issue_token: true },
        { ref: 'bob', display_name: 'Bob', issue_token: false },
        { ref: 'carol', display_name: 'Carol' },
      ],
      projects: [{ ref: 'project-a', repository: 'github.com/example/project-a', member_refs: ['alice', 'bob', 'carol'] }],
    });
    const run = await withInputFile('bootstrap.json', input, (filePath) => runAdmin(['bootstrap', filePath]));
    const output = parseSuccessJson(run);
    const tokens = list(output.tokens).map(record);
    assert.deepEqual(
      tokens.map((token) => token.ref),
      ['alice'],
    );
    assert.equal(await countRows(pool, 'auth_tokens'), 1);
  });

  it('会社が存在するDBでは何も変更せずbootstrap_already_completedを返す', async () => {
    const first = await withInputFile('bootstrap.json', bootstrapInput(), (filePath) => runAdmin(['bootstrap', filePath]));
    parseSuccessJson(first);
    const before = await pool.query('SELECT id, name FROM companies');

    const second = await withInputFile('bootstrap.json', bootstrapInput({ company: { name: 'other' } }), (filePath) =>
      runAdmin(['bootstrap', filePath]),
    );
    expectFail(second, 'bootstrap_already_completed');

    assert.equal(await countRows(pool, 'companies'), 1);
    assert.equal(await countRows(pool, 'employees'), 2);
    assert.deepEqual((await pool.query('SELECT id, name FROM companies')).rows, before.rows);
  });

  it('途中のrepository重複では先行insertをすべてrollbackする', async () => {
    const input = bootstrapInput({
      employees: [{ ref: 'alice', display_name: 'Alice', issue_token: true }],
      projects: [
        { ref: 'p1', repository: 'https://github.com/example/dup.git', member_refs: ['alice'] },
        { ref: 'p2', repository: 'git@github.com:example/dup.git', member_refs: ['alice'] },
      ],
    });
    const run = await withInputFile('bootstrap.json', input, (filePath) => runAdmin(['bootstrap', filePath]));
    expectFail(run, 'repository_conflict');

    for (const table of ['companies', 'employees', 'projects', 'project_members', 'auth_tokens']) {
      assert.equal(await countRows(pool, table), 0, `${table} に部分的insertが残っている`);
    }
  });

  it('ref・社員・案件・所属の重複と未知refをZodで拒否する', async () => {
    const cases: Record<string, unknown>[] = [
      bootstrapInput({
        employees: [
          { ref: 'alice', display_name: 'Alice' },
          { ref: 'alice', display_name: 'Alice2' },
        ],
      }),
      bootstrapInput({ projects: [{ ref: 'p1', repository: 'github.com/example/p1', member_refs: [] }, { ref: 'p1', repository: 'github.com/example/p2', member_refs: [] }] }),
      bootstrapInput({ projects: [{ ref: 'p1', repository: 'github.com/example/p1', member_refs: ['alice', 'alice'] }] }),
      bootstrapInput({ projects: [{ ref: 'p1', repository: 'github.com/example/p1', member_refs: ['nobody'] }] }),
      bootstrapInput({ company: { name: 'example' }, employees: [], projects: [] }),
    ];
    for (const input of cases) {
      const run = await withInputFile('bootstrap.json', input, (filePath) => runAdmin(['bootstrap', filePath]));
      expectFail(run, 'invalid_input');
      assert.equal(await countRows(pool, 'companies'), 0);
    }
  });
});

describe('個別コマンド', () => {
  it('company・employee・project・memberを個別に作成できる', async () => {
    const companyId = await createCompany('individual');
    const employeeId = await createEmployee(companyId, 'Alice');
    const project = await createProject(companyId, 'git@github.com:example/individual.git');
    const projectId = assertUuidV7(project.project_id);
    assert.equal(project.status, 'created');
    assert.equal(project.company_id, companyId);
    assert.equal(project.repository_identifier, 'github.com/example/individual');

    const added = await addMember(companyId, projectId, employeeId);
    const addedOutput = parseSuccessJson(added);
    assert.equal(addedOutput.status, 'created');
    assert.equal(addedOutput.project_id, projectId);
    assert.equal(addedOutput.employee_id, employeeId);
    assert.equal(await countRows(pool, 'project_members'), 1);
  });

  it('repository重複はrepository_conflictで拒否し、既存案件を変更しない', async () => {
    const companyId = await createCompany();
    const project = await createProject(companyId, 'https://github.com/example/dup.git');
    const projectId = str(project.project_id);
    const before = await pool.query('SELECT id, repository_identifier, created_at FROM projects');

    const same = await runWithFile('project:create', 'project.json', {
      company_id: companyId,
      repository: 'https://github.com/example/dup.git',
    });
    expectFail(same, 'repository_conflict');

    const equivalent = await runWithFile('project:create', 'project.json', {
      company_id: companyId,
      repository: 'git@github.com:example/dup.git',
    });
    expectFail(equivalent, 'repository_conflict');

    assert.equal(projectId, str(project.project_id));
    assert.deepEqual((await pool.query('SELECT id, repository_identifier, created_at FROM projects')).rows, before.rows);
  });

  it('別会社なら同じrepositoryを登録できる', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const first = await createProject(companyA, 'github.com/example/shared');
    const second = await createProject(companyB, 'github.com/example/shared');
    assert.notEqual(first.project_id, second.project_id);
    assert.equal(await countRows(pool, 'projects'), 2);
  });

  it('token:issueで同一社員へ複数の未失効tokenを発行できる', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const first = await issueTokenViaCli(companyId, employeeId);
    const second = await issueTokenViaCli(companyId, employeeId);

    assert.notEqual(first.token_id, second.token_id);
    assert.notEqual(first.token, second.token);
    assert.equal(await countRows(pool, 'auth_tokens'), 2);
    for (const token of [first, second]) {
      const auth = await authenticateWithToken(pool, str(token.token));
      assert.deepEqual(auth, { companyId, employeeId });
    }
  });

  it('token:issueのscope省略はemployee、明示時はcompany_adminとして保存する', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Admin');
    const employeeToken = await issueTokenViaCli(companyId, employeeId);
    const adminToken = await issueTokenViaCli(companyId, employeeId, 'company_admin');

    assert.equal(employeeToken.scope, 'employee');
    assert.equal(adminToken.scope, 'company_admin');
    const rows = await pool.query<{ id: string; scope: string }>(
      'SELECT id, scope FROM auth_tokens WHERE id = ANY($1) ORDER BY scope',
      [[employeeToken.token_id, adminToken.token_id]],
    );
    assert.deepEqual(rows.rows.map((row) => row.scope), ['company_admin', 'employee']);
  });

  it('token:revokeで失効させるとAPI認証SQLが拒否する', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const revoked = await issueTokenViaCli(companyId, employeeId);
    const kept = await issueTokenViaCli(companyId, employeeId);

    const run = await runWithFile('token:revoke', 'revoke.json', { company_id: companyId, token_id: str(revoked.token_id) });
    const output = parseSuccessJson(run);
    assert.equal(output.status, 'revoked');
    assert.equal(output.token_id, revoked.token_id);

    assert.equal(await authenticateWithToken(pool, str(revoked.token)), null, '失効済みtokenが認証できてしまう');
    assert.deepEqual(await authenticateWithToken(pool, str(kept.token)), { companyId, employeeId });
    const stored = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_tokens WHERE id = $1', [str(revoked.token_id)]);
    assert.ok(stored.rows[0].revoked_at !== null, 'revoked_atが設定されていない');
    assert.equal(await countRows(pool, 'auth_tokens'), 2, '失効で行が削除されている');
  });

  it('inspectは会社scopeの構成とtoken metadataだけを返す', async () => {
    const companyId = await createCompany('inspected');
    const employeeId = await createEmployee(companyId, 'Alice');
    const projectId = assertUuidV7((await createProject(companyId, 'github.com/example/inspected')).project_id);
    parseSuccessJson(await addMember(companyId, projectId, employeeId));
    const issued = await issueTokenViaCli(companyId, employeeId);

    const otherCompany = await createCompany('other');
    await createEmployee(otherCompany, 'Bob');

    const run = await runAdmin(['inspect', companyId]);
    const output = parseSuccessJson(run);
    assert.equal(output.status, 'ok');
    assert.deepEqual(record(output.company), {
      company_id: companyId,
      name: 'inspected',
      created_at: str(record(output.company).created_at),
    });

    const employees = list(output.employees).map(record);
    assert.deepEqual(
      employees.map((employee) => employee.employee_id),
      [employeeId],
    );
    assert.equal(employees[0].display_name, 'Alice');
    assert.ok(str(employees[0].created_at).length > 0);

    const projects = list(output.projects).map(record);
    assert.deepEqual(
      projects.map((project) => project.repository_identifier),
      ['github.com/example/inspected'],
    );
    assert.equal(projects[0].project_id, projectId);

    const members = list(output.members).map(record);
    assert.deepEqual(members, [{ project_id: projectId, employee_id: employeeId, created_at: str(members[0].created_at) }]);

    const tokens = list(output.tokens).map(record);
    assert.equal(tokens.length, 1);
    assert.deepEqual(Object.keys(tokens[0]).sort(), ['created_at', 'employee_id', 'revoked_at', 'token_id']);
    assert.equal(tokens[0].token_id, issued.token_id);
    assert.equal(tokens[0].employee_id, employeeId);
    assert.equal(tokens[0].revoked_at, null);

    const serialized = JSON.stringify(output);
    assert.ok(!serialized.includes('yori_'), 'inspect出力に生tokenが含まれている');
    assert.ok(!serialized.includes(sha256Utf8(str(issued.token)).toString('hex')), 'inspect出力にtoken hashが含まれている');
    assert.ok(!serialized.includes('Bob'), '別会社の社員が混ざっている');
  });
});

describe('usage', () => {
  const insertUsage = (companyId: string, values: { provider: string; operation: string; tokens: number | null; ms: number; success?: boolean; ago?: string; jobId?: string }) =>
    pool.query(
      `INSERT INTO usage_events (id, company_id, provider, operation, input_tokens, duration_ms, success, created_at, job_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now() - $7::interval, $8)`,
      [companyId, values.provider, values.operation, values.tokens, values.ms, values.success ?? true, values.ago ?? '1 second', values.jobId ?? null],
    );

  it('usageは会社scopeの外部呼出しの費用と、jobと自動検索の所要時間を返す', async () => {
    const companyId = await createCompany('usage');
    const projectId = str((await createProject(companyId, 'github.com/example/usage')).project_id);
    const sessionId = (await pool.query<{ id: string }>('INSERT INTO sessions (id, project_id) VALUES (gen_random_uuid(), $1) RETURNING id', [projectId])).rows[0].id;
    const jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO jobs (id, kind, status, session_id, created_at, started_at, updated_at)
         VALUES (gen_random_uuid(), 'classify_message', 'completed', $1, now() - interval '10 seconds', now() - interval '8 seconds', now() - interval '5 seconds')
         RETURNING id`,
        [sessionId],
      )
    ).rows[0].id;
    await insertUsage(companyId, { provider: 'jev', operation: 'classify_message', tokens: 1_000_000, ms: 200, jobId });
    await insertUsage(companyId, { provider: 'jev', operation: 'classify_message', tokens: null, ms: 400, success: false, jobId });
    await insertUsage(companyId, { provider: 'voyage_direct', operation: 'document', tokens: 500_000, ms: 300 });
    // 集計期間より古い呼出しと、別会社の呼出しは数えない。
    await insertUsage(companyId, { provider: 'jev', operation: 'classify_message', tokens: 9_000_000, ms: 100, ago: '8 days' });
    const otherCompany = await createCompany('usage-other');
    await insertUsage(otherCompany, { provider: 'jev', operation: 'classify_message', tokens: 7_000_000, ms: 100 });
    for (const [created, updated] of [['3 seconds', '1 second'], ['30 seconds', '0 seconds']]) {
      await pool.query(
        `INSERT INTO search_requests (id, company_id, trigger, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'auto', 'completed', now() - $2::interval, now() - $3::interval)`,
        [companyId, created, updated],
      );
    }

    const output = parseSuccessJson(await runAdmin(['usage', companyId]));
    assert.equal(output.status, 'ok');
    assert.equal(output.company_id, companyId);
    assert.equal(output.days, 7);
    assert.deepEqual(output.usd_per_million_input_tokens, { jev: 0.042, voyage_direct: 0.02 });
    const daily = list(output.daily).map(record);
    assert.deepEqual(
      daily.map((row) => [row.provider, row.calls, row.failed, row.input_tokens]),
      [
        ['jev', 2, 1, 1_000_000],
        ['voyage_direct', 1, 0, 500_000],
      ],
    );
    assert.ok(Math.abs(Number(daily[0].cost_usd) - 0.042) < 1e-9, `Jevの費用が単価どおりでない: ${String(daily[0].cost_usd)}`);
    assert.ok(Math.abs(Number(daily[1].cost_usd) - 0.01) < 1e-9, `Voyageの費用が単価どおりでない: ${String(daily[1].cost_usd)}`);
    const classify = list(output.operations).map(record).find((row) => row.operation === 'classify_message');
    assert.equal(classify?.duration_ms_p50, 300);
    const jobs = list(output.jobs).map(record);
    assert.deepEqual(
      jobs.map((row) => [row.kind, row.completed, row.wait_ms_p50, row.run_ms_p50]),
      [['classify_message', 1, 2000, 3000]],
    );
    assert.ok(Math.abs(Number(jobs[0].jev_cost_usd_per_job) - 0.042) < 1e-9, 'jobに紐付くJevの費用を平均していない');
    const autoSearch = record(output.auto_search);
    assert.deepEqual([autoSearch.completed, autoSearch.within_notify_wait_ratio, autoSearch.duration_ms_p50], [2, 0.5, 16000]);

    const wide = parseSuccessJson(await runAdmin(['usage', companyId, '--days', '9']));
    const wideJevCalls = list(wide.daily)
      .map(record)
      .filter((row) => row.provider === 'jev')
      .reduce((sum, row) => sum + Number(row.calls), 0);
    assert.equal(wideJevCalls, 3, '--daysで集計期間を広げても古い呼出しを数えていない');
  });

  it('usageは引数・会社・必要なmigrationを確認してから集計する', async () => {
    const companyId = await createCompany('usage-check');
    for (const args of [['usage'], ['usage', 'not-a-uuid'], ['usage', companyId, '--days', '0'], ['usage', companyId, '--days', '91'], ['usage', companyId, '--days', '1.5'], ['usage', companyId, '--day', '7']]) {
      expectFail(await runAdmin(args), 'invalid_arguments');
    }
    expectFail(await runAdmin(['usage', '01930000-0000-7000-8000-000000000099']), 'company_not_found');
    await pool.query("DELETE FROM schema_migrations WHERE version = '0021_job_timing_usage_job.sql'");
    try {
      expectFail(await runAdmin(['usage', companyId]), 'internal_error');
    } finally {
      await pool.query("INSERT INTO schema_migrations (version) VALUES ('0021_job_timing_usage_job.sql') ON CONFLICT DO NOTHING");
    }
  });
});

describe('会社境界', () => {
  it('別会社の社員を案件メンバーへ追加できない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const employeeB = await createEmployee(companyB, 'Bob');
    const projectId = assertUuidV7((await createProject(companyA, 'github.com/example/a')).project_id);

    expectFail(await addMember(companyA, projectId, employeeB), 'company_scope_mismatch');
    assert.equal(await countRows(pool, 'project_members'), 0);

    expectFail(await addMember(companyB, projectId, employeeB), 'project_not_found');
    assert.equal(await countRows(pool, 'project_members'), 0);
  });

  it('別会社の社員へtokenを発行できない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const employeeB = await createEmployee(companyB, 'Bob');

    expectFail(await runWithFile('token:issue', 'token.json', { company_id: companyA, employee_id: employeeB }), 'company_scope_mismatch');
    assert.equal(await countRows(pool, 'auth_tokens'), 0);
  });

  it('別会社のtokenを失効できない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const employeeB = await createEmployee(companyB, 'Bob');
    const tokenB = await issueTokenViaCli(companyB, employeeB);

    expectFail(await runWithFile('token:revoke', 'revoke.json', { company_id: companyA, token_id: str(tokenB.token_id) }), 'company_scope_mismatch');
    assert.deepEqual(await authenticateWithToken(pool, str(tokenB.token)), { companyId: companyB, employeeId: employeeB });
  });

  it('別会社のmember:removeは所属を消さない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const employeeA = await createEmployee(companyA, 'Alice');
    const employeeB = await createEmployee(companyB, 'Bob');
    const projectId = assertUuidV7((await createProject(companyA, 'github.com/example/a')).project_id);
    parseSuccessJson(await addMember(companyA, projectId, employeeA));

    expectFail(
      await runWithFile('member:remove', 'member.json', { company_id: companyB, project_id: projectId, employee_id: employeeB }),
      'project_not_found',
    );
    expectFail(
      await runWithFile('member:remove', 'member.json', { company_id: companyA, project_id: projectId, employee_id: employeeB }),
      'company_scope_mismatch',
    );
    assert.equal(await countRows(pool, 'project_members'), 1);
  });

  it('別会社のproject:removeは案件を消さない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const projectId = assertUuidV7((await createProject(companyA, 'github.com/example/a')).project_id);

    expectFail(await runWithFile('project:remove', 'project.json', { company_id: companyB, project_id: projectId }), 'project_not_found');
    assert.equal(await countRows(pool, 'projects'), 1);
  });
});

describe('project:remove', () => {
  it('案件を所属・repository aliasごと削除し、他の案件と社員は残す', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const removedProjectId = assertUuidV7((await createProject(companyId, 'github.com/example/removed')).project_id);
    const keptProjectId = assertUuidV7((await createProject(companyId, 'github.com/example/kept')).project_id);
    parseSuccessJson(await addMember(companyId, removedProjectId, employeeId));
    parseSuccessJson(await addMember(companyId, keptProjectId, employeeId));
    parseSuccessJson(
      await runWithFile('project:repository:add', 'repository.json', {
        company_id: companyId,
        project_id: removedProjectId,
        repository: 'github.com/example/removed-alias',
      }),
    );

    const input = { company_id: companyId, project_id: removedProjectId };
    assert.deepEqual(parseSuccessJson(await runWithFile('project:remove', 'project.json', input)), {
      status: 'removed',
      project_id: removedProjectId,
    });

    const projects = await pool.query<{ id: string }>('SELECT id FROM projects');
    assert.deepEqual(projects.rows, [{ id: keptProjectId }]);
    const members = await pool.query<{ project_id: string }>('SELECT project_id FROM project_members');
    assert.deepEqual(members.rows, [{ project_id: keptProjectId }]);
    const repositories = await pool.query<{ repository_identifier: string }>('SELECT repository_identifier FROM project_repositories');
    assert.deepEqual(repositories.rows, [{ repository_identifier: 'github.com/example/kept' }]);
    assert.equal(await countRows(pool, 'employees'), 1);
  });

  it('削除済み・存在しない案件はproject_not_foundで拒否する', async () => {
    const companyId = await createCompany();
    const projectId = assertUuidV7((await createProject(companyId, 'github.com/example/a')).project_id);
    const input = { company_id: companyId, project_id: projectId };
    parseSuccessJson(await runWithFile('project:remove', 'project.json', input));

    expectFail(await runWithFile('project:remove', 'project.json', input), 'project_not_found');
    expectFail(await runWithFile('project:remove', 'project.json', { ...input, project_id: companyMissingUuid }), 'project_not_found');
  });

  it('未知keyと欠落keyをDB変更前にinvalid_inputで拒否する', async () => {
    const companyId = await createCompany();
    const projectId = assertUuidV7((await createProject(companyId, 'github.com/example/a')).project_id);

    expectFail(await runWithFile('project:remove', 'project.json', { company_id: companyId }), 'invalid_input');
    expectFail(
      await runWithFile('project:remove', 'project.json', { company_id: companyId, project_id: projectId, repository: 'github.com/example/a' }),
      'invalid_input',
    );
    assert.equal(await countRows(pool, 'projects'), 1);
  });
});

describe('異常系', () => {
  // DB接続先を到達不能にし、契約違反がDB接続前に拒否されることを示す。
  const unreachable = { DATABASE_URL: 'postgres://yori:yori@127.0.0.1:1/yori' };

  it('引数・入力file・入力値の誤りをDB接続前に固定codeで拒否する', async () => {
    expectFail(await runAdmin(['bootstrap'], { env: unreachable }), 'invalid_arguments');
    expectFail(await runAdmin(['unknown:command'], { env: unreachable }), 'invalid_arguments');
    expectFail(await runAdmin(['inspect'], { env: unreachable }), 'invalid_arguments');
    expectFail(await runAdmin(['inspect', 'not-a-uuid'], { env: unreachable }), 'invalid_arguments');
    expectFail(await runAdmin(['inspect', '0f8fad5b-d9cb-469f-a165-70867728950e', 'extra'], { env: unreachable }), 'invalid_arguments');
    expectFail(await runAdmin(['company:create', '/nonexistent/missing.json'], { env: unreachable }), 'invalid_input_file');
    expectFail(await runWithFile('company:create', 'broken.json', '{ not json', unreachable), 'invalid_input_file');
    expectFail(await runWithFile('company:create', 'unknown.json', { name: 'a', extra: true }, unreachable), 'invalid_input');
    expectFail(await runWithFile('employee:create', 'bad.json', { company_id: 'not-a-uuid', display_name: 'a' }, unreachable), 'invalid_input');
    expectFail(await runWithFile('token:issue', 'bad.json', { company_id: 'not-a-uuid', employee_id: companyMissingUuid }, unreachable), 'invalid_input');
    expectFail(await runWithFile('token:revoke', 'bad.json', { company_id: companyMissingUuid, token_id: 'not-a-uuid' }, unreachable), 'invalid_input');
    expectFail(await runWithFile('company:create', 'empty.json', {}, unreachable), 'invalid_input');
  });

  it('DATABASE_URL欠落をinvalid_admin_configで拒否する', async () => {
    expectFail(await runWithFile('company:create', 'company.json', { name: 'example' }, { DATABASE_URL: undefined }), 'invalid_admin_config');
  });

  it('0001 migration markerがないDBを成功扱いしない', async () => {
    await pool.query("DELETE FROM schema_migrations WHERE version = '0001_init.sql'");
    try {
      const bootstrap = await withInputFile('bootstrap.json', bootstrapInput(), (filePath) => runAdmin(['bootstrap', filePath]));
      expectFail(bootstrap, 'internal_error');
      assert.equal(await countRows(pool, 'companies'), 0, 'migration未適用DBをbootstrapが更新した');

      const inspect = await runAdmin(['inspect', companyMissingUuid]);
      expectFail(inspect, 'internal_error');
      for (const output of [bootstrap.stdout, bootstrap.stderr, inspect.stdout, inspect.stderr]) {
        assert.ok(!output.includes('schema_migrations'));
        assert.ok(!output.includes('0001_init.sql'));
        assert.ok(!output.includes('DATABASE_URL'));
        assert.ok(!output.includes('postgres://'));
      }
    } finally {
      await pool.query("INSERT INTO schema_migrations (version) VALUES ('0001_init.sql') ON CONFLICT DO NOTHING");
    }
  });

  it('空文字・NUL・単独surrogate・repository上限超過を拒否する', async () => {
    const companyId = await createCompany();
    const cases: [string, string, unknown][] = [
      ['company:create', 'company.json', { name: '' }],
      ['company:create', 'company.json', { name: 'bad\u0000name' }],
      ['company:create', 'company.json', { name: 'bad\uD800name' }],
      ['employee:create', 'employee.json', { company_id: companyId, display_name: '' }],
      ['employee:create', 'employee.json', { company_id: companyId, display_name: 'bad\u0000name' }],
      ['employee:create', 'employee.json', { company_id: companyId, display_name: 'bad\uDFFFname' }],
      ['project:create', 'project.json', { company_id: companyId, repository: '' }],
      ['project:create', 'project.json', { company_id: companyId, repository: 'bad\u0000repository' }],
      ['project:create', 'project.json', { company_id: companyId, repository: `/local/path` }],
      ['project:create', 'project.json', { company_id: companyId, repository: `github.com/example/${'a'.repeat(1024)}` }],
    ];
    for (const [command, name, input] of cases) {
      expectFail(await runWithFile(command, name, input), 'invalid_input');
    }
    assert.equal(await countRows(pool, 'employees'), 0);
    assert.equal(await countRows(pool, 'projects'), 0);
  });

  it('存在しない会社・社員・案件・tokenを固定codeで拒否する', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const projectId = assertUuidV7((await createProject(companyId, 'github.com/example/a')).project_id);

    expectFail(await runWithFile('employee:create', 'employee.json', { company_id: companyMissingUuid, display_name: 'Alice' }), 'company_not_found');
    expectFail(await runWithFile('project:create', 'project.json', { company_id: companyMissingUuid, repository: 'github.com/example/x' }), 'company_not_found');
    expectFail(await runAdmin(['inspect', companyMissingUuid]), 'company_not_found');
    expectFail(await runWithFile('member:add', 'member.json', { company_id: companyId, project_id: companyMissingUuid, employee_id: employeeId }), 'project_not_found');
    expectFail(await runWithFile('member:add', 'member.json', { company_id: companyId, project_id: projectId, employee_id: companyMissingUuid }), 'employee_not_found');
    expectFail(await runWithFile('token:issue', 'token.json', { company_id: companyId, employee_id: companyMissingUuid }), 'employee_not_found');
    expectFail(await runWithFile('token:revoke', 'revoke.json', { company_id: companyId, token_id: companyMissingUuid }), 'token_not_found');
  });

  it('既存所属・未存在所属・失効済みtokenを固定codeで区別する', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const projectId = assertUuidV7((await createProject(companyId, 'github.com/example/a')).project_id);
    parseSuccessJson(await addMember(companyId, projectId, employeeId));

    expectFail(await addMember(companyId, projectId, employeeId), 'member_already_exists');
    assert.equal(await countRows(pool, 'project_members'), 1);

    const memberInput = { company_id: companyId, project_id: projectId, employee_id: employeeId };
    const removed = parseSuccessJson(await runWithFile('member:remove', 'member.json', memberInput));
    assert.equal(removed.status, 'removed');
    expectFail(await runWithFile('member:remove', 'member.json', memberInput), 'member_not_found');

    const token = await issueTokenViaCli(companyId, employeeId);
    parseSuccessJson(await runWithFile('token:revoke', 'revoke.json', { company_id: companyId, token_id: str(token.token_id) }));
    expectFail(await runWithFile('token:revoke', 'revoke.json', { company_id: companyId, token_id: str(token.token_id) }), 'token_already_revoked');
  });
});

describe('競合とtoken生成', () => {
  it('同時bootstrapは片方だけが成功し、会社を二重登録しない', async () => {
    const [first, second] = await Promise.all([
      withInputFile('bootstrap.json', bootstrapInput(), (filePath) => runAdmin(['bootstrap', filePath])),
      withInputFile('bootstrap.json', bootstrapInput({ company: { name: 'second' } }), (filePath) => runAdmin(['bootstrap', filePath])),
    ]);

    const successes = [first, second].filter((run) => run.code === 0);
    const failures = [first, second].filter((run) => run.code !== 0);
    assert.equal(successes.length, 1, `成功したbootstrapが1件ではない: ${JSON.stringify([first, second])}`);
    assert.equal(failures.length, 1);
    expectFail(failures[0], 'bootstrap_already_completed');

    assert.equal(await countRows(pool, 'companies'), 1);
    assert.equal(await countRows(pool, 'employees'), 2);
    assert.equal(await countRows(pool, 'auth_tokens'), 2);
  });

  it('token hash衝突は限定回数だけ再生成し、上限でinternal_errorにする', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const otherEmployeeId = await createEmployee(companyId, 'Bob');
    const collisions = Array.from({ length: TOKEN_HASH_RETRY_LIMIT }, (_, index) => `yori_collision_${index}`);
    for (const token of collisions) {
      await insertAuthToken(pool, companyId, otherEmployeeId, token);
    }

    let generated = 0;
    const exhausted = await issueToken(
      pool,
      { company_id: companyId, employee_id: employeeId, scope: 'employee' },
      {
        generateToken: () => {
          generated += 1;
          return generated <= TOKEN_HASH_RETRY_LIMIT ? collisions[generated - 1] : `yori_fresh_${generated}`;
        },
      },
    );
    assert.deepEqual(exhausted, { ok: false, code: 'internal_error' });
    assert.equal(generated, TOKEN_HASH_RETRY_LIMIT, '衝突時の再生成回数が上限と一致しない');
    assert.equal(await countRows(pool, 'auth_tokens'), TOKEN_HASH_RETRY_LIMIT, '衝突時に余計な行を作っている');

    generated = 0;
    const retried = await issueToken(
      pool,
      { company_id: companyId, employee_id: employeeId, scope: 'employee' },
      {
        generateToken: () => {
          generated += 1;
          return generated === 1 ? collisions[0] : `yori_fresh_${generated}`;
        },
      },
    );
    assert.ok(retried.ok, '衝突後の再生成で成功していない');
    assert.equal(generated, 2, '衝突時に新しいtokenで再生成していない');
    assert.equal(retried.value.token, 'yori_fresh_2');
    assert.deepEqual(await authenticateWithToken(pool, 'yori_fresh_2'), { companyId, employeeId });
  });

  it('token hash以外の一意制約違反や一般エラーは再生成対象にしない', () => {
    assert.equal(isTokenHashConflict({ code: '23505', constraint: 'auth_tokens_token_hash_key' }), true);
    assert.equal(isTokenHashConflict({ code: '23505', constraint: 'projects_company_id_repository_identifier_key' }), false);
    assert.equal(isTokenHashConflict({ code: '23505' }), false);
    assert.equal(isTokenHashConflict({ code: '23503', constraint: 'auth_tokens_token_hash_key' }), false);
    assert.equal(isTokenHashConflict(new Error('connection terminated')), false);
    assert.equal(isTokenHashConflict(undefined), false);
  });
});

describe('情報漏えい', () => {
  it('生tokenは発行成功のstdoutにだけ現れ、DBにはSHA-256だけが残る', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const issued = await issueTokenViaCli(companyId, employeeId);
    const token = str(issued.token);

    assert.equal(await countRows(pool, 'auth_tokens'), 1);
    const rows = await pool.query<{ row: string; token_hash: Buffer }>('SELECT row_to_json(auth_tokens)::text AS row, token_hash FROM auth_tokens');
    assert.equal(rows.rows.length, 1);
    assert.equal(Buffer.compare(rows.rows[0].token_hash, sha256Utf8(token)), 0, '保存されたhashが生tokenのSHA-256ではない');
    assert.ok(!rows.rows[0].row.includes(token), 'DB行に生tokenが含まれている');

    const run = await runWithFile('token:issue', 'token.json', { company_id: companyId, employee_id: employeeId });
    const stdout = parseSuccessJson(run);
    const second = str(stdout.token);
    assert.notEqual(second, token, '再発行で同じ生tokenを返している');
    assert.equal(run.stdout.split(second).length - 1, 1, '生tokenがstdoutへ複数回現れている');
    assert.ok(!run.stdout.includes(token), '先に発行した生tokenが後続の出力へ現れている');
    assert.equal(await countRows(pool, 'auth_tokens'), 2);
  });

  it('失敗経路にtoken・hash・DATABASE_URL・入力file本文・DBエラー本文を出さない', async () => {
    const companyId = await createCompany();
    const employeeId = await createEmployee(companyId, 'Alice');
    const issued = await issueTokenViaCli(companyId, employeeId);

    const secret = 'SECRET_MARKER_9f2c';
    const failures: AdminRun[] = [
      await runWithFile('token:issue', 'unknown.json', { company_id: companyId, employee_id: employeeId, [secret]: secret }),
      await runWithFile('company:create', 'broken.json', `{ "${secret}": `),
      await runAdmin(['company:create', `/nonexistent/${secret}.json`]),
      await runAdmin(['token:issue', `${secret}.json`]),
      await runAdmin(['company:create', '/nonexistent/file.json'], { env: { DATABASE_URL: 'postgres://yori:secret-password@127.0.0.1:1/yori' } }),
      await runAdmin(['inspect', companyMissingUuid], { env: { DATABASE_URL: 'postgres://yori:secret-password@127.0.0.1:1/yori' } }),
    ];

    for (const run of failures) {
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^admin: [a-z_]+\n$/, `失敗出力が固定codeだけではない: ${JSON.stringify(run.stderr)}`);
      for (const forbidden of [secret, str(issued.token), sha256Utf8(str(issued.token)).toString('hex'), 'secret-password', 'DATABASE_URL', 'postgres://']) {
        assert.ok(!run.stderr.includes(forbidden), `stderrに禁止文字列が含まれている: ${forbidden}`);
        assert.ok(!run.stdout.includes(forbidden), `stdoutに禁止文字列が含まれている: ${forbidden}`);
      }
    }

    const internal = failures[failures.length - 1];
    expectFail(internal, 'internal_error');
  });
});
