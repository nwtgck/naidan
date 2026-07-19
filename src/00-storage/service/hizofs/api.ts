import { promiseAllKeyed } from '@/utils/promise';
import type {
  HizoFSCommitDto,
  HizoFSDescriptorDto,
  HizoFSSubvolumeAccessDto,
  HizoFSSubvolumeDescriptorDto,
  HizoFSSuperblockDto,
} from "@/00-storage/00-dto/hizofs.dto";
import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountSession,
  StorageDirectoryWorkerMountSource,
  StorageFileSystemSession,
} from "@/00-storage/service/storage-file-system/types";
import { NativeOpfsHizoFSBackingStore } from "./backing-store/native-opfs-backing-store";
import {
  deriveHizoFSFileSystemId,
  importHizoFSRootKey,
  importHizoFSWorkerRootKey,
} from "./crypto/object-crypto";
import {
  createHizoFSDescriptor,
  HizoFSDescriptorCorruptionError,
  getCanonicalHizoFSDescriptor,
  readHizoFSDescriptor,
  restoreHizoFSDescriptor,
} from "./format/descriptor-store";
import { createHizoFSStableId } from "./id";
import { HizoFSCorruptionError } from './errors';
import { DEFAULT_HIZOFS_POLICY, type HizoFSPolicy } from "./file-system/policy";
import { createHizoFSRuntime, type HizoFSRuntime } from "./file-system/runtime";
import {
  getHizoFSDirectoryHandleContext,
  HizoFSSession,
} from "./file-system/session";
import {
  loadHizoFSFixedSubvolumeState,
  type HizoFSFilesystemState,
} from './file-system/active-state';
import { HizoFSBulkBuilder } from './file-system/bulk-builder';
import type { HizoFSRuntimeDiagnostics } from './file-system/diagnostics';

export async function createHizoFS({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return createHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
    diagnostics: undefined,
  });
}

export async function createHizoFSDiagnosticSession({
  backingDirectory,
  fileSystemRootKey,
  policy,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  diagnostics: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  return createHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy,
    now: () => Date.now(),
    diagnostics,
  });
}

export async function openHizoFS({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return openHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
    diagnostics: undefined,
  });
}

export async function openHizoFSDiagnosticSession({
  backingDirectory,
  fileSystemRootKey,
  policy,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  diagnostics: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  return openHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy,
    now: () => Date.now(),
    diagnostics,
  });
}

export async function createHizoFSBulkBuilder({
  fileSystemSession,
}: {
  fileSystemSession: StorageFileSystemSession;
}): Promise<HizoFSBulkBuilder | undefined> {
  if (!(fileSystemSession instanceof HizoFSSession)) {
    return undefined;
  }
  fileSystemSession.assertOpen();
  return await HizoFSBulkBuilder.create({
    runtime: fileSystemSession.runtime,
    rootDirectoryNodeId: fileSystemSession.rootDirectoryNodeId,
  });
}

export type HizoFSSubvolumeAccess = HizoFSSubvolumeAccessDto;

export type HizoFSSubvolumeInfo = {
  readonly subvolumeId: string;
  readonly access: HizoFSSubvolumeAccess;
  readonly stateSelection: 'current' | 'fallback';
  readonly root: boolean;
};

function createHizoFSNamedError({
  name,
  message,
}: {
  name: string;
  message: string;
}): Error {
  const error = new Error(`${name}: ${message}`);
  error.name = name;
  return error;
}

function requireHizoFSDirectoryContext({
  handle,
  role,
}: {
  handle: StorageDirectoryHandle;
  role: 'source' | 'destination';
}): NonNullable<ReturnType<typeof getHizoFSDirectoryHandleContext>> {
  const context = getHizoFSDirectoryHandleContext({ handle });
  if (context === undefined) {
    throw createHizoFSNamedError({
      name: 'TypeMismatchError',
      message: `HizoFS subvolume ${role} must be a HizoFS directory`,
    });
  }
  return context;
}

export async function createHizoFSSubvolume({
  destination,
  name,
  access,
}: {
  destination: StorageDirectoryHandle;
  name: string;
  access: HizoFSSubvolumeAccess;
}): Promise<StorageDirectoryHandle> {
  const destinationContext = requireHizoFSDirectoryContext({
    handle: destination,
    role: 'destination',
  });
  switch (access) {
  case 'read':
    return await destinationContext.session.createReadSubvolume({
      directoryNodeId: destinationContext.nodeId,
      name,
    });
  case 'read_write':
    return await destinationContext.session.createReadWriteSubvolume({
      directoryNodeId: destinationContext.nodeId,
      name,
    });
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled HizoFS subvolume access: ${String(_ex)}`);
  }
  }
}

export async function snapshotHizoFSSubvolume({
  source,
  destination,
  name,
  access,
}: {
  source: StorageDirectoryHandle;
  destination: StorageDirectoryHandle;
  name: string;
  access: HizoFSSubvolumeAccess;
}): Promise<StorageDirectoryHandle> {
  const sourceContext = requireHizoFSDirectoryContext({
    handle: source,
    role: 'source',
  });
  if (!sourceContext.subvolumeRoot) {
    throw createHizoFSNamedError({
      name: 'InvalidModificationError',
      message: 'HizoFS snapshots require a subvolume root handle',
    });
  }
  const destinationContext = requireHizoFSDirectoryContext({
    handle: destination,
    role: 'destination',
  });
  switch (access) {
  case 'read':
  case 'read_write':
    return await destinationContext.session.snapshotSubvolume({
      sourceSession: sourceContext.session,
      directoryNodeId: destinationContext.nodeId,
      name,
      access,
    });
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled HizoFS subvolume access: ${String(_ex)}`);
  }
  }
}

// TODO(hizofs-subvolume): Add explicit subvolume deletion after garbage
// collection retains every reachable read_write child head generation and
// active runtime pin, then reclaims orphan heads without traversing ordinary
// file trees during the delete operation. Remove this TODO after crash
// injection covers pre-publication orphan metadata, post-publication outcomes,
// previous-generation reachability, and runtime-pinned deleted subvolumes.

export async function getHizoFSSubvolumeInfo({
  handle,
}: {
  handle: StorageDirectoryHandle;
}): Promise<HizoFSSubvolumeInfo | undefined> {
  const context = getHizoFSDirectoryHandleContext({ handle });
  if (context === undefined || !context.subvolumeRoot) return undefined;
  context.session.assertOpen();
  const { state, rootState } = await promiseAllKeyed({
    state: context.session.loadFilesystemState(),
    rootState: context.session.runtime.core.loadActiveState(),
  });
  const stateSelection = 'stateSelection' in state
    ? state.stateSelection
    : 'current';
  return {
    subvolumeId: state.subvolumeDescriptor.subvolumeId,
    access: state.subvolumeDescriptor.access,
    stateSelection,
    root:
      state.subvolumeDescriptorObjectId
      === rootState.subvolumeDescriptorObjectId,
  };
}

export async function openHizoFSWorkerMount({
  source,
}: {
  source: StorageDirectoryWorkerMountSource;
}): Promise<StorageDirectoryWorkerMountSession> {
  // The in-module fallback lock is isolated per realm. Allowing it here would
  // let the UI and Wesh Worker publish conflicting commits independently.
  if (
    typeof navigator === "undefined" ||
    navigator.locks?.request === undefined
  ) {
    throw new Error(
      "Worker-local HizoFS mounts require the Web Locks API for cross-realm consistency",
    );
  }
  switch (source.type) {
  case "hizofs":
    return openHizoFSWithImportedRootKey({
      backingDirectory: source.backingDirectory,
      fileSystemId: source.fileSystemId,
      rootKey: source.rootKey,
      subvolumeDescriptorObjectId: source.subvolumeDescriptorObjectId,
      rootDirectoryNodeId: source.rootDirectoryNodeId,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => Date.now(),
    });
  default: {
    const _ex: never = source.type;
    throw new Error(
      `Unhandled storage directory Worker mount: ${String(_ex)}`,
    );
  }
  }
}

export async function deriveHizoFSFileSystemIdFromRawRootKey({
  fileSystemRootKey,
}: {
  fileSystemRootKey: Uint8Array;
}): Promise<string> {
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  return deriveHizoFSFileSystemId({ rootKey });
}

export interface HizoFSInspection {
  readonly descriptor: HizoFSDescriptorDto;
  readonly fileSystemId: string;
  readonly superblock: HizoFSSuperblockDto;
  readonly rootSubvolumeDescriptor: HizoFSSubvolumeDescriptorDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: HizoFSCommitDto;
}

export async function inspectHizoFS({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<HizoFSInspection> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    fileHandleCacheEntryLimit:
      DEFAULT_HIZOFS_POLICY.backingFileHandleCacheEntryLimit,
    fileSnapshotCacheEntryLimit:
      DEFAULT_HIZOFS_POLICY.backingFileSnapshotCacheEntryLimit,
    diagnostics: undefined,
  });
  let descriptor: HizoFSDescriptorDto;
  try {
    descriptor = await readHizoFSDescriptor({ backingStore })
      ?? getCanonicalHizoFSDescriptor();
  } catch (error) {
    if (!(error instanceof HizoFSDescriptorCorruptionError)) {
      throw error;
    }
    descriptor = getCanonicalHizoFSDescriptor();
  }
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
    diagnostics: undefined,
  });
  try {
    const activeState = await runtime.core.loadActiveState();
    return {
      descriptor,
      fileSystemId,
      superblock: activeState.superblock,
      rootSubvolumeDescriptor: activeState.subvolumeDescriptor,
      activeCommitObjectId: activeState.commitObjectId,
      activeCommit: activeState.commit,
    };
  } finally {
    await runtime.close();
  }
}

async function runWithRuntimeInitialization<T>({
  runtime,
  operation,
}: {
  runtime: HizoFSRuntime;
  operation: () => Promise<T>;
}): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    try {
      await runtime.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'HizoFS runtime initialization and cleanup both failed',
      );
    }
    throw error;
  }
}

async function createHizoFSInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  now: () => number;
  diagnostics?: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    fileHandleCacheEntryLimit: policy.backingFileHandleCacheEntryLimit,
    fileSnapshotCacheEntryLimit: policy.backingFileSnapshotCacheEntryLimit,
    diagnostics,
  });
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const workerRootKey = await importHizoFSWorkerRootKey({
    rawRootKey: fileSystemRootKey,
  });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  await createHizoFSDescriptor({ backingStore });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy,
    now,
    diagnostics,
  });

  return runWithRuntimeInitialization({
    runtime,
    operation: async () => {
      const rootSubvolumeId = createHizoFSStableId();
      const rootDirectoryNodeId = createHizoFSStableId();
      const timestamp = now();
      const rootInodeObjectId = await runtime.inodeStore.writeDirectory({
        inode: {
          nodeId: rootDirectoryNodeId,
          revision: 0,
          createdAt: timestamp,
          modifiedAt: timestamp,
          storage: { type: "inline", entries: [] },
        },
      });
      const inodeIndexRootObjectId = await runtime.inodeIndex.buildFromSortedEntries({
        entries: [{ nodeId: rootDirectoryNodeId, inodeObjectId: rootInodeObjectId }],
      });
      const subvolumeMountIndexRootObjectId =
        await runtime.subvolumeMountIndex.createEmpty();
      const subvolumeDescriptorObjectId =
        await runtime.subvolumeDescriptorStore.write({
          descriptor: {
            subvolumeId: rootSubvolumeId,
            access: 'read_write',
          },
        });
      const commitObjectId = await runtime.commitStore.write({
        commit: {
          revision: 0,
          publicationId: createHizoFSStableId(),
          subvolumeId: rootSubvolumeId,
          rootDirectoryNodeId,
          inodeIndexRootObjectId,
          subvolumeMountIndexRootObjectId,
        },
      });
      for (const sequence of [0, 1] as const) {
        await runtime.core.superblockStore.write({
          value: {
            sequence,
            fileSystemId,
            subvolumeDescriptorObjectId,
            activeCommitObjectId: commitObjectId,
          },
        });
      }
      const state = await runtime.core.loadActiveState();
      return new HizoFSSession({
        runtime,
        core: runtime.core,
        subvolumeId: state.subvolumeDescriptor.subvolumeId,
        rootDirectoryNodeId,
        rootName: '',
        workerMountContext: {
          type: "hizofs",
          backingDirectory,
          fileSystemId,
          rootKey: workerRootKey,
          subvolumeDescriptorObjectId:
            state.superblock.subvolumeDescriptorObjectId,
        },
        fixedState: undefined,
        sessionLease: undefined,
      });
    },
  });
}

async function openHizoFSInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  now: () => number;
  diagnostics?: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    fileHandleCacheEntryLimit: policy.backingFileHandleCacheEntryLimit,
    fileSnapshotCacheEntryLimit: policy.backingFileSnapshotCacheEntryLimit,
    diagnostics,
  });
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const workerRootKey = await importHizoFSWorkerRootKey({
    rawRootKey: fileSystemRootKey,
  });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy,
    now,
    diagnostics,
  });
  return runWithRuntimeInitialization({
    runtime,
    operation: async () => {
      const state = await runtime.core.loadActiveState();
      await restoreHizoFSDescriptor({ backingStore });
      return new HizoFSSession({
        runtime,
        core: runtime.core,
        subvolumeId: state.subvolumeDescriptor.subvolumeId,
        rootDirectoryNodeId: state.commit.rootDirectoryNodeId,
        rootName: '',
        workerMountContext: {
          type: "hizofs",
          backingDirectory,
          fileSystemId,
          rootKey: workerRootKey,
          subvolumeDescriptorObjectId:
            state.superblock.subvolumeDescriptorObjectId,
        },
        fixedState: undefined,
        sessionLease: undefined,
      });
    },
  });
}

async function openHizoFSWithImportedRootKey({
  backingDirectory,
  fileSystemId,
  rootKey,
  subvolumeDescriptorObjectId,
  rootDirectoryNodeId,
  policy,
  now,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemId: string;
  rootKey: CryptoKey;
  subvolumeDescriptorObjectId: string;
  rootDirectoryNodeId: string;
  policy: HizoFSPolicy;
  now: () => number;
}): Promise<StorageDirectoryWorkerMountSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    fileHandleCacheEntryLimit: policy.backingFileHandleCacheEntryLimit,
    fileSnapshotCacheEntryLimit: policy.backingFileSnapshotCacheEntryLimit,
    diagnostics: undefined,
  });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy,
    now,
    diagnostics: undefined,
  });
  return runWithRuntimeInitialization({
    runtime,
    operation: async () => {
      const rootState = await runtime.core.loadActiveState();
      let core = runtime.core;
      let fixedState: HizoFSFilesystemState | undefined;
      let state: HizoFSFilesystemState;
      if (
        rootState.superblock.subvolumeDescriptorObjectId
        === subvolumeDescriptorObjectId
      ) {
        state = rootState;
      } else {
        const descriptor = await runtime.subvolumeDescriptorStore.read({
          objectId: subvolumeDescriptorObjectId,
        });
        switch (descriptor.access) {
        case 'read':
          fixedState = await loadHizoFSFixedSubvolumeState({
            subvolumeDescriptorObjectId,
            commitStore: runtime.commitStore,
            subvolumeDescriptorStore: runtime.subvolumeDescriptorStore,
            inodeIndex: runtime.inodeIndex,
            inodeStore: runtime.inodeStore,
          });
          state = fixedState;
          break;
        case 'read_write':
          core = runtime.getReadWriteSubvolumeCore({
            subvolumeId: descriptor.subvolumeId,
          });
          state = await core.loadActiveState();
          if (state.subvolumeDescriptorObjectId !== subvolumeDescriptorObjectId) {
            throw new HizoFSCorruptionError({
              message: 'HizoFS worker mount resolved an unexpected child descriptor',
              cause: undefined,
            });
          }
          break;
        default: {
          const _ex: never = descriptor;
          throw new Error(`Unhandled HizoFS worker subvolume access: ${String(_ex)}`);
        }
        }
      }
      await restoreHizoFSDescriptor({ backingStore });
      await runtime.nodeService.readDirectory({
        state,
        nodeId: rootDirectoryNodeId,
      });
      return new HizoFSSession({
        runtime,
        core,
        subvolumeId: state.subvolumeDescriptor.subvolumeId,
        rootDirectoryNodeId,
        rootName: '',
        workerMountContext: {
          type: "hizofs",
          backingDirectory,
          fileSystemId,
          rootKey,
          subvolumeDescriptorObjectId,
        },
        fixedState,
        sessionLease: undefined,
      });
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createHizoFSInternal,
  openHizoFSInternal,
};
