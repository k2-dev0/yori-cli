import { MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS, MAX_CUSTOM_REDACTION_RULES } from './contract.js';

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

// yori src/api/redaction.ts:validateCustomRedactionRules と同じ境界検証。
// 件数・code points・重複・空文字・placeholder部分文字列をDB/API到達前に拒否する。
export function isValidCustomRedactionRules(rules: readonly string[]): boolean {
  if (rules.length > MAX_CUSTOM_REDACTION_RULES) {
    return false;
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.length === 0 || [...rule].length > MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS || seen.has(rule) || isRedactionPlaceholderFragment(rule)) {
      return false;
    }
    seen.add(rule);
  }
  return true;
}
