import type { WeshCommandContext, WeshEntryRef, WeshFileHandle, WeshPreparedRename } from '@/features/wesh/types';
import { WeshRenameIncompleteError } from '@/features/wesh/types';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { readAllFileBytes, readAllFileText, readAllHandleBytes, writeAllFileBytes } from "@/features/wesh/utils/fs";

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

export async function readFileBytes({ files, path, entry }: { files: GitFiles } & (
  { path: string, entry?: never } | { path?: never, entry: WeshEntryRef<'file'> }
)): Promise<Uint8Array> {
  if (entry === undefined) {
    return readAllFileBytes({ files, path });
  }
  const handle = await files.openEntry({
    entry,
    flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
  });
  try {
    return await readAllHandleBytes({ handle });
  } finally {
    await handle.close();
  }
}

export async function readFileText({ files, path, entry }: { files: GitFiles } & (
  { path: string, entry?: never } | { path?: never, entry: WeshEntryRef<'file'> }
)): Promise<string> {
  if (entry === undefined) {
    return readAllFileText({ files, path });
  }
  const blob = await files.tryReadBlobEfficiently({ entry });
  switch (blob.kind) {
  case 'blob':
    return blob.blob.text();
  case 'fallback_required':
    break;
  default: {
    const _ex: never = blob;
    throw new Error(`Unhandled blob result: ${String(_ex)}`);
  }
  }
  return new TextDecoder().decode(await readFileBytes({ files, entry }));
}

export async function resolveOptionalEntry({ files, path }: { files: GitFiles, path: string }): Promise<WeshEntryRef | undefined> {
  try {
    return await files.resolveEntry({ path, finalSymlinkTreatment: 'no-follow', pinBacking: true });
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }
}


export async function readFileRange({ files, path, position, length }: {
  files: GitFiles,
  path: string,
  position: number,
  length: number,
}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error(`invalid file position: ${position}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`invalid file read length: ${length}`);
  }
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
      if (bytesRead === 0) {
        break;
      }
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
    if (bytesWritten === 0) {
      throw new Error('short write to output');
    }
    offset += bytesWritten;
  }
}

export type GitFilePublisher = ({ rename }: { rename: WeshPreparedRename }) => Promise<void>;

interface GitFileReplacement {
  bytes: Uint8Array,
  expectedDestination?: { entry: WeshEntryRef | undefined },
  publish?: GitFilePublisher,
}

export interface GitFileLock {
  replace: ({ replacement }: { replacement: GitFileReplacement }) => Promise<void>,
  verify: () => Promise<void>,
}

export async function withFileLock<T>({ files, path, operation }: {
  files: GitFiles,
  path: string,
  operation({ replace, verify }: { replace: GitFileLock['replace'], verify: GitFileLock['verify'] }): Promise<T>,
}): Promise<T> {
  const lockPath = `${path}.lock`;
  const lock = await files.createTemporaryFile({ path: lockPath });
  let handle: WeshFileHandle | undefined = lock.handle;
  let keepLock = false;
  let published = false;

  async function verify(): Promise<void> {
    const currentLock = await resolveOptionalEntry({ files, path: lockPath });
    if (currentLock === undefined || await files.compareEntryIdentity({ first: lock.entry, second: currentLock }) !== 'same') {
      throw new Error(`Source entry changed: ${lockPath}`);
    }
  }

  async function replace({ replacement }: { replacement: GitFileReplacement }): Promise<void> {
    const { bytes, expectedDestination, publish } = replacement;
    if (handle === undefined) {
      throw new Error(`Lock has already been written: ${lockPath}`);
    }
    await writeHandleBytes({ handle, bytes });
    await handle.close();
    handle = undefined;
    try {
      if (publish === undefined) {
        await files.rename({
          oldPath: lockPath,
          newPath: path,
          expectedSource: lock.entry,
          noReplace: (expectedDestination !== undefined && expectedDestination.entry === undefined) || undefined,
          expectedDestination: expectedDestination?.entry,
        });
      } else {
        if (expectedDestination === undefined) {
          throw new Error(`Missing publication destination: ${path}`);
        }
        await publish({ rename: { operation: 'rename', entry: lock.entry, path, expected: expectedDestination.entry } });
      }
      published = true;
    } catch (error: unknown) {
      keepLock = error instanceof WeshRenameIncompleteError;
      throw error;
    }
  }

  let result: T;
  try {
    result = await operation({ replace, verify });
  } catch (error: unknown) {
    await handle?.close().catch(() => {});
    if (!published && !keepLock) {
      await lock.discard().catch(() => {});
    }
    throw error;
  }
  try {
    await handle?.close();
  } finally {
    if (!published && !keepLock) {
      await lock.discard();
    }
  }
  return result;
}

export async function withFileLocks<T>({ files, paths, operation }: {
  files: GitFiles,
  paths: readonly string[],
  operation: ({ locks }: { locks: ReadonlyMap<string, GitFileLock> }) => Promise<T>,
}): Promise<T> {
  const locks = new Map<string, GitFileLock>();
  async function acquire({ index }: { index: number }): Promise<T> {
    const path = paths[index];
    if (path === undefined) {
      return operation({ locks });
    }
    return withFileLock({
      files,
      path,
      operation: ({ replace, verify }) => {
        locks.set(path, { replace, verify });
        return acquire({ index: index + 1 });
      },
    });
  }
  return acquire({ index: 0 });
}

export async function replaceFileViaLock({ files, path, prepareBytes }: {
  files: GitFiles,
  path: string,
  prepareBytes: () => GitFileReplacement | Promise<GitFileReplacement>,
}): Promise<void> {
  await withFileLock({
    files,
    path,
    operation: async ({ replace }) => replace({ replacement: await prepareBytes() }),
  });
}

export async function replaceTextViaLock({ files, path, text }: {
  files: GitFiles,
  path: string,
  text: string,
}): Promise<void> {
  await replaceFileViaLock({ files, path, prepareBytes: () => ({ bytes: textEncoder.encode(text) }) });
}

export const TEST_ONLY = {
};
