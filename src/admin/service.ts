import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import {
  BOOTSTRAP_LOCK_KEY,
  TOKEN_HASH_RETRY_LIMIT,
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
  type TokenIssueInput,
  type TokenIssueOutput,
  type TokenRevokeInput,
  type TokenRevokeOutput,
} from './contract.js';
import { generateAuthToken, hashAuthToken } from './token.js';

export interface TokenIssueOptions {
  // テストがhash衝突を人工的に作れるよう、token生成を差し替え可能にする。
  generateToken?: () => string;
}

const REPOSITORY_CONSTRAINT = 'projects_company_id_repository_identifier_key';
const MEMBER_CONSTRAINT = 'project_members_pkey';
const TOKEN_HASH_CONSTRAINT = 'auth_tokens_token_hash_key';
const REQUIRED_MIGRATION = '0001_init.sql';

// PostgreSQLの一意制約違反だけを対象にする。他のDB障害を再生成や成功扱いで隠さない。
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export function isTokenHashConflict(error: unknown): boolean {
  return isUniqueViolation(error, TOKEN_HASH_CONSTRAINT);
}

// 1コマンド1 transaction。失敗時は必ずrollbackし、部分的な登録を残さない。
async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<AdminResult<T>>): Promise<AdminResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const migration = await client.query<{ version: string }>('SELECT version FROM schema_migrations WHERE version = $1', [
      REQUIRED_MIGRATION,
    ]);
    if (migration.rows.length !== 1) {
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
): Promise<{ tokenId: string; token: string } | null> {
  for (let attempt = 0; attempt < TOKEN_HASH_RETRY_LIMIT; attempt += 1) {
    const tokenId = uuidv7();
    const token = generateToken();
    await client.query('SAVEPOINT admin_auth_token_insert');
    try {
      await client.query('INSERT INTO auth_tokens (id, company_id, employee_id, token_hash) VALUES ($1, $2, $3, $4)', [
        tokenId,
        companyId,
        employeeId,
        hashAuthToken(token),
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
  return withTransaction(pool, async (client) => {
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
      if (isUniqueViolation(error, REPOSITORY_CONSTRAINT)) {
        return { ok: false, code: 'repository_conflict' };
      }
      throw error;
    }
    return {
      ok: true,
      value: {
        status: 'created',
        project_id: projectId,
        company_id: input.company_id,
        repository_identifier: input.repository,
      },
    };
  });
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
    const issued = await insertAuthToken(client, input.company_id, input.employee_id, generateToken);
    if (issued === null) {
      return { ok: false, code: 'internal_error' };
    }
    return {
      ok: true,
      value: { status: 'created', token_id: issued.tokenId, employee_id: input.employee_id, token: issued.token },
    };
  });
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
