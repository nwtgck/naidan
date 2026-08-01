import type {
  TransitionNamespaceMetadata,
  TransitionNamespacePath,
  TransitionNamespaceSourcePort,
  TransitionNamespaceTargetPort,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import type {
  StorageDirectoryHandle,
  StorageFileSystemSession,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';
import { createStorageFileSystemTransitionSource } from '@/00-storage/service/naidan-persistence-control/transition/storage-file-system-transition-source';

export interface NativePlainTransitionLifecyclePort {
  stageLifecycle({ lifecycle }: {
    lifecycle: 'active' | 'sealed';
  }): Promise<void>;
}

const PROJECTED_METADATA: TransitionNamespaceMetadata = {
  createdAt: undefined,
  modifiedAt: undefined,
};

function requireProjectedMetadata({ metadata }: { metadata: TransitionNamespaceMetadata }): void {
  if (metadata.createdAt !== undefined || metadata.modifiedAt !== undefined) {
    throw new TypeError('native OPFS plain transition cannot preserve source timestamps');
  }
}

function safeInteger({ label, value }: { label: string; value: bigint }): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the native OPFS safe-integer range`);
  }
  return Number(value);
}

async function resolveDirectory({ create, path, root }: {
  create: boolean;
  path: TransitionNamespacePath;
  root: StorageDirectoryHandle;
}): Promise<StorageDirectoryHandle> {
  let directory = root;
  for (const name of path) directory = await directory.getDirectoryHandle({ create, name });
  return directory;
}

function splitPath({ path }: { path: TransitionNamespacePath }): {
  name: string;
  parent: TransitionNamespacePath;
} {
  const name = path.at(-1);
  if (name === undefined) throw new TypeError('native plain transition entry path must not be root');
  return { name, parent: path.slice(0, -1) };
}

async function settleWritable({ operation, writable }: {
  operation: ({ writable }: { writable: StorageWritableFile }) => Promise<void>;
  writable: StorageWritableFile;
}): Promise<void> {
  try {
    await operation({ writable });
    await writable.close();
  } catch (cause: unknown) {
    try {
      await writable.abort({ reason: cause });
    } catch {
      // Preserve the original write, truncate, or close failure.
    }
    throw cause;
  }
}

export function projectNativePlainTransitionSource({ source }: {
  source: TransitionNamespaceSourcePort;
}): TransitionNamespaceSourcePort {
  return {
    readRootMetadata: async () => PROJECTED_METADATA,
    listDirectory: async ({ afterName, maximumEntries, path }) => {
      const page = await source.listDirectory({ afterName, maximumEntries, path });
      return {
        ...page,
        entries: page.entries.map(entry => ({ ...entry, metadata: PROJECTED_METADATA })),
      };
    },
    readFileChunk: async ({ maximumBytes, offset, path }) => await source.readFileChunk({ maximumBytes, offset, path }),
    readSymlink: async ({ path }) => await source.readSymlink({ path }),
  };
}

export async function assertNativePlainTransitionSourceCompatible({ maximumDirectoryEntriesPerRead, source }: {
  maximumDirectoryEntriesPerRead: number;
  source: TransitionNamespaceSourcePort;
}): Promise<void> {
  if (!Number.isSafeInteger(maximumDirectoryEntriesPerRead) || maximumDirectoryEntriesPerRead < 1) {
    throw new RangeError('native plain transition preflight page size must be a positive safe integer');
  }
  const stack: { afterName: string | undefined; path: TransitionNamespacePath }[] = [{ afterName: undefined, path: [] }];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const page = await source.listDirectory({
      afterName: frame.afterName,
      maximumEntries: maximumDirectoryEntriesPerRead,
      path: frame.path,
    });
    for (const entry of page.entries) {
      frame.afterName = entry.name;
      let descended = false;
      switch (entry.kind) {
      case 'directory':
        stack.push({ afterName: undefined, path: [...frame.path, entry.name] });
        descended = true;
        break;
      case 'file': break;
      case 'symlink': throw new TypeError('native OPFS plain transition does not support symbolic links');
      default: entry satisfies never;
      }
      if (descended) break;
    }
    if (stack.at(-1) !== frame) continue;
    switch (page.state) {
    case 'complete': stack.pop(); break;
    case 'more':
      if (page.entries.length === 0) throw new TypeError('native plain transition preflight received an empty non-final page');
      break;
    default: page.state satisfies never;
    }
  }
}

export function createNativePlainTransitionNamespaceSession({ bridge, session, verificationSession = session }: {
  bridge: NativePlainTransitionLifecyclePort;
  session: StorageFileSystemSession;
  verificationSession?: StorageFileSystemSession;
}): Readonly<{
  close(): Promise<void>;
  source: TransitionNamespaceSourcePort;
  target: TransitionNamespaceTargetPort;
}> {
  const exactSource = createStorageFileSystemTransitionSource({ session: verificationSession });
  const target: TransitionNamespaceTargetPort = {
    setRootMetadata: async ({ metadata }) => {
      requireProjectedMetadata({ metadata });
      await bridge.stageLifecycle({ lifecycle: 'active' });
    },
    ensureDirectory: async ({ metadata, path }) => {
      requireProjectedMetadata({ metadata });
      await resolveDirectory({ create: true, path, root: session.root });
      await bridge.stageLifecycle({ lifecycle: 'active' });
    },
    writeFileChunk: async ({ bytes, offset, path }) => {
      const { name, parent } = splitPath({ path });
      const directory = await resolveDirectory({ create: false, path: parent, root: session.root });
      const file = await directory.getFileHandle({ create: true, name });
      const writable = await file.createWritable({ keepExistingData: true });
      await settleWritable({
        operation: async ({ writable: opened }) => await opened.write({
          data: Uint8Array.from(bytes),
          position: safeInteger({ label: 'native plain transition file offset', value: offset }),
        }),
        writable,
      });
      await bridge.stageLifecycle({ lifecycle: 'active' });
    },
    finalizeFile: async ({ metadata, path, size }) => {
      requireProjectedMetadata({ metadata });
      const { name, parent } = splitPath({ path });
      const directory = await resolveDirectory({ create: false, path: parent, root: session.root });
      const file = await directory.getFileHandle({ create: true, name });
      const writable = await file.createWritable({ keepExistingData: true });
      await settleWritable({
        operation: async ({ writable: opened }) => await opened.truncate({
          size: safeInteger({ label: 'native plain transition file size', value: size }),
        }),
        writable,
      });
      await bridge.stageLifecycle({ lifecycle: 'active' });
    },
    writeSymlink: async () => {
      throw new TypeError('native OPFS plain transition does not support symbolic links');
    },
    completeNamespace: async () => {
      await bridge.stageLifecycle({ lifecycle: 'sealed' });
    },
  };
  return {
    close: async () => {
      const closeOperations = verificationSession === session
        ? [session.close()]
        : [session.close(), verificationSession.close()];
      const results = await Promise.allSettled(closeOperations);
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'native plain transition namespace close failed');
    },
    source: projectNativePlainTransitionSource({ source: exactSource }),
    target,
  };
}

export const TEST_ONLY = {
  PROJECTED_METADATA,
  requireProjectedMetadata,
  resolveDirectory,
  safeInteger,
  splitPath,
};
