import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { validateRedactionPolicy } from '../admin/redaction-rules.js';
import { COLLECTOR_API_DEFAULT_URL, CollectorFailure } from './contract.js';

// yori POST /v1/collector/setup の200応答。strict objectで未知field・不正UUID・policy契約違反を拒否する。
// policyはadmin CLIと同じboundary validatorで検証し、不正なfields/terms/suspicion_modeを受け入れない。
const collectorSetupResponseSchema = z.strictObject({
  project_id: z.uuid(),
  repository: z.string().min(1),
  redaction_policy: z.strictObject({
    version: z.number().int().min(0),
    fields: z.array(z.string()),
    terms: z.array(z.string()),
    suspicion_mode: z.enum(['observe', 'block']),
    detector_version: z.literal('initial-v1'),
  }),
});
const collectorErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(['invalid_request', 'unauthorized', 'not_found', 'internal_error']),
  }),
});
const COMPATIBILITY_REPOSITORY = 'github.com/yori/collector-compatibility-probe';

export interface CollectorSetupResult {
  project_id: string;
  repository: string;
  policy_version: number;
}

// https、またはloopback httpだけを許可する。userinfo・query・fragmentは資格情報や曖昧さを持ち込むため拒否する。
function validateCollectorApiUrl(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new CollectorFailure('collector_config_invalid');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new CollectorFailure('collector_config_invalid');
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && loopback) {
    return;
  }
  throw new CollectorFailure('collector_config_invalid');
}

// 既存configのapi_urlを再利用し、未作成時だけproduction既定を使う。壊れたconfigは上書きしない。
export async function loadCollectorApiUrl(configPath: string): Promise<string> {
  const text = await readFile(configPath, 'utf8').catch(() => null);
  const apiUrl = text === null ? COLLECTOR_API_DEFAULT_URL : parseConfigApiUrl(text);
  validateCollectorApiUrl(apiUrl);
  return apiUrl;
}

function parseConfigApiUrl(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CollectorFailure('collector_config_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CollectorFailure('collector_config_invalid');
  }
  const apiUrl = (parsed as { api_url?: unknown }).api_url;
  if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
    throw new CollectorFailure('collector_config_invalid');
  }
  return apiUrl;
}

// Bearerでcanonical repositoryだけを送る。応答body・raw error・token・rulesは失敗出力へ出さない。
export async function requestCollectorSetup(apiUrl: string, token: string, repository: string): Promise<CollectorSetupResult> {
  let compatibility: Response;
  try {
    compatibility = await fetch(`${apiUrl}/v1/collector/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: COMPATIBILITY_REPOSITORY }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CollectorFailure('collector_internal_error');
  }
  const compatibilityBody: unknown = await compatibility.json().catch(() => null);
  const compatibilityError = collectorErrorResponseSchema.safeParse(compatibilityBody);
  if (compatibility.status !== 401 || !compatibilityError.success || compatibilityError.data.error.code !== 'unauthorized') {
    throw new CollectorFailure('collector_server_incompatible');
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/collector/setup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repository }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CollectorFailure('collector_internal_error');
  }
  if (response.status === 200) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = collectorSetupResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.repository !== repository) {
      throw new CollectorFailure('collector_internal_error');
    }
    try {
      validateRedactionPolicy(parsed.data.redaction_policy);
    } catch {
      throw new CollectorFailure('collector_internal_error');
    }
    return {
      project_id: parsed.data.project_id,
      repository: parsed.data.repository,
      policy_version: parsed.data.redaction_policy.version,
    };
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = collectorErrorResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new CollectorFailure('collector_server_incompatible');
  }
  const code = parsed.data.error.code;
  if (response.status === 400 && code === 'invalid_request') {
    throw new CollectorFailure('collector_invalid_request');
  }
  if (response.status === 401 && code === 'unauthorized') {
    throw new CollectorFailure('collector_unauthorized');
  }
  if (response.status === 404 && code === 'not_found') {
    throw new CollectorFailure('project_not_found');
  }
  if (response.status === 500 && code === 'internal_error') {
    throw new CollectorFailure('collector_internal_error');
  }
  throw new CollectorFailure('collector_server_incompatible');
}
