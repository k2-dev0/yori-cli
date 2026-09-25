import type { Pool } from 'pg';
import type {
  AdminResult,
  BootstrapInput,
  BootstrapOutput,
  CompanyCreateInput,
  CompanyCreateOutput,
  EmployeeCreateInput,
  EmployeeCreateOutput,
  InspectOutput,
  MemberAddOutput,
  MemberInput,
  MemberRemoveOutput,
  ProjectCreateInput,
  ProjectCreateOutput,
  TokenIssueInput,
  TokenIssueOutput,
  TokenRevokeInput,
  TokenRevokeOutput,
} from './contract.js';

export interface TokenIssueOptions {
  generateToken?: () => string;
}

// 未実装の骨子。transaction・会社scope検証・登録・所属変更・token発行失効・inspectを実装する。
export function isTokenHashConflict(_error: unknown): boolean {
  return false;
}

export async function runBootstrap(_pool: Pool, _input: BootstrapInput, _options: TokenIssueOptions = {}): Promise<AdminResult<BootstrapOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function createCompany(_pool: Pool, _input: CompanyCreateInput): Promise<AdminResult<CompanyCreateOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function createEmployee(_pool: Pool, _input: EmployeeCreateInput): Promise<AdminResult<EmployeeCreateOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function createProject(_pool: Pool, _input: ProjectCreateInput): Promise<AdminResult<ProjectCreateOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function addMember(_pool: Pool, _input: MemberInput): Promise<AdminResult<MemberAddOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function removeMember(_pool: Pool, _input: MemberInput): Promise<AdminResult<MemberRemoveOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function issueToken(
  _pool: Pool,
  _input: TokenIssueInput,
  _options: TokenIssueOptions = {},
): Promise<AdminResult<TokenIssueOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function revokeToken(_pool: Pool, _input: TokenRevokeInput): Promise<AdminResult<TokenRevokeOutput>> {
  return { ok: false, code: 'internal_error' };
}

export async function inspectCompany(_pool: Pool, _companyId: string): Promise<AdminResult<InspectOutput>> {
  return { ok: false, code: 'internal_error' };
}
