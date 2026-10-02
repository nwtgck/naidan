import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileStat,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import {
  compareTransitionNamespaceEntryNameBytes,
  validateTransitionNamespaceEntryName,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-contracts';
import type {
  TransitionNamespaceEntry,
  TransitionNamespaceMetadata,
  TransitionNamespacePath,
  TransitionNamespaceSourcePort,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';

function requireSafeInteger({ label, value }: { label: string; value: number }): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
  return value;
}

function metadata({ stat }: { stat: StorageFileStat }): TransitionNamespaceMetadata {
  return {
    createdAt: stat.createdAt === undefined
      ? undefined
      : BigInt(requireSafeInteger({ label: 'created timestamp', value: stat.createdAt })),
    modifiedAt: stat.modifiedAt === undefined
      ? undefined
      : BigInt(requireSafeInteger({ label: 'modified timestamp', value: stat.modifiedAt })),
  };
}

async function resolveDirectory({ root, path }: {
  root: StorageDirectoryHandle;
  path: TransitionNamespacePath;
}): Promise<StorageDirectoryHandle> {
  let directory = root;
  for (const name of path) {
    validateTransitionNamespaceEntryName({ name });
    const entry = await directory.getEntryHandle({ name });
    switch (entry.kind) {
    case 'directory': directory = entry; break;
    case 'file':
    case 'symlink': throw new TypeError('transition source path component is not a directory');
    default: entry satisfies never;
    }
  }
  return directory;
}

async function resolveEntry({ root, path }: {
  root: StorageDirectoryHandle;
  path: TransitionNamespacePath;
}): Promise<StorageEntryHandle> {
  const name = path.at(-1);
  if (name === undefined) throw new TypeError('transition source entry path must not be empty');
  const parent = await resolveDirectory({ root, path: path.slice(0, -1) });
  validateTransitionNamespaceEntryName({ name });
  return await parent.getEntryHandle({ name });
}

type DirectoryCandidate = Readonly<{
  handle: StorageEntryHandle;
  name: string;
  nameBytes: Uint8Array;
}>;

function insertBounded({ candidate, candidates, maximumCandidates }: {
  candidate: DirectoryCandidate;
  candidates: DirectoryCandidate[];
  maximumCandidates: number;
}): void {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const current = candidates[middle];
    if (current === undefined) throw new Error('bounded transition candidate index is invalid');
    if (compareTransitionNamespaceEntryNameBytes({ left: current.nameBytes, right: candidate.nameBytes }) < 0) low = middle + 1;
    else high = middle;
  }
  const current = candidates[low];
  if (current !== undefined && compareTransitionNamespaceEntryNameBytes({ left: current.nameBytes, right: candidate.nameBytes }) === 0) {
    throw new TypeError('transition source directory contains duplicate entry names');
  }
  candidates.splice(low, 0, candidate);
  if (candidates.length > maximumCandidates) candidates.pop();
}

async function projectEntry({ handle, name }: { handle: StorageEntryHandle; name: string }): Promise<TransitionNamespaceEntry> {
  const stat = await handle.stat();
  const projectedMetadata = metadata({ stat });
  switch (handle.kind) {
  case 'directory': return { kind: 'directory', metadata: projectedMetadata, name };
  case 'file': {
    const size = requireSafeInteger({ label: 'file size', value: stat.size });
    if (size < 0) throw new RangeError('file size must not be negative');
    return { kind: 'file', metadata: projectedMetadata, name, size: BigInt(size) };
  }
  case 'symlink': return { kind: 'symlink', metadata: projectedMetadata, name };
  default: return handle satisfies never;
  }
}

async function readFileChunk({ file, maximumBytes, offset }: {
  file: StorageFileHandle;
  maximumBytes: number;
  offset: bigint;
}): Promise<Readonly<{ bytes: Uint8Array; state: 'complete' | 'more' }>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('transition source maximum bytes must be a positive safe integer');
  }
  if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('transition source file offset is outside the safe integer range');
  }
  const stat = await file.stat();
  const size = requireSafeInteger({ label: 'file size', value: stat.size });
  const position = Number(offset);
  if (position >= size) return { bytes: new Uint8Array(0), state: 'complete' };
  const length = Math.min(maximumBytes, size - position);
  const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
  let result: Readonly<{ bytes: Uint8Array; state: 'complete' | 'more' }> | undefined;
  let primaryFailure: { cause: unknown } | undefined;
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await readable.read({
      buffer,
      length,
      offset: 0,
      position,
      signal: undefined,
    });
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > length) {
      throw new TypeError('transition source returned an invalid file read length');
    }
    const nextPosition = position + bytesRead;
    result = { bytes: buffer.slice(0, bytesRead), state: nextPosition === size ? 'complete' : 'more' };
  } catch (cause: unknown) {
    primaryFailure = { cause };
  }
  let closeFailure: { cause: unknown } | undefined;
  try {
    await readable.close();
  } catch (cause: unknown) {
    closeFailure = { cause };
  }
  if (primaryFailure !== undefined) throw primaryFailure.cause;
  if (closeFailure !== undefined) throw closeFailure.cause;
  if (result === undefined) throw new Error('transition source file read produced no result');
  return result;
}

/**
 * Projects an ordinary storage session into the bounded transition source
 * contract. Genuine ordered pages are forwarded; the unordered fallback keeps
 * at most one page plus a look-ahead entry while scanning the directory.
 */
export function createStorageFileSystemTransitionSource({ session }: {
  session: StorageFileSystemSession;
}): TransitionNamespaceSourcePort {
  return {
    readRootMetadata: async () => metadata({ stat: await session.root.stat() }),
    listDirectory: async ({ afterName, maximumEntries, path }) => {
      if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
        throw new TypeError('transition source maximum entries must be a positive safe integer');
      }
      const afterNameBytes = afterName === undefined ? undefined : validateTransitionNamespaceEntryName({ name: afterName });
      const directory = await resolveDirectory({ root: session.root, path });
      if (directory.listEntriesPage !== undefined) {
        const { entries: pageEntries, truncated, ...unhandled } = await directory.listEntriesPage({ afterName, maximumEntries });
        unhandled satisfies Record<PropertyKey, never>;
        if (typeof truncated !== 'boolean' || pageEntries.length > maximumEntries || (truncated && pageEntries.length === 0)) {
          throw new TypeError('transition source returned an invalid bounded directory page');
        }
        let previous = afterNameBytes;
        for (const [name, handle] of pageEntries) {
          if (name !== handle.name) throw new TypeError('transition source entry name disagrees with its handle');
          const bytes = validateTransitionNamespaceEntryName({ name });
          if (previous !== undefined && compareTransitionNamespaceEntryNameBytes({ left: previous, right: bytes }) >= 0) {
            throw new TypeError('transition source page must advance in canonical filename order');
          }
          previous = bytes;
        }
        const entries = await Promise.all(pageEntries.map(async ([name, handle]) => await projectEntry({ handle, name })));
        return { entries, state: truncated ? 'more' : 'complete' };
      }
      const candidates: DirectoryCandidate[] = [];
      for await (const [name, handle] of directory.entries()) {
        if (name !== handle.name) throw new TypeError('transition source entry name disagrees with its handle');
        const nameBytes = validateTransitionNamespaceEntryName({ name });
        if (afterNameBytes !== undefined && compareTransitionNamespaceEntryNameBytes({ left: nameBytes, right: afterNameBytes }) <= 0) continue;
        insertBounded({ candidate: { handle, name, nameBytes }, candidates, maximumCandidates: maximumEntries + 1 });
      }
      const hasMore = candidates.length > maximumEntries;
      const entries = await Promise.all(candidates.slice(0, maximumEntries).map(async ({ handle, name }) => await projectEntry({ handle, name })));
      return { entries, state: hasMore ? 'more' : 'complete' };
    },
    readFileChunk: async ({ maximumBytes, offset, path }) => {
      const entry = await resolveEntry({ root: session.root, path });
      switch (entry.kind) {
      case 'file': return await readFileChunk({ file: entry, maximumBytes, offset });
      case 'directory':
      case 'symlink': throw new TypeError('transition source file path does not resolve to a file');
      default: return entry satisfies never;
      }
    },
    readSymlink: async ({ path }) => {
      const entry = await resolveEntry({ root: session.root, path });
      switch (entry.kind) {
      case 'symlink': return await entry.readTarget();
      case 'directory':
      case 'file': throw new TypeError('transition source symlink path does not resolve to a symlink');
      default: return entry satisfies never;
      }
    },
  };
}

export const TEST_ONLY = {
  insertBounded,
  metadata,
};
