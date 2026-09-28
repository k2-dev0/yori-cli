import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'deployment', 'compose.yaml');
const REQUIRED_DATABASE_ENV = ['YORI_POSTGRES_USER', 'YORI_POSTGRES_PASSWORD', 'YORI_POSTGRES_DB'];

function composeConfig(overrides = {}) {
  const env = { ...process.env };
  for (const name of [...REQUIRED_DATABASE_ENV, 'YORI_ADMIN_DATABASE_URL', 'YORI_ADMIN_NETWORK']) {
    delete env[name];
  }
  Object.assign(env, overrides);

  return spawnSync('docker', ['compose', '--file', COMPOSE_FILE, '--profile', 'tools', 'config', '--format', 'json'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
}

function validEnvironment() {
  return {
    YORI_POSTGRES_USER: 'compose_test_user',
    YORI_POSTGRES_PASSWORD: 'compose_test_password',
    YORI_POSTGRES_DB: 'compose_test_database',
  };
}

describe('production compose contract', () => {
  for (const name of REQUIRED_DATABASE_ENV) {
    it(`${name} の未設定と空値を拒否する`, () => {
      for (const value of [undefined, '']) {
        const env = validEnvironment();
        if (value === undefined) {
          delete env[name];
        } else {
          env[name] = value;
        }
        const result = composeConfig(env);
        assert.notEqual(result.status, 0, `${name}=${JSON.stringify(value)} でCompose configが成功した`);
        assert.equal(result.stdout, '', '失敗時に解決済みconfigをstdoutへ出している');
      }
    });
  }

  it('3値からDATABASE_URLを構成し、cliだけを外部networkへ接続する', () => {
    const result = composeConfig({ ...validEnvironment(), YORI_ADMIN_NETWORK: 'custom_yori_network' });
    assert.equal(result.status, 0, `Compose configが失敗した: ${result.stderr}`);

    const config = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(config.services), ['cli']);
    assert.equal(
      config.services.cli.environment.DATABASE_URL,
      'postgres://compose_test_user:compose_test_password@db:5432/compose_test_database',
    );
    assert.deepEqual(config.services.cli.networks, { yori: null });
    assert.equal(config.services.cli.ports, undefined, 'CLI serviceがDBまたは他のportをhostへ公開している');
    assert.equal(config.networks.yori.name, 'custom_yori_network');
    assert.equal(config.networks.yori.external, true);
  });

  it('固定DB URLと旧YORI_ADMIN_DATABASE_URLをproduction composeへ保持しない', async () => {
    const source = await readFile(COMPOSE_FILE, 'utf8');
    assert.ok(!source.includes('YORI_ADMIN_DATABASE_URL'));
    assert.ok(!source.includes('postgres://yori:yori@db:5432/yori'));
  });

  it('secretをimage・entrypoint・command・port設定へ複製しない', () => {
    const result = composeConfig(validEnvironment());
    assert.equal(result.status, 0, `Compose configが失敗した: ${result.stderr}`);

    const service = JSON.parse(result.stdout).services.cli;
    const nonEnvironmentConfig = JSON.stringify({
      image: service.image,
      entrypoint: service.entrypoint,
      command: service.command,
      ports: service.ports,
    });
    assert.ok(!nonEnvironmentConfig.includes('compose_test_password'));
    assert.ok(!nonEnvironmentConfig.includes('postgres://'));
  });
});
