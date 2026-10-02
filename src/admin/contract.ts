import { z } from 'zod';
import { normalizeRepositoryIdentifier } from './repository.js';

// 管理CLIの固定エラーコード。stderrへはこのcodeだけを出し、DB error本文や入力を転記しない。
export const ADMIN_ERROR_CODES = [
  'invalid_arguments',
  'invalid_admin_config',
  'invalid_input_file',
  'invalid_input',
  'last_company_admin',
  'bootstrap_already_completed',
  'company_not_found',
  'employee_not_found',
  'forbidden',
  'project_not_found',
  'project_remove_cancelled',
  'token_not_found',
  'company_scope_mismatch',
  'repository_conflict',
  'repository_not_found',
  'member_already_exists',
  'member_not_found',
  'token_already_revoked',
  'redaction_policy_conflict',
  'redaction_policy_not_found',
  'agent_not_found',
  'collector_already_installed',
  'collector_artifact_invalid',
  'collector_backfill_error',
  'collector_config_invalid',
  'collector_hook_conflict',
  'collector_hook_error',
  'collector_hook_invalid',
  'collector_install_error',
  'collector_internal_error',
  'collector_invalid_request',
  'collector_keychain_error',
  'collector_not_installed',
  'collector_repository_not_found',
  'collector_rollback_failed',
  'collector_server_incompatible',
  'collector_unauthorized',
  'unsupported_platform',
  'internal_error',
] as const;

export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];


// 上限はyori本体の契約に合わせる。repositoryはAPI・collectorと同じUTF-8 1024バイト (src/api/contract.ts:6)。
export const MAX_SOURCE_IDENTIFIER_BYTES = 1024;
export const MAX_NAME_BYTES = 1024;
export const MAX_REF_BYTES = 128;
// token hash衝突時だけ新しいtokenで再生成する上限。他のDB障害を再生成で隠さないため有限にする。
export const TOKEN_HASH_RETRY_LIMIT = 5;
// bootstrapの空DB判定と登録を直列化するtransaction advisory lockのキー。既存namespace (20260922) と重複しない。
export const BOOTSTRAP_LOCK_KEY = 20_260_925;

// Unicodeモードでは有効なペアを1コードポイントとして扱い、単独サロゲートだけを拒否する (src/api/schema.ts:5-8 と同じ規則)。
const storableString = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value), {
    message: 'NULおよび単独サロゲートは指定できません',
  });

function boundedString(maxBytes: number, label: string) {
  return storableString.refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, {
    message: `${label}はUTF-8で${maxBytes}バイト以内にしてください`,
  });
}

const companyName = boundedString(MAX_NAME_BYTES, 'name');
const displayName = boundedString(MAX_NAME_BYTES, 'display_name');
const ref = boundedString(MAX_REF_BYTES, 'ref');

// repositoryはcollectorと同じ規則でcanonical化し、変換できない値を登録対象にしない。
const repository = storableString
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_IDENTIFIER_BYTES, {
    message: `repositoryはUTF-8で${MAX_SOURCE_IDENTIFIER_BYTES}バイト以内にしてください`,
  })
  .refine((value) => normalizeRepositoryIdentifier(value) !== null, { message: 'repositoryはcanonical host/pathで指定してください' })
  .transform((value) => normalizeRepositoryIdentifier(value) as string);

// UUIDは小文字の正規形へ揃え、DB正本との比較を表記ゆれに依存させない。
const uuid = z.uuid().transform((value) => value.toLowerCase());

const bootstrapEmployeeSchema = z.strictObject({
  ref,
  display_name: displayName,
  issue_token: z.boolean().default(false),
});

const bootstrapProjectSchema = z.strictObject({
  ref,
  repository,
  member_refs: z.array(ref).default([]),
});

// bootstrap入力。refは同一file内だけの一時識別子で、DBへ保存しない。
export const bootstrapInputSchema = z
  .strictObject({
    company: z.strictObject({ name: companyName }),
    employees: z.array(bootstrapEmployeeSchema).min(1),
    projects: z.array(bootstrapProjectSchema).min(1),
  })
  .superRefine((input, context) => {
    const employeeRefs = new Set<string>();
    input.employees.forEach((employee, index) => {
      if (employeeRefs.has(employee.ref)) {
        context.addIssue({ code: 'custom', path: ['employees', index, 'ref'], message: 'refが重複しています' });
      }
      employeeRefs.add(employee.ref);
    });

    const projectRefs = new Set<string>();
    input.projects.forEach((project, index) => {
      if (projectRefs.has(project.ref)) {
        context.addIssue({ code: 'custom', path: ['projects', index, 'ref'], message: 'refが重複しています' });
      }
      projectRefs.add(project.ref);

      const memberRefs = new Set<string>();
      project.member_refs.forEach((memberRef, memberIndex) => {
        if (memberRefs.has(memberRef)) {
          context.addIssue({ code: 'custom', path: ['projects', index, 'member_refs', memberIndex], message: '所属が重複しています' });
        }
        if (!employeeRefs.has(memberRef)) {
          context.addIssue({ code: 'custom', path: ['projects', index, 'member_refs', memberIndex], message: '未知のrefです' });
        }
        memberRefs.add(memberRef);
      });
    });
  });

// business伏せ字policyの上限・版はyori migration 0010・yori src/api/contract.tsと同じ。
// admin CLIもcollector setupもfield/term/suspicion_modeだけを公開し、literal等の旧shapeは受けない。
export const MAX_BUSINESS_REDACTION_RULES = 100;
export const MAX_BUSINESS_FIELD_CODE_POINTS = 128;
export const MAX_BUSINESS_TERM_CODE_POINTS = 512;
export const REDACTION_DETECTOR_VERSION = 'initial-v1';
export const SUSPICION_MODES = ['observe', 'block'] as const;
export const TOKEN_SCOPES = ['employee', 'company_admin'] as const;
export type SuspicionMode = (typeof SUSPICION_MODES)[number];
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type DetectorVersion = typeof REDACTION_DETECTOR_VERSION;

export const redactionReplaceInputSchema = z.strictObject({
  company_id: uuid,
  expected_version: z.number().int().min(0),
  fields: z.array(z.string()),
  terms: z.array(z.string()),
  suspicion_mode: z.enum(SUSPICION_MODES),
});

export const repositoryInputSchema = z.strictObject({
  company_id: uuid,
  project_id: uuid,
  repository,
});

export const companyCreateInputSchema = z.strictObject({ name: companyName });
export const employeeCreateInputSchema = z.strictObject({ company_id: uuid, display_name: displayName });
export const projectCreateInputSchema = z.strictObject({ company_id: uuid, repository });
export const projectRemoveInputSchema = z.strictObject({ company_id: uuid, project_id: uuid });
export const memberInputSchema = z.strictObject({ company_id: uuid, project_id: uuid, employee_id: uuid });
export const tokenIssueInputSchema = z.strictObject({ company_id: uuid, employee_id: uuid, scope: z.enum(TOKEN_SCOPES).default('employee') });
export const tokenRevokeInputSchema = z.strictObject({ company_id: uuid, token_id: uuid });

export type BootstrapInput = z.infer<typeof bootstrapInputSchema>;
export type RedactionReplaceInput = z.infer<typeof redactionReplaceInputSchema>;
export type RepositoryInput = z.infer<typeof repositoryInputSchema>;
export type CompanyCreateInput = z.infer<typeof companyCreateInputSchema>;
export type EmployeeCreateInput = z.infer<typeof employeeCreateInputSchema>;
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;
export type ProjectRemoveInput = z.infer<typeof projectRemoveInputSchema>;
export type MemberInput =z.infer<typeof memberInputSchema>;
export type TokenIssueInput = z.infer<typeof tokenIssueInputSchema>;
export type TokenRevokeInput = z.infer<typeof tokenRevokeInputSchema>;

export interface CompanySummary {
  company_id: string;
  name: string;
  created_at: string;
}

export interface EmployeeSummary {
  employee_id: string;
  display_name: string;
  created_at: string;
}

export interface ProjectSummary {
  project_id: string;
  repository_identifier: string;
  created_at: string;
}

export interface MemberSummary {
  project_id: string;
  employee_id: string;
  created_at: string;
}

// inspectはtokenのmetadataだけを返す。生tokenとtoken hashは返さない。
export interface TokenMetadata {
  token_id: string;
  employee_id: string;
  created_at: string;
  revoked_at: string | null;
}

export interface InspectOutput {
  status: 'ok';
  company: CompanySummary;
  employees: EmployeeSummary[];
  projects: ProjectSummary[];
  members: MemberSummary[];
  tokens: TokenMetadata[];
}

// 生tokenを返すのはbootstrapとtoken:issueの成功出力だけ。
export interface BootstrapOutput {
  status: 'created';
  company: { company_id: string; name: string };
  employees: { ref: string; employee_id: string; display_name: string }[];
  projects: { ref: string; project_id: string; repository_identifier: string }[];
  members: { project_id: string; employee_id: string }[];
  tokens: { ref: string; token_id: string; employee_id: string; token: string }[];
}

export interface CompanyCreateOutput {
  status: 'created';
  company_id: string;
  name: string;
}

export interface EmployeeCreateOutput {
  status: 'created';
  employee_id: string;
  company_id: string;
  display_name: string;
}

export interface ProjectCreateOutput {
  status: 'created';
  project_id: string;
  company_id: string;
  repository_identifier: string;
}

export interface ProjectRemoveOutput {
  status: 'removed';
  project_id: string;
}

export interface MemberAddOutput {
  status: 'created';
  project_id: string;
  employee_id: string;
}

export interface MemberRemoveOutput {
  status: 'removed';
  project_id: string;
  employee_id: string;
}

export interface TokenIssueOutput {
  status: 'created';
  token_id: string;
  employee_id: string;
  scope: TokenScope;
  token: string;
}

export interface TokenRevokeOutput {
  status: 'revoked';
  token_id: string;
}

export interface RedactionReplaceOutput {
  status: 'replaced';
  company_id: string;
  version: number;
}

// policyはversion・fields・terms・suspicion_mode・detector_versionだけを公開する。
export interface RedactionPolicy {
  version: number;
  fields: string[];
  terms: string[];
  suspicion_mode: SuspicionMode;
  detector_version: DetectorVersion;
}

export type RedactionListOutput = RedactionPolicy;

export interface RepositoryAddOutput {
  status: 'created';
  project_id: string;
  repository_identifier: string;
}

export interface RepositoryRemoveOutput {
  status: 'removed';
  project_id: string;
  repository_identifier: string;
}

export type AdminResult<T> = { ok: true; value: T } | { ok: false; code: AdminErrorCode };
