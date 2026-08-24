import type { WeshCommandContext, WeshFileHandle } from '@/features/wesh/types';
import { readAllFileBytes, readAllFileText, writeAllFileBytes } from "@/features/wesh/utils/fs";

export type GitFiles = WeshCommandContext["files"];

const textEncoder = new TextEncoder();

export async function pathExists({ files, path }: { files: GitFiles, path: string }): Promise<boolean> {
  try {
    await files.lstat({ path });
    return true;
  } catch {
    return false;
  }
}

export async function readFileBytes({ files, path }: { files: GitFiles, path: string }): Promise<Uint8Array> {
  return readAllFileBytes({ files, path });
}

export async function readFileText({ files, path }: { files: GitFiles, path: string }): Promise<string> {
  return readAllFileText({ files, path });
}


export async function readFileRange({ files, path, position, length }: {
  files: GitFiles,
  path: string,
  position: number,
  length: number,
}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error(`invalid file position: ${position}`);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error(`invalid file read length: ${length}`);
  const handle = await files.open({
    path,
    flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
  });
  try {
    const buffer = new Uint8Array(length);
    let totalRead = 0;
    while (totalRead < length) {
      const { bytesRead } = await handle.read({
        buffer,
        offset: totalRead,
        length: length - totalRead,
        position: position + totalRead,
      });
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return buffer.subarray(0, totalRead);
  } finally {
    await handle.close();
  }
}

export async function fileSize({ files, path }: { files: GitFiles, path: string }): Promise<number> {
  return (await files.stat({ path })).size;
}

export async function writeFileBytes({ files, path, bytes }: {
  files: GitFiles,
  path: string,
  bytes: Uint8Array,
}): Promise<void> {
  await writeAllFileBytes({ files, path, data: bytes });
}

export async function writeFileText({ files, path, text }: {
  files: GitFiles,
  path: string,
  text: string,
}): Promise<void> {
  await writeFileBytes({ files, path, bytes: textEncoder.encode(text) });
}


export async function writeHandleBytes({ handle, bytes }: {
  handle: WeshFileHandle,
  bytes: Uint8Array,
}): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write({
      buffer: bytes,
      offset,
      length: bytes.byteLength - offset,
    });
    if (bytesWritten === 0) throw new Error('short write to output');
    offset += bytesWritten;
  }
}

export async function replaceFileViaLock({ files, path, bytes }: {
  files: GitFiles,
  path: string,
  bytes: Uint8Array,
}): Promise<void> {
  const lockPath = `${path}.lock`;
  let lockExists = false;
  let handle: WeshFileHandle | undefined;
  try {
    handle = await files.open({
      path: lockPath,
      flags: { access: 'write', creation: 'always', truncate: 'preserve', append: 'preserve' },
    });
    lockExists = true;
    await writeHandleBytes({ handle, bytes });
    await handle.close();
    handle = undefined;
    await files.rename({ oldPath: lockPath, newPath: path });
    lockExists = false;
  } finally {
    if (handle !== undefined) await handle.close();
    if (lockExists && await pathExists({ files, path: lockPath })) {
      await files.unlink({ path: lockPath });
    }
  }
}

export async function replaceTextViaLock({ files, path, text }: {
  files: GitFiles,
  path: string,
  text: string,
}): Promise<void> {
  await replaceFileViaLock({ files, path, bytes: textEncoder.encode(text) });
}

export const TEST_ONLY = {
};
