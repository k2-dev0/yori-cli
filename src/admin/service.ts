import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import {
  AUTO_SEARCH_NOTIFY_WAIT_MS,
  BOOTSTRAP_LOCK_KEY,
  TOKEN_HASH_RETRY_LIMIT,
  TOKENS_PER_PRICE_UNIT,
  USD_PER_MILLION_INPUT_TOKENS,
  type UsageOutput,
  type AdminResult,
  type BootstrapInput,
  type BootstrapOutput,
  type CompanyCreateInput,
  type CompanyCreateOutput,
  type EmployeeCreateInput,
  type EmployeeCreateOutput,
  type InspectOutput,
  type MemberAddOutput,
  type MemberInput,
  type MemberRemoveOutput,
  type ProjectCreateInput,
  type ProjectCreateOutput,
  type ProjectRemoveInput,
  type ProjectRemoveOutput,
  type RedactionListOutput,
  type RedactionPolicy,
  type RedactionReplaceInput,
  type RedactionReplaceOutput,
  type RepositoryAddOutput,
  type RepositoryInput,
  type RepositoryRemoveOutput,
  type TokenIssueInput,
  type TokenIssueOutput,
  type TokenScope,
  type TokenRevokeInput,
  type TokenRevokeOutput,
} from './contract.js';
import { validateRedactionPolicy } from './redaction-rules.js';
import { generateAuthToken, hashAuthToken } from './token.js';

export interface TokenIssueOptions {
  // テストがhash衝突を人工的に作れるよう、token生成を差し替え可能にする。
  generateToken?: () => string;
}

const REPOSITORY_CONSTRAINT = 'projects_company_id_repository_identifier_key';
const MEMBER_CONSTRAINT = 'project_members_pkey';
const TOKEN_HASH_CONSTRAINT = 'auth_tokens_token_hash_key';
const REQUIRED_MIGRATION = '0001_init.sql';
const REDACTION_MIGRATION = '0010_custom_redaction.sql';
const AUTH_TOKEN_SCOPE_MIGRATION = '0013_auth_token_scope.sql';
// usageが読むjobs.started_atとusage_events.job_idを足したyori本体のmigration。
const USAGE_MIGRATION = '0021_job_timing_usage_job.sql';
const JEV_PROVIDER = 'jev';
const MS_PER_SECOND = 1_000;
const REDACTION_DETECTOR_VERSION = 'initial-v1';

// PostgreSQLの一意制約違反だけを対象にする。他のDB障害を再生成や成功扱いで隠さない。
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

// 制約名を持たないtriggerの23505も含め、一意制約違反コードだけを対象にする。
function isUniqueViolationCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (error as { code?: unknown }).code === '23505';
}

export function isTokenHashConflict(error: unknown): boolean {
  return isUniqueViolation(error, TOKEN_HASH_CONSTRAINT);
}

// 1コマンド1 transaction。失敗時は必ずrollbackし、部分的な登録を残さない。
async function withTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<AdminResult<T>>,
  requiredMigrations: readonly string[] = [REQUIRED_MIGRATION],
): Promise<AdminResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const migration = await client.query<{ version: string }>('SELECT version FROM schema_migrations WHERE version = ANY($1)', [
      requiredMigrations,
    ]);
    if (migration.rows.length !== requiredMigrations.length) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'internal_error' };
    }
    const result = await run(client);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function requireRef<T>(map: Map<string, T>, ref: string): T {
  const value = map.get(ref);
  if (value === undefined) {
    // 未知refはcontractのZodで拒否しているため到達しない。
    throw new Error('refを解決できません');
  }
  return value;
}

// tokenを発行し、hash衝突のときだけsavepointで巻き戻して新しいtokenで再生成する。
// 他のDB障害は再生成で隠さず、そのまま呼出元へ返す。上限まで衝突したらnullを返す。
async function insertAuthToken(
  client: PoolClient,
  companyId: string,
  employeeId: string,
  generateToken: () => string,
  scope: TokenScope = 'employee',
): Promise<{ tokenId: string; token: string } | null> {
  for (let attempt = 0; attempt < TOKEN_HASH_RETRY_LIMIT; attempt += 1) {
    const tokenId = uuidv7();
    const token = generateToken();
    await client.query('SAVEPOINT admin_auth_token_insert');
    try {
      await client.query('INSERT INTO auth_tokens (id, company_id, employee_id, token_hash, scope) VALUES ($1, $2, $3, $4, $5)', [
        tokenId,
        companyId,
        employeeId,
        hashAuthToken(token),
        scope,
      ]);
      await client.query('RELEASE SAVEPOINT admin_auth_token_insert');
      return { tokenId, token };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT admin_auth_token_insert');
      if (!isTokenHashConflict(error)) {
        throw error;
      }
    }
  }
  return null;
}

export async function runBootstrap(pool: Pool, input: BootstrapInput, options: TokenIssueOptions = {}): Promise<AdminResult<BootstrapOutput>> {
  const generateToken = options.generateToken ?? generateAuthToken;
  return withTransaction(pool, async (client) => {
    // 空DB判定と登録を直列化し、同時bootstrapが双方とも空DBを観測する競合を防ぐ。
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [BOOTSTRAP_LOCK_KEY]);
    const existing = await client.query('SELECT 1 FROM companies LIMIT 1');
    if (existing.rows.length > 0) {
      return { ok: false, code: 'bootstrap_already_completed' };
    }

    const companyId = uuidv7();
    await client.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, input.company.name]);

    const employeeIds = new Map<string, string>();
    const employees: BootstrapOutput['employees'] = [];
    for (const employee of input.employees) {
      const employeeId = uuidv7();
      await client.query('INSERT INTO employees (id, company_id, display_name) VALUES ($1, $2, $3)', [
        employeeId,
        companyId,
        employee.display_name,
      ]);
      employeeIds.set(employee.ref, employeeId);
      employees.push({ ref: employee.ref, employee_id: employeeId, display_name: employee.display_name });
    }

    const projects: BootstrapOutput['projects'] = [];
    const members: BootstrapOutput['members'] = [];
    for (const project of input.projects) {
      const projectId = uuidv7();
      try {
        await client.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
          projectId,
          companyId,
          project.repository,
        ]);
      } catch (error) {
        // 途中の制約違反は先行insertごとrollbackする（呼出元のwithTransactionがROLLBACKする）。
        if (isUniqueViolation(error, REPOSITORY_CONSTRAINT)) {
          return { ok: false, code: 'repository_conflict' };
        }
        throw error;
      }
      projects.push({ ref: project.ref, project_id: projectId, repository_identifier: project.repository });
      for (const memberRef of project.member_refs) {
        const employeeId = requireRef(employeeIds, memberRef);
        await client.query('INSERT INTO project_members (project_id, employee_id) VALUES ($1, $2)', [projectId, employeeId]);
        members.push({ project_id: projectId, employee_id: employeeId });
      }
    }

    const tokens: BootstrapOutput['tokens'] = [];
    for (const employee of input.employees) {
      if (!employee.issue_token) {
        continue;
      }
      const employeeId = requireRef(employeeIds, employee.ref);
      const issued = await insertAuthToken(client, companyId, employeeId, generateToken);
      if (issued === null) {
        return { ok: false, code: 'internal_error' };
      }
      tokens.push({ ref: employee.ref, token_id: issued.tokenId, employee_id: employeeId, token: issued.token });
    }

    return {
      ok: true,
      value: {
        status: 'created',
        company: { company_id: companyId, name: input.company.name },
        employees,
        projects,
        members,
        tokens,
      },
    };
  });
}

export async function createCompany(pool: Pool, input: CompanyCreateInput): Promise<AdminResult<CompanyCreateOutput>> {
  return withTransaction(pool, async (client) => {
    const companyId = uuidv7();
    await client.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, input.name]);
    return { ok: true, value: { status: 'created', company_id: companyId, name: input.name } };
  });
}

export async function createEmployee(pool: Pool, input: EmployeeCreateInput): Promise<AdminResult<EmployeeCreateOutput>> {
  return withTransaction(pool, async (client) => {
    const company = await client.query('SELECT 1 FROM companies WHERE id = $1', [input.company_id]);
    if (company.rows.length === 0) {
      return { ok: false, code: 'company_not_found' };
    }
    const employeeId = uuidv7();
    await client.query('INSERT INTO employees (id, company_id, display_name) VALUES ($1, $2, $3)', [
      employeeId,
      input.company_id,
      input.display_name,
    ]);
    return {
      ok: true,
      value: { status: 'created', employee_id: employeeId, company_id: input.company_id, display_name: input.display_name },
    };
  });
}

export async function createProject(pool: Pool, input: ProjectCreateInput): Promise<AdminResult<ProjectCreateOutput>> {
  return withTransaction(
    pool,
    async (client) => {
      const company = await client.query('SELECT 1 FROM companies WHERE id = $1', [input.company_id]);
      if (company.rows.length === 0) {
        return { ok: false, code: 'company_not_found' };
      }
      const projectId = uuidv7();
      try {
        await client.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
          projectId,
          input.company_id,
          input.repository,
        ]);
      } catch (error) {
        // 同じ会社で同じcanonical identifierの案件は登録せず、既存案件も変更しない。
        // 0010のtriggerが先に23505を返す場合も同じconflictへ縮退する。
        if (isUniqueViolation(error, REPOSITORY_CONSTRAINT) || isUniqueViolationCode(error)) {
          return { ok: false, code: 'repository_conflict' };
        }
        throw error;
      }
      // primary repositoryも同じtransactionでalias表へ登録し、aliasとprimaryの衝突判定を一本化する。
      await client.query('INSERT INTO project_repositories (project_id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
        projectId,
        input.company_id,
        input.repository,
      ]);
      return {
        ok: true,
        value: {
          status: 'created',
          project_id: projectId,
          company_id: input.company_id,
          repository_identifier: input.repository,
        },
      };
    },
    [REQUIRED_MIGRATION, REDACTION_MIGRATION],
  );
}

export async function addMember(pool: Pool, input: MemberInput): Promise<AdminResult<MemberAddOutput>> {
  return withTransaction(pool, async (client) => {
    const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND company_id = $2', [input.project_id, input.company_id]);
    if (project.rows.length === 0) {
      return { ok: false, code: 'project_not_found' };
    }
    const employee = await client.query<{ company_id: string }>('SELECT company_id FROM employees WHERE id = $1', [input.employee_id]);
    const employeeRow = employee.rows[0];
    if (employeeRow === undefined) {
      return { ok: false, code: 'employee_not_found' };
    }
    if (employeeRow.company_id !== input.company_id) {
      return { ok: false, code: 'company_scope_mismatch' };
    }
    try {
      await client.query('INSERT INTO project_members (project_id, employee_id) VALUES ($1, $2)', [input.project_id, input.employee_id]);
    } catch (error) {
      if (isUniqueViolation(error, MEMBER_CONSTRAINT)) {
        return { ok: false, code: 'member_already_exists' };
      }
      throw error;
    }
    return { ok: true, value: { status: 'created', project_id: input.project_id, employee_id: input.employee_id } };
  });
}

// 会社境界内のproject行を物理削除する。所属・alias・収集済みデータは外部キーのON DELETE CASCADEで同じtransaction内に消える。
export async function removeProject(pool: Pool, input: ProjectRemoveInput): Promise<AdminResult<ProjectRemoveOutput>> {
  return withTransaction(pool, async (client) => {
    const removed = await client.query('DELETE FROM projects WHERE id = $1 AND company_id = $2', [input.project_id, input.company_id]);
    if (removed.rowCount !== 1) {
      return { ok: false, code: 'project_not_found' };
    }
    return { ok: true, value: { status: 'removed', project_id: input.project_id } };
  });
}

export async function removeMember(pool: Pool, input: MemberInput): Promise<AdminResult<MemberRemoveOutput>> {
  return withTransaction(pool, async (client) => {
    const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND company_id = $2', [input.project_id, input.company_id]);
    if (project.rows.length === 0) {
      return { ok: false, code: 'project_not_found' };
    }
    const employee = await client.query<{ company_id: string }>('SELECT company_id FROM employees WHERE id = $1', [input.employee_id]);
    const employeeRow = employee.rows[0];
    if (employeeRow === undefined) {
      return { ok: false, code: 'employee_not_found' };
    }
    if (employeeRow.company_id !== input.company_id) {
      return { ok: false, code: 'company_scope_mismatch' };
    }
    const removed = await client.query('DELETE FROM project_members WHERE project_id = $1 AND employee_id = $2', [
      input.project_id,
      input.employee_id,
    ]);
    if (removed.rowCount !== 1) {
      return { ok: false, code: 'member_not_found' };
    }
    return { ok: true, value: { status: 'removed', project_id: input.project_id, employee_id: input.employee_id } };
  });
}

export async function issueToken(pool: Pool, input: TokenIssueInput, options: TokenIssueOptions = {}): Promise<AdminResult<TokenIssueOutput>> {
  const generateToken = options.generateToken ?? generateAuthToken;
  return withTransaction(pool, async (client) => {
    // 社員の会社を毎回DB正本で確認し、他社の社員へtokenを発行しない。
    const employee = await client.query<{ company_id: string }>('SELECT company_id FROM employees WHERE id = $1', [input.employee_id]);
    const employeeRow = employee.rows[0];
    if (employeeRow === undefined) {
      return { ok: false, code: 'employee_not_found' };
    }
    if (employeeRow.company_id !== input.company_id) {
      return { ok: false, code: 'company_scope_mismatch' };
    }
    const issued = await insertAuthToken(client, input.company_id, input.employee_id, generateToken, input.scope);
    if (issued === null) {
      return { ok: false, code: 'internal_error' };
    }
    return {
      ok: true,
      value: { status: 'created', token_id: issued.tokenId, employee_id: input.employee_id, scope: input.scope, token: issued.token },
    };
  }, [REQUIRED_MIGRATION, AUTH_TOKEN_SCOPE_MIGRATION]);
}

export async function revokeToken(pool: Pool, input: TokenRevokeInput): Promise<AdminResult<TokenRevokeOutput>> {
  return withTransaction(pool, async (client) => {
    const token = await client.query<{ company_id: string; employee_company_id: string; revoked_at: Date | null }>(
      `SELECT t.company_id, e.company_id AS employee_company_id, t.revoked_at
         FROM auth_tokens t
         JOIN employees e ON e.id = t.employee_id
        WHERE t.id = $1`,
      [input.token_id],
    );
    const row = token.rows[0];
    if (row === undefined) {
      return { ok: false, code: 'token_not_found' };
    }
    if (row.company_id !== input.company_id || row.employee_company_id !== input.company_id) {
      return { ok: false, code: 'company_scope_mismatch' };
    }
    if (row.revoked_at !== null) {
      return { ok: false, code: 'token_already_revoked' };
    }
    // 失効は物理削除せずrevoked_atで表す。同時失効はWHEREで一方だけを成功させる。
    const updated = await client.query('UPDATE auth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [input.token_id]);
    if (updated.rowCount !== 1) {
      return { ok: false, code: 'token_already_revoked' };
    }
    return { ok: true, value: { status: 'revoked', token_id: input.token_id } };
  });
}

export async function inspectCompany(pool: Pool, companyId: string): Promise<AdminResult<InspectOutput>> {
  return withTransaction(pool, async (client) => {
    const company = await client.query<{ id: string; name: string; created_at: Date }>(
      'SELECT id, name, created_at FROM companies WHERE id = $1',
      [companyId],
    );
    const companyRow = company.rows[0];
    if (companyRow === undefined) {
      return { ok: false, code: 'company_not_found' };
    }

    const employees = await client.query<{ id: string; display_name: string; created_at: Date }>(
      'SELECT id, display_name, created_at FROM employees WHERE company_id = $1 ORDER BY created_at, id',
      [companyId],
    );
    const projects = await client.query<{ id: string; repository_identifier: string; created_at: Date }>(
      'SELECT id, repository_identifier, created_at FROM projects WHERE company_id = $1 ORDER BY created_at, id',
      [companyId],
    );
    const members = await client.query<{ project_id: string; employee_id: string; created_at: Date }>(
      `SELECT pm.project_id, pm.employee_id, pm.created_at
         FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
        WHERE p.company_id = $1
        ORDER BY pm.created_at, pm.project_id, pm.employee_id`,
      [companyId],
    );
    // token hashと生tokenは返さない。metadataだけを会社scopeで返す。
    const tokens = await client.query<{ id: string; employee_id: string; created_at: Date; revoked_at: Date | null }>(
      `SELECT t.id, t.employee_id, t.created_at, t.revoked_at
         FROM auth_tokens t
         JOIN employees e ON e.id = t.employee_id AND e.company_id = t.company_id
        WHERE t.company_id = $1
        ORDER BY t.created_at, t.id`,
      [companyId],
    );

    return {
      ok: true,
      value: {
        status: 'ok',
        company: { company_id: companyRow.id, name: companyRow.name, created_at: companyRow.created_at.toISOString() },
        employees: employees.rows.map((row) => ({
          employee_id: row.id,
          display_name: row.display_name,
          created_at: row.created_at.toISOString(),
        })),
        projects: projects.rows.map((row) => ({
          project_id: row.id,
          repository_identifier: row.repository_identifier,
          created_at: row.created_at.toISOString(),
        })),
        members: members.rows.map((row) => ({
          project_id: row.project_id,
          employee_id: row.employee_id,
          created_at: row.created_at.toISOString(),
        })),
        tokens: tokens.rows.map((row) => ({
          token_id: row.id,
          employee_id: row.employee_id,
          created_at: row.created_at.toISOString(),
          revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
        })),
      },
    };
  });
}

// 日・providerごとの外部呼出し。$3/$4は単価表、$5は単価の基準token数。単価の無いproviderの費用はNULL。
const USAGE_DAILY_SQL = `
  SELECT to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_date, u.provider, count(*)::int AS calls,
         (count(*) FILTER (WHERE NOT u.success))::int AS failed, COALESCE(sum(u.input_tokens), 0)::float8 AS input_tokens,
         COALESCE(sum(u.input_tokens), 0)::float8 * max(price.usd) / $5 AS cost_usd
    FROM usage_events u LEFT JOIN unnest($3::text[], $4::float8[]) AS price(provider, usd) ON price.provider = u.provider
   WHERE u.company_id = $1 AND u.created_at >= $2
   GROUP BY 1, 2 ORDER BY 1, 2`;

// provider・処理ごとの外部呼出しと所要時間の中央値・90%点。引数はUSAGE_DAILY_SQLと同じ。
const USAGE_OPERATIONS_SQL = `
  SELECT u.provider, u.operation, count(*)::int AS calls, (count(*) FILTER (WHERE NOT u.success))::int AS failed,
         COALESCE(sum(u.input_tokens), 0)::float8 AS input_tokens, COALESCE(sum(u.input_tokens), 0)::float8 * max(price.usd) / $5 AS cost_usd,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY u.duration_ms) AS duration_ms_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY u.duration_ms) AS duration_ms_p90
    FROM usage_events u LEFT JOIN unnest($3::text[], $4::float8[]) AS price(provider, usd) ON price.provider = u.provider
   WHERE u.company_id = $1 AND u.created_at >= $2
   GROUP BY 1, 2 ORDER BY 1, 2`;

// 完了したjobの種別ごとの待ち（作成→開始）と処理時間（開始→完了）。$3はJevの単価、$4は基準token数、$5は1秒のms。
const USAGE_JOBS_SQL = `
  SELECT j.kind, count(*)::int AS completed, COALESCE(sum(c.input_tokens), 0)::float8 * $3 / $4 / count(*) AS jev_cost_usd_per_job,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM j.started_at - j.created_at) * $5) AS wait_ms_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM j.started_at - j.created_at) * $5) AS wait_ms_p90,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM j.updated_at - j.started_at) * $5) AS run_ms_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM j.updated_at - j.started_at) * $5) AS run_ms_p90
    FROM jobs j JOIN sessions s ON s.id = j.session_id JOIN projects p ON p.id = s.project_id
    LEFT JOIN LATERAL (SELECT sum(u.input_tokens) AS input_tokens FROM usage_events u WHERE u.job_id = j.id AND u.provider = $6) c ON true
   WHERE p.company_id = $1 AND j.status = 'completed' AND j.started_at >= $2
   GROUP BY j.kind ORDER BY j.kind`;

// 完了した自動検索の受付から完了まで。$3は1秒のms、$4は入力時のhookが待つ上限のms。
const USAGE_AUTO_SEARCH_SQL = `
  SELECT count(*)::int AS completed, avg((extract(epoch FROM r.updated_at - r.created_at) * $3 <= $4)::int)::float8 AS within_notify_wait_ratio,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.updated_at - r.created_at) * $3) AS duration_ms_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM r.updated_at - r.created_at) * $3) AS duration_ms_p90
    FROM search_requests r
   WHERE r.company_id = $1 AND r.trigger = 'auto' AND r.status = 'completed' AND r.created_at >= $2`;

// 外部呼出しの費用・所要時間と、jobと自動検索の所要時間を会社scopeで集計する。原文・tokenは読まない。
export async function reportCompanyUsage(pool: Pool, companyId: string, days: number): Promise<AdminResult<UsageOutput>> {
  return withTransaction(
    pool,
    async (client) => {
      const company = await client.query<{ since: Date }>('SELECT now() - make_interval(days => $2) AS since FROM companies WHERE id = $1', [companyId, days]);
      const since = company.rows[0]?.since;
      if (since === undefined) {
        return { ok: false, code: 'company_not_found' };
      }
      const prices = [Object.keys(USD_PER_MILLION_INPUT_TOKENS), Object.values(USD_PER_MILLION_INPUT_TOKENS), TOKENS_PER_PRICE_UNIT];
      const daily = await client.query<UsageOutput['daily'][number]>(USAGE_DAILY_SQL, [companyId, since, ...prices]);
      const operations = await client.query<UsageOutput['operations'][number]>(USAGE_OPERATIONS_SQL, [companyId, since, ...prices]);
      const jobParams = [companyId, since, USD_PER_MILLION_INPUT_TOKENS[JEV_PROVIDER], TOKENS_PER_PRICE_UNIT, MS_PER_SECOND, JEV_PROVIDER];
      const jobs = await client.query<UsageOutput['jobs'][number]>(USAGE_JOBS_SQL, jobParams);
      const searchParams = [companyId, since, MS_PER_SECOND, AUTO_SEARCH_NOTIFY_WAIT_MS];
      const autoSearch = await client.query<UsageOutput['auto_search']>(USAGE_AUTO_SEARCH_SQL, searchParams);
      // 集計関数だけの問合せなので、自動検索は対象が0件でも必ず1行返る。
      const value: UsageOutput = {
        status: 'ok',
        company_id: companyId,
        days,
        since: since.toISOString(),
        usd_per_million_input_tokens: { ...USD_PER_MILLION_INPUT_TOKENS },
        daily: daily.rows,
        operations: operations.rows,
        jobs: jobs.rows,
        auto_search: autoSearch.rows[0] as UsageOutput['auto_search'],
      };
      return { ok: true, value };
    },
    [REQUIRED_MIGRATION, USAGE_MIGRATION],
  );
}

// 検証済みpolicyのfield/termを0010の正規化規則で保存する。
// fieldはcase-insensitive照合用にlower(value)、termはcase-sensitive照合のためvalueそのものを使う。
async function insertRedactionRules(client: PoolClient, companyId: string, policy: RedactionPolicy): Promise<void> {
  for (const field of policy.fields) {
    await client.query('INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)', [
      companyId,
      'field',
      field,
      field.toLowerCase(),
    ]);
  }
  for (const term of policy.terms) {
    await client.query('INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)', [
      companyId,
      'term',
      term,
      term,
    ]);
  }
}

// 会社のcurrent policyをCASで置換する。初回だけexpected_version 0を受ける。
export async function replaceRedactionPolicy(pool: Pool, input: RedactionReplaceInput): Promise<AdminResult<RedactionReplaceOutput>> {
  // fields/terms/suspicion_modeはDBへ触れる前に0010契約で検証し、不正入力では何も変更しない。
  let policy: RedactionPolicy;
  try {
    policy = validateRedactionPolicy({
      version: input.expected_version,
      fields: input.fields,
      terms: input.terms,
      suspicion_mode: input.suspicion_mode,
      detector_version: REDACTION_DETECTOR_VERSION,
    });
  } catch {
    return { ok: false, code: 'invalid_input' };
  }
  return withTransaction(
    pool,
    async (client) => {
      const company = await client.query('SELECT 1 FROM companies WHERE id = $1', [input.company_id]);
      if (company.rows.length === 0) {
        return { ok: false, code: 'company_not_found' };
      }
      const existing = await client.query<{ version: number }>(
        'SELECT version FROM company_redaction_policies WHERE company_id = $1 FOR UPDATE',
        [input.company_id],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        if (input.expected_version !== 0) {
          return { ok: false, code: 'redaction_policy_not_found' };
        }
        await client.query(
          'INSERT INTO company_redaction_policies (company_id, version, suspicion_mode, detector_version) VALUES ($1, 1, $2, $3)',
          [input.company_id, policy.suspicion_mode, policy.detector_version],
        );
        await insertRedactionRules(client, input.company_id, policy);
        return { ok: true, value: { status: 'replaced', company_id: input.company_id, version: 1 } };
      }
      if (row.version !== input.expected_version) {
        return { ok: false, code: 'redaction_policy_conflict' };
      }
      await client.query('DELETE FROM company_redaction_rules WHERE company_id = $1', [input.company_id]);
      await insertRedactionRules(client, input.company_id, policy);
      const nextVersion = row.version + 1;
      await client.query(
        'UPDATE company_redaction_policies SET version = $2, suspicion_mode = $3, detector_version = $4, updated_at = now() WHERE company_id = $1',
        [input.company_id, nextVersion, policy.suspicion_mode, policy.detector_version],
      );
      return { ok: true, value: { status: 'replaced', company_id: input.company_id, version: nextVersion } };
    },
    [REQUIRED_MIGRATION, REDACTION_MIGRATION],
  );
}

// 会社のcurrent policyをversion・fields・terms・suspicion_mode・detector_versionだけで返す。
// policy未登録の会社はversion 0・field/term空・既定observeを返す。
export async function listRedactionPolicy(pool: Pool, companyId: string): Promise<AdminResult<RedactionListOutput>> {
  return withTransaction(
    pool,
    async (client) => {
      const company = await client.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
      if (company.rows.length === 0) {
        return { ok: false, code: 'company_not_found' };
      }
      const policy = await client.query<{ version: number; suspicion_mode: string; detector_version: string }>(
        'SELECT version, suspicion_mode, detector_version FROM company_redaction_policies WHERE company_id = $1',
        [companyId],
      );
      const row = policy.rows[0];
      if (row === undefined) {
        return {
          ok: true,
          value: { version: 0, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' },
        };
      }
      if (
        (row.suspicion_mode !== 'observe' && row.suspicion_mode !== 'block') ||
        row.detector_version !== REDACTION_DETECTOR_VERSION
      ) {
        // 0010のCHECKを迂回した行を部分的に隠さず失敗させる。
        return { ok: false, code: 'internal_error' };
      }
      const rules = await client.query<{ rule_type: string; value: string; normalized_value: string }>(
        'SELECT rule_type, value, normalized_value FROM company_redaction_rules WHERE company_id = $1',
        [companyId],
      );
      const fields: string[] = [];
      const terms: string[] = [];
      for (const rule of rules.rows) {
        if (rule.rule_type === 'field' && rule.normalized_value === rule.value.toLowerCase()) {
          fields.push(rule.value);
        } else if (rule.rule_type === 'term' && rule.normalized_value === rule.value) {
          terms.push(rule.value);
        } else {
          // 0010契約外のruleを隠した部分的成功にしない。
          return { ok: false, code: 'internal_error' };
        }
      }
      fields.sort();
      terms.sort();
      return {
        ok: true,
        value: {
          version: row.version,
          fields,
          terms,
          suspicion_mode: row.suspicion_mode,
          detector_version: REDACTION_DETECTOR_VERSION,
        },
      };
    },
    [REQUIRED_MIGRATION, REDACTION_MIGRATION],
  );
}

// 会社境界を確認したprojectへcanonical repository aliasを追加する。
export async function addRepository(pool: Pool, input: RepositoryInput): Promise<AdminResult<RepositoryAddOutput>> {
  return withTransaction(
    pool,
    async (client) => {
      const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND company_id = $2', [input.project_id, input.company_id]);
      if (project.rows.length === 0) {
        return { ok: false, code: 'project_not_found' };
      }
      try {
        await client.query('INSERT INTO project_repositories (project_id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
          input.project_id,
          input.company_id,
          input.repository,
        ]);
      } catch (error) {
        // 既存aliasとの重複と、他projectのprimaryとの衝突は同じrepository_conflictへ縮退する。
        if (isUniqueViolationCode(error)) {
          return { ok: false, code: 'repository_conflict' };
        }
        throw error;
      }
      return { ok: true, value: { status: 'created', project_id: input.project_id, repository_identifier: input.repository } };
    },
    [REQUIRED_MIGRATION, REDACTION_MIGRATION],
  );
}

// 会社境界を確認したprojectからrepository aliasだけを削除する。primary行は対象にしない。
export async function removeRepository(pool: Pool, input: RepositoryInput): Promise<AdminResult<RepositoryRemoveOutput>> {
  return withTransaction(
    pool,
    async (client) => {
      const project = await client.query<{ repository_identifier: string }>(
        'SELECT repository_identifier FROM projects WHERE id = $1 AND company_id = $2',
        [input.project_id, input.company_id],
      );
      const projectRow = project.rows[0];
      if (projectRow === undefined) {
        return { ok: false, code: 'project_not_found' };
      }
      // primary repositoryは案件identityそのものなので、alias表から削除させない。
      if (projectRow.repository_identifier === input.repository) {
        return { ok: false, code: 'repository_conflict' };
      }
      const removed = await client.query(
        'DELETE FROM project_repositories WHERE project_id = $1 AND company_id = $2 AND repository_identifier = $3',
        [input.project_id, input.company_id, input.repository],
      );
      if (removed.rowCount !== 1) {
        return { ok: false, code: 'repository_not_found' };
      }
      return { ok: true, value: { status: 'removed', project_id: input.project_id, repository_identifier: input.repository } };
    },
    [REQUIRED_MIGRATION, REDACTION_MIGRATION],
  );
}
