import { promiseAllKeyed } from '@/utils/promise';
import type { HizoFSBulkBuilder } from '@/00-storage/service/hizofs/file-system/bulk-builder';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
} from '@/00-storage/service/storage-file-system/types';
import { writeStorageReadableStream } from '@/00-storage/service/storage-file-system/io';

const STORAGE_DIRECTORY_NAME = 'naidan-storage';
const DURABLE_TOP_LEVEL_DIRECTORY_NAMES = [
  STORAGE_DIRECTORY_NAME,
  'naidan-chat-wesh',
  'naidan-debug-wesh',
] as const;
const TEMPORARY_DIRECTORY_NAME = 'naidan-tmp';
const STORAGE_CONTROL_ENTRY_NAMES = new Set([
  'encryption-state',
  'encrypted-stores',
]);

export type NaidanPersistenceNamespaceTotals = {
  readonly totalBytes: number;
  readonly totalEntries: number;
};

export type NaidanPersistenceNamespaceProgress = {
  readonly completedBytes: number;
  readonly totalBytes: number | undefined;
  readonly completedEntries: number;
  readonly totalEntries: number | undefined;
};

export type NaidanPersistenceNamespaceProgressListener = ({ progress }: {
  progress: NaidanPersistenceNamespaceProgress;
}) => void;

function createNamespaceProgressTracker({
  totals,
  onProgress,
}: {
  totals: NaidanPersistenceNamespaceTotals | undefined;
  onProgress: NaidanPersistenceNamespaceProgressListener | undefined;
}) {
  let completedBytes = 0;
  let completedEntries = 0;
  const report = () => onProgress?.({
    progress: {
      completedBytes,
      totalBytes: totals?.totalBytes,
      completedEntries,
      totalEntries: totals?.totalEntries,
    },
  });
  report();
  return {
    addBytes({ byteLength }: { byteLength: number }): void {
      completedBytes += byteLength;
      report();
    },
    addEntries({ count }: { count: number }): void {
      completedEntries += count;
      report();
    },
    getTotals(): NaidanPersistenceNamespaceTotals {
      return {
        totalBytes: completedBytes,
        totalEntries: completedEntries,
      };
    },
  };
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError'
        || error.message.startsWith('NotFoundError'));
}

async function getDirectoryIfPresent({
  parent,
  name,
}: {
  parent: StorageDirectoryHandle;
  name: string;
}): Promise<StorageDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle({ name, create: false });
  } catch (error) {
    if (isNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }
}

async function removeIfPresent({
  parent,
  name,
}: {
  parent: StorageDirectoryHandle;
  name: string;
}): Promise<void> {
  try {
    await parent.removeEntry({ name, recursive: true });
  } catch (error) {
    if (!isNotFoundError({ error })) {
      throw error;
    }
  }
}

async function clearDirectory({
  directory,
  preserveNames,
}: {
  directory: StorageDirectoryHandle;
  preserveNames: ReadonlySet<string>;
}): Promise<void> {
  const names: string[] = [];
  for await (const [name] of directory.entries()) {
    if (!preserveNames.has(name)) {
      names.push(name);
    }
  }
  for (const name of names) {
    await directory.removeEntry({ name, recursive: true });
  }
}

async function copyEntry({
  source,
  target,
  name,
  signal,
  onBytesCopied,
  onEntryCopied,
}: {
  source: StorageEntryHandle;
  target: StorageDirectoryHandle;
  name: string;
  signal: AbortSignal | undefined;
  onBytesCopied: ({ byteLength }: { byteLength: number }) => void;
  onEntryCopied: () => void;
}): Promise<void> {
  signal?.throwIfAborted();
  switch (source.kind) {
  case 'directory': {
    const targetDirectory = await target.getDirectoryHandle({ name, create: true });
    await copyDirectoryContents({
      source,
      target: targetDirectory,
      excludedNames: new Set(),
      signal,
      onBytesCopied,
      onEntryCopied,
    });
    break;
  }
  case 'file': {
    const stat = await source.stat();
    const readable = await source.openReadable({
      mimeType: 'application/octet-stream',
    });
    try {
      await writeStorageReadableStream({
        fileHandle: await target.getFileHandle({ name, create: true }),
        source: readable.stream({
          start: 0,
          end: undefined,
          signal,
        }),
        expectedSize: stat.size,
        signal,
        onBytesWritten: onBytesCopied,
      });
    } finally {
      await readable.close();
    }
    break;
  }
  case 'symlink':
    await target.createSymlink({
      name,
      target: await source.readTarget(),
    });
    break;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled persistence namespace entry: ${String(_ex)}`);
  }
  }
  onEntryCopied();
}

async function copyDirectoryContents({
  source,
  target,
  excludedNames,
  signal,
  onBytesCopied,
  onEntryCopied,
}: {
  source: StorageDirectoryHandle;
  target: StorageDirectoryHandle;
  excludedNames: ReadonlySet<string>;
  signal: AbortSignal | undefined;
  onBytesCopied: ({ byteLength }: { byteLength: number }) => void;
  onEntryCopied: () => void;
}): Promise<void> {
  for await (const [name, entry] of source.entries()) {
    if (excludedNames.has(name)) {
      continue;
    }
    await copyEntry({
      source: entry,
      target,
      name,
      signal,
      onBytesCopied,
      onEntryCopied,
    });
  }
}

export async function clearNaidanPersistenceNamespace({
  targetRoot,
}: {
  targetRoot: StorageDirectoryHandle;
}): Promise<void> {
  const storageDirectory = await getDirectoryIfPresent({
    parent: targetRoot,
    name: STORAGE_DIRECTORY_NAME,
  });
  if (storageDirectory !== undefined) {
    await clearDirectory({
      directory: storageDirectory,
      preserveNames: STORAGE_CONTROL_ENTRY_NAMES,
    });
  }
  for (const name of DURABLE_TOP_LEVEL_DIRECTORY_NAMES.slice(1)) {
    await removeIfPresent({ parent: targetRoot, name });
  }
  await removeIfPresent({ parent: targetRoot, name: TEMPORARY_DIRECTORY_NAME });
}

export async function prepareNaidanPersistenceNamespaceTarget({
  targetRoot,
}: {
  targetRoot: StorageDirectoryHandle;
}): Promise<void> {
  await clearNaidanPersistenceNamespace({ targetRoot });
  await targetRoot.getDirectoryHandle({
    name: STORAGE_DIRECTORY_NAME,
    create: true,
  });
  await targetRoot.getDirectoryHandle({
    name: TEMPORARY_DIRECTORY_NAME,
    create: true,
  });
}

export async function copyNaidanPersistenceNamespace({
  sourceRoot,
  targetRoot,
  targetBuilder,
  signal,
  onProgress,
}: {
  sourceRoot: StorageDirectoryHandle;
  targetRoot: StorageDirectoryHandle;
  targetBuilder: HizoFSBulkBuilder | undefined;
  signal: AbortSignal | undefined;
  onProgress?: NaidanPersistenceNamespaceProgressListener;
}): Promise<NaidanPersistenceNamespaceTotals> {
  const tracker = createNamespaceProgressTracker({ totals: undefined, onProgress });
  if (targetBuilder !== undefined) {
    try {
      await targetBuilder.importRootMetadata({ source: sourceRoot });
      for (const name of DURABLE_TOP_LEVEL_DIRECTORY_NAMES) {
        signal?.throwIfAborted();
        const sourceDirectory = await getDirectoryIfPresent({
          parent: sourceRoot,
          name,
        });
        if (sourceDirectory === undefined) {
          if (name === STORAGE_DIRECTORY_NAME) {
            await targetBuilder.createEmptyDirectory({ name });
          }
          continue;
        }
        await targetBuilder.importDirectory({
          source: sourceDirectory,
          name,
          excludedNames: name === STORAGE_DIRECTORY_NAME
            ? STORAGE_CONTROL_ENTRY_NAMES
            : new Set(),
          signal,
          onProgress: ({ byteLength, completedEntries }) => {
            if (byteLength > 0) tracker.addBytes({ byteLength });
            if (completedEntries > 0) tracker.addEntries({ count: completedEntries });
          },
        });
      }
      await targetBuilder.createEmptyDirectory({
        name: TEMPORARY_DIRECTORY_NAME,
      });
      await targetBuilder.commit();
      return tracker.getTotals();
    } catch (error) {
      try {
        await targetBuilder.abort({ reason: error });
      } catch (abortError) {
        throw new AggregateError(
          [error, abortError],
          'Failed to abort HizoFS bulk namespace construction',
        );
      }
      throw error;
    }
  }

  await prepareNaidanPersistenceNamespaceTarget({ targetRoot });
  for (const name of DURABLE_TOP_LEVEL_DIRECTORY_NAMES) {
    signal?.throwIfAborted();
    const sourceDirectory = await getDirectoryIfPresent({
      parent: sourceRoot,
      name,
    });
    if (sourceDirectory === undefined) {
      continue;
    }
    const targetDirectory = await targetRoot.getDirectoryHandle({
      name,
      create: true,
    });
    await copyDirectoryContents({
      source: sourceDirectory,
      target: targetDirectory,
      excludedNames: name === STORAGE_DIRECTORY_NAME
        ? STORAGE_CONTROL_ENTRY_NAMES
        : new Set(),
      signal,
      onBytesCopied: ({ byteLength }) => tracker.addBytes({ byteLength }),
      onEntryCopied: () => tracker.addEntries({ count: 1 }),
    });
    tracker.addEntries({ count: 1 });
  }
  return tracker.getTotals();
}

const FILE_VERIFICATION_BUFFER_BYTE_LENGTH = 256 * 1024;

async function assertFileContentsEqual({
  source,
  target,
  path,
  signal,
  onBytesVerified,
}: {
  source: Extract<StorageEntryHandle, { kind: 'file' }>;
  target: Extract<StorageEntryHandle, { kind: 'file' }>;
  path: string;
  signal: AbortSignal | undefined;
  onBytesVerified: ({ byteLength }: { byteLength: number }) => void;
}): Promise<void> {
  const sourceStat = await source.stat();
  const targetStat = await target.stat();
  if (sourceStat.size !== targetStat.size) {
    throw new Error(`Transferred file size does not match at ${path}`);
  }

  const sourceReadable = await source.openReadable({
    mimeType: 'application/octet-stream',
  });
  const targetReadable = await target.openReadable({
    mimeType: 'application/octet-stream',
  });
  const sourceBuffer = new Uint8Array(FILE_VERIFICATION_BUFFER_BYTE_LENGTH);
  const targetBuffer = new Uint8Array(FILE_VERIFICATION_BUFFER_BYTE_LENGTH);
  try {
    let position = 0;
    while (position < sourceStat.size) {
      signal?.throwIfAborted();
      const length = Math.min(
        FILE_VERIFICATION_BUFFER_BYTE_LENGTH,
        sourceStat.size - position,
      );
      const { sourceResult, targetResult } = await promiseAllKeyed({
        sourceResult: sourceReadable.read({
          buffer: sourceBuffer,
          offset: 0,
          length,
          position,
          signal,
        }),
        targetResult: targetReadable.read({
          buffer: targetBuffer,
          offset: 0,
          length,
          position,
          signal,
        }),
      });
      if (
        sourceResult.bytesRead !== length
        || targetResult.bytesRead !== length
      ) {
        throw new Error(`Transferred file ended unexpectedly at ${path}`);
      }
      for (let index = 0; index < length; index += 1) {
        if (sourceBuffer[index] !== targetBuffer[index]) {
          throw new Error(`Transferred file contents do not match at ${path}`);
        }
      }
      position += length;
      onBytesVerified({ byteLength: length });
    }
  } finally {
    await Promise.all([
      sourceReadable.close(),
      targetReadable.close(),
    ]);
  }
}

async function assertDirectoryContentsEqual({
  source,
  target,
  excludedNames,
  path,
  signal,
  onBytesVerified,
  onEntryVerified,
}: {
  source: StorageDirectoryHandle;
  target: StorageDirectoryHandle;
  excludedNames: ReadonlySet<string>;
  path: string;
  signal: AbortSignal | undefined;
  onBytesVerified: ({ byteLength }: { byteLength: number }) => void;
  onEntryVerified: () => void;
}): Promise<void> {
  const sourceEntries = new Map<string, StorageEntryHandle>();
  const targetEntries = new Map<string, StorageEntryHandle>();
  for await (const [name, entry] of source.entries()) {
    if (!excludedNames.has(name)) {
      sourceEntries.set(name, entry);
    }
  }
  for await (const [name, entry] of target.entries()) {
    if (!excludedNames.has(name)) {
      targetEntries.set(name, entry);
    }
  }
  const sourceNames = [...sourceEntries.keys()].sort();
  const targetNames = [...targetEntries.keys()].sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) {
    throw new Error(`Transferred directory entries do not match at ${path}`);
  }

  for (const name of sourceNames) {
    const sourceEntry = sourceEntries.get(name)!;
    const targetEntry = targetEntries.get(name)!;
    const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
    switch (sourceEntry.kind) {
    case 'directory':
      switch (targetEntry.kind) {
      case 'directory':
        await assertDirectoryContentsEqual({
          source: sourceEntry,
          target: targetEntry,
          excludedNames: new Set(),
          path: childPath,
          signal,
          onBytesVerified,
          onEntryVerified,
        });
        break;
      case 'file':
      case 'symlink':
        throw new Error(`Transferred entry kind does not match at ${childPath}`);
      default: {
        const _ex: never = targetEntry;
        throw new Error(`Unhandled target entry: ${String(_ex)}`);
      }
      }
      break;
    case 'file':
      switch (targetEntry.kind) {
      case 'file':
        await assertFileContentsEqual({
          source: sourceEntry,
          target: targetEntry,
          path: childPath,
          signal,
          onBytesVerified,
        });
        break;
      case 'directory':
      case 'symlink':
        throw new Error(`Transferred entry kind does not match at ${childPath}`);
      default: {
        const _ex: never = targetEntry;
        throw new Error(`Unhandled target entry: ${String(_ex)}`);
      }
      }
      break;
    case 'symlink':
      switch (targetEntry.kind) {
      case 'symlink':
        if (await sourceEntry.readTarget() !== await targetEntry.readTarget()) {
          throw new Error(`Transferred symbolic link does not match at ${childPath}`);
        }
        break;
      case 'directory':
      case 'file':
        throw new Error(`Transferred entry kind does not match at ${childPath}`);
      default: {
        const _ex: never = targetEntry;
        throw new Error(`Unhandled target entry: ${String(_ex)}`);
      }
      }
      break;
    default: {
      const _ex: never = sourceEntry;
      throw new Error(`Unhandled source entry: ${String(_ex)}`);
    }
    }
    onEntryVerified();
  }
}

export async function verifyNaidanPersistenceNamespaceCopy({
  sourceRoot,
  targetRoot,
  signal,
  totals,
  onProgress,
}: {
  sourceRoot: StorageDirectoryHandle;
  targetRoot: StorageDirectoryHandle;
  signal: AbortSignal | undefined;
  totals?: NaidanPersistenceNamespaceTotals;
  onProgress?: NaidanPersistenceNamespaceProgressListener;
}): Promise<void> {
  const tracker = createNamespaceProgressTracker({ totals, onProgress });
  for (const name of DURABLE_TOP_LEVEL_DIRECTORY_NAMES) {
    const source = await getDirectoryIfPresent({ parent: sourceRoot, name });
    const target = await getDirectoryIfPresent({ parent: targetRoot, name });
    if (source === undefined) {
      if (target !== undefined && name !== STORAGE_DIRECTORY_NAME) {
        throw new Error(`Transferred namespace contains unexpected directory: /${name}`);
      }
      continue;
    }
    if (target === undefined) {
      throw new Error(`Transferred namespace is missing directory: /${name}`);
    }
    await assertDirectoryContentsEqual({
      source,
      target,
      excludedNames: name === STORAGE_DIRECTORY_NAME
        ? STORAGE_CONTROL_ENTRY_NAMES
        : new Set(),
      path: `/${name}`,
      signal,
      onBytesVerified: ({ byteLength }) => tracker.addBytes({ byteLength }),
      onEntryVerified: () => tracker.addEntries({ count: 1 }),
    });
    tracker.addEntries({ count: 1 });
  }

  const temporary = await getDirectoryIfPresent({
    parent: targetRoot,
    name: TEMPORARY_DIRECTORY_NAME,
  });
  if (temporary === undefined) {
    throw new Error('Transferred namespace is missing its temporary directory');
  }
  for await (const [name] of temporary.entries()) {
    throw new Error(`Transferred temporary directory is not empty: ${name}`);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DURABLE_TOP_LEVEL_DIRECTORY_NAMES,
  STORAGE_CONTROL_ENTRY_NAMES,
  TEMPORARY_DIRECTORY_NAME,
};
