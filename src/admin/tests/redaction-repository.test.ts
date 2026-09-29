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

// yori migration 0010 (rule_type/value/normalized_value) とrepository aliasを管理CLIから操作する契約。
// CLIのcustom redactionはliteral valueだけを公開し、assignment_keyはlistで黙って隠さず失敗する。
// 失敗時はversion・values・aliasを一切変更しない（transaction）。
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

async function runReplace(input: unknown): Promise<AdminRun> {
  return withInputFile('redaction.json', input, (filePath) => runAdmin(['redaction:replace', filePath]));
}

async function replaceValues(companyId: string, expectedVersion: number, values: unknown): Promise<AdminRun> {
  return runReplace({ company_id: companyId, expected_version: expectedVersion, values });
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

async function storedRules(companyId: string): Promise<{ version: number; values: string[]; rows: StoredRuleRow[] }[]> {
  const result = await pool.query<{ version: number; rule_type: string | null; value: string | null; normalized_value: string | null }>(
    `SELECT p.version, r.rule_type, r.value, r.normalized_value
       FROM company_redaction_policies p
       LEFT JOIN company_redaction_rules r ON r.company_id = p.company_id
      WHERE p.company_id = $1
      ORDER BY r.rule_type, r.value`,
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
  return [{ version: result.rows[0].version, values: rows.filter((row) => row.rule_type === 'literal').map((row) => row.value), rows }];
}

describe('redaction:replace / redaction:list', () => {
  it('literal valuesを登録し、listはversionと決定的順のvaluesだけを返す', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replaceValues(companyId, 0, ['beta-literal', 'alpha-literal']));

    const listed = await listPolicy(companyId);
    assert.deepEqual(Object.keys(listed).sort(), ['values', 'version']);
    assert.equal(listed.version, 1);
    assert.deepEqual(list(listed.values), ['alpha-literal', 'beta-literal']);

    const stored = await storedRules(companyId);
    assert.equal(stored[0].version, 1);
    assert.deepEqual(stored[0].values, ['alpha-literal', 'beta-literal']);
    for (const row of stored[0].rows) {
      assert.equal(row.rule_type, 'literal', 'literal以外で保存している');
      assert.equal(row.normalized_value, row.value, 'literalのnormalized_valueがvalueと違う');
    }
  });

  it('CAS成功時に旧assignment_key rowを含む全rulesをDELETEし、valuesだけへ置換する', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replaceValues(companyId, 0, ['keep-literal']));
    await pool.query(
      "INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, 'assignment_key', 'old_key', 'old_key')",
      [companyId],
    );
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2);

    parseSuccessJson(await replaceValues(companyId, 1, ['after-literal']));
    const stored = await storedRules(companyId);
    assert.deepEqual(stored[0].values, ['after-literal']);
    assert.ok(stored[0].rows.every((row) => row.rule_type === 'literal'), 'assignment_key rowが残っている');
    assert.equal(await countRows(pool, 'company_redaction_rules'), 1);

    assert.deepEqual(list((await listPolicy(companyId)).values), ['after-literal']);
  });

  it('literal valuesは512cp・100件境界を受理し、空・placeholder・重複・旧shapeを拒否する', async () => {
    const companyId = await createCompany();
    const maxLiteral = 'x'.repeat(512);
    parseSuccessJson(await replaceValues(companyId, 0, [maxLiteral]));
    assert.deepEqual(list((await listPolicy(companyId)).values), [maxLiteral]);

    const hundred = Array.from({ length: 100 }, (_, index) => `lit-${String(index).padStart(3, '0')}`);
    const hundredSorted = [...hundred].sort();
    parseSuccessJson(await replaceValues(companyId, 1, hundred));
    assert.equal(await countRows(pool, 'company_redaction_rules'), 100);
    assert.deepEqual(list((await listPolicy(companyId)).values), hundredSorted);

    const invalidCases: { label: string; input: unknown }[] = [
      {
        label: '101件',
        input: { company_id: companyId, expected_version: 2, values: Array.from({ length: 101 }, (_, index) => `over-${index}`) },
      },
      { label: '513cp', input: { company_id: companyId, expected_version: 2, values: ['x'.repeat(513)] } },
      { label: '空文字', input: { company_id: companyId, expected_version: 2, values: [''] } },
      { label: 'placeholder custom', input: { company_id: companyId, expected_version: 2, values: ['[REDACTED:custom]'] } },
      { label: 'placeholder jwt', input: { company_id: companyId, expected_version: 2, values: ['[REDACTED:jwt]'] } },
      { label: '重複', input: { company_id: companyId, expected_version: 2, values: ['LEAK_MARKER_dup', 'LEAK_MARKER_dup'] } },
      { label: '非文字列', input: { company_id: companyId, expected_version: 2, values: [1] } },
      { label: '旧rules field', input: { company_id: companyId, expected_version: 2, rules: ['old-literal'] } },
      { label: 'typed rule object', input: { company_id: companyId, expected_version: 2, values: [{ type: 'literal', value: 'typed' }] } },
      { label: 'keys field', input: { company_id: companyId, expected_version: 2, keys: ['old_key'] } },
      { label: 'assignment_keys field', input: { company_id: companyId, expected_version: 2, assignment_keys: ['old_key'] } },
      {
        label: 'rules併記',
        input: { company_id: companyId, expected_version: 2, values: ['ok-literal'], rules: ['old-literal'] },
      },
      { label: 'unknown field', input: { company_id: companyId, expected_version: 2, values: ['ok-literal'], extra: true } },
    ];
    for (const invalid of invalidCases) {
      const run = await runReplace(invalid.input);
      expectFixedFailure(run, ['invalid_arguments', 'internal_error']);
      assert.ok(!run.stderr.includes('LEAK_MARKER_dup'), `${invalid.label} のstderrへvalueを出している`);
      const stored = await storedRules(companyId);
      assert.equal(stored[0].version, 2, `${invalid.label} でversionを変更している`);
      assert.deepEqual(stored[0].values, hundredSorted, `${invalid.label} でvaluesを変更している`);
    }
  });

  it('DBにassignment_key rowが存在する場合、listは黙って隠さずinternal_errorで失敗する', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replaceValues(companyId, 0, ['keep-literal']));
    await pool.query(
      "INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, 'assignment_key', 'legacy_key', 'legacy_key')",
      [companyId],
    );

    const run = await runAdmin(['redaction:list', companyId]);
    assert.equal(run.code, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'admin: internal_error\n', 'assignment_key rowを黙って隠している');
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2, 'list失敗でassignment_key rowを削除している');
  });

  it('staleなexpected_versionは競合として拒否し、versionとvaluesを変更しない', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replaceValues(companyId, 0, ['keep-literal']));

    const stale = await replaceValues(companyId, 0, ['new-literal']);
    expectFixedFailure(stale, ['invalid_arguments', 'internal_error', 'invalid_input']);

    const listed = await listPolicy(companyId);
    assert.equal(listed.version, 1);
    assert.deepEqual(list(listed.values), ['keep-literal']);
    assert.deepEqual((await storedRules(companyId))[0].values, ['keep-literal']);
  });

  it('insert途中の失敗では旧version・旧valuesへrollbackする', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replaceValues(companyId, 0, ['keep-me']));

    const failed = await replaceValues(companyId, 1, ['new-first', 'bad\u0000literal']);
    expectFixedFailure(failed, ['invalid_arguments']);

    assert.deepEqual((await storedRules(companyId))[0].values, ['keep-me'], '失敗時にpolicyがrollbackされていない');
    assert.equal(await countRows(pool, 'company_redaction_rules'), 1);
  });

  it('他社のpolicyとvaluesへ影響しない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    parseSuccessJson(await replaceValues(companyA, 0, ['a-literal']));
    parseSuccessJson(await replaceValues(companyB, 0, ['b-literal']));
    assert.deepEqual((await storedRules(companyA))[0].values, ['a-literal']);
    assert.deepEqual((await storedRules(companyB))[0].values, ['b-literal']);
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
