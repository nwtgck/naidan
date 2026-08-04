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
import {
  NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
  NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES,
  NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES,
  type NaidanOpfsContainerRootDirectoryName,
  type NaidanOpfsSpecialFileSystemDirectoryName,
  parseNaidanOpfsContainerRootDirectoryName,
} from '@/00-storage/service/opfs/naidan-opfs-root-directory-registry';

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

function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === 'NotFoundError'
    : cause instanceof Error
      && (cause.name === 'NotFoundError' || cause.message.startsWith('NotFoundError'));
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

function createEmptyProjectedDirectory({ name }: {
  name: NaidanOpfsContainerRootDirectoryName;
}): StorageDirectoryHandle {
  const notFound = (): never => {
    throw new DOMException('empty projected transition directory', 'NotFoundError');
  };
  return {
    cloneFile: async () => unsupportedMutation(),
    createSymlink: async () => unsupportedMutation(),
    entries: async function* () {},
    getDirectoryHandle: async ({ create }) => create ? unsupportedMutation() : notFound(),
    getEntryHandle: async () => notFound(),
    getFileHandle: async ({ create }) => create ? unsupportedMutation() : notFound(),
    kind: 'directory',
    moveEntry: async () => unsupportedMutation(),
    name,
    removeEntry: async () => unsupportedMutation(),
    stat: async () => ({ createdAt: undefined, modifiedAt: undefined, size: 0 }),
  };
}

function projectManagedRootDirectory({ directory, name }: {
  directory: StorageDirectoryHandle;
  name: NaidanOpfsContainerRootDirectoryName;
}): StorageDirectoryHandle {
  return projectDirectory({
    directory,
    filterDirectChild: name === NAIDAN_OPFS_STORAGE_DIRECTORY_NAME
      ? includeNativePlainApplicationStorageEntry
      : () => true,
  });
}

async function openManagedRootDirectory({ name, root }: {
  name: NaidanOpfsContainerRootDirectoryName;
  root: StorageDirectoryHandle;
}): Promise<StorageDirectoryHandle | undefined> {
  try {
    return await root.getDirectoryHandle({ create: false, name });
  } catch (cause: unknown) {
    if (isNotFoundError({ cause })) return undefined;
    throw cause;
  }
}

export function createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): StorageFileSystemSession {
  const nativeSession = createNativeOpfsFileSystemSession({ root: nativeNamespaceRoot });
  const nativeRoot = nativeSession.root;
  const projectedRoot = projectDirectory({
    directory: {
      cloneFile: async () => unsupportedMutation(),
      createSymlink: async () => unsupportedMutation(),
      entries: async function* () {
        for (const name of NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES) {
          const directory = await openManagedRootDirectory({ name, root: nativeRoot });
          yield [
            name,
            directory === undefined
              ? createEmptyProjectedDirectory({ name })
              : projectManagedRootDirectory({ directory, name }),
          ] as const;
        }
      },
      getDirectoryHandle: async ({ create, name }) => {
        if (create) unsupportedMutation();
        const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
        if (managedName === undefined) {
          throw new DOMException('excluded transition entry', 'NotFoundError');
        }
        const directory = await openManagedRootDirectory({ name: managedName, root: nativeRoot });
        return directory === undefined
          ? createEmptyProjectedDirectory({ name: managedName })
          : projectManagedRootDirectory({ directory, name: managedName });
      },
      getEntryHandle: async ({ name }) => {
        const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
        if (managedName === undefined) {
          throw new DOMException('excluded transition entry', 'NotFoundError');
        }
        const directory = await openManagedRootDirectory({ name: managedName, root: nativeRoot });
        return directory === undefined
          ? createEmptyProjectedDirectory({ name: managedName })
          : projectManagedRootDirectory({ directory, name: managedName });
      },
      getFileHandle: async ({ create }) => {
        if (create) unsupportedMutation();
        throw new DOMException('excluded transition entry', 'NotFoundError');
      },
      kind: nativeRoot.kind,
      moveEntry: async () => unsupportedMutation(),
      name: nativeRoot.name,
      removeEntry: async () => unsupportedMutation(),
      stat: async () => await nativeRoot.stat(),
    },
    filterDirectChild: ({ name }) => parseNaidanOpfsContainerRootDirectoryName({ name }) !== undefined,
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

type NativePlainApplicationNamespaceEntry =
  | Readonly<{ kind: 'storage_child'; name: string }>
  | Readonly<{ kind: 'managed_root'; name: NaidanOpfsSpecialFileSystemDirectoryName }>;

async function openNativeDirectory({ name, parent }: {
  name: string;
  parent: FileSystemDirectoryHandle;
}): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch (cause: unknown) {
    if (isNotFoundError({ cause })) return undefined;
    throw cause;
  }
}

async function listNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<readonly NativePlainApplicationNamespaceEntry[]> {
  const entries: NativePlainApplicationNamespaceEntry[] = [];
  const storage = await openNativeDirectory({
    name: NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
    parent: nativeNamespaceRoot,
  });
  if (storage !== undefined) {
    for await (const name of storage.keys()) {
      if (includeNativePlainApplicationStorageEntry({ name })) {
        entries.push({ kind: 'storage_child', name });
      }
    }
  }
  for (const name of NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES) {
    if (await openNativeDirectory({ name, parent: nativeNamespaceRoot }) !== undefined) {
      entries.push({ kind: 'managed_root', name });
    }
  }
  return entries.toSorted((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) return byName;
    return left.kind.localeCompare(right.kind);
  });
}

export async function isNativePlainApplicationNamespaceEmpty({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<boolean> {
  return (await listNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot })).length === 0;
}

export async function listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  return (await listNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot }))
    .map(({ name }) => name);
}

export async function cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const entries = await listNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot });
  if (entries.length === 0) return [];
  let storage: FileSystemDirectoryHandle | undefined;
  const removedNames: string[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
    case 'managed_root':
      await nativeNamespaceRoot.removeEntry(entry.name, { recursive: true });
      break;
    case 'storage_child':
      storage ??= await nativeNamespaceRoot.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      await storage.removeEntry(entry.name, { recursive: true });
      break;
    default: entry satisfies never;
    }
    removedNames.push(entry.name);
  }
  return removedNames;
}

export async function cleanupNativePlainApplicationNamespace({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  await cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot });
}

export const TEST_ONLY = {
  listEntries: listNativePlainApplicationNamespaceEntries,
  projectDirectory,
  runWithSession: runWithNativePlainApplicationNamespaceSession,
};
