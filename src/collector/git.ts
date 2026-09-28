import { execFileSync } from 'node:child_process';
import { normalizeRepositoryIdentifier } from '../admin/repository.js';
import { DEFAULT_GIT_BIN, CollectorFailure } from './contract.js';

// test/development overrideは絶対pathの明示指定だけを受ける。
export function collectorGitBin(env: NodeJS.ProcessEnv): string {
  const override = env.YORI_GIT_BIN;
  return override !== undefined && override.length > 0 ? override : DEFAULT_GIT_BIN;
}

// hook cwdのoriginをcanonical host/pathへ正規化する。directory名からは推定しない。
export function resolveRepositoryFromCwd(env: NodeJS.ProcessEnv, cwd: string): string {
  const bin = collectorGitBin(env);
  try {
    const toplevel = execFileSync(bin, ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (toplevel.length === 0) {
      throw new Error('empty toplevel');
    }
    const remote = execFileSync(bin, ['-C', toplevel, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const canonical = normalizeRepositoryIdentifier(remote);
    if (canonical === null) {
      throw new Error('invalid remote');
    }
    return canonical;
  } catch {
    throw new CollectorFailure('collector_repository_not_found');
  }
}
