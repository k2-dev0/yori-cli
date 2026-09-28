import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

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
