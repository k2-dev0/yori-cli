#!/usr/bin/env node
// yori本体（YORI_REPOSITORY、既定../yori）の配布用collector artifactをversion・Git SHA・SHA-256検証して
// yori-cliのdist/collectorへcopyする。2 fileはstagingから切り替え、片方失敗時は元へ戻す。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const SOURCE_DIR = path.join(path.resolve(REPO_ROOT, process.env.YORI_REPOSITORY ?? '../yori'), 'dist', 'collector');
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'collector');
const BUNDLE_NAME = 'yori-collector.mjs';
const MANIFEST_NAME = 'collector-manifest.json';
const BUNDLE_PATH = path.join(OUT_DIR, BUNDLE_NAME);
const MANIFEST_PATH = path.join(OUT_DIR, MANIFEST_NAME);

function fail(message) {
  console.error(`collector copy: ${message}`);
  process.exit(1);
}

// 既存copyをbytesで退避し、switch途中の失敗時に元へ戻す。
function snapshot(target) {
  return existsSync(target) ? readFileSync(target) : null;
}

function restore(target, bytes) {
  if (bytes === null) {
    rmSync(target, { force: true });
    return;
  }
  const temp = `${target}.restore-${process.pid}`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
}

const bundlePath = path.join(SOURCE_DIR, BUNDLE_NAME);
const manifestPath = path.join(SOURCE_DIR, MANIFEST_NAME);
if (!existsSync(bundlePath) || !existsSync(manifestPath)) {
  fail(`artifactが見つかりません: ${SOURCE_DIR}`);
}
const bundle = readFileSync(bundlePath);
const manifestText = readFileSync(manifestPath, 'utf8');
let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch {
  fail('manifestをparseできません');
}
if (
  typeof manifest !== 'object' ||
  manifest === null ||
  manifest.file !== BUNDLE_NAME ||
  typeof manifest.version !== 'string' ||
  manifest.version !== CLI_VERSION ||
  typeof manifest.git_sha !== 'string' ||
  !/^[0-9a-f]{40}$/.test(manifest.git_sha) ||
  typeof manifest.checksum !== 'string'
) {
  fail('manifestのversion/file/checksumが不正です');
}
const checksum = createHash('sha256').update(bundle).digest('hex');
if (checksum !== manifest.checksum.toLowerCase()) {
  fail('manifest.checksumがartifact内容と一致しません');
}

// 検証後だけstagingへ書き、bundle→manifestの順でrenameする。
mkdirSync(OUT_DIR, { recursive: true });
const stagingDir = path.join(OUT_DIR, `.staging-${process.pid}`);
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
const previousBundle = snapshot(BUNDLE_PATH);
const previousManifest = snapshot(MANIFEST_PATH);
try {
  const stagedBundle = path.join(stagingDir, BUNDLE_NAME);
  const stagedManifest = path.join(stagingDir, MANIFEST_NAME);
  writeFileSync(stagedBundle, bundle);
  writeFileSync(stagedManifest, manifestText);
  let bundleSwitched = false;
  try {
    renameSync(stagedBundle, BUNDLE_PATH);
    bundleSwitched = true;
    renameSync(stagedManifest, MANIFEST_PATH);
  } catch (error) {
    if (bundleSwitched) {
      restore(BUNDLE_PATH, previousBundle);
      restore(MANIFEST_PATH, previousManifest);
    }
    throw error;
  }
  console.log(`collector artifact: dist/collector/${BUNDLE_NAME} v${manifest.version}`);
} catch (error) {
  fail(error instanceof Error ? error.message : 'copyに失敗しました');
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
