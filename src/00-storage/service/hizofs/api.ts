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
  loadHizoFSActiveStateFromStores,
  loadHizoFSFixedSubvolumeState,
  type HizoFSFilesystemState,
} from './file-system/active-state';
import { HizoFSBulkBuilder } from './file-system/bulk-builder';
import type { HizoFSRuntimeDiagnostics } from './file-system/diagnostics';
import { collectHizoFSCurrentSubvolumeDescriptorObjectIds } from './file-system/subvolume-graph';
import {
  acquireHizoFSResourceLease,
  acquireHizoFSSubvolumeRuntimePin,
  type HizoFSMaintenanceLease,
} from './file-system/maintenance-lock';

async function assertHizoFSSubvolumeDescriptorReachable({
  runtime,
  rootState,
  targetDescriptorObjectId,
}: {
  runtime: HizoFSRuntime;
  rootState: HizoFSFilesystemState;
  targetDescriptorObjectId: string;
}): Promise<void> {
  const descriptorObjectIds =
    await collectHizoFSCurrentSubvolumeDescriptorObjectIds({
      runtime,
      rootState,
    });
  if (descriptorObjectIds.has(targetDescriptorObjectId)) return;
  throw new DOMException(
    'The HizoFS subvolume is no longer reachable from the current namespace',
    'NotFoundError',
  );
}

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

export async function deleteHizoFSSubvolume({
  subvolume,
  recursiveSubvolumes,
}: {
  subvolume: StorageDirectoryHandle;
  recursiveSubvolumes: boolean;
}): Promise<void> {
  const context = requireHizoFSDirectoryContext({
    handle: subvolume,
    role: 'source',
  });
  if (!context.subvolumeRoot) {
    throw createHizoFSNamedError({
      name: 'InvalidModificationError',
      message: 'HizoFS subvolume deletion requires a subvolume root handle',
    });
  }
  await context.session.deleteSubvolume({ recursiveSubvolumes });
}

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
      instanceId: source.instanceId,
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
      ?? getCanonicalHizoFSDescriptor({ instanceId: createHizoFSStableId() });
  } catch (error) {
    if (!(error instanceof HizoFSDescriptorCorruptionError)) {
      throw error;
    }
    descriptor = getCanonicalHizoFSDescriptor({ instanceId: createHizoFSStableId() });
  }
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    instanceId: descriptor.instanceId,
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
  const rootSubvolumeId = createHizoFSStableId();
  const descriptor = await createHizoFSDescriptor({
    backingStore,
    instanceId: rootSubvolumeId,
  });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    instanceId: descriptor.instanceId,
    policy,
    now,
    diagnostics,
  });

  return runWithRuntimeInitialization({
    runtime,
    operation: async () => {
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
          instanceId: descriptor.instanceId,
          rootKey: workerRootKey,
          subvolumeDescriptorObjectId:
            state.superblock.subvolumeDescriptorObjectId,
        },
        fixedState: undefined,
        sessionLease: undefined,
        mountedAttachment: undefined,
        subvolumeRuntimePin: undefined,
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
  let descriptor: HizoFSDescriptorDto | undefined;
  try {
    descriptor = await readHizoFSDescriptor({ backingStore });
  } catch (error) {
    if (!(error instanceof HizoFSDescriptorCorruptionError)) throw error;
  }
  if (descriptor === undefined) {
    const provisionalRuntime = createHizoFSRuntime({
      backingStore,
      rootKey,
      fileSystemId,
      instanceId: createHizoFSStableId(),
      policy,
      now,
      diagnostics,
    });
    let authenticatedInstanceId: string;
    try {
      const state = await loadHizoFSActiveStateFromStores({
        superblockStore: provisionalRuntime.core.superblockStore,
        expectedSubvolumeId: undefined,
        commitStore: provisionalRuntime.commitStore,
        subvolumeDescriptorStore:
          provisionalRuntime.subvolumeDescriptorStore,
        inodeIndex: provisionalRuntime.inodeIndex,
        inodeStore: provisionalRuntime.inodeStore,
        validatedRootCache: undefined,
      });
      authenticatedInstanceId = state.commit.subvolumeId;
    } finally {
      await provisionalRuntime.close();
    }
    await restoreHizoFSDescriptor({
      backingStore,
      instanceId: authenticatedInstanceId,
    });
    return await openHizoFSInternal({
      backingDirectory,
      fileSystemRootKey,
      policy,
      now,
      diagnostics,
    });
  }
  const instanceId = descriptor.instanceId;
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    instanceId,
    policy,
    now,
    diagnostics,
  });
  return runWithRuntimeInitialization({
    runtime,
    operation: async () => {
      const state = await runtime.core.loadActiveState();
      if (state.commit.subvolumeId !== instanceId) {
        throw new HizoFSCorruptionError({
          message:
            'HizoFS descriptor instanceId does not match the authenticated root subvolume identity',
          cause: undefined,
        });
      }
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
          instanceId,
          rootKey: workerRootKey,
          subvolumeDescriptorObjectId:
            state.superblock.subvolumeDescriptorObjectId,
        },
        fixedState: undefined,
        sessionLease: undefined,
        mountedAttachment: undefined,
        subvolumeRuntimePin: undefined,
      });
    },
  });
}

async function openHizoFSWithImportedRootKey({
  backingDirectory,
  fileSystemId,
  instanceId,
  rootKey,
  subvolumeDescriptorObjectId,
  rootDirectoryNodeId,
  policy,
  now,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemId: string;
  instanceId: string;
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
  const descriptor = await readHizoFSDescriptor({ backingStore });
  if (descriptor === undefined || descriptor.instanceId !== instanceId) {
    throw new DOMException(
      'The HizoFS Worker mount belongs to a different filesystem instance',
      'NotFoundError',
    );
  }
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    instanceId,
    policy,
    now,
    diagnostics: undefined,
  });
  return runWithRuntimeInitialization({
    runtime,
    operation: async () => {
      const resourceLease = await acquireHizoFSResourceLease({ instanceId });
      let subvolumeRuntimePin: HizoFSMaintenanceLease | undefined;
      try {
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
          await assertHizoFSSubvolumeDescriptorReachable({
            runtime,
            rootState,
            targetDescriptorObjectId: subvolumeDescriptorObjectId,
          });
          const descriptor = await runtime.subvolumeDescriptorStore.read({
            objectId: subvolumeDescriptorObjectId,
          });
          subvolumeRuntimePin = await acquireHizoFSSubvolumeRuntimePin({
            instanceId,
            subvolumeId: descriptor.subvolumeId,
            subvolumeDescriptorObjectId,
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
        await restoreHizoFSDescriptor({ backingStore, instanceId });
        await runtime.nodeService.readDirectory({
          state,
          nodeId: rootDirectoryNodeId,
        });
        const session = new HizoFSSession({
          runtime,
          core,
          subvolumeId: state.subvolumeDescriptor.subvolumeId,
          rootDirectoryNodeId,
          rootName: '',
          workerMountContext: {
            type: "hizofs",
            backingDirectory,
            fileSystemId,
            instanceId,
            rootKey,
            subvolumeDescriptorObjectId,
          },
          fixedState,
          sessionLease: undefined,
          mountedAttachment: undefined,
          subvolumeRuntimePin,
        });
        subvolumeRuntimePin = undefined;
        return session;
      } catch (error) {
        await subvolumeRuntimePin?.release();
        throw error;
      } finally {
        await resourceLease.release();
      }
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createHizoFSInternal,
  openHizoFSInternal,
};
