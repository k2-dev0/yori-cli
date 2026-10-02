import { z } from 'zod';
import type { AdminErrorCode, AdminResult } from '../admin/contract.js';
import { loadCollectorApiUrl, requestCollectorSetup } from './api.js';
import { CollectorFailure, isSupportedCollectorPlatform } from './contract.js';
import { resolveRepositoryFromCwd } from './git.js';
import {
  deleteAdminKeychainToken,
  deleteKeychainToken,
  ensureAdminKeychainToken,
  ensureKeychainToken,
} from './keychain.js';
import { collectorConfigPath, collectorHome } from './layout.js';

const tokenScopeSchema = z.enum(['employee', 'company_admin']);
const timestampSchema = z.iso.datetime({ offset: true });
const companySchema = z.strictObject({ company_id: z.uuid(), name: z.string().min(1) });
const employeeSchema = z.strictObject({ employee_id: z.uuid(), display_name: z.string().min(1), created_at: timestampSchema });
const projectSchema = z.strictObject({ project_id: z.uuid(), repository: z.string().min(1), created_at: timestampSchema });
const tokenMetadataSchema = z.strictObject({
  token_id: z.uuid(),
  employee_id: z.uuid(),
  scope: tokenScopeSchema,
  created_at: timestampSchema,
  revoked_at: timestampSchema.nullable(),
});
const meResponseSchema = z.strictObject({
  company: companySchema,
  employee: employeeSchema,
  token: tokenMetadataSchema.omit({ employee_id: true }),
  projects: z.array(projectSchema),
});
const companyResponseSchema = z.strictObject({
  company: companySchema,
  employees: z.array(employeeSchema),
  projects: z.array(projectSchema),
  tokens: z.array(tokenMetadataSchema),
});
const memberCreateResponseSchema = employeeSchema.extend({ status: z.literal('done') });
const employeeRenameResponseSchema = z.strictObject({
  status: z.literal('done'),
  employee_id: z.uuid(),
  display_name: z.string().min(1),
});
const issueResponseSchema = z.strictObject({
  status: z.literal('done'),
  token_id: z.uuid(),
  employee_id: z.uuid(),
  scope: tokenScopeSchema,
  token: z.string().regex(/^yori_[A-Za-z0-9_-]+$/),
});
const revokeResponseSchema = z.strictObject({ status: z.enum(['done', 'already']), token_id: z.uuid() });
const projectRemovalResponseSchema = z.strictObject({ status: z.literal('done'), project_id: z.uuid() });
const accountErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.enum(['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'internal_error']) }),
});

export type TokenScope = z.infer<typeof tokenScopeSchema>;
export type MeOutput = z.infer<typeof meResponseSchema>;
export type CompanyOutput = z.infer<typeof companyResponseSchema>;
export type MemberCreateOutput = z.infer<typeof memberCreateResponseSchema>;
export type EmployeeRenameOutput = z.infer<typeof employeeRenameResponseSchema>;
export type TokenIssueOutput = z.infer<typeof issueResponseSchema>;
export type TokenRevokeOutput = z.infer<typeof revokeResponseSchema>;
export type ProjectRemovalOutput = z.infer<typeof projectRemovalResponseSchema>;
export interface ProjectRemovalTarget {
  project_id: string;
  repository: string;
}
export interface MemberCreateWithTokenOutput {
  status: 'done';
  employee_id: string;
  display_name: string;
  token_id: string;
  scope: 'employee';
  token: string;
}

function apiFailure(status: number, body: unknown, notFound: AdminErrorCode, conflict: AdminErrorCode): never {
  const parsed = accountErrorSchema.safeParse(body);
  if (!parsed.success) throw new CollectorFailure('collector_server_incompatible');
  const code = parsed.data.error.code;
  if (status === 400 && code === 'invalid_request') throw new CollectorFailure('collector_invalid_request');
  if (status === 401 && code === 'unauthorized') throw new CollectorFailure('collector_unauthorized');
  if (status === 403 && code === 'forbidden') throw new CollectorFailure('forbidden');
  if (status === 404 && code === 'not_found') throw new CollectorFailure(notFound);
  if (status === 409 && code === 'conflict') throw new CollectorFailure(conflict);
  if (status === 500 && code === 'internal_error') throw new CollectorFailure('internal_error');
  throw new CollectorFailure('collector_server_incompatible');
}

async function requestJson<T>(
  apiUrl: string,
  token: string,
  path: string,
  init: RequestInit,
  expectedStatus: number,
  schema: z.ZodType<T>,
  notFound: AdminErrorCode,
  conflict: AdminErrorCode,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CollectorFailure('collector_internal_error');
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === expectedStatus) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new CollectorFailure('collector_internal_error');
    return parsed.data;
  }
  return apiFailure(response.status, body, notFound, conflict);
}

async function withAccountToken<T>(env: NodeJS.ProcessEnv, admin: boolean, run: (apiUrl: string, token: string) => Promise<T>): Promise<T> {
  const home = collectorHome(env);
  const apiUrl = await loadCollectorApiUrl(collectorConfigPath(home));
  const keychain = admin ? ensureAdminKeychainToken(env, apiUrl) : ensureKeychainToken(env, apiUrl);
  try {
    return await run(apiUrl, keychain.token);
  } catch (error) {
    if (error instanceof CollectorFailure) {
      if (admin && (error.code === 'collector_unauthorized' || error.code === 'forbidden')) {
        deleteAdminKeychainToken(env, apiUrl);
      } else if (keychain.created && error.code === 'collector_unauthorized') {
        deleteKeychainToken(env, apiUrl);
      }
    }
    throw error;
  }
}

async function accountResult<T>(run: () => Promise<T>): Promise<AdminResult<T>> {
  if (!isSupportedCollectorPlatform(process.platform)) return { ok: false, code: 'unsupported_platform' };
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return error instanceof CollectorFailure ? { ok: false, code: error.code } : { ok: false, code: 'collector_internal_error' };
  }
}

function requestMemberCreate(apiUrl: string, token: string, displayName: string): Promise<MemberCreateOutput> {
  return requestJson(
    apiUrl,
    token,
    '/v1/employees',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: displayName }) },
    201,
    memberCreateResponseSchema,
    'employee_not_found',
    'internal_error',
  );
}

function requestTokenIssue(apiUrl: string, token: string, employeeId: string, scope: TokenScope): Promise<TokenIssueOutput> {
  return requestJson(
    apiUrl,
    token,
    `/v1/employees/${employeeId}/tokens`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope }) },
    201,
    issueResponseSchema,
    'employee_not_found',
    'internal_error',
  );
}

export async function loadMeViaApi(env: NodeJS.ProcessEnv): Promise<AdminResult<MeOutput>> {
  return accountResult(() =>
    withAccountToken(env, false, (apiUrl, token) =>
      requestJson(apiUrl, token, '/v1/me', { method: 'GET' }, 200, meResponseSchema, 'employee_not_found', 'internal_error'),
    ),
  );
}

export async function loadCompanyViaApi(env: NodeJS.ProcessEnv): Promise<AdminResult<CompanyOutput>> {
  return accountResult(() =>
    withAccountToken(env, true, (apiUrl, token) =>
      requestJson(apiUrl, token, '/v1/company', { method: 'GET' }, 200, companyResponseSchema, 'company_not_found', 'internal_error'),
    ),
  );
}

export async function createMemberViaApi(
  env: NodeJS.ProcessEnv,
  displayName: string,
): Promise<AdminResult<MemberCreateOutput>> {
  return accountResult(() => withAccountToken(env, true, (apiUrl, token) => requestMemberCreate(apiUrl, token, displayName)));
}

export async function createMemberWithTokenViaApi(
  env: NodeJS.ProcessEnv,
  displayName: string,
): Promise<AdminResult<MemberCreateWithTokenOutput>> {
  return accountResult(() =>
    withAccountToken(env, true, async (apiUrl, token) => {
      const employee = await requestMemberCreate(apiUrl, token, displayName);
      const issued = await requestTokenIssue(apiUrl, token, employee.employee_id, 'employee');
      if (issued.employee_id !== employee.employee_id || issued.scope !== 'employee') {
        throw new CollectorFailure('collector_server_incompatible');
      }
      return {
        status: 'done',
        employee_id: employee.employee_id,
        display_name: employee.display_name,
        token_id: issued.token_id,
        scope: 'employee',
        token: issued.token,
      };
    }),
  );
}

export async function renameEmployeeViaApi(
  env: NodeJS.ProcessEnv,
  employeeId: string,
  displayName: string,
): Promise<AdminResult<EmployeeRenameOutput>> {
  return accountResult(() =>
    withAccountToken(env, true, (apiUrl, token) =>
      requestJson(
        apiUrl,
        token,
        `/v1/employees/${employeeId}`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: displayName }) },
        200,
        employeeRenameResponseSchema,
        'employee_not_found',
        'internal_error',
      ),
    ),
  );
}

export async function issueTokenViaApi(
  env: NodeJS.ProcessEnv,
  employeeId: string,
  scope: TokenScope,
): Promise<AdminResult<TokenIssueOutput>> {
  return accountResult(() => withAccountToken(env, true, (apiUrl, token) => requestTokenIssue(apiUrl, token, employeeId, scope)));
}

export async function revokeTokenViaApi(env: NodeJS.ProcessEnv, tokenId: string): Promise<AdminResult<TokenRevokeOutput>> {
  return accountResult(() =>
    withAccountToken(env, true, (apiUrl, token) =>
      requestJson(
        apiUrl,
        token,
        `/v1/tokens/${tokenId}`,
        { method: 'DELETE' },
        200,
        revokeResponseSchema,
        'token_not_found',
        'last_company_admin',
      ),
    ),
  );
}

// cwdのrepositoryを案件へ解決し、confirmがtrueを返したときだけcompany admin tokenで物理削除する。
export async function removeCurrentProject(
  env: NodeJS.ProcessEnv,
  cwd: string,
  confirm: (target: ProjectRemovalTarget) => Promise<boolean>,
): Promise<AdminResult<ProjectRemovalOutput>> {
  return accountResult(() => {
    const repository = resolveRepositoryFromCwd(env, cwd);
    return withAccountToken(env, true, async (apiUrl, token) => {
      const target = await requestCollectorSetup(apiUrl, token, repository);
      if (!(await confirm({ project_id: target.project_id, repository: target.repository }))) {
        throw new CollectorFailure('project_remove_cancelled');
      }
      const path = `/v1/projects/${target.project_id}`;
      return requestJson(apiUrl, token, path, { method: 'DELETE' }, 200, projectRemovalResponseSchema, 'project_not_found', 'internal_error');
    });
  });
}
