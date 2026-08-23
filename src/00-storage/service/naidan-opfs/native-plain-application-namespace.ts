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

function projectCanonicalManagedRootShape({ root }: {
  root: StorageDirectoryHandle;
}): StorageDirectoryHandle {
  const projectEntry = ({ entry }: { entry: StorageEntryHandle }): StorageEntryHandle => {
    switch (entry.kind) {
    case 'directory': return projectDirectory({ directory: entry, filterDirectChild: () => true });
    case 'file':
    case 'symlink': return entry;
    default: return entry satisfies never;
    }
  };
  const openManagedRoot = async ({ name }: {
    name: NaidanOpfsContainerRootDirectoryName;
  }): Promise<StorageDirectoryHandle> => {
    try {
      return projectDirectory({
        directory: await root.getDirectoryHandle({ create: false, name }),
        filterDirectChild: () => true,
      });
    } catch (cause: unknown) {
      if (isNotFoundError({ cause })) return createEmptyProjectedDirectory({ name });
      throw cause;
    }
  };
  return {
    cloneFile: async () => unsupportedMutation(),
    createSymlink: async () => unsupportedMutation(),
    entries: async function* () {
      const presentManagedRoots = new Set<NaidanOpfsContainerRootDirectoryName>();
      for await (const [name, entry] of root.entries()) {
        const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
        if (managedName !== undefined) presentManagedRoots.add(managedName);
        yield [name, projectEntry({ entry })] as const;
      }
      for (const name of NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES) {
        if (!presentManagedRoots.has(name)) {
          yield [name, createEmptyProjectedDirectory({ name })] as const;
        }
      }
    },
    getDirectoryHandle: async ({ create, name }) => {
      if (create) unsupportedMutation();
      const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
      if (managedName !== undefined) return await openManagedRoot({ name: managedName });
      return projectDirectory({
        directory: await root.getDirectoryHandle({ create: false, name }),
        filterDirectChild: () => true,
      });
    },
    getEntryHandle: async ({ name }) => {
      const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
      if (managedName !== undefined) return await openManagedRoot({ name: managedName });
      return projectEntry({ entry: await root.getEntryHandle({ name }) });
    },
    getFileHandle: async ({ create, name }) => {
      if (create) unsupportedMutation();
      return await root.getFileHandle({ create: false, name });
    },
    kind: 'directory',
    moveEntry: async () => unsupportedMutation(),
    name: root.name,
    removeEntry: async () => unsupportedMutation(),
    stat: async () => await root.stat(),
  };
}

/**
 * Gives every transition endpoint the same four managed-root projection.
 * A missing managed root is represented as an empty read-only directory; any
 * other root entry remains visible so verification cannot hide extra data.
 */
export function projectCanonicalNaidanApplicationNamespaceSession({ session }: {
  session: StorageFileSystemSession;
}): StorageFileSystemSession {
  return {
    capabilities: session.capabilities,
    close: async () => await session.close(),
    root: projectCanonicalManagedRootShape({ root: session.root }),
    sync: async () => await session.sync(),
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
          if (directory !== undefined) {
            yield [name, projectManagedRootDirectory({ directory, name })] as const;
          }
        }
      },
      getDirectoryHandle: async ({ create, name }) => {
        if (create) unsupportedMutation();
        const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
        if (managedName === undefined) {
          throw new DOMException('excluded transition entry', 'NotFoundError');
        }
        const directory = await openManagedRootDirectory({ name: managedName, root: nativeRoot });
        if (directory === undefined) throw new DOMException('missing managed root', 'NotFoundError');
        return projectManagedRootDirectory({ directory, name: managedName });
      },
      getEntryHandle: async ({ name }) => {
        const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
        if (managedName === undefined) {
          throw new DOMException('excluded transition entry', 'NotFoundError');
        }
        const directory = await openManagedRootDirectory({ name: managedName, root: nativeRoot });
        if (directory === undefined) throw new DOMException('missing managed root', 'NotFoundError');
        return projectManagedRootDirectory({ directory, name: managedName });
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
  return projectCanonicalNaidanApplicationNamespaceSession({ session: {
    capabilities: nativeSession.capabilities,
    close: async () => await nativeSession.close(),
    root: projectedRoot,
    sync: async () => await nativeSession.sync(),
  } });
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

export type NativePlainApplicationNamespaceEntry =
  | Readonly<{
    entryKind: 'directory';
    owner: 'managed_root';
    path: readonly [NaidanOpfsSpecialFileSystemDirectoryName];
  }>
  | Readonly<{
    entryKind: 'directory' | 'file';
    owner: 'storage_child';
    path: readonly [typeof NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, string];
  }>;

export type NativePlainApplicationNamespaceObservedEntry = Readonly<{
  entryKind: 'directory' | 'file';
  owner: NativePlainApplicationNamespaceEntry['owner'];
  path: readonly string[];
}>;

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
    for await (const [name, handle] of storage.entries()) {
      if (includeNativePlainApplicationStorageEntry({ name })) {
        entries.push({ entryKind: handle.kind, owner: 'storage_child', path: [NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, name] });
      }
    }
  }
  for (const name of NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES) {
    const directory = await openNativeDirectory({ name, parent: nativeNamespaceRoot });
    if (directory !== undefined) {
      entries.push({ entryKind: 'directory', owner: 'managed_root', path: [name] });
    }
  }
  return entries.toSorted((left, right) => {
    const byName = left.path.at(-1)!.localeCompare(right.path.at(-1)!);
    if (byName !== 0) return byName;
    const byOwner = left.owner.localeCompare(right.owner);
    if (byOwner !== 0) return byOwner;
    return left.entryKind.localeCompare(right.entryKind);
  });
}

export async function inspectNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<readonly NativePlainApplicationNamespaceObservedEntry[]> {
  const roots = await listNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot });
  const observed: NativePlainApplicationNamespaceObservedEntry[] = [];
  for (const root of roots) {
    observed.push(root);
    switch (root.entryKind) {
    case 'file': continue;
    case 'directory': break;
    default: root satisfies never;
    }
    const directory = await (async () => {
      switch (root.owner) {
      case 'managed_root':
        return await nativeNamespaceRoot.getDirectoryHandle(root.path[0], { create: false });
      case 'storage_child':
        return await (await nativeNamespaceRoot.getDirectoryHandle(
          NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
          { create: false },
        )).getDirectoryHandle(root.path[1], { create: false });
      default: return root satisfies never;
      }
    })();
    const stack = [{ directory, path: root.path }] as Array<{
      directory: FileSystemDirectoryHandle;
      path: readonly string[];
    }>;
    while (stack.length > 0) {
      const current = stack.pop()!;
      for await (const [name, handle] of current.directory.entries()) {
        const path = [...current.path, name];
        observed.push({ entryKind: handle.kind, owner: root.owner, path });
        switch (handle.kind) {
        case 'directory': stack.push({ directory: handle, path }); break;
        case 'file': break;
        default: handle satisfies never;
        }
      }
    }
  }
  return observed.toSorted((left, right) => {
    const byPath = left.path.join('/').localeCompare(right.path.join('/'));
    if (byPath !== 0) return byPath;
    const byOwner = left.owner.localeCompare(right.owner);
    if (byOwner !== 0) return byOwner;
    return left.entryKind.localeCompare(right.entryKind);
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
    .map(({ path }) => path.at(-1)!);
}

export async function cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const entries = await listNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot });
  if (entries.length === 0) return [];
  let storage: FileSystemDirectoryHandle | undefined;
  const removedNames: string[] = [];
  for (const entry of entries) {
    switch (entry.owner) {
    case 'managed_root':
      await nativeNamespaceRoot.removeEntry(entry.path[0], { recursive: true });
      break;
    case 'storage_child':
      storage ??= await nativeNamespaceRoot.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      await storage.removeEntry(entry.path[1], { recursive: true });
      break;
    default: entry satisfies never;
    }
    removedNames.push(entry.path.at(-1)!);
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
