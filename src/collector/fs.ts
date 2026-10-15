import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CollectorFailure } from './contract.js';

// エージェント設定fileを読み書きする実体のpathとstatを返す。未作成ならnull。
// symlinkは、辿った実体がhome配下に存在する通常fileの時だけ実体を返す。書き込みは実体へ行い、symlink自体は置き換えない。
// tmpdirのようにhome自体がsymlinkを含む場合も比べられるよう、homeもrealpathで比べる。
export async function resolveAgentConfigFile(filePath: string, home: string): Promise<{ path: string; stats: Stats } | null> {
  const link = await lstat(filePath).catch(() => null);
  if (link === null) {
    return null;
  }
  if (!link.isSymbolicLink()) {
    return { path: filePath, stats: link };
  }
  // 壊れたsymlinkはrealpathが失敗する。
  const target = await realpath(filePath).catch(() => null);
  const root = await realpath(home).catch(() => null);
  if (target === null || root === null) {
    throw new CollectorFailure('collector_hook_symlink_invalid');
  }
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CollectorFailure('collector_hook_symlink_invalid');
  }
  const stats = await stat(target).catch(() => null);
  if (stats === null || !stats.isFile()) {
    throw new CollectorFailure('collector_hook_symlink_invalid');
  }
  return { path: target, stats };
}

// tempへ書いてfsyncしてからrenameする。可能ならparent directoryもfsyncし、途中失敗で既存fileを壊さない。
export async function writeFileAtomic(target: string, content: string | Buffer, mode: number): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, 'w', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temp, mode);
    await rename(temp, target);
    await fsyncDirectory(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// directory fsyncはfilesystemが未対応の場合だけ無視する。file本体はrename済みのため成功を維持する。
async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r').catch(() => null);
  if (handle === null) {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // directory fsync非対応のfilesystemではrenameの永続化をOSへ任せる。
  } finally {
    await handle.close().catch(() => undefined);
  }
}
