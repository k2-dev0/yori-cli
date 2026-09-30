import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { COLLECTOR_BUNDLE_FILE_NAME, COLLECTOR_MANIFEST_FILE_NAME, CollectorFailure } from './contract.js';

export interface CollectorArtifact {
  version: string;
  gitSha: string;
  checksum: string;
  // bundleは配置先へそのままcopyし、manifestも検証済み本文をそのまま置く。
  bundle: Buffer;
  manifest: Buffer;
}

// 標準は公開packageのbin隣接dist/collectorだけ。cwdやsource treeの探索はしない。
// source/test実行はYORI_COLLECTOR_ARTIFACT_DIRを明示する。
function defaultArtifactDir(): string {
  const entry = process.argv[1];
  let resolved = entry ?? process.execPath;
  try {
    resolved = realpathSync(resolved);
  } catch {
    // symlinkを解決できない場合はargv[1]のpath判定を続ける。
  }
  return path.join(path.dirname(resolved), 'collector');
}

// test/developmentの明示overrideだけを受ける。成果物へoverride pathを保存しない。
function artifactDir(env: NodeJS.ProcessEnv): string {
  const override = env.YORI_COLLECTOR_ARTIFACT_DIR;
  return override !== undefined && override.length > 0 ? override : defaultArtifactDir();
}

// artifact本文とmanifestのversion・Git SHA・checksumを検証する。不一致は配置前に拒否する。
export async function readCollectorArtifact(env: NodeJS.ProcessEnv): Promise<CollectorArtifact> {
  const dir = artifactDir(env);
  let bundle: Buffer;
  let manifestText: string;
  try {
    [bundle, manifestText] = await Promise.all([
      readFile(path.join(dir, COLLECTOR_BUNDLE_FILE_NAME)),
      readFile(path.join(dir, COLLECTOR_MANIFEST_FILE_NAME), 'utf8'),
    ]);
  } catch {
    throw new CollectorFailure('collector_artifact_invalid');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new CollectorFailure('collector_artifact_invalid');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new CollectorFailure('collector_artifact_invalid');
  }
  const candidate = manifest as { version?: unknown; file?: unknown; git_sha?: unknown; checksum?: unknown };
  if (
    typeof candidate.version !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(candidate.version) ||
    candidate.file !== COLLECTOR_BUNDLE_FILE_NAME ||
    typeof candidate.git_sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(candidate.git_sha) ||
    typeof candidate.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(candidate.checksum)
  ) {
    throw new CollectorFailure('collector_artifact_invalid');
  }
  const checksum = createHash('sha256').update(bundle).digest('hex');
  if (checksum !== candidate.checksum.toLowerCase()) {
    throw new CollectorFailure('collector_artifact_invalid');
  }
  return { version: candidate.version, gitSha: candidate.git_sha, checksum, bundle, manifest: Buffer.from(manifestText, 'utf8') };
}
