import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  parseNaidanContainerToken,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/naidan-opfs/opfs-storage-location';

export function isCanonicalHizoFSContainerName({ name }: { name: string }): boolean {
  try {
    parseNaidanContainerToken({ value: name });
    return true;
  } catch (cause: unknown) {
    if (cause instanceof TypeError) return false;
    throw cause;
  }
}

export function includeNativePlainApplicationStorageEntry({ name }: { name: string }): boolean {
  return name !== NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName
    && !isCanonicalHizoFSContainerName({ name });
}

function unsupportedMutation(): never {
  throw new TypeError('native plain application projection is read-only');
}

function projectDirectory({ directory, filterDirectChild }: {
  directory: StorageDirectoryHandle;
  filterDirectChild: ({ name }: { name: string }) => boolean;
}): StorageDirectoryHandle {
  const projectEntry = ({ entry }: { entry: StorageEntryHandle }): StorageEntryHandle => {
    switch (entry.kind) {
    case 'directory': return projectDirectory({ directory: entry, filterDirectChild: () => true });
    case 'file':
    case 'symlink': return entry;
    default: return entry satisfies never;
    }
  };
  const requireIncluded = ({ name }: { name: string }): void => {
    if (!filterDirectChild({ name })) throw new DOMException('excluded transition entry', 'NotFoundError');
  };
  return {
    cloneFile: async () => unsupportedMutation(),
    createSymlink: async () => unsupportedMutation(),
    entries: async function* () {
      for await (const [name, entry] of directory.entries()) {
        if (!filterDirectChild({ name })) continue;
        yield [name, projectEntry({ entry })] as const;
      }
    },
    getDirectoryHandle: async ({ create, name }) => {
      if (create) unsupportedMutation();
      requireIncluded({ name });
      return projectDirectory({
        directory: await directory.getDirectoryHandle({ create: false, name }),
        filterDirectChild: () => true,
      });
    },
    getEntryHandle: async ({ name }) => {
      requireIncluded({ name });
      return projectEntry({ entry: await directory.getEntryHandle({ name }) });
    },
    getFileHandle: async ({ create, name }) => {
      if (create) unsupportedMutation();
      requireIncluded({ name });
      return await directory.getFileHandle({ create: false, name });
    },
    kind: 'directory',
    moveEntry: async () => unsupportedMutation(),
    name: directory.name,
    removeEntry: async () => unsupportedMutation(),
    stat: async () => await directory.stat(),
  };
}

export function createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): StorageFileSystemSession {
  const nativeSession = createNativeOpfsFileSystemSession({ root: nativeNamespaceRoot });
  const nativeRoot = nativeSession.root;
  const projectedRoot = projectDirectory({
    directory: {
      cloneFile: async ({ name, destination, newName, replace }) => await nativeRoot.cloneFile({
        name,
        destination,
        newName,
        replace,
      }),
      createSymlink: async ({ name, target }) => await nativeRoot.createSymlink({ name, target }),
      entries: async function* () {
        let storage: StorageDirectoryHandle;
        try {
          storage = await nativeRoot.getDirectoryHandle({
            create: false,
            name: NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
          });
        } catch (cause: unknown) {
          if (cause instanceof DOMException && cause.name === 'NotFoundError') return;
          if (cause instanceof Error && cause.name === 'NotFoundError') return;
          throw cause;
        }
        yield [
          NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
          projectDirectory({ directory: storage, filterDirectChild: includeNativePlainApplicationStorageEntry }),
        ] as const;
      },
      getDirectoryHandle: async ({ create, name }) => {
        if (create || name !== NAIDAN_OPFS_STORAGE_DIRECTORY_NAME) unsupportedMutation();
        const storage = await nativeRoot.getDirectoryHandle({ create: false, name });
        return projectDirectory({ directory: storage, filterDirectChild: includeNativePlainApplicationStorageEntry });
      },
      getEntryHandle: async ({ name }) => {
        if (name !== NAIDAN_OPFS_STORAGE_DIRECTORY_NAME) {
          throw new DOMException('excluded transition entry', 'NotFoundError');
        }
        const storage = await nativeRoot.getDirectoryHandle({ create: false, name });
        return projectDirectory({ directory: storage, filterDirectChild: includeNativePlainApplicationStorageEntry });
      },
      getFileHandle: async ({ create, name }) => await nativeRoot.getFileHandle({ create, name }),
      kind: nativeRoot.kind,
      moveEntry: async ({ name, destination, newName, replace }) => await nativeRoot.moveEntry({
        name,
        destination,
        newName,
        replace,
      }),
      name: nativeRoot.name,
      removeEntry: async ({ name, recursive }) => await nativeRoot.removeEntry({ name, recursive }),
      stat: async () => await nativeRoot.stat(),
    },
    filterDirectChild: ({ name }) => name === NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
  });
  return {
    capabilities: nativeSession.capabilities,
    close: async () => await nativeSession.close(),
    root: projectedRoot,
  };
}

/**
 * Readiness checks must close their transient plain session without allowing a
 * later close failure to erase the validation failure that rejected the
 * endpoint. The session is passed in so its ownership transfer is explicit.
 */
export async function runWithNativePlainApplicationNamespaceSession<T>({ failureMessage, operation, session }: {
  failureMessage: string;
  operation: ({ session }: { session: StorageFileSystemSession }) => Promise<T>;
  session: StorageFileSystemSession;
}): Promise<T> {
  let operationFailure: unknown;
  let value: T | undefined;
  try {
    value = await operation({ session });
  } catch (cause: unknown) {
    operationFailure = cause;
  }
  try {
    await session.close();
  } catch (closeFailure: unknown) {
    if (operationFailure !== undefined) {
      throw new AggregateError([operationFailure, closeFailure], failureMessage);
    }
    throw closeFailure;
  }
  if (operationFailure !== undefined) throw operationFailure;
  return value as T;
}

export async function isNativePlainApplicationNamespaceEmpty({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<boolean> {
  let storage: FileSystemDirectoryHandle;
  try {
    storage = await nativeNamespaceRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, { create: false });
  } catch (cause: unknown) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return true;
    if (cause instanceof Error && cause.name === 'NotFoundError') return true;
    throw cause;
  }
  for await (const name of storage.keys()) {
    if (includeNativePlainApplicationStorageEntry({ name })) return false;
  }
  return true;
}

export async function listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  let storage: FileSystemDirectoryHandle;
  try {
    storage = await nativeNamespaceRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, { create: false });
  } catch (cause: unknown) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return [];
    if (cause instanceof Error && cause.name === 'NotFoundError') return [];
    throw cause;
  }
  const names: string[] = [];
  for await (const name of storage.keys()) {
    if (includeNativePlainApplicationStorageEntry({ name })) names.push(name);
  }
  return names.toSorted();
}

export async function cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const names = await listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot });
  if (names.length === 0) return [];
  const storage = await nativeNamespaceRoot.getDirectoryHandle(
    NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
    { create: false },
  );
  const removedNames: string[] = [];
  for (const name of names) {
    await storage.removeEntry(name, { recursive: true });
    removedNames.push(name);
  }
  return removedNames;
}

export async function cleanupNativePlainApplicationNamespace({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  await cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot });
}

export const TEST_ONLY = {
  projectDirectory,
  runWithSession: runWithNativePlainApplicationNamespaceSession,
};
