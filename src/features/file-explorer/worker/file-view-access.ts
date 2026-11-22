import { createSha256Hasher } from '@/utils/sha256';
import { isFileSystemEntryLookupMiss } from '@/utils/file-system-stream';
import type { FileExplorerFileViewProgress } from './types';

export interface FileEditFingerprint {
  size: number,
  digest: string,
}

export interface FileEditStamp extends FileEditFingerprint {
  lastModified: number,
}

const fileViewLocks = new Map<string, Promise<void>>();
const pendingSharedFileOperations = new Set<Promise<void>>();
let pendingDirectoryTransfer = Promise.resolve();

function getFileViewLockName({ name }: { name: string }): string {
  // Handles to the same native file may have different Explorer paths. The
  // platform does not expose a stable ID across Workers, so conservatively
  // serialize the normalized file name even across separate directories.
  return `naidan:file-explorer:save:${name.normalize().toLowerCase()}`;
}

export function withFileViewLock<TResult>({ name, signal, run }: {
  name: string,
  signal: AbortSignal,
  run: () => Promise<TResult>,
}): Promise<TResult> {
  return withFileViewLockName({ lockName: getFileViewLockName({ name }), signal, run });
}

export function withFileViewLocks<TResult>({ names, mode, signal, run }: {
  names: readonly string[],
  mode: LockMode,
  signal: AbortSignal,
  run: () => Promise<TResult>,
}): Promise<TResult> {
  const ordered = [...new Set(names.map(name => getFileViewLockName({ name })))].sort();
  // A consistent order prevents deadlock when two operations share names.
  function acquire({ index }: { index: number }): Promise<TResult> {
    const lockName = ordered[index];
    return lockName === undefined ? run() : withFileViewLockName({ lockName, signal, run: () => acquire({ index: index + 1 }) });
  }
  // Acquire the directory gate before every name lock. A directory operation
  // can delete descendants whose names it cannot know until copying them.
  return withDirectoryTransferLock({ mode, signal, run: () => acquire({ index: 0 }) });
}

async function withDirectoryTransferLock<TResult>({ mode, signal, run }: {
  mode: LockMode,
  signal: AbortSignal,
  run: () => Promise<TResult>,
}): Promise<TResult> {
  signal.throwIfAborted();
  const locks = globalThis.navigator?.locks;
  if (locks?.request) {
    return locks.request('naidan:file-explorer:directory-transfer', { mode, signal }, run);
  }

  const released = Promise.withResolvers<void>();
  const previous = (() => {
    switch (mode) {
    case 'shared':
      pendingSharedFileOperations.add(released.promise);
      return pendingDirectoryTransfer;
    case 'exclusive': {
      const before = Promise.all([pendingDirectoryTransfer, ...pendingSharedFileOperations]);
      pendingDirectoryTransfer = before.then(() => released.promise);
      return before;
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(String(exhaustive));
    }
    }
  })();
  try {
    await waitForFileViewLock({ previous, signal });
    return await run();
  } finally {
    pendingSharedFileOperations.delete(released.promise);
    released.resolve();
  }
}

async function withFileViewLockName<TResult>({ lockName, signal, run }: {
  lockName: string,
  signal: AbortSignal,
  run: () => Promise<TResult>,
}): Promise<TResult> {
  signal.throwIfAborted();
  const locks = globalThis.navigator?.locks;
  if (locks?.request) {
    return locks.request(lockName, { mode: 'exclusive', signal }, run);
  }

  const previous = fileViewLocks.get(lockName) ?? Promise.resolve();
  const released = Promise.withResolvers<void>();
  const tail = previous.then(() => released.promise);
  fileViewLocks.set(lockName, tail);
  try {
    await waitForFileViewLock({ previous, signal });
    return await run();
  } finally {
    released.resolve();
    void tail.then(() => {
      if (fileViewLocks.get(lockName) === tail) {
        fileViewLocks.delete(lockName);
      }
    });
  }
}

async function waitForFileViewLock({ previous, signal }: { previous: Promise<unknown>, signal: AbortSignal }): Promise<void> {
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([previous, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  signal.throwIfAborted();
}

function fileEditSampleRanges({ size }: { size: number }): { start: number, end: number }[] {
  // Fingerprint small documents in full. For large files, the file stamp and
  // two bounded windows detect changes without reading the model weights.
  const sampleBytes = 64 * 1024;
  return size <= 2 * 1024 * 1024
    ? [{ start: 0, end: size }]
    : [{ start: 0, end: sampleBytes }, { start: size - sampleBytes, end: size }];
}

export async function readFileEditStamp({ file, signal }: {
  file: File,
  signal: AbortSignal,
}): Promise<FileEditStamp> {
  const hasher = createSha256Hasher();
  for (const { start, end } of fileEditSampleRanges({ size: file.size })) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    if (bytes.byteLength !== end - start) {
      throw new Error('The file changed while checking its edit revision');
    }
    hasher.update({ bytes });
  }
  signal.throwIfAborted();
  return { size: file.size, lastModified: file.lastModified, digest: hasher.digestHex() };
}

export function matchesFileEditStamp({ current, expected }: {
  current: FileEditStamp,
  expected: FileEditStamp,
}): boolean {
  return current.size === expected.size
    && current.lastModified === expected.lastModified
    && current.digest === expected.digest;
}

export async function readBoundedFileStream({ stream, maxBytes, signal }: {
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
}): Promise<{ blob: Blob, partial: boolean }> {
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const parts: BlobPart[] = [];
  let remaining = maxBytes;
  let complete = false;

  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        complete = true;
        return { blob: new Blob(parts), partial: false };
      }
      if (chunk.value.byteLength === 0) {
        continue;
      }
      const length = Math.min(remaining, chunk.value.byteLength);
      if (length > 0) {
        parts.push(Uint8Array.from(chunk.value.subarray(0, length)).buffer);
        remaining -= length;
      }
      if (length < chunk.value.byteLength) {
        return { blob: new Blob(parts), partial: true };
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!complete) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export async function findExistingFileHandle({ directory, name }: {
  directory: FileSystemDirectoryHandle,
  name: string,
}): Promise<FileSystemFileHandle | undefined> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (!isFileSystemEntryLookupMiss({ error })) {
      throw error;
    }
    return undefined;
  }
}

export async function writeFileViewBlob({ blob, handle, signal, beforeCommit, onProgress }: {
  blob: Blob,
  handle: FileSystemFileHandle,
  signal: AbortSignal,
  beforeCommit: () => Promise<void>,
  onProgress: ({ writtenBytes, totalBytes }: { writtenBytes: number, totalBytes: number }) => void,
}): Promise<FileEditFingerprint> {
  signal.throwIfAborted();
  const writable = await handle.createWritable();
  const chunkBytes = 1024 * 1024;
  // Coalesce progress for huge files so it remains useful without flooding RPC.
  const progressBytes = 8 * chunkBytes;
  const samples = fileEditSampleRanges({ size: blob.size });
  const hasher = createSha256Hasher();
  let reportedBytes = 0;

  try {
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      signal.throwIfAborted();
      const writtenBytes = Math.min(offset + chunkBytes, blob.size);
      const bytes = new Uint8Array(await blob.slice(offset, writtenBytes).arrayBuffer());
      if (bytes.byteLength !== writtenBytes - offset) {
        throw new Error('The edited file changed during saving');
      }
      signal.throwIfAborted();
      await writable.write(bytes);
      for (const sample of samples) {
        const start = Math.max(offset, sample.start);
        const end = Math.min(writtenBytes, sample.end);
        if (start < end) {
          hasher.update({ bytes: bytes.subarray(start - offset, end - offset) });
        }
      }
      if (writtenBytes === blob.size || writtenBytes - reportedBytes >= progressBytes) {
        const progress: FileExplorerFileViewProgress = { writtenBytes, totalBytes: blob.size };
        onProgress(progress);
        reportedBytes = writtenBytes;
      }
    }
    signal.throwIfAborted();
    await beforeCommit();
    signal.throwIfAborted();
    const fingerprint = { size: blob.size, digest: hasher.digestHex() };
    await writable.close();
    return fingerprint;
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

export const TEST_ONLY = {
};
