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

// yori migration 0010 のcustom伏せ字policyとrepository aliasを管理CLIから操作する契約。
// 失敗時はversion・rules・aliasを一切変更しない（transaction）。
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

async function replacePolicy(companyId: string, expectedVersion: number, rules: unknown): Promise<AdminRun> {
  return withInputFile('redaction.json', { company_id: companyId, expected_version: expectedVersion, rules }, (filePath) =>
    runAdmin(['redaction:replace', filePath]),
  );
}

async function listPolicy(companyId: string): Promise<Record<string, unknown>> {
  return parseSuccessJson(await runAdmin(['redaction:list', companyId]));
}

async function storedRules(companyId: string): Promise<{ version: number; rules: string[] }[]> {
  const result = await pool.query<{ version: number; literal: string | null }>(
    `SELECT p.version, r.literal
       FROM company_redaction_policies p
       LEFT JOIN company_redaction_rules r ON r.company_id = p.company_id
      WHERE p.company_id = $1
      ORDER BY r.literal`,
    [companyId],
  );
  return result.rows.length === 0 ? [] : [{ version: result.rows[0].version, rules: result.rows.flatMap((row) => (row.literal === null ? [] : [row.literal])) }];
}

async function runRepositoryCommand(command: 'project:repository:add' | 'project:repository:remove', input: unknown): Promise<AdminRun> {
  return withInputFile('repository.json', input, (filePath) => runAdmin([command, filePath]));
}

describe('redaction:replace / redaction:list', () => {
  it('version 0からruleを登録し、listはversionとrulesだけを返す', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, ['alpha-literal', 'beta-literal']));

    const listed = await listPolicy(companyId);
    assert.deepEqual(Object.keys(listed).sort(), ['rules', 'version']);
    assert.equal(listed.version, 1);
    assert.deepEqual(list(listed.rules).slice().sort(), ['alpha-literal', 'beta-literal']);
    assert.equal(await countRows(pool, 'company_redaction_rules'), 2);
  });

  it('expected_version一致でdelete+insert+version incrementを1 transactionで行う', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, ['alpha-literal', 'beta-literal']));
    parseSuccessJson(await replacePolicy(companyId, 1, ['gamma-literal']));

    const listed = await listPolicy(companyId);
    assert.equal(listed.version, 2);
    assert.deepEqual(listed.rules, ['gamma-literal']);
    assert.equal(await countRows(pool, 'company_redaction_rules'), 1, '旧ruleが残っている');
    assert.deepEqual(await storedRules(companyId), [{ version: 2, rules: ['gamma-literal'] }]);
  });

  it('上限100件は受理し、101件・513 code points・placeholder fragment・重複を拒否する', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, ['baseline']));

    const hundred = Array.from({ length: 100 }, (_, index) => `limit-rule-${index}`);
    const hundredSorted = [...hundred].sort();
    parseSuccessJson(await replacePolicy(companyId, 1, hundred));
    assert.equal(await countRows(pool, 'company_redaction_rules'), 100);
    assert.deepEqual((await listPolicy(companyId)).rules, hundredSorted, 'listはliteral順で決定的に返す');

    interface InvalidCase {
      label: string;
      rules: unknown;
      expectedCodes?: string[];
    }
    const cases: InvalidCase[] = [
      { label: '101件', rules: Array.from({ length: 101 }, (_, index) => `over-limit-${index}`) },
      { label: '513 code points', rules: ['x'.repeat(513)] },
      { label: 'placeholder fragment', rules: ['[REDACTED:custom]', 'other'] },
      { label: 'built-in placeholder fragment', rules: ['[REDACTED:jwt]'] },
      { label: '重複', rules: ['LEAK_MARKER_rule', 'LEAK_MARKER_rule'] },
      { label: '空文字', rules: [''] },
      { label: '非文字列', rules: [1] },
    ];
    for (const invalid of cases) {
      const run = await replacePolicy(companyId, 2, invalid.rules);
      expectFixedFailure(run, ['invalid_arguments', 'internal_error']);
      assert.ok(!run.stderr.includes('LEAK_MARKER_rule'), `${invalid.label} のstderrへrule値を出している`);
      assert.deepEqual(await storedRules(companyId), [{ version: 2, rules: hundredSorted }], `${invalid.label} でpolicyを変更している`);
    }

    const unknownField = await withInputFile('redaction.json', { company_id: companyId, expected_version: 2, rules: [], extra: true }, (filePath) =>
      runAdmin(['redaction:replace', filePath]),
    );
    expectFixedFailure(unknownField, ['invalid_arguments', 'internal_error']);
    assert.deepEqual(await storedRules(companyId), [{ version: 2, rules: hundredSorted }]);
  });

  it('staleなexpected_versionは競合として拒否し、versionとrulesを変更しない', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, ['keep-literal']));

    const stale = await replacePolicy(companyId, 0, ['new-literal']);
    expectFixedFailure(stale, ['invalid_arguments', 'internal_error', 'invalid_input']);

    const listed = await listPolicy(companyId);
    assert.equal(listed.version, 1);
    assert.deepEqual(listed.rules, ['keep-literal']);
    assert.deepEqual(await storedRules(companyId), [{ version: 1, rules: ['keep-literal'] }]);
  });

  it('insert途中の失敗では旧version・旧rulesへrollbackする', async () => {
    const companyId = await createCompany();
    parseSuccessJson(await replacePolicy(companyId, 0, ['keep-me']));

    const failed = await replacePolicy(companyId, 1, ['new-first', 'bad\u0000literal']);
    expectFixedFailure(failed, ['invalid_arguments']);

    assert.deepEqual(await storedRules(companyId), [{ version: 1, rules: ['keep-me'] }], '失敗時にpolicyがrollbackされていない');
    assert.equal(await countRows(pool, 'company_redaction_rules'), 1);
  });

  it('他社のpolicyとrulesへ影響しない', async () => {
    const companyA = await createCompany('a');
    const companyB = await createCompany('b');
    parseSuccessJson(await replacePolicy(companyA, 0, ['a-literal']));
    parseSuccessJson(await replacePolicy(companyB, 0, ['b-literal']));
    assert.deepEqual(await storedRules(companyA), [{ version: 1, rules: ['a-literal'] }]);
    assert.deepEqual(await storedRules(companyB), [{ version: 1, rules: ['b-literal'] }]);
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
