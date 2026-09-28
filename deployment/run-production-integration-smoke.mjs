#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YORI_ROOT = path.resolve(process.env.YORI_REPOSITORY ?? path.join(REPO_ROOT, '..', 'yori'));
const YORI_COMPOSE_FILE = path.join(YORI_ROOT, 'deployment', 'compose.test.yaml');
const CLI_COMPOSE_FILE = path.join(REPO_ROOT, 'deployment', 'compose.yaml');
const PROJECT_NAME = `yori-cli-integration-${process.pid}`;
const CLI_PROJECT_NAME = `${PROJECT_NAME}-cli`;
const NETWORK_NAME = `${PROJECT_NAME}_default`;
const SYNTHETIC_DATABASE_ENV = {
  YORI_POSTGRES_USER: 'yori',
  YORI_POSTGRES_PASSWORD: 'yori',
  YORI_POSTGRES_DB: 'yori',
  YORI_ADMIN_NETWORK: NETWORK_NAME,
  YORI_CLI_NODE_MODULES_VOLUME: `${CLI_PROJECT_NAME}-node-modules`,
  YORI_CLI_NPM_CACHE_VOLUME: `${CLI_PROJECT_NAME}-npm-cache`,
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function yoriCompose(...args) {
  return run('docker', ['compose', '--project-name', PROJECT_NAME, '--file', YORI_COMPOSE_FILE, ...args], { cwd: YORI_ROOT });
}

function cliCompose(args) {
  return run('docker', ['compose', '--project-name', CLI_PROJECT_NAME, '--file', CLI_COMPOSE_FILE, '--profile', 'tools', ...args], {
    env: { ...process.env, ...SYNTHETIC_DATABASE_ENV },
  });
}

function assertExit(result, code, step) {
  assert.equal(result.code, code, `${step} failed with exit code ${result.code}`);
}

function assertNoSecret(output, forbidden, step) {
  for (const value of forbidden) {
    assert.ok(!output.includes(value), `${step} exposed protected data`);
  }
}

function assertCliFailure(result, code, step) {
  assertExit(result, 1, step);
  assert.equal(result.stdout, '');
  const protocolLines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('admin:'));
  assert.deepEqual(protocolLines, [`admin: ${code}`]);
}

let temporaryDirectory;
try {
  await access(YORI_COMPOSE_FILE);
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'yori-cli-integration-'));
  const bootstrapPath = path.join(temporaryDirectory, 'bootstrap.json');
  await writeFile(
    bootstrapPath,
    JSON.stringify({
      company: { name: 'integration-smoke' },
      employees: [{ ref: 'operator', display_name: 'Synthetic Operator', issue_token: true }],
      projects: [{ ref: 'project', repository: 'github.com/example/integration-smoke', member_refs: ['operator'] }],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );

  assertExit(await yoriCompose('up', '--detach', '--wait', 'db'), 0, 'test database startup');

  const beforeMigration = await cliCompose([
    'run',
    '--rm',
    '--volume',
    `${bootstrapPath}:/input/bootstrap.json:ro`,
    'cli',
    'bootstrap',
    '/input/bootstrap.json',
  ]);
  assertCliFailure(beforeMigration, 'internal_error', 'pre-migration bootstrap');
  console.log('PASS migration未適用DBを拒否');

  assertExit(await yoriCompose('run', '--rm', 'migrate'), 0, 'yori migration');

  const bootstrap = await cliCompose([
    'run',
    '--rm',
    '--volume',
    `${bootstrapPath}:/input/bootstrap.json:ro`,
    'cli',
    'bootstrap',
    '/input/bootstrap.json',
  ]);
  assertExit(bootstrap, 0, 'bootstrap');
  assert.equal(bootstrap.stderr, '');
  const bootstrapOutput = JSON.parse(bootstrap.stdout);
  assert.equal(bootstrapOutput.status, 'created');
  const companyId = bootstrapOutput.company.company_id;
  const rawToken = bootstrapOutput.tokens[0].token;
  assert.equal(typeof companyId, 'string');
  assert.equal(typeof rawToken, 'string');
  console.log('PASS yori本体migration済みschemaへbootstrap');

  const repeated = await cliCompose([
    'run',
    '--rm',
    '--volume',
    `${bootstrapPath}:/input/bootstrap.json:ro`,
    'cli',
    'bootstrap',
    '/input/bootstrap.json',
  ]);
  assertCliFailure(repeated, 'bootstrap_already_completed', 'repeated bootstrap');
  assertNoSecret(repeated.stdout + repeated.stderr, [rawToken, 'postgres://', SYNTHETIC_DATABASE_ENV.YORI_POSTGRES_PASSWORD], 'repeated bootstrap');
  console.log('PASS bootstrap再実行を拒否');

  const inspect = await cliCompose(['run', '--rm', 'cli', 'inspect', companyId]);
  assertExit(inspect, 0, 'inspect');
  assert.equal(inspect.stderr, '');
  const inspectOutput = JSON.parse(inspect.stdout);
  assert.equal(inspectOutput.status, 'ok');
  assert.ok(inspectOutput.tokens.every((token) => !('token' in token) && !('token_hash' in token)));
  assertNoSecret(inspect.stdout, [rawToken, 'postgres://', SYNTHETIC_DATABASE_ENV.YORI_POSTGRES_PASSWORD], 'inspect');
  console.log('PASS inspectのtoken・DB秘密非露出');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'integration smoke failed');
  process.exitCode = 1;
} finally {
  const cliTeardown = await cliCompose(['down', '--volumes', '--remove-orphans']).catch(() => ({ code: 1 }));
  if (cliTeardown.code !== 0) {
    console.error(`cleanup failed for Compose project ${CLI_PROJECT_NAME}`);
    process.exitCode = 1;
  }
  const teardown = await yoriCompose('down', '--volumes', '--remove-orphans').catch(() => ({ code: 1 }));
  if (teardown.code !== 0) {
    console.error(`cleanup failed for Compose project ${PROJECT_NAME}`);
    process.exitCode = 1;
  }
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
