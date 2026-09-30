import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './support.js';

// build時にYORI_REPOSITORY（既定../yori）の配布用collector artifactをchecksum検証してcopyする契約。
// 実repositoryのdistを汚さないよう、検証中だけdist/collectorを退避・復元する。
const DIST_DIR = path.join(REPO_ROOT, 'dist', 'collector');
const BUNDLE_PATH = path.join(DIST_DIR, 'yori-collector.mjs');
const MANIFEST_PATH = path.join(DIST_DIR, 'collector-manifest.json');
const BUILD_TIMEOUT_MS = 180_000;

interface BuildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBuild(yoriRepository: string): BuildResult {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
    env: { ...process.env, YORI_REPOSITORY: yoriRepository },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function writeArtifact(
  yoriRepository: string,
  options: { version: string; content: string; checksum?: string; gitSha?: string },
): Promise<void> {
  const outDir = path.join(yoriRepository, 'dist', 'collector');
  await mkdir(outDir, { recursive: true });
  const manifest = {
    version: options.version,
    file: 'yori-collector.mjs',
    git_sha: options.gitSha ?? '1111111111111111111111111111111111111111',
    checksum: options.checksum ?? createHash('sha256').update(options.content).digest('hex'),
  };
  await writeFile(path.join(outDir, 'yori-collector.mjs'), options.content, 'utf8');
  await writeFile(path.join(outDir, 'collector-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// dist/collectorを退避し、test後に元の状態へ戻す。存在しなかった場合は削除する。
async function withDistBackup(run: () => Promise<void>): Promise<void> {
  const hadDist = existsSync(DIST_DIR);
  const backupDir = hadDist ? await mkdtemp(path.join(tmpdir(), 'yori-dist-backup-')) : null;
  if (backupDir !== null) {
    await cp(DIST_DIR, backupDir, { recursive: true });
  }
  try {
    await run();
  } finally {
    await rm(DIST_DIR, { recursive: true, force: true });
    if (backupDir !== null) {
      await cp(backupDir, DIST_DIR, { recursive: true });
      await rm(backupDir, { recursive: true, force: true });
    }
  }
}

describe('collector build copy', () => {
  it('YORI_REPOSITORYのartifactをchecksum検証してcopyし、checksum不一致では既存copyを変更しない', async () => {
    const yoriRepository = await mkdtemp(path.join(tmpdir(), 'yori-repository-fixture-'));
    try {
      await withDistBackup(async () => {
        const content = 'console.log("build-fixture-v1");\n';
        const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
        await writeArtifact(yoriRepository, { version: packageJson.version, content });
        const first = runBuild(yoriRepository);
        assert.equal(first.status, 0, `buildが失敗した: ${first.stderr}`);
        assert.ok(existsSync(BUNDLE_PATH), `collector bundleがcopyされていない: ${BUNDLE_PATH}`);
        assert.ok(existsSync(MANIFEST_PATH), 'collector manifestがcopyされていない');
        assert.equal(await readFile(BUNDLE_PATH, 'utf8'), content, 'copy内容がfixture artifactと違う');
        const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
        assert.equal(manifest.checksum, createHash('sha256').update(content).digest('hex'));
        assert.equal(manifest.file, 'yori-collector.mjs');
        assert.equal(typeof manifest.version, 'string');
        assert.ok((manifest.version as string).length > 0);
        assert.equal(manifest.version, packageJson.version);
        assert.match(String(manifest.git_sha), /^[0-9a-f]{40}$/);

        // npm artifact（pack）へcollector bundleとmanifestを同梱する。
        const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO_ROOT, encoding: 'utf8' });
        assert.equal(pack.status, 0, `npm pack --dry-runが失敗した: ${pack.stderr}`);
        const packed = JSON.parse(pack.stdout) as { files: { path: string }[] }[];
        const packedPaths = packed[0].files.map((file) => file.path);
        assert.ok(packedPaths.includes('dist/collector/yori-collector.mjs'), `packへcollector bundleが含まれていない: ${JSON.stringify(packedPaths)}`);
        assert.ok(packedPaths.includes('dist/collector/collector-manifest.json'), `packへcollector manifestが含まれていない: ${JSON.stringify(packedPaths)}`);
        assert.ok(!packedPaths.some((value) => value.startsWith('src/')), 'packへsrcが含まれている');

        // checksum不一致のartifactはbuildを失敗させ、直前のcopyを変更しない。
        const before = await readFile(BUNDLE_PATH);
        const beforeManifest = await readFile(MANIFEST_PATH);
        await writeArtifact(yoriRepository, {
          version: packageJson.version,
          content: 'console.log("build-fixture-v2");\n',
          checksum: '0'.repeat(64),
        });
        const second = runBuild(yoriRepository);
        assert.notEqual(second.status, 0, 'checksum不一致のartifactでbuildが成功した');
        assert.deepEqual(await readFile(BUNDLE_PATH), before, 'checksum不一致で既存copyを変更している');
        assert.deepEqual(await readFile(MANIFEST_PATH), beforeManifest, 'checksum不一致で既存manifestを変更している');
      });
    } finally {
      await rm(yoriRepository, { recursive: true, force: true });
    }
  });

  it('collector versionがyori-cli package versionと違う、またはgit_shaが不正ならcopyしない', async () => {
    const yoriRepository = await mkdtemp(path.join(tmpdir(), 'yori-repository-version-fixture-'));
    try {
      await withDistBackup(async () => {
        for (const artifact of [
          { version: '0.0.0', content: 'console.log("bad-version");\n' },
          { version: '0.1.2', content: 'console.log("bad-sha");\n', gitSha: 'not-a-sha' },
        ]) {
          await writeArtifact(yoriRepository, artifact);
          const result = runBuild(yoriRepository);
          assert.notEqual(result.status, 0, `不正metadataを成功扱いした: ${JSON.stringify(artifact)}`);
        }
      });
    } finally {
      await rm(yoriRepository, { recursive: true, force: true });
    }
  });

  it('collector artifactを持たないYORI_REPOSITORYを成功扱いしない', async () => {
    const yoriRepository = await mkdtemp(path.join(tmpdir(), 'yori-repository-empty-'));
    try {
      await withDistBackup(async () => {
        const result = runBuild(yoriRepository);
        assert.notEqual(result.status, 0, 'artifactがないYORI_REPOSITORYでbuildが成功した');
      });
    } finally {
      await rm(yoriRepository, { recursive: true, force: true });
    }
  });

  it('manifest切替に失敗したらbundle copyも元へrollbackする', async () => {
    const yoriRepository = await mkdtemp(path.join(tmpdir(), 'yori-repository-rollback-'));
    try {
      await withDistBackup(async () => {
        const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
        await writeArtifact(yoriRepository, { version: packageJson.version, content: 'console.log("rollback-v1");\n' });
        assert.equal(runBuild(yoriRepository).status, 0, 'rollback testの事前buildが失敗した');
        const before = await readFile(BUNDLE_PATH);
        // manifestのtargetをdirectoryへ置換し、2つ目のrenameだけを失敗させる。
        await rm(MANIFEST_PATH, { force: true });
        await mkdir(MANIFEST_PATH, { recursive: true });
        const result = runBuild(yoriRepository);
        assert.notEqual(result.status, 0, 'manifest切替失敗でbuildが成功した');
        assert.deepEqual(await readFile(BUNDLE_PATH), before, 'manifest切替失敗でbundle copyが不整合になっている');
      });
    } finally {
      await rm(yoriRepository, { recursive: true, force: true });
    }
  });

  it('package filesはcollector bundleとmanifestを含み、runtime dependenciesは0のまま', async () => {
    const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files: string[];
      dependencies?: Record<string, string>;
      bin: Record<string, string>;
    };
    assert.deepEqual(
      [...packageJson.files].sort(),
      ['dist/collector/collector-manifest.json', 'dist/collector/yori-collector.mjs', 'dist/yori.cjs', 'dist/yori.cjs.map'].sort(),
    );
    assert.equal(packageJson.dependencies, undefined, 'runtime dependencyが追加されている');
    assert.deepEqual(packageJson.bin, { yori: 'dist/yori.cjs' });
  });
});
