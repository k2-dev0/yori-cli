import {
  ASSIGNMENT_KEY_IDENTIFIER_PATTERN,
  MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS,
  MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS,
  MAX_CUSTOM_REDACTION_RULES,
  type CustomRedactionRule,
} from './contract.js';

// yori migration 0010のyori_is_redaction_placeholder_fragment()と同じ集合。
export const CUSTOM_REDACTION_PLACEHOLDER_FRAGMENTS = [
  '[REDACTED:custom]',
  '[REDACTED:private_key]',
  '[REDACTED:aws_access_key]',
  '[REDACTED:google_api_key]',
  '[REDACTED:github_token]',
  '[REDACTED:slack_token]',
  '[REDACTED:openai_key]',
  '[REDACTED:jwt]',
  '[REDACTED:url_credentials]',
  '[REDACTED:authorization]',
  '[REDACTED:env_value]',
] as const;

// literalが既知placeholderの部分文字列なら、置換済み本文の再適用でplaceholderを壊すため拒否する。
export function isRedactionPlaceholderFragment(rule: string): boolean {
  return CUSTOM_REDACTION_PLACEHOLDER_FRAGMENTS.some((placeholder) => placeholder.includes(rule));
}

// DBへ渡すruleと正規化値。literalはcase-sensitive、assignment_keyはlower(value)で一意性を判定する。
export interface ValidatedRedactionRule {
  rule: CustomRedactionRule;
  normalized_value: string;
}

// yori src/api/redaction.ts:validateCustomRedactionRules と同じ境界検証。
// 旧string rule・discriminated union以外・unknown field・空・placeholder部分文字列・上限超過・
// 不正identifier・REDACTED・type別重複（assignment_keyはcase-insensitive）を拒否する。
export function validateCustomRedactionRules(rules: unknown): ValidatedRedactionRule[] {
  if (!Array.isArray(rules) || rules.length > MAX_CUSTOM_REDACTION_RULES) {
    throw new Error('custom伏せ字ruleの件数が不正です');
  }
  const seenLiterals = new Set<string>();
  const seenAssignmentKeys = new Set<string>();
  const validated: ValidatedRedactionRule[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new Error('custom伏せ字ruleが不正です');
    }
    const fields = Object.keys(rule);
    if (fields.length !== 2 || !fields.includes('type') || !fields.includes('value')) {
      throw new Error('custom伏せ字ruleが不正です');
    }
    const { type, value } = rule as { type?: unknown; value?: unknown };
    if (typeof value !== 'string') {
      throw new Error('custom伏せ字ruleが不正です');
    }
    if (type === 'literal') {
      if (
        value.length === 0 ||
        isRedactionPlaceholderFragment(value) ||
        [...value].length > MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS ||
        seenLiterals.has(value)
      ) {
        throw new Error('custom伏せ字ruleが不正です');
      }
      seenLiterals.add(value);
      validated.push({ rule: { type: 'literal', value }, normalized_value: value });
      continue;
    }
    if (type === 'assignment_key') {
      const normalized = value.toLowerCase();
      if (
        !ASSIGNMENT_KEY_IDENTIFIER_PATTERN.test(value) ||
        [...value].length > MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS ||
        normalized === 'redacted' ||
        seenAssignmentKeys.has(normalized)
      ) {
        throw new Error('custom伏せ字ruleが不正です');
      }
      seenAssignmentKeys.add(normalized);
      validated.push({ rule: { type: 'assignment_key', value }, normalized_value: normalized });
      continue;
    }
    throw new Error('custom伏せ字ruleが不正です');
  }
  return validated;
}
