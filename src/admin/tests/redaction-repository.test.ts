import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../../db/pool.js';
import {
  applyTestSchema,
  countRows,
  expectFail,
  parseSuccessJson,
  resetDatabase,
  runAdmin,
  testDatabaseUrl,
  withInputFile,
  type AdminRun,
} from './support.js';

// yori migration 0010 (business policy: rule_type field/term + suspicion_mode/detector_version) と
// repository aliasを管理CLIから操作する契約。CLIはfield/term/suspicion_modeだけを公開し、
// literal/assignment_key等の旧shapeはDBへ書かず固定codeで拒否する。
// 失敗時はversion・fields・termsを一切変更しない（transaction）。
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

function str(value: unknown): string {
  assert.equal(typeof value, 'string', `文字列ではない: ${JSON.stringify(value)}`);
  return value as string;
}

function sorted(values: readonly unknown[]): unknown[] {
  return [...values].sort();
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

async function runReplace(input: unknown): Promise<AdminRun> {
  return withInputFile('redaction.json', input, (filePath) => runAdmin(['redaction:replace', filePath]));
}

interface PolicyBody {
  fields?: unknown;
  terms?: unknown;
  suspicion_mode?: unknown;
}

async function replacePolicy(companyId: string, expectedVersion: number, body: PolicyBody): Promise<AdminRun> {
  return runReplace({
    company_id: companyId,
    expected_version: expectedVersion,
    fields: body.fields ?? [],
    terms: body.terms ?? [],
    suspicion_mode: body.suspicion_mode ?? 'observe',
  });
}

async function listPolicy(companyId: string): Promise<Record<string, unknown>> {
  return parseSuccessJson(await runAdmin(['redaction:list', companyId]));
}

async function runRepositoryCommand(command: 'project:repository:add' | 'project:repository:remove', input: unknown): Promise<AdminRun> {
  return withInputFile('repository.json', input, (filePath) => runAdmin([command, filePath]));
}

interface StoredRuleRow {
  rule_type: string;
  value: string;
  normalized_value: string;
}

interface StoredPolicy {
  version: number;
  suspicion_mode: string;
  detector_version: string;
  rows: StoredRuleRow[];
}

// policy行とrule行をDBから直接読み、CLI出力に依存せず永続化を検証する。
async function storedPolicy(companyId: string): Promise<StoredPolicy | null> {
  const result = await pool.query<{
    version: number;
    suspicion_mode: string;
    detector_version: string;
    rule_type: string | null;
    value: string | null;
    normalized_value: string | null;
  }>(
    `SELECT p.version, p.suspicion_mode, p.detector_version, r.rule_type, r.value, r.normalized_value
       FROM company_redaction_policies p
       LEFT JOIN company_redaction_rules r ON r.company_id = p.company_id
      WHERE p.company_id = $1
      ORDER BY r.rule_type, r.normalized_value`,
    [companyId],
  );
  const first = result.rows[0];
  if (first === undefined) {
    return null;
  }
  const rows = result.rows.flatMap((row): StoredRuleRow[] =>
    row.rule_type === null || row.value === null || row.normalized_value === null
      ? []
      : [{ rule_type: row.rule_type, value: row.value, normalized_value: row.normalized_value }],
  );
  return { version: first.version, suspicion_mode: first.suspicion_mode, detector_version: first.detector_version, rows };
}

function storedValues(policy: StoredPolicy, ruleType: 'field' | 'term'): string[] {
  return policy.rows.filter((row) => row.rule_type === ruleType).map((row) => row.value).sort();
}

describe('redaction:replace / redaction:list', () => {
  it('field/term/suspicion_modeを直接DBへ保存し、listはversion・fields・terms・suspicion_mode・detector_versionだけを返す', async () => {
    const companyId = await createCompany();
    const replaced = parseSuccessJson(
      await replacePolicy(companyId, 0, { fields: ['pass_key', 'Pass'], terms: ['beta-term', 'alpha-term'], suspicion_mode: 'block' }),
    );
    assert.deepEqual(replaced, { status: 'replaced', company_id: companyId, version: 1 });

    const listed = await listPolicy(companyId);
    assert.deepEqual(Object.keys(listed).sort(), ['detector_version', 'fields', 'suspicion_mode', 'terms', 'version']);
    assert.equal(listed.version, 1);
    assert.equal(listed.suspicion_mode, 'block');
    assert.equal(listed.detector_version, 'initial-v1');
    assert.deepEqual(listed.fields, sorted(['Pass', 'pass_key']));
    assert.deepEqual(listed.terms, sorted(['alpha-term', 'beta-term']));

    const policy = await storedPolicy(companyId);
    assert.ok(policy !== null, 'policy行が保存されていない');
    assert.equal(policy.version, 1);
    assert.equal(policy.suspicion_mode, 'block');
    assert.equal(policy.detector_version, 'initial-v1');
    assert.deepEqual(storedValues(policy, 'field'), sorted(['Pass', 'pass_key']));
    assert.deepEqual(storedValues(policy, 'term'), sorted(['alpha-term', 'beta-term']));
    const fieldRows = policy.rows.filter((row) => row.rule_type === 'field');
    for (const row of fieldRows) {
      assert.equal(row.normalized_value, row.value.toLowerCase(), 'fieldのnormalized_valueがlower(value)ではない');
    }
    const termRows = policy.rows.filter((row) => row.rule_type === 'term');
    for (const row of termRows) {
      assert.equal(row.normalized_value, row.value, 'termのnormalized_valueがvalueと違う');
    }
  });

  it('version CASで全ruleを原子的に置換し、stale versionをredaction_policy_conflictで拒否する', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, { fields: ['old_field'], terms: ['old-term-marker'], suspicion_mode: 'observe' }));

    parseSuccessJson(await replacePolicy(companyId, 1, { fields: ['new_field'], terms: ['new-term'], suspicion_mode: 'block' }));
    const policy = await storedPolicy(companyId);
    assert.ok(policy !== null);
    assert.equal(policy.version, 2);
    assert.equal(policy.suspicion_mode, 'block');
    assert.deepEqual(storedValues(policy, 'field'), ['new_field']);
    assert.deepEqual(storedValues(policy, 'term'), ['new-term']);
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2, '旧ruleが残っている');

    const stale = await replacePolicy(companyId, 1, { fields: ['stale_field'], terms: [], suspicion_mode: 'observe' });
    expectFail(stale, 'redaction_policy_conflict');
    const afterStale = await storedPolicy(companyId);
    assert.ok(afterStale !== null);
    assert.equal(afterStale.version, 2);
    assert.deepEqual(storedValues(afterStale, 'field'), ['new_field'], 'stale versionでfieldを変更している');
    assert.deepEqual(storedValues(afterStale, 'term'), ['new-term'], 'stale versionでtermを変更している');

    const missingCompany = '01930000-0000-7000-8000-0000000000fe';
    expectFail(await replacePolicy(missingCompany, 0, { fields: [], terms: [], suspicion_mode: 'observe' }), 'company_not_found');
  });

  it('fields/termsの上限・identifier・placeholder・重複を終了codeと無変更で拒否する', async () => {
    const companyId = await createCompany();
    const maxField = 'a'.repeat(128);
    const maxTerm = 'x'.repeat(512);
    parseSuccessJson(await replacePolicy(companyId, 0, { fields: [maxField], terms: [maxTerm], suspicion_mode: 'observe' }));

    const tooMany = {
      fields: Array.from({ length: 50 }, (_, index) => `field_${String(index).padStart(3, '0')}`),
      terms: Array.from({ length: 51 }, (_, index) => `term-${String(index).padStart(3, '0')}`),
    };
    const invalidBodies: { label: string; body: PolicyBody }[] = [
      { label: 'field 129cp', body: { fields: ['a'.repeat(129)] } },
      { label: 'term 513cp', body: { terms: ['x'.repeat(513)] } },
      { label: 'field identifier', body: { fields: ['1bad'] } },
      { label: 'field space', body: { fields: ['has space'] } },
      { label: 'field redacted', body: { fields: ['redacted'] } },
      { label: 'field REDACTED', body: { fields: ['REDACTED'] } },
      { label: 'field empty', body: { fields: [''] } },
      { label: 'field non-string', body: { fields: [1] } },
      { label: 'field case重複', body: { fields: ['dup_field_MARKER', 'DUP_FIELD_MARKER'] } },
      { label: 'term empty', body: { terms: [''] } },
      { label: 'term REDACTED', body: { terms: ['REDACTED'] } },
      { label: 'term placeholder', body: { terms: ['[REDACTED:jwt]'] } },
      { label: 'term business_value', body: { terms: ['business_value'] } },
      { label: 'term known_secret', body: { terms: ['known_secret'] } },
      { label: 'term colon', body: { terms: ['a:b'] } },
      { label: 'term non-string', body: { terms: [1] } },
      { label: 'term重複', body: { terms: ['dup-term-marker', 'dup-term-marker'] } },
      { label: '合計101件', body: { ...tooMany } },
      { label: 'suspicion_mode不正', body: { suspicion_mode: 'warn' } },
      { label: 'fields非配列', body: { fields: 'not-array' } },
      { label: 'terms非配列', body: { terms: 'not-array' } },
    ];
    for (const invalid of invalidBodies) {
      const run = await replacePolicy(companyId, 1, invalid.body);
      expectFixedFailure(run, ['redaction_policy_conflict', 'company_not_found']);
      assert.equal(run.stderr, 'admin: invalid_input\n', `${invalid.label} がinvalid_inputではない`);
      assert.ok(!run.stderr.includes('dup_field_MARKER') && !run.stderr.includes('dup-term-marker'), `${invalid.label} のstderrへ値を出している`);
      const policy = await storedPolicy(companyId);
      assert.ok(policy !== null);
      assert.equal(policy.version, 1, `${invalid.label} でversionを変更している`);
      assert.deepEqual(storedValues(policy, 'field'), [maxField], `${invalid.label} でfieldsを変更している`);
      assert.deepEqual(storedValues(policy, 'term'), [maxTerm], `${invalid.label} でtermsを変更している`);
    }
  });

  it('literal/assignment_key等の旧shape・必須key欠落・未知keyをinvalid_inputで拒否する', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, { fields: ['keep_field'], terms: ['keep-term'], suspicion_mode: 'observe' }));

    const base: Record<string, unknown> = {
      company_id: companyId,
      expected_version: 1,
      fields: ['ok_field'],
      terms: ['ok-term'],
      suspicion_mode: 'observe',
    };
    const without = (key: string): Record<string, unknown> => {
      const copy = { ...base };
      delete copy[key];
      return copy;
    };
    const legacyInputs: { label: string; input: Record<string, unknown> }[] = [
      { label: 'values', input: { ...base, values: ['old-literal'] } },
      { label: 'rules', input: { ...base, rules: [{ type: 'literal', value: 'old-literal' }] } },
      { label: 'assignment_keys', input: { ...base, assignment_keys: ['old_key'] } },
      { label: 'keys', input: { ...base, keys: ['old_key'] } },
      { label: 'typed field rule', input: { ...base, fields: [{ type: 'field', value: 'typed' }] } },
      { label: 'suspicion_mode欠落', input: without('suspicion_mode') },
      { label: 'expected_version欠落', input: without('expected_version') },
      { label: 'fields欠落', input: without('fields') },
      { label: 'terms欠落', input: without('terms') },
      { label: 'detector_version未知', input: { ...base, detector_version: 'initial-v1' } },
      { label: 'extra key', input: { ...base, extra: true } },
    ];
    for (const legacy of legacyInputs) {
      const run = await runReplace(legacy.input);
      expectFixedFailure(run, ['redaction_policy_conflict', 'company_not_found']);
      assert.equal(run.stderr, 'admin: invalid_input\n', `${legacy.label} がinvalid_inputではない`);
      const policy = await storedPolicy(companyId);
      assert.ok(policy !== null);
      assert.equal(policy.version, 1, `${legacy.label} でversionを変更している`);
      assert.deepEqual(storedValues(policy, 'field'), ['keep_field']);
      assert.deepEqual(storedValues(policy, 'term'), ['keep-term']);
    }
  });

  it('field/term合計100件を受け入れ、listはfield/termを各々ソートして返す', async () => {
    const companyId = await createCompany();
    const fields = Array.from({ length: 50 }, (_, index) => `field_${String(49 - index).padStart(3, '0')}`);
    const terms = Array.from({ length: 50 }, (_, index) => `term-${String(49 - index).padStart(3, '0')}`);
    parseSuccessJson(await replacePolicy(companyId, 0, { fields, terms, suspicion_mode: 'observe' }));
    assert.equal(await countRows(pool, 'company_redaction_rules'), 100);

    const listed = await listPolicy(companyId);
    assert.deepEqual(listed.fields, [...fields].sort());
    assert.deepEqual(listed.terms, [...terms].sort());
  });

  it('空のfields/termsでもpolicy versionとsuspicion_modeだけを更新できる', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, { fields: [], terms: [], suspicion_mode: 'observe' }));
    const first = await storedPolicy(companyId);
    assert.ok(first !== null);
    assert.equal(first.version, 1);
    assert.equal(first.rows.length, 0, '空policyでrule行を作成している');

    parseSuccessJson(await replacePolicy(companyId, 1, { fields: [], terms: [], suspicion_mode: 'block' }));
    const second = await storedPolicy(companyId);
    assert.ok(second !== null);
    assert.equal(second.version, 2);
    assert.equal(second.suspicion_mode, 'block');
    assert.equal(second.detector_version, 'initial-v1');
    assert.equal(second.rows.length, 0);
    const listed = await listPolicy(companyId);
    assert.deepEqual(listed, {
      version: 2,
      fields: [],
      terms: [],
      suspicion_mode: 'block',
      detector_version: 'initial-v1',
    });
  });

  it('未登録会社のlistはversion 0のempty policyを返す', async () => {
    const companyId = await createCompany();
    const listed = await listPolicy(companyId);
    assert.deepEqual(listed, {
      version: 0,
      fields: [],
      terms: [],
      suspicion_mode: 'observe',
      detector_version: 'initial-v1',
    });
  });

  it('termはcase-sensitive、fieldはcase-insensitiveに重複判定し、typeが違えば同名を許可する', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, { fields: ['PassKey'], terms: ['PassKey', 'passkey'], suspicion_mode: 'observe' }));

    const listed = await listPolicy(companyId);
    assert.deepEqual(listed.fields, ['PassKey']);
    assert.deepEqual(listed.terms, sorted(['PassKey', 'passkey']));
    const policy = await storedPolicy(companyId);
    assert.ok(policy !== null);
    assert.equal(policy.rows.length, 3, 'typeが異なる同名valueを拒否している');

    const duplicateField = await replacePolicy(companyId, 1, { fields: ['passkey'], terms: [], suspicion_mode: 'observe' });
    expectFail(duplicateField, 'invalid_input');
    const duplicateTerm = await replacePolicy(companyId, 1, { fields: [], terms: ['PASSKEY', 'PASSKEY'], suspicion_mode: 'observe' });
    expectFail(duplicateTerm, 'invalid_input');
    assert.equal((await storedPolicy(companyId))?.rows.length, 3, '重複拒否で既存ruleを変更している');
  });

  it('expected_versionは0以上の整数だけを受理する', async () => {
    const companyId = await createCompany();
    for (const expected of [-1, 1.5, '1', null]) {
      const run = await runReplace({ company_id: companyId, expected_version: expected, fields: [], terms: [], suspicion_mode: 'observe' });
      expectFixedFailure(run, ['redaction_policy_conflict', 'company_not_found']);
      assert.equal(run.stderr, 'admin: invalid_input\n', `expected_version=${String(expected)} がinvalid_inputではない`);
    }
  });

  it('insert途中の失敗では旧version・旧fields/termsへrollbackする', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, { fields: ['keep_field'], terms: ['keep-term'], suspicion_mode: 'observe' }));

    const failed = await replacePolicy(companyId, 1, { fields: ['new_field'], terms: ['bad\u0000term'], suspicion_mode: 'block' });
    expectFixedFailure(failed, ['redaction_policy_conflict', 'company_not_found']);
    assert.equal(failed.stderr, 'admin: invalid_input\n');

    const policy = await storedPolicy(companyId);
    assert.ok(policy !== null);
    assert.equal(policy.version, 1, '失敗時にversionを変更している');
    assert.equal(policy.suspicion_mode, 'observe', '失敗時にsuspicion_modeを変更している');
    assert.deepEqual(storedValues(policy, 'field'), ['keep_field']);
    assert.deepEqual(storedValues(policy, 'term'), ['keep-term']);
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2);
  });

  it('他社のpolicyとrulesへ影響しない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    parseSuccessJson(await replacePolicy(companyA, 0, { fields: ['a_field'], terms: ['a-term'], suspicion_mode: 'observe' }));
    parseSuccessJson(await replacePolicy(companyB, 0, { fields: ['b_field'], terms: ['b-term'], suspicion_mode: 'block' }));
    assert.deepEqual(storedValues((await storedPolicy(companyA)) as StoredPolicy, 'field'), ['a_field']);
    assert.deepEqual(storedValues((await storedPolicy(companyB)) as StoredPolicy, 'field'), ['b_field']);
    assert.equal((await listPolicy(companyB)).suspicion_mode, 'block');
    assert.equal((await listPolicy(companyA)).suspicion_mode, 'observe');
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
