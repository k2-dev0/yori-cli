import { z } from 'zod';
import type { AdminResult } from '../admin/contract.js';
import { loadCollectorApiUrl } from './api.js';
import { CollectorFailure, isSupportedCollectorPlatform } from './contract.js';
import { resolveRepositoryFromCwd } from './git.js';
import { deleteKeychainToken, ensureKeychainToken } from './keychain.js';
import { collectorConfigPath, collectorHome } from './layout.js';

const projectOutputSchema = z.strictObject({
  status: z.enum(['done', 'already']),
  project_id: z.uuid(),
  repository: z.string().min(1),
});
const memberOutputSchema = z.strictObject({
  status: z.enum(['done', 'already']),
  project_id: z.uuid(),
  employee_id: z.uuid(),
});
const projectErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'repository_conflict', 'internal_error']),
  }),
});

export type ProjectRegistrationOutput = z.infer<typeof projectOutputSchema>;
export type ProjectMemberOutput = z.infer<typeof memberOutputSchema>;

function mapApiFailure(status: number, body: unknown): never {
  const parsed = projectErrorSchema.safeParse(body);
  if (!parsed.success) {
    throw new CollectorFailure('collector_server_incompatible');
  }
  const code = parsed.data.error.code;
  if (status === 400 && code === 'invalid_request') {
    throw new CollectorFailure('collector_invalid_request');
  }
  if (status === 401 && code === 'unauthorized') {
    throw new CollectorFailure('collector_unauthorized');
  }
  if (status === 403 && code === 'forbidden') {
    throw new CollectorFailure('forbidden');
  }
  if (status === 404 && code === 'not_found') {
    throw new CollectorFailure('project_not_found');
  }
  if (status === 409 && code === 'repository_conflict') {
    throw new CollectorFailure('repository_conflict');
  }
  if (status === 500 && code === 'internal_error') {
    throw new CollectorFailure('internal_error');
  }
  throw new CollectorFailure('collector_server_incompatible');
}

async function requestProjectRegistration(apiUrl: string, token: string, repository: string): Promise<ProjectRegistrationOutput> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repository }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CollectorFailure('collector_internal_error');
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 200 || response.status === 201) {
    const parsed = projectOutputSchema.safeParse(body);
    if (!parsed.success || parsed.data.repository !== repository) {
      throw new CollectorFailure('collector_internal_error');
    }
    return parsed.data;
  }
  return mapApiFailure(response.status, body);
}

async function requestProjectMember(
  apiUrl: string,
  token: string,
  projectId: string,
  employeeId: string,
): Promise<ProjectMemberOutput> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/projects/${projectId}/members/${employeeId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CollectorFailure('collector_internal_error');
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 200) {
    const parsed = memberOutputSchema.safeParse(body);
    if (!parsed.success || parsed.data.project_id !== projectId || parsed.data.employee_id !== employeeId) {
      throw new CollectorFailure('collector_internal_error');
    }
    return parsed.data;
  }
  return mapApiFailure(response.status, body);
}

async function withProjectToken<T>(
  env: NodeJS.ProcessEnv,
  run: (apiUrl: string, token: string) => Promise<T>,
): Promise<T> {
  const home = collectorHome(env);
  const apiUrl = await loadCollectorApiUrl(collectorConfigPath(home));
  const keychain = ensureKeychainToken(env, apiUrl);
  try {
    return await run(apiUrl, keychain.token);
  } catch (error) {
    if (keychain.created && error instanceof CollectorFailure && error.code === 'collector_unauthorized') {
      deleteKeychainToken(env, apiUrl);
    }
    throw error;
  }
}

export async function registerCurrentProject(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<AdminResult<ProjectRegistrationOutput>> {
  if (!isSupportedCollectorPlatform(process.platform)) {
    return { ok: false, code: 'unsupported_platform' };
  }
  try {
    const repository = resolveRepositoryFromCwd(env, cwd);
    return { ok: true, value: await withProjectToken(env, (apiUrl, token) => requestProjectRegistration(apiUrl, token, repository)) };
  } catch (error) {
    return error instanceof CollectorFailure
      ? { ok: false, code: error.code }
      : { ok: false, code: 'collector_internal_error' };
  }
}

export async function addProjectMemberViaApi(
  env: NodeJS.ProcessEnv,
  projectId: string,
  employeeId: string,
): Promise<AdminResult<ProjectMemberOutput>> {
  if (!isSupportedCollectorPlatform(process.platform)) {
    return { ok: false, code: 'unsupported_platform' };
  }
  try {
    return {
      ok: true,
      value: await withProjectToken(env, (apiUrl, token) => requestProjectMember(apiUrl, token, projectId, employeeId)),
    };
  } catch (error) {
    return error instanceof CollectorFailure
      ? { ok: false, code: error.code }
      : { ok: false, code: 'collector_internal_error' };
  }
}
