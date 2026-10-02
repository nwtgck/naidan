import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  parseNaidanContainerToken,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import { compareTransitionNamespaceEntryNameBytes } from '@/00-storage/service/naidan-persistence-control/transition/namespace-contracts';
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

function projectDirectory({ assertOpen, directory, filterDirectChild }: {
  assertOpen: (() => void) | undefined;
  directory: StorageDirectoryHandle;
  filterDirectChild: (({ name }: { name: string }) => boolean) | undefined;
}): StorageDirectoryHandle {
  const projectEntry = ({ entry }: { entry: StorageEntryHandle }): StorageEntryHandle => {
    switch (entry.kind) {
    case 'directory': return projectDirectory({ assertOpen, directory: entry, filterDirectChild: undefined });
    case 'file':
    case 'symlink': return entry;
    default: return entry satisfies never;
    }
  };
  const requireIncluded = ({ name }: { name: string }): void => {
    assertOpen?.();
    if (filterDirectChild?.({ name }) === false) throw new DOMException('excluded transition entry', 'NotFoundError');
  };
  return {
    cloneFile: async () => unsupportedMutation(),
    createSymlink: async () => unsupportedMutation(),
    entries: async function* () {
      assertOpen?.();
      for await (const [name, entry] of directory.entries()) {
        assertOpen?.();
        if (filterDirectChild?.({ name }) === false) continue;
        yield [name, projectEntry({ entry })] as const;
      }
    },
    getDirectoryHandle: async ({ create, name }) => {
      if (create) unsupportedMutation();
      requireIncluded({ name });
      const child = await directory.getDirectoryHandle({ create: false, name });
      assertOpen?.();
      return projectDirectory({
        assertOpen,
        directory: child,
        filterDirectChild: undefined,
      });
    },
    getEntryHandle: async ({ name }) => {
      requireIncluded({ name });
      const entry = await directory.getEntryHandle({ name });
      assertOpen?.();
      return projectEntry({ entry });
    },
    getFileHandle: async ({ create, name }) => {
      if (create) unsupportedMutation();
      requireIncluded({ name });
      const file = await directory.getFileHandle({ create: false, name });
      assertOpen?.();
      return file;
    },
    kind: 'directory',
    listEntriesPage: filterDirectChild === undefined && directory.listEntriesPage !== undefined
      ? async ({ afterName, maximumEntries }) => {
        assertOpen?.();
        const { entries, truncated, ...unhandled } = await directory.listEntriesPage!({ afterName, maximumEntries });
        unhandled satisfies Record<PropertyKey, never>;
        assertOpen?.();
        return { entries: entries.map(([name, entry]) => [name, projectEntry({ entry })] as const), truncated };
      }
      : undefined,
    moveEntry: async () => unsupportedMutation(),
    name: directory.name,
    removeEntry: async () => unsupportedMutation(),
    stat: async () => {
      assertOpen?.();
      const stat = await directory.stat();
      assertOpen?.();
      return stat;
    },
  };
}

function createEmptyProjectedDirectory({ assertOpen, name }: {
  assertOpen: () => void;
  name: NaidanOpfsContainerRootDirectoryName;
}): StorageDirectoryHandle {
  const notFound = (): never => {
    assertOpen();
    throw new DOMException('empty projected transition directory', 'NotFoundError');
  };
  return {
    cloneFile: async () => unsupportedMutation(),
    createSymlink: async () => unsupportedMutation(),
    entries: async function* () {
      assertOpen();
      yield* [];
    },
    getDirectoryHandle: async ({ create }) => create ? unsupportedMutation() : notFound(),
    getEntryHandle: async () => notFound(),
    getFileHandle: async ({ create }) => create ? unsupportedMutation() : notFound(),
    kind: 'directory',
    listEntriesPage: async ({ maximumEntries }) => {
      assertOpen();
      if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new TypeError('maximum entries must be a positive safe integer');
      return { entries: [], truncated: false };
    },
    moveEntry: async () => unsupportedMutation(),
    name,
    removeEntry: async () => unsupportedMutation(),
    stat: async () => {
      assertOpen();
      return { createdAt: undefined, modifiedAt: undefined, size: 0 };
    },
  };
}

function projectCanonicalManagedRootShape({ assertOpen, root }: {
  assertOpen: () => void;
  root: StorageDirectoryHandle;
}): StorageDirectoryHandle {
  const projectEntry = ({ entry }: { entry: StorageEntryHandle }): StorageEntryHandle => {
    switch (entry.kind) {
    case 'directory': return projectDirectory({ assertOpen, directory: entry, filterDirectChild: undefined });
    case 'file':
    case 'symlink': return entry;
    default: return entry satisfies never;
    }
  };
  const openManagedRoot = async ({ name }: {
    name: NaidanOpfsContainerRootDirectoryName;
  }): Promise<StorageDirectoryHandle> => {
    assertOpen();
    try {
      const directory = await root.getDirectoryHandle({ create: false, name });
      assertOpen();
      return projectDirectory({
        assertOpen,
        directory,
        filterDirectChild: undefined,
      });
    } catch (cause: unknown) {
      if (isNotFoundError({ cause })) {
        assertOpen();
        return createEmptyProjectedDirectory({ assertOpen, name });
      }
      throw cause;
    }
  };
  return {
    cloneFile: async () => unsupportedMutation(),
    createSymlink: async () => unsupportedMutation(),
    entries: async function* () {
      assertOpen();
      const presentManagedRoots = new Set<NaidanOpfsContainerRootDirectoryName>();
      for await (const [name, entry] of root.entries()) {
        assertOpen();
        const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
        if (managedName !== undefined) presentManagedRoots.add(managedName);
        yield [name, projectEntry({ entry })] as const;
      }
      for (const name of NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES) {
        assertOpen();
        if (!presentManagedRoots.has(name)) {
          yield [name, createEmptyProjectedDirectory({ assertOpen, name })] as const;
        }
      }
    },
    getDirectoryHandle: async ({ create, name }) => {
      assertOpen();
      if (create) unsupportedMutation();
      const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
      if (managedName !== undefined) return await openManagedRoot({ name: managedName });
      const directory = await root.getDirectoryHandle({ create: false, name });
      assertOpen();
      return projectDirectory({
        assertOpen,
        directory,
        filterDirectChild: undefined,
      });
    },
    getEntryHandle: async ({ name }) => {
      assertOpen();
      try {
        const entry = await root.getEntryHandle({ name });
        assertOpen();
        return projectEntry({ entry });
      } catch (cause: unknown) {
        const managedName = parseNaidanOpfsContainerRootDirectoryName({ name });
        if (managedName === undefined || !isNotFoundError({ cause })) throw cause;
        assertOpen();
        return createEmptyProjectedDirectory({ assertOpen, name: managedName });
      }
    },
    getFileHandle: async ({ create, name }) => {
      assertOpen();
      if (create) unsupportedMutation();
      const file = await root.getFileHandle({ create: false, name });
      assertOpen();
      return file;
    },
    kind: 'directory',
    listEntriesPage: root.listEntriesPage === undefined ? undefined : async ({ afterName, maximumEntries }) => {
      assertOpen();
      if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new TypeError('maximum entries must be a positive safe integer');
      const { entries: rawEntries, truncated, ...unhandled } = await root.listEntriesPage!({ afterName, maximumEntries });
      unhandled satisfies Record<PropertyKey, never>;
      assertOpen();
      const encoder = new TextEncoder();
      const rawPage = rawEntries.map(([name, handle]) => ({ name, handle, bytes: encoder.encode(name) }));
      const afterBytes = afterName === undefined ? undefined : encoder.encode(afterName);
      const missing: Array<{ name: NaidanOpfsContainerRootDirectoryName; bytes: Uint8Array }> = [];
      for (const name of NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES) {
        const bytes = encoder.encode(name);
        if (afterBytes !== undefined && compareTransitionNamespaceEntryNameBytes({ left: bytes, right: afterBytes }) <= 0) continue;
        if (rawPage.some(entry => entry.name === name)) continue;
        try {
          await root.getEntryHandle({ name });
        } catch (cause: unknown) {
          if (!isNotFoundError({ cause })) throw cause;
          missing.push({ name, bytes });
        }
        assertOpen();
      }
      missing.sort((left, right) => compareTransitionNamespaceEntryNameBytes({ left: left.bytes, right: right.bytes }));
      const entries: Array<readonly [string, StorageEntryHandle]> = [];
      let rawIndex = 0;
      let missingIndex = 0;
      // Only the finite missing-root set is sorted; the raw bounded page is
      // already canonical. A virtual insertion may cause the next floor seek.
      while (entries.length < maximumEntries) {
        const raw = rawPage[rawIndex];
        const virtual = missing[missingIndex];
        if (raw === undefined && virtual === undefined) break;
        if (virtual !== undefined && (raw === undefined || compareTransitionNamespaceEntryNameBytes({ left: virtual.bytes, right: raw.bytes }) < 0)) {
          entries.push([virtual.name, createEmptyProjectedDirectory({ assertOpen, name: virtual.name })]);
          missingIndex += 1;
        } else if (raw !== undefined) {
          entries.push([raw.name, projectEntry({ entry: raw.handle })]);
          rawIndex += 1;
        }
      }
      assertOpen();
      return { entries, truncated: truncated || rawIndex < rawPage.length || missingIndex < missing.length };
    },
    moveEntry: async () => unsupportedMutation(),
    name: root.name,
    removeEntry: async () => unsupportedMutation(),
    stat: async () => {
      assertOpen();
      const stat = await root.stat();
      assertOpen();
      return stat;
    },
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
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error('application namespace projection is closed');
  };
  return {
    capabilities: session.capabilities,
    close: async () => {
      closed = true;
      await session.close();
    },
    root: projectCanonicalManagedRootShape({ assertOpen, root: session.root }),
    sync: async () => {
      assertOpen();
      await session.sync();
      assertOpen();
    },
  };
}

function projectManagedRootDirectory({ directory, name }: {
  directory: StorageDirectoryHandle;
  name: NaidanOpfsContainerRootDirectoryName;
}): StorageDirectoryHandle {
  return projectDirectory({
    assertOpen: undefined,
    directory,
    filterDirectChild: name === NAIDAN_OPFS_STORAGE_DIRECTORY_NAME
      ? includeNativePlainApplicationStorageEntry
      : undefined,
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
    assertOpen: undefined,
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
  let operationFailure: { cause: unknown } | undefined;
  let value: T | undefined;
  try {
    value = await operation({ session });
  } catch (cause: unknown) {
    operationFailure = { cause };
  }
  try {
    await session.close();
  } catch (closeFailure: unknown) {
    if (operationFailure !== undefined) {
      throw new AggregateError([operationFailure.cause, closeFailure], failureMessage);
    }
    throw closeFailure;
  }
  if (operationFailure !== undefined) throw operationFailure.cause;
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
