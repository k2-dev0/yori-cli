import {
  MAX_BUSINESS_FIELD_CODE_POINTS,
  MAX_BUSINESS_REDACTION_RULES,
  MAX_BUSINESS_TERM_CODE_POINTS,
  REDACTION_DETECTOR_VERSION,
  SUSPICION_MODES,
  type RedactionPolicy,
} from './contract.js';

// yori migration 0010のyori_is_redaction_placeholder_fragment()と同じ集合。
// termがplaceholderの構文・種類名そのものなら、置換済み本文の再適用でplaceholderを壊すため拒否する。
const PLACEHOLDER_KINDS = new Set([
  'private_key',
  'aws_access_key',
  'google_api_key',
  'github_token',
  'slack_token',
  'openai_key',
  'jwt',
  'url_credentials',
  'authorization',
  'env_value',
  'business_value',
  'business_term',
  'known_secret',
]);

function isRedactionPlaceholderFragment(value: string): boolean {
  return value === 'REDACTED' || value.includes('[') || value.includes(']') || value.includes(':') || PLACEHOLDER_KINDS.has(value);
}

// yori src/api/redaction.ts:validateRedactionPolicy と同じfield identifier。
const FIELD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function codePointLength(value: string): number {
  return [...value].length;
}

// DBのtextへ格納できないNULと単独サロゲートを境界で拒否する (src/admin/contract.tsと同じ規則)。
function isStorableTerm(value: string): boolean {
  return value.length > 0 && !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value);
}

// 会社のbusiness伏せ字policyを境界検証する。fields/terms合算上限・identifier・placeholder断片・
// 長さ・exact重複 (fieldはcase-insensitive)・suspicion_mode・detector_versionを満たさないpolicyは適用しない。
export function validateRedactionPolicy(policy: unknown): RedactionPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new Error('redaction policyが不正です');
  }
  const record = policy as Record<string, unknown>;
  const keys = Object.keys(record);
  const required = ['version', 'fields', 'terms', 'suspicion_mode', 'detector_version'];
  if (keys.length !== required.length || !required.every((key) => keys.includes(key))) {
    throw new Error('redaction policyが不正です');
  }
  const { version, fields, terms, suspicion_mode, detector_version } = record;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error('redaction policyのversionが不正です');
  }
  if (!Array.isArray(fields) || !Array.isArray(terms)) {
    throw new Error('redaction policyのfields/termsが不正です');
  }
  if (fields.length + terms.length > MAX_BUSINESS_REDACTION_RULES) {
    throw new Error('redaction ruleの件数が上限を超えています');
  }

  const seenFields = new Set<string>();
  const validatedFields: string[] = [];
  for (const field of fields) {
    if (typeof field !== 'string') {
      throw new Error('redaction fieldが不正です');
    }
    const normalized = field.toLowerCase();
    if (
      !FIELD_IDENTIFIER.test(field) ||
      codePointLength(field) > MAX_BUSINESS_FIELD_CODE_POINTS ||
      normalized === 'redacted' ||
      seenFields.has(normalized)
    ) {
      throw new Error('redaction fieldが不正です');
    }
    seenFields.add(normalized);
    validatedFields.push(field);
  }

  const seenTerms = new Set<string>();
  const validatedTerms: string[] = [];
  for (const term of terms) {
    if (
      typeof term !== 'string' ||
      !isStorableTerm(term) ||
      isRedactionPlaceholderFragment(term) ||
      codePointLength(term) > MAX_BUSINESS_TERM_CODE_POINTS ||
      seenTerms.has(term)
    ) {
      throw new Error('redaction termが不正です');
    }
    seenTerms.add(term);
    validatedTerms.push(term);
  }

  if (typeof suspicion_mode !== 'string' || !(SUSPICION_MODES as readonly string[]).includes(suspicion_mode)) {
    throw new Error('suspicion_modeが不正です');
  }
  if (detector_version !== REDACTION_DETECTOR_VERSION) {
    throw new Error('detector_versionが不正です');
  }
  return {
    version,
    fields: validatedFields,
    terms: validatedTerms,
    suspicion_mode: suspicion_mode as RedactionPolicy['suspicion_mode'],
    detector_version: REDACTION_DETECTOR_VERSION,
  };
}
