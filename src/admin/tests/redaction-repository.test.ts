import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../../db/pool.js';
import {
  applyTestSchema,
  countRows,
  parseSuccessJson,
  resetDatabase,
  runAdmin,
  testDatabaseUrl,
  withInputFile,
  type AdminRun,
} from './support.js';

// yori migration 0010 (rule_type/value/normalized_value) のcustom伏せ字policyとrepository aliasを
// 管理CLIから操作する契約。失敗時はversion・rules・aliasを一切変更しない（transaction）。
const pool = createPool(testDatabaseUrl());

before(async () => {
  await applyTestSchema(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
});

after(async () => {
  await pool.end();
});

type TypedRule = { type: 'literal' | 'assignment_key'; value: string };

function literal(value: string): TypedRule {
  return { type: 'literal', value };
}

function assignmentKey(value: string): TypedRule {
  return { type: 'assignment_key', value };
}

function normalizedValue(rule: TypedRule): string {
  return rule.type === 'literal' ? rule.value : rule.value.toLowerCase();
}

// listはrule_type→normalized_valueの決定的な順で返す。
function expectedOrder(rules: readonly TypedRule[]): TypedRule[] {
  return [...rules].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type < right.type ? -1 : 1;
    }
    const leftValue = normalizedValue(left);
    const rightValue = normalizedValue(right);
    if (leftValue === rightValue) {
      return 0;
    }
    return leftValue < rightValue ? -1 : 1;
  });
}

function str(value: unknown): string {
  assert.equal(typeof value, 'string', `文字列ではない: ${JSON.stringify(value)}`);
  return value as string;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), `配列ではない: ${JSON.stringify(value)}`);
  return value;
}

// 既知失敗は `admin: <code>` だけで、入力値やDB error本文を出さない。
function expectFixedFailure(run: AdminRun, notCodes: string[] = []): string {
  assert.equal(run.code, 1, `終了コードが1ではない: code=${run.code} stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(run.stdout, '', `失敗時にstdoutへ出力している: ${run.stdout}`);
  assert.match(run.stderr, /^admin: [a-z_]+\n$/, `固定codeではない: ${JSON.stringify(run.stderr)}`);
  for (const code of notCodes) {
    assert.notEqual(run.stderr, `admin: ${code}\n`, `禁止した失敗codeが返っている: ${code}`);
  }
  return run.stderr.trim();
}

async function createCompany(name = 'redaction'): Promise<string> {
  const run = await withInputFile('company.json', { name }, (filePath) => runAdmin(['company:create', filePath]));
  return str(parseSuccessJson(run).company_id);
}

async function createProject(companyId: string, repository: string): Promise<string> {
  const run = await withInputFile('project.json', { company_id: companyId, repository }, (filePath) =>
    runAdmin(['project:create', filePath]),
  );
  return str(parseSuccessJson(run).project_id);
}

async function replacePolicy(companyId: string, expectedVersion: number, rules: unknown): Promise<AdminRun> {
  return withInputFile('redaction.json', { company_id: companyId, expected_version: expectedVersion, rules }, (filePath) =>
    runAdmin(['redaction:replace', filePath]),
  );
}

async function listPolicy(companyId: string): Promise<Record<string, unknown>> {
  return parseSuccessJson(await runAdmin(['redaction:list', companyId]));
}

interface StoredRuleRow {
  rule_type: string;
  value: string;
  normalized_value: string;
}

async function storedRules(companyId: string): Promise<{ version: number; rules: TypedRule[]; rows: StoredRuleRow[] }[]> {
  const result = await pool.query<{ version: number; rule_type: string | null; value: string | null; normalized_value: string | null }>(
    `SELECT p.version, r.rule_type, r.value, r.normalized_value
       FROM company_redaction_policies p
       LEFT JOIN company_redaction_rules r ON r.company_id = p.company_id
      WHERE p.company_id = $1
      -- 期待順（expectedOrderのcodepoint順）とDB locale collationの差でtestが揺れないようC collationで読む。
      ORDER BY r.rule_type, r.normalized_value COLLATE "C"`,
    [companyId],
  );
  if (result.rows.length === 0) {
    return [];
  }
  const rows = result.rows.flatMap((row): StoredRuleRow[] =>
    row.rule_type === null || row.value === null || row.normalized_value === null
      ? []
      : [{ rule_type: row.rule_type, value: row.value, normalized_value: row.normalized_value }],
  );
  const rules = rows.flatMap((row): TypedRule[] =>
    row.rule_type === 'literal' || row.rule_type === 'assignment_key' ? [{ type: row.rule_type, value: row.value }] : [],
  );
  return [{ version: result.rows[0].version, rules, rows }];
}

async function runRepositoryCommand(command: 'project:repository:add' | 'project:repository:remove', input: unknown): Promise<AdminRun> {
  return withInputFile('repository.json', input, (filePath) => runAdmin([command, filePath]));
}

describe('redaction:replace / redaction:list', () => {
  it('literalとassignment_keyのtyped ruleを登録し、listはrule_type→normalized_value順で返す', async () => {
    const companyId = await createCompany();
    // 並びはrule_type→normalized_valueで一意になり、collation差でも崩れないASCII小文字中心の値を使う。
    const input = [literal('beta-literal'), assignmentKey('Zed_key'), literal('alpha-literal'), assignmentKey('beta_key')];
    parseSuccessJson(await replacePolicy(companyId, 0, input));

    const listed = await listPolicy(companyId);
    assert.deepEqual(Object.keys(listed).sort(), ['rules', 'version']);
    assert.equal(listed.version, 1);
    const expected = expectedOrder(input);
    assert.deepEqual(list(listed.rules), expected, 'listがrule_type→normalized_value順のtyped ruleを返していない');
    assert.equal(await countRows(pool, 'company_redaction_rules'), 4);

    const stored = await storedRules(companyId);
    assert.equal(stored[0].version, 1);
    assert.deepEqual(stored[0].rules, expected, 'DBがtyped ruleを保持していない');
    const normalized = new Map(stored[0].rows.map((row) => [`${row.rule_type}:${row.value}`, row.normalized_value]));
    assert.equal(normalized.get('literal:beta-literal'), 'beta-literal');
    assert.equal(normalized.get('assignment_key:Zed_key'), 'zed_key');
    assert.equal(normalized.get('assignment_key:beta_key'), 'beta_key');
  });

  it('expected_version一致でdelete+insert+version incrementをtyped ruleで行う', async () => {
    const companyId = await createCompany();
    const first = [literal('alpha-literal'), assignmentKey('pass')];
    const second = [assignmentKey('SECRET_KEY'), literal('Gamma')];
    parseSuccessJson(await replacePolicy(companyId, 0, first));
    parseSuccessJson(await replacePolicy(companyId, 1, second));

    const listed = await listPolicy(companyId);
    assert.equal(listed.version, 2);
    assert.deepEqual(list(listed.rules), expectedOrder(second));
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2, '旧ruleが残っている');
    assert.deepEqual((await storedRules(companyId))[0].rules, expectedOrder(second));
  });

  it('literalはcase違いを別ruleとして受理し、assignment_keyはcase-insensitive重複を拒否する', async () => {
    const companyId = await createCompany();
    const caseLiterals = [literal('Case'), literal('case')];
    parseSuccessJson(await replacePolicy(companyId, 0, caseLiterals));
    // case違いは別ruleなので両方保持される。順序はcollation依存を避けて集合で比較する。
    const listedCaseRules = list((await listPolicy(companyId)).rules).map((rule) => JSON.stringify(rule)).sort();
    assert.deepEqual(listedCaseRules, caseLiterals.map((rule) => JSON.stringify(rule)).sort());
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2);

    const duplicateKeys = [assignmentKey('pass'), assignmentKey('PASS')];
    const run = await replacePolicy(companyId, 1, duplicateKeys);
    expectFixedFailure(run, ['invalid_arguments', 'internal_error']);
    assert.ok(!run.stderr.includes('pass'), 'assignment_keyの値をstderrへ出している');
    assert.deepEqual((await storedRules(companyId))[0].rules, expectedOrder(caseLiterals), '重複拒否でpolicyを変更している');
  });

  it('literal512cp・assignment_key128cpの境界を受理し、上限超過・不正identifier・REDACTED・placeholderを拒否する', async () => {
    const companyId = await createCompany();
    const boundaryLiteral = literal('x'.repeat(512));
    const boundaryKey = assignmentKey(`A${'a'.repeat(127)}`);
    const boundaryRules = [boundaryLiteral, boundaryKey];
    parseSuccessJson(await replacePolicy(companyId, 0, boundaryRules));
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2);

    const cases: { label: string; rules: unknown }[] = [
      { label: 'literal 513cp', rules: [literal('x'.repeat(513))] },
      { label: 'assignment_key 129cp', rules: [assignmentKey(`a${'a'.repeat(128)}`)] },
      { label: 'assignment_key 先頭数字', rules: [assignmentKey('1pass')] },
      { label: 'assignment_key 空白', rules: [assignmentKey('pass key')] },
      { label: 'assignment_key colon', rules: [assignmentKey('pass:key')] },
      { label: 'assignment_key 空文字', rules: [assignmentKey('')] },
      { label: 'assignment_key REDACTED', rules: [assignmentKey('REDACTED')] },
      { label: 'assignment_key Redacted', rules: [assignmentKey('Redacted')] },
      { label: 'literal placeholder custom', rules: [literal('[REDACTED:custom]')] },
      { label: 'literal placeholder jwt', rules: [literal('[REDACTED:jwt]')] },
      { label: 'literal 空文字', rules: [literal('')] },
      { label: '旧string rule', rules: ['alpha-literal'] },
      { label: 'unknown type', rules: [{ type: 'regex', value: 'x' }] },
      { label: 'value欠落', rules: [{ type: 'literal' }] },
      { label: 'unknown field', rules: [{ type: 'literal', value: 'ok', extra: true }] },
      { label: '非object', rules: [1] },
      { label: 'literal重複', rules: [literal('LEAK_MARKER_dup'), literal('LEAK_MARKER_dup')] },
      { label: '合算101件', rules: Array.from({ length: 101 }, (_, index) => assignmentKey(`key_${index}`)) },
    ];
    for (const invalid of cases) {
      const run = await replacePolicy(companyId, 1, invalid.rules);
      expectFixedFailure(run, ['invalid_arguments', 'internal_error']);
      assert.ok(!run.stderr.includes('LEAK_MARKER_dup'), `${invalid.label} のstderrへrule値を出している`);
      assert.deepEqual(
        (await storedRules(companyId))[0].rules,
        expectedOrder(boundaryRules),
        `${invalid.label} でpolicyを変更している`,
      );
    }

    const hundred = Array.from({ length: 50 }, (_, index) => literal(`lit_${index}`)).concat(
      Array.from({ length: 50 }, (_, index) => assignmentKey(`key_${index}`)),
    );
    parseSuccessJson(await replacePolicy(companyId, 1, hundred));
    assert.equal(await countRows(pool, 'company_redaction_rules'), 100, 'typed rule合算100件を受理していない');
    assert.deepEqual(list((await listPolicy(companyId)).rules), expectedOrder(hundred));
  });

  it('staleなexpected_versionは競合として拒否し、versionとtyped rulesを変更しない', async () => {
    const companyId = await createCompany();
    const baseline = [literal('keep-literal')];
    parseSuccessJson(await replacePolicy(companyId, 0, baseline));

    const stale = await replacePolicy(companyId, 0, [literal('new-literal')]);
    expectFixedFailure(stale, ['invalid_arguments', 'internal_error', 'invalid_input']);

    const listed = await listPolicy(companyId);
    assert.equal(listed.version, 1);
    assert.deepEqual(list(listed.rules), expectedOrder(baseline));
    assert.deepEqual((await storedRules(companyId))[0].rules, expectedOrder(baseline));
  });

  it('insert途中の失敗では旧version・旧typed rulesへrollbackする', async () => {
    const companyId = await createCompany();
    const baseline = [literal('keep-me')];
    parseSuccessJson(await replacePolicy(companyId, 0, baseline));

    const failed = await replacePolicy(companyId, 1, [literal('new-first'), literal('bad\u0000literal')]);
    expectFixedFailure(failed, ['invalid_arguments']);

    assert.deepEqual((await storedRules(companyId))[0].rules, expectedOrder(baseline), '失敗時にpolicyがrollbackされていない');
    assert.equal(await countRows(pool, 'company_redaction_rules'), 1);
  });

  it('他社のpolicyとrulesへ影響しない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const rulesA = [literal('a-literal')];
    const rulesB = [assignmentKey('b_key')];
    parseSuccessJson(await replacePolicy(companyA, 0, rulesA));
    parseSuccessJson(await replacePolicy(companyB, 0, rulesB));
    assert.deepEqual((await storedRules(companyA))[0].rules, expectedOrder(rulesA));
    assert.deepEqual((await storedRules(companyB))[0].rules, expectedOrder(rulesB));
  });
});

describe('project:repository:add / remove', () => {
  it('repository aliasをcanonical化して追加し、別表記でremoveできる', async () => {
    const companyId = await createCompany();
    const projectId = await createProject(companyId, 'github.com/example/main');

    parseSuccessJson(await runRepositoryCommand('project:repository:add', {
      company_id: companyId,
      project_id: projectId,
      repository: 'https://github.com/example/alias.git',
    }));
    assert.equal(await countRows(pool, 'project_repositories'), 2, 'primary backfillとaliasが入っていない');
    const stored = await pool.query<{ repository_identifier: string }>(
      'SELECT repository_identifier FROM project_repositories WHERE project_id = $1 ORDER BY repository_identifier',
      [projectId],
    );
    assert.deepEqual(
      stored.rows.map((row) => row.repository_identifier),
      ['github.com/example/alias', 'github.com/example/main'],
    );

    parseSuccessJson(await runRepositoryCommand('project:repository:remove', {
      company_id: companyId,
      project_id: projectId,
      repository: 'git@github.com:example/alias.git',
    }));
    assert.equal(await countRows(pool, 'project_repositories'), 1);
  });

  it('重複alias・他projectのprimaryとの衝突を拒否し、行を増やさない', async () => {
    const companyId = await createCompany();
    const projectA = await createProject(companyId, 'github.com/example/a');
    const projectB = await createProject(companyId, 'github.com/example/b');

    const add = { company_id: companyId, project_id: projectA, repository: 'github.com/example/alias' };
    parseSuccessJson(await runRepositoryCommand('project:repository:add', add));

    expectFixedFailure(await runRepositoryCommand('project:repository:add', add), ['invalid_arguments', 'internal_error']);
    expectFixedFailure(
      await runRepositoryCommand('project:repository:add', { ...add, project_id: projectB }),
      ['invalid_arguments', 'internal_error'],
    );
    assert.equal(await countRows(pool, 'project_repositories'), 3, '衝突時にalias行を増やしている');

    expectFixedFailure(
      await runRepositoryCommand('project:repository:remove', { ...add, repository: 'github.com/example/not-added' }),
      ['invalid_arguments', 'internal_error'],
    );
    assert.equal(await countRows(pool, 'project_repositories'), 3);
  });

  it('会社境界とcanonical repositoryをtransactionで検証する', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    const projectA = await createProject(companyA, 'github.com/example/a');

    expectFixedFailure(
      await runRepositoryCommand('project:repository:add', {
        company_id: companyA,
        project_id: projectA,
        repository: '/local/path',
      }),
      ['invalid_arguments', 'internal_error'],
    );

    const crossCompany = await runRepositoryCommand('project:repository:add', {
      company_id: companyB,
      project_id: projectA,
      repository: 'github.com/example/alias',
    });
    expectFixedFailure(crossCompany, ['invalid_arguments', 'internal_error']);
    assert.equal(crossCompany.stderr.trim(), 'admin: project_not_found', '別会社projectを会社不一致として拒否していない');
    // 失敗した2操作はどちらも行を追加しない。残るのはcreateProjectが入れたprimary repositoryの1行だけ。
    assert.equal(await countRows(pool, 'project_repositories'), 1);
  });

  it('primary repositoryはremoveで削除できず、固定codeで拒否する', async () => {
    const companyId = await createCompany();
    const projectId = await createProject(companyId, 'github.com/example/primary');

    const run = await runRepositoryCommand('project:repository:remove', {
      company_id: companyId,
      project_id: projectId,
      repository: 'https://github.com/example/primary.git',
    });
    expectFixedFailure(run, ['invalid_arguments', 'internal_error']);
    assert.equal(run.stderr.trim(), 'admin: repository_conflict', 'primary repositoryを削除可能にしている');
    assert.equal(await countRows(pool, 'project_repositories'), 1);
    const stored = await pool.query<{ repository_identifier: string }>(
      'SELECT repository_identifier FROM project_repositories WHERE project_id = $1',
      [projectId],
    );
    assert.deepEqual(stored.rows.map((row) => row.repository_identifier), ['github.com/example/primary']);
  });
});
