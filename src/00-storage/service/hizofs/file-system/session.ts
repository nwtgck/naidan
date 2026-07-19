import type {
  HizoFSDirectoryEntryDto,
  HizoFSDirectoryInodeDto,
  HizoFSFileInodeDto,
  HizoFSSubvolumeDescriptorDto,
  HizoFSSubvolumeMountDto,
  HizoFSSymlinkInodeDto,
} from "@/00-storage/00-dto/hizofs.dto";
import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountSession,
  StorageDirectoryWorkerMountSource,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileStat,
  StorageFileSystemSession,
  StorageSymlinkHandle,
  StorageWritableFile,
} from "@/00-storage/service/storage-file-system/types";
import { createStorageEntryNotFoundError } from "@/00-storage/service/storage-file-system/errors";
import { createHizoFSStableId } from "@/00-storage/service/hizofs/id";
import {
  HizoFSCorruptionError,
  HizoFSCrossDeviceError,
} from "@/00-storage/service/hizofs/errors";
import type {
  HizoFSActiveState,
  HizoFSCore,
  HizoFSPublishedMutation,
  HizoFSTopologyMutationResult,
} from "./core";
import {
  loadHizoFSFixedSubvolumeState,
  type HizoFSFilesystemState,
} from './active-state';
import type { HizoFSDirectoryChange } from "./directory-storage";
import type { HizoFSDirectoryIndexLookupCache } from "./directory-index";
import { HizoFSFileReader } from "./file-reader";
import { HizoFSFileWriter } from "./file-writer";
import type {
  LoadedHizoFSDirectory,
  LoadedHizoFSFile,
} from "./node-service";
import type { HizoFSRuntime } from "./runtime";
import {
  acquireHizoFSMaintenanceLease,
  acquireHizoFSResourceLease,
  acquireHizoFSSubvolumeRuntimePin,
} from "./maintenance-lock";
import type { HizoFSMaintenanceLease } from "./maintenance-lock";
import { assertHizoFSEntryName } from "./semantic-validation";
import type { StorageBinaryObjectReadHandle } from "@/00-storage/service/binary-object-io";

function createSubvolumeDescriptor({
  subvolumeId,
  access,
  commitObjectId,
}: {
  subvolumeId: string;
  access: 'read' | 'read_write';
  commitObjectId: string;
}): HizoFSSubvolumeDescriptorDto {
  switch (access) {
  case 'read':
    return {
      subvolumeId,
      access,
      fixedCommitObjectId: commitObjectId,
    };
  case 'read_write':
    return { subvolumeId, access };
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled HizoFS subvolume access: ${String(_ex)}`);
  }
  }
}

function isReadWriteSubvolumeAccess(
  access: 'read' | 'read_write',
): access is 'read_write' {
  switch (access) {
  case 'read':
    return false;
  case 'read_write':
    return true;
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled HizoFS subvolume access: ${String(_ex)}`);
  }
  }
}

function isSubvolumeDirectoryEntry(
  entry: HizoFSDirectoryEntryDto,
): entry is Extract<HizoFSDirectoryEntryDto, { readonly kind: 'subvolume' }> {
  switch (entry.kind) {
  case 'subvolume':
    return true;
  case 'directory':
  case 'file':
  case 'symlink':
    return false;
  default: {
    const _ex: never = entry;
    throw new Error(
      `Unhandled HizoFS directory entry kind: ${String(((_ex satisfies never) as { readonly kind: string }).kind)}`,
    );
  }
  }
}

function isOrdinaryDirectoryEntry(
  entry: HizoFSDirectoryEntryDto,
): entry is Extract<HizoFSDirectoryEntryDto, { readonly kind: 'directory' }> {
  switch (entry.kind) {
  case 'directory':
    return true;
  case 'file':
  case 'subvolume':
  case 'symlink':
    return false;
  default: {
    const _ex: never = entry;
    throw new Error(
      `Unhandled HizoFS directory entry kind: ${String(((_ex satisfies never) as { readonly kind: string }).kind)}`,
    );
  }
  }
}

function createNamedError({
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


function unwrapSettledResult<T>({
  result,
}: {
  result: PromiseSettledResult<T>;
}): T {
  switch (result.status) {
  case 'fulfilled':
    return result.value;
  case 'rejected':
    throw result.reason;
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled HizoFS independent write result: ${String(_ex)}`);
  }
  }
}

async function awaitIndependentWrites<Left, Right>({
  left,
  right,
}: {
  left: Promise<Left>;
  right: Promise<Right>;
}): Promise<readonly [Left, Right]> {
  // Both immutable writes are allowed to become unreachable on failure, but
  // both must settle before the mutation lease can be released. This avoids a
  // rejected Promise leaving an unobserved physical write running after the
  // caller has already started recovery or another mutation.
  const [leftResult, rightResult] = await Promise.allSettled([left, right]);
  return [
    unwrapSettledResult({ result: leftResult }),
    unwrapSettledResult({ result: rightResult }),
  ];
}

type HizoFSSessionResource = {
  dispose(): Promise<void>;
};

type HizoFSDirectoryHandleCache = {
  loadedDirectory: {
    readonly commitObjectId: string;
    readonly commitRevision: number;
    readonly directory: LoadedHizoFSDirectory;
  } | undefined;
  readonly entryLookupCache: HizoFSDirectoryIndexLookupCache;
};

const DIRECTORY_READ_CACHE_MAXIMUM_ENTRY_COUNT = 64;

class HizoFSDirectoryReadCache {
  constructor({ entryLimit }: { entryLimit: number }) {
    if (!Number.isSafeInteger(entryLimit) || entryLimit < 0) {
      throw new Error(
        'HizoFS directory read cache entry limit must be non-negative',
      );
    }
    this.entryLimit = entryLimit;
  }

  private readonly entryLimit: number;
  private readonly entries = new Map<string, HizoFSDirectoryHandleCache>();

  get({ nodeId }: { nodeId: string }): HizoFSDirectoryHandleCache {
    const existing = this.entries.get(nodeId);
    if (existing !== undefined) {
      this.entries.delete(nodeId);
      this.entries.set(nodeId, existing);
      return existing;
    }
    const created: HizoFSDirectoryHandleCache = {
      loadedDirectory: undefined,
      entryLookupCache: { value: undefined },
    };
    if (this.entryLimit === 0) return created;
    this.entries.set(nodeId, created);
    while (this.entries.size > this.entryLimit) {
      const oldestNodeId = this.entries.keys().next().value as string | undefined;
      if (oldestNodeId === undefined) break;
      const oldest = this.entries.get(oldestNodeId);
      if (oldest !== undefined) this.clearEntry({ entry: oldest });
      this.entries.delete(oldestNodeId);
    }
    return created;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      this.clearEntry({ entry });
    }
    this.entries.clear();
  }

  private clearEntry({ entry }: { entry: HizoFSDirectoryHandleCache }): void {
    entry.loadedDirectory = undefined;
    entry.entryLookupCache.value = undefined;
  }
}

type HizoFSFileHandleMutationResult = {
  readonly nodeId: string;
  readonly directory: LoadedHizoFSDirectory;
};

type HizoFSDirectoryHandleMutationResult =
  | {
      readonly type: 'node';
      readonly nodeId: string;
      readonly parentDirectory: LoadedHizoFSDirectory;
      readonly childDirectory: LoadedHizoFSDirectory | undefined;
    }
  | {
      readonly type: 'subvolume';
      readonly entry: Extract<
        HizoFSDirectoryEntryDto,
        { readonly kind: 'subvolume' }
      >;
      readonly parentDirectory: LoadedHizoFSDirectory;
    };

type HizoFSReadSubvolumeCreationResult = {
  readonly entry: Extract<
    HizoFSDirectoryEntryDto,
    { readonly kind: 'subvolume' }
  >;
  readonly parentDirectory: LoadedHizoFSDirectory;
};

type HizoFSSubvolumeSnapshotResult =
  HizoFSReadSubvolumeCreationResult;

type ClonedHizoFSSubvolume = {
  readonly subvolumeDescriptorObjectId: string;
};

type HizoFSMountedSubvolumeAttachment = {
  readonly parentSession: HizoFSSession;
  readonly mountId: string;
  readonly subvolumeDescriptorObjectId: string;
};

type HizoFSMountedSubvolumeRegistry = {
  readonly descriptorObjectIdBySubvolumeId: Map<string, string>;
  readonly mountIdentityByDescriptorObjectId: Map<string, string>;
};

type HizoFSFileDirectoryEntry = Extract<
  HizoFSDirectoryEntryDto,
  { readonly kind: 'file' }
>;

function requireFileEntry({
  entry,
  name,
}: {
  entry: HizoFSDirectoryEntryDto;
  name: string;
}): HizoFSFileDirectoryEntry {
  switch (entry.kind) {
  case "file":
    return entry;
  case "directory":
  case "symlink":
  case 'subvolume':
    throw createNamedError({
      name: "TypeMismatchError",
      message: `'${name}' is not a file`,
    });
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
  }
  }
}

function requireDirectoryEntry({
  entry,
  name,
}: {
  entry: HizoFSDirectoryEntryDto;
  name: string;
}): Extract<HizoFSDirectoryEntryDto, { readonly kind: 'directory' }> {
  switch (entry.kind) {
  case "directory":
    return entry;
  case "file":
  case "symlink":
  case 'subvolume':
    throw createNamedError({
      name: "TypeMismatchError",
      message: `'${name}' is not a directory`,
    });
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
  }
  }
}

function isDirectoryEntry({
  entry,
}: {
  entry: HizoFSDirectoryEntryDto;
}): boolean {
  switch (entry.kind) {
  case "directory":
  case 'subvolume':
    return true;
  case "file":
  case "symlink":
    return false;
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
  }
  }
}

function renameHizoFSDirectoryEntry({
  entry,
  name,
}: {
  entry: HizoFSDirectoryEntryDto;
  name: string;
}): HizoFSDirectoryEntryDto {
  switch (entry.kind) {
  case 'file':
    return { name, kind: 'file', nodeId: entry.nodeId };
  case 'directory':
    return { name, kind: 'directory', nodeId: entry.nodeId };
  case 'symlink':
    return { name, kind: 'symlink', nodeId: entry.nodeId };
  case 'subvolume':
    return { name, kind: 'subvolume', mountId: entry.mountId };
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled HizoFS directory entry: ${String(_ex)}`);
  }
  }
}

function createClonedFileRecord({
  source,
  nodeId,
  timestamp,
}: {
  source: LoadedHizoFSFile;
  nodeId: string;
  timestamp: number;
}): {
  readonly inode: HizoFSFileInodeDto;
  readonly binaryPayload: Uint8Array;
} {
  const {
    nodeId: _sourceNodeId,
    revision: _sourceRevision,
    createdAt: _sourceCreatedAt,
    modifiedAt: _sourceModifiedAt,
    size,
    storage,
    ...unhandledInode
  } = source.inode;
  unhandledInode satisfies Record<PropertyKey, never>;

  switch (storage.type) {
  case "inline": {
    const { type, ...unhandledStorage } = storage;
      unhandledStorage satisfies Record<PropertyKey, never>;
      return {
        inode: {
          nodeId,
          revision: 0,
          createdAt: timestamp,
          modifiedAt: timestamp,
          size,
          storage: { type },
        },
        binaryPayload: source.binaryPayload.slice(),
      };
  }
  case "extents": {
    const { type, chunkSize, extentIndexRootObjectId, ...unhandledStorage } =
        storage;
      unhandledStorage satisfies Record<PropertyKey, never>;
      return {
        inode: {
          nodeId,
          revision: 0,
          createdAt: timestamp,
          modifiedAt: timestamp,
          size,
          storage: {
            type,
            chunkSize,
            extentIndexRootObjectId,
          },
        },
        binaryPayload: new Uint8Array(),
      };
  }
  default: {
    const _ex: never = storage;
    throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
  }
  }
}

export class HizoFSSession implements StorageDirectoryWorkerMountSession {
  constructor({
    runtime,
    core,
    subvolumeId,
    rootDirectoryNodeId,
    rootName,
    workerMountContext,
    fixedState,
    sessionLease,
    mountedAttachment,
    subvolumeRuntimePin,
    mountedSubvolumeRegistry,
  }: {
    runtime: HizoFSRuntime;
    core: HizoFSCore;
    subvolumeId: string;
    rootDirectoryNodeId: string;
    rootName: string;
    workerMountContext: Omit<
      StorageDirectoryWorkerMountSource,
      "rootDirectoryNodeId"
    >;
    fixedState: HizoFSFilesystemState | undefined;
    sessionLease: HizoFSMaintenanceLease | undefined;
    mountedAttachment: HizoFSMountedSubvolumeAttachment | undefined;
    subvolumeRuntimePin: HizoFSMaintenanceLease | undefined;
    mountedSubvolumeRegistry?: HizoFSMountedSubvolumeRegistry;
  }) {
    this.runtime = runtime;
    this.core = core;
    this.runtime.retainSession();
    this.directoryReadCache = new HizoFSDirectoryReadCache({
      entryLimit: Math.min(
        DIRECTORY_READ_CACHE_MAXIMUM_ENTRY_COUNT,
        runtime.policy.metadataObjectCacheEntryLimit,
      ),
    });
    this.rootDirectoryNodeId = rootDirectoryNodeId;
    this.subvolumeId = subvolumeId;
    this.fileSystemId = core.fileSystemId;
    this.instanceId = core.instanceId;
    this.workerMountContext = workerMountContext;
    this.fixedState = fixedState;
    this.sessionLease = sessionLease;
    this.mountedAttachment = mountedAttachment;
    this.subvolumeRuntimePin = subvolumeRuntimePin;
    this.mountedSubvolumeRegistry = mountedSubvolumeRegistry ?? {
      descriptorObjectIdBySubvolumeId: new Map([[
        subvolumeId,
        workerMountContext.subvolumeDescriptorObjectId,
      ]]),
      mountIdentityByDescriptorObjectId: new Map([[
        workerMountContext.subvolumeDescriptorObjectId,
        'root',
      ]]),
    };
    this.root = new HizoFSDirectoryHandle({
      session: this,
      nodeId: rootDirectoryNodeId,
      name: rootName,
    });
  }

  readonly capabilities = {
    directBlob: "unsupported" as const,
    symbolicLink: "supported" as const,
    atomicMove: "supported" as const,
    wholeFileClone: "supported" as const,
  };
  readonly root: StorageDirectoryHandle;
  readonly fileSystemId: string;
  readonly instanceId: string;
  readonly subvolumeId: string;
  readonly rootDirectoryNodeId: string;
  readonly runtime: HizoFSRuntime;
  readonly core: HizoFSCore;
  private readonly directoryReadCache: HizoFSDirectoryReadCache;
  private readonly fixedState: HizoFSFilesystemState | undefined;
  private readonly sessionLease: HizoFSMaintenanceLease | undefined;
  private readonly mountedAttachment: HizoFSMountedSubvolumeAttachment | undefined;
  private readonly subvolumeRuntimePin: HizoFSMaintenanceLease | undefined;
  private readonly workerMountContext: Omit<
    StorageDirectoryWorkerMountSource,
    "rootDirectoryNodeId"
  >;
  private readonly resources = new Set<HizoFSSessionResource>();
  private readonly mountedSubvolumeSessions = new Map<
    string,
    Promise<HizoFSSession>
  >();
  private readonly mountedSubvolumeRegistry: HizoFSMountedSubvolumeRegistry;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.resources].map((resource) => resource.dispose()),
    );
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    try {
      await this.sessionLease?.release();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.subvolumeRuntimePin?.release();
    } catch (error) {
      errors.push(error);
    }
    this.directoryReadCache.clear();
    this.runtime.clearPlaintextCaches();
    try {
      await this.runtime.releaseSession();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Failed to close HizoFS session resources",
      );
    }
  }

  async createReadSnapshot(): Promise<StorageFileSystemSession> {
    this.assertOpen();
    const sessionLease = await acquireHizoFSResourceLease({
      instanceId: this.instanceId,
    });
    let subvolumeRuntimePin: HizoFSMaintenanceLease | undefined;
    try {
      subvolumeRuntimePin = this.mountedAttachment === undefined
        ? undefined
        : await acquireHizoFSSubvolumeRuntimePin({
          instanceId: this.instanceId,
          subvolumeId: this.subvolumeId,
          subvolumeDescriptorObjectId:
            this.mountedAttachment.subvolumeDescriptorObjectId,
        });
      const fixedState = await this.loadFilesystemState();
      const snapshot = new HizoFSSession({
        runtime: this.runtime,
        core: this.core,
        subvolumeId: this.subvolumeId,
        rootDirectoryNodeId: fixedState.commit.rootDirectoryNodeId,
        rootName: this.root.name,
        workerMountContext: this.workerMountContext,
        fixedState,
        sessionLease,
        mountedAttachment: this.mountedAttachment,
        subvolumeRuntimePin,
        mountedSubvolumeRegistry: this.mountedSubvolumeRegistry,
      });
      subvolumeRuntimePin = undefined;
      return snapshot;
    } catch (error) {
      const releases = await Promise.allSettled([
        sessionLease.release(),
        subvolumeRuntimePin?.release(),
      ]);
      const releaseErrors = releases.flatMap(result => {
        switch (result.status) {
        case 'fulfilled':
          return [];
        case 'rejected':
          return [result.reason];
        default: {
          const _ex: never = result;
          throw new Error(
            `Unhandled HizoFS lease release result: ${String(_ex)}`,
          );
        }
        }
      });
      if (releaseErrors.length > 0) {
        throw new AggregateError(
          [error, ...releaseErrors],
          'Failed to release HizoFS read snapshot leases after an error',
        );
      }
      throw error;
    }
  }

  loadActiveState(): Promise<HizoFSActiveState> {
    this.assertOpen();
    if (this.fixedState !== undefined) {
      throw new Error('A fixed HizoFS subvolume has no mutable active state');
    }
    return this.core.loadActiveState();
  }

  loadFilesystemState(): Promise<HizoFSFilesystemState> {
    this.assertOpen();
    return this.fixedState === undefined
      ? this.core.loadActiveState()
      : Promise.resolve(this.fixedState);
  }

  private async runWithReadLease<T>({ operation }: {
    operation: () => Promise<T>;
  }): Promise<T> {
    this.assertOpen();
    if (this.sessionLease !== undefined) {
      return await operation();
    }
    const lease = await acquireHizoFSResourceLease({
      instanceId: this.instanceId,
    });
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  assertOpen(): void {
    if (this.closed) {
      throw new Error("HizoFS session is closed");
    }
  }

  private assertMutable(): void {
    if (this.fixedState !== undefined) {
      throw createNamedError({
        name: 'NoModificationAllowedError',
        message: 'HizoFS read subvolume is immutable',
      });
    }
  }

  async createReadSubvolume({
    directoryNodeId,
    name,
  }: {
    directoryNodeId: string;
    name: string;
  }): Promise<StorageDirectoryHandle> {
    return await this.createSubvolume({
      directoryNodeId,
      name,
      access: 'read',
    });
  }

  async createReadWriteSubvolume({
    directoryNodeId,
    name,
  }: {
    directoryNodeId: string;
    name: string;
  }): Promise<StorageDirectoryHandle> {
    return await this.createSubvolume({
      directoryNodeId,
      name,
      access: 'read_write',
    });
  }

  private async createSubvolume({
    directoryNodeId,
    name,
    access,
  }: {
    directoryNodeId: string;
    name: string;
    access: 'read' | 'read_write';
  }): Promise<StorageDirectoryHandle> {
    this.assertOpen();
    this.assertMutable();
    assertHizoFSEntryName({ name });
    const directoryCache = this.directoryReadCache.get({
      nodeId: directoryNodeId,
    });
    const mutation = await this.core
      .mutateTopologyAndReturnState<HizoFSReadSubvolumeCreationResult>({
        operation: async ({ state }) => {
          const parentDirectory = await this.readDirectory({
            state,
            nodeId: directoryNodeId,
            directoryCache,
          });
          const existing = await this.runtime.directoryStorage.getEntryWithCache({
            inode: parentDirectory.inode,
            name,
            lookupCache: directoryCache.entryLookupCache,
          });
          if (existing !== undefined) {
            throw createNamedError({
              name: 'InvalidModificationError',
              message: `Destination '${name}' already exists`,
            });
          }

          const subvolumeId = createHizoFSStableId();
          const mountId = createHizoFSStableId();
          const rootDirectoryNodeId = createHizoFSStableId();
          const timestamp = this.runtime.now();
          const rootDirectoryInode: HizoFSDirectoryInodeDto = {
            nodeId: rootDirectoryNodeId,
            revision: 0,
            createdAt: timestamp,
            modifiedAt: timestamp,
            storage: { type: 'inline', entries: [] },
          };
          const rootDirectoryInodeObjectId =
            await this.runtime.inodeStore.writeDirectory({
              inode: rootDirectoryInode,
            });
          const childInodeIndexRootObjectId =
            await this.runtime.inodeIndex.buildFromSortedEntries({
              entries: [{
                nodeId: rootDirectoryNodeId,
                inodeObjectId: rootDirectoryInodeObjectId,
              }],
            });
          const childMountIndexRootObjectId =
            await this.runtime.subvolumeMountIndex.createEmpty();
          const childCommitObjectId = await this.runtime.commitStore.write({
            commit: {
              revision: 0,
              publicationId: createHizoFSStableId(),
              subvolumeId,
              rootDirectoryNodeId,
              inodeIndexRootObjectId: childInodeIndexRootObjectId,
              subvolumeMountIndexRootObjectId:
                childMountIndexRootObjectId,
            },
          });
          const subvolumeDescriptorObjectId =
            await this.runtime.subvolumeDescriptorStore.write({
              descriptor: createSubvolumeDescriptor({
                subvolumeId,
                access,
                commitObjectId: childCommitObjectId,
              }),
            });
          if (isReadWriteSubvolumeAccess(access)) {
            const childCore = this.runtime.getReadWriteSubvolumeCore({
              subvolumeId,
            });
            for (const sequence of [0, 1] as const) {
              await childCore.superblockStore.write({
                value: {
                  sequence,
                  fileSystemId: this.fileSystemId,
                  subvolumeDescriptorObjectId,
                  activeCommitObjectId: childCommitObjectId,
                },
              });
            }
          }
          const entry = {
            name,
            kind: 'subvolume' as const,
            mountId,
          };
          const [changedParentDirectory, subvolumeMountIndexRootObjectId] =
            await awaitIndependentWrites({
              left: this.runtime.directoryStorage.writeChangedInode({
                inode: parentDirectory.inode,
                changes: [{ type: 'set', entry }],
                modifiedAt: timestamp,
              }),
              right: this.runtime.subvolumeMountIndex.set({
                rootObjectId:
                  state.commit.subvolumeMountIndexRootObjectId,
                mount: {
                  mountId,
                  subvolumeDescriptorObjectId,
                  parentDirectoryNodeId: directoryNodeId,
                  entryName: name,
                },
              }),
            });
          const inodeIndexRootObjectId =
            await this.runtime.nodeService.setInode({
              inodeIndexRootObjectId:
                state.commit.inodeIndexRootObjectId,
              nodeId: directoryNodeId,
              inodeObjectId: changedParentDirectory.inodeObjectId,
            });
          return {
            changed: 'yes' as const,
            inodeIndexRootObjectId,
            subvolumeMountIndexRootObjectId,
            result: {
              entry,
              parentDirectory: changedParentDirectory,
            },
          };
        },
      });
    this.rememberDirectory({
      state: mutation.state,
      directory: mutation.result.parentDirectory,
      directoryCache,
    });
    const childSession = await this.openMountedSubvolumeSessionAfterPublication({
      entry: mutation.result.entry,
      parentDirectoryNodeId: directoryNodeId,
    });
    return new HizoFSDirectoryHandle({
      session: childSession,
      nodeId: childSession.rootDirectoryNodeId,
      name,
    });
  }

  async snapshotSubvolume({
    sourceSession,
    directoryNodeId,
    name,
    access,
  }: {
    sourceSession: HizoFSSession;
    directoryNodeId: string;
    name: string;
    access: 'read' | 'read_write';
  }): Promise<StorageDirectoryHandle> {
    this.assertOpen();
    this.assertMutable();
    sourceSession.assertOpen();
    assertHizoFSEntryName({ name });
    if (sourceSession.fileSystemId !== this.fileSystemId) {
      throw new HizoFSCrossDeviceError({
        message: 'HizoFS snapshots require one shared object store',
      });
    }
    if (
      !(await this.workerMountContext.backingDirectory.isSameEntry(
        sourceSession.workerMountContext.backingDirectory,
      ))
    ) {
      throw new HizoFSCrossDeviceError({
        message: 'HizoFS snapshots require one shared backing directory',
      });
    }
    const directoryCache = this.directoryReadCache.get({
      nodeId: directoryNodeId,
    });
    const sourceFixedState = sourceSession.fixedState;
    const mutation = await this.mutateSnapshotTopology<
      HizoFSSubvolumeSnapshotResult
    >({
      requiresExclusiveMaintenance: sourceFixedState === undefined,
      operation: async ({ state }) => {
        const parentDirectory = await this.readDirectory({
          state,
          nodeId: directoryNodeId,
          directoryCache,
        });
        const existing = await this.runtime.directoryStorage.getEntryWithCache({
          inode: parentDirectory.inode,
          name,
          lookupCache: directoryCache.entryLookupCache,
        });
        if (existing !== undefined) {
          throw createNamedError({
            name: 'InvalidModificationError',
            message: `Destination '${name}' already exists`,
          });
        }

        const sourceState = sourceFixedState
            ?? (sourceSession.subvolumeId === state.commit.subvolumeId
              ? state
              : await sourceSession.loadFilesystemState());
        const cloned = await this.cloneSubvolumeGraph({
          sourceState,
          access,
          visitingSubvolumeIds: new Set<string>(),
          completedSubvolumeIds: new Set<string>(),
        });
        const mountId = createHizoFSStableId();
        const timestamp = this.runtime.now();
        const entry = {
          name,
          kind: 'subvolume' as const,
          mountId,
        };
        const [changedParentDirectory, subvolumeMountIndexRootObjectId] =
            await awaitIndependentWrites({
              left: this.runtime.directoryStorage.writeChangedInode({
                inode: parentDirectory.inode,
                changes: [{ type: 'set', entry }],
                modifiedAt: timestamp,
              }),
              right: this.runtime.subvolumeMountIndex.set({
                rootObjectId:
                  state.commit.subvolumeMountIndexRootObjectId,
                mount: {
                  mountId,
                  subvolumeDescriptorObjectId:
                    cloned.subvolumeDescriptorObjectId,
                  parentDirectoryNodeId: directoryNodeId,
                  entryName: name,
                },
              }),
            });
        const inodeIndexRootObjectId =
            await this.runtime.nodeService.setInode({
              inodeIndexRootObjectId:
                state.commit.inodeIndexRootObjectId,
              nodeId: directoryNodeId,
              inodeObjectId: changedParentDirectory.inodeObjectId,
            });
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          subvolumeMountIndexRootObjectId,
          result: {
            entry,
            parentDirectory: changedParentDirectory,
          },
        };
      },
    });
    this.rememberDirectory({
      state: mutation.state,
      directory: mutation.result.parentDirectory,
      directoryCache,
    });
    const childSession = await this.openMountedSubvolumeSessionAfterPublication({
      entry: mutation.result.entry,
      parentDirectoryNodeId: directoryNodeId,
    });
    return new HizoFSDirectoryHandle({
      session: childSession,
      nodeId: childSession.rootDirectoryNodeId,
      name,
    });
  }

  async deleteSubvolume({
    recursiveSubvolumes,
  }: {
    recursiveSubvolumes: boolean;
  }): Promise<void> {
    this.assertOpen();
    const attachment = this.mountedAttachment;
    if (attachment === undefined) {
      throw createNamedError({
        name: 'InvalidModificationError',
        message: 'The HizoFS root subvolume cannot be deleted',
      });
    }
    await attachment.parentSession.deleteMountedSubvolume({
      childSession: this,
      attachment,
      recursiveSubvolumes,
    });
  }

  private async deleteMountedSubvolume({
    childSession,
    attachment,
    recursiveSubvolumes,
  }: {
    childSession: HizoFSSession;
    attachment: HizoFSMountedSubvolumeAttachment;
    recursiveSubvolumes: boolean;
  }): Promise<void> {
    this.assertOpen();
    this.assertMutable();
    childSession.assertOpen();
    const lease = await acquireHizoFSMaintenanceLease({
      instanceId: this.instanceId,
    });
    try {
      await this.core.mutateTopologyWithResourceLeaseHeldAndReturnState({
        operation: async ({ state }) => {
          const mount = await this.runtime.subvolumeMountIndex.get({
            rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
            mountId: attachment.mountId,
          });
          if (
            mount === undefined
            || mount.subvolumeDescriptorObjectId
              !== attachment.subvolumeDescriptorObjectId
          ) {
            throw createStorageEntryNotFoundError({
              message: 'The HizoFS subvolume is no longer mounted',
            });
          }
          await this.assertMountedSubvolumeLocation({ state, mount });
          const childState = await childSession.loadFilesystemState();
          if (
            childState.subvolumeDescriptorObjectId
              !== mount.subvolumeDescriptorObjectId
          ) {
            throw new HizoFSCorruptionError({
              message: 'HizoFS mounted subvolume descriptor identity changed',
              cause: undefined,
            });
          }
          if (!recursiveSubvolumes) {
            const structure = await this.runtime.subvolumeMountIndex
              .validateStructure({
                rootObjectId:
                  childState.commit.subvolumeMountIndexRootObjectId,
              });
            if (structure.entryCount !== 0) {
              throw createNamedError({
                name: 'InvalidModificationError',
                message: 'The HizoFS subvolume contains child subvolumes',
              });
            }
          }

          const parentDirectory = await this.runtime.nodeService.readDirectory({
            state,
            nodeId: mount.parentDirectoryNodeId,
          });
          const timestamp = this.runtime.now();
          const [changedParentDirectory, subvolumeMountIndexRootObjectId] =
            await awaitIndependentWrites({
              left: this.runtime.directoryStorage.writeChangedInode({
                inode: parentDirectory.inode,
                changes: [{ type: 'delete', name: mount.entryName }],
                modifiedAt: timestamp,
              }),
              right: this.runtime.subvolumeMountIndex.delete({
                rootObjectId:
                  state.commit.subvolumeMountIndexRootObjectId,
                mountId: mount.mountId,
              }),
            });
          const inodeIndexRootObjectId =
            await this.runtime.nodeService.setInode({
              inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
              nodeId: mount.parentDirectoryNodeId,
              inodeObjectId: changedParentDirectory.inodeObjectId,
            });
          return {
            changed: 'yes' as const,
            inodeIndexRootObjectId,
            subvolumeMountIndexRootObjectId,
            result: undefined,
          };
        },
      });
    } finally {
      await lease.release();
    }
  }

  private async assertMountedSubvolumeLocation({
    state,
    mount,
  }: {
    state: HizoFSFilesystemState;
    mount: HizoFSSubvolumeMountDto;
  }): Promise<void> {
    const parentDirectory = await this.runtime.nodeService.readDirectory({
      state,
      nodeId: mount.parentDirectoryNodeId,
    });
    const entry = await this.runtime.directoryStorage.getEntry({
      inode: parentDirectory.inode,
      name: mount.entryName,
    });
    if (
      entry?.kind !== 'subvolume'
      || entry.mountId !== mount.mountId
    ) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS subvolume mount location does not match the namespace',
        cause: undefined,
      });
    }
  }

  private async mutateSnapshotTopology<T>({
    requiresExclusiveMaintenance,
    operation,
  }: {
    requiresExclusiveMaintenance: boolean;
    operation: ({ state }: {
      state: HizoFSActiveState;
    }) => Promise<HizoFSTopologyMutationResult<T>>;
  }): Promise<HizoFSPublishedMutation<T>> {
    if (!requiresExclusiveMaintenance) {
      return await this.core.mutateTopologyAndReturnState({ operation });
    }
    const lease = await acquireHizoFSMaintenanceLease({
      instanceId: this.instanceId,
    });
    try {
      return await this.core
        .mutateTopologyWithResourceLeaseHeldAndReturnState({ operation });
    } finally {
      await lease.release();
    }
  }

  private async cloneSubvolumeGraph({
    sourceState,
    access,
    visitingSubvolumeIds,
    completedSubvolumeIds,
  }: {
    sourceState: HizoFSFilesystemState;
    access: 'read' | 'read_write';
    visitingSubvolumeIds: Set<string>;
    completedSubvolumeIds: Set<string>;
  }): Promise<ClonedHizoFSSubvolume> {
    const sourceSubvolumeId = sourceState.subvolumeDescriptor.subvolumeId;
    if (visitingSubvolumeIds.has(sourceSubvolumeId)) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS subvolume graph contains a cycle',
        cause: undefined,
      });
    }
    if (completedSubvolumeIds.has(sourceSubvolumeId)) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS subvolume graph contains multiple parents',
        cause: undefined,
      });
    }
    visitingSubvolumeIds.add(sourceSubvolumeId);
    try {
      const clonedMounts = [];
      for await (const sourceMount of this.runtime.subvolumeMountIndex.entries({
        rootObjectId:
          sourceState.commit.subvolumeMountIndexRootObjectId,
      })) {
        await this.assertMountedSubvolumeLocation({
          state: sourceState,
          mount: sourceMount,
        });
        const childDescriptor =
          await this.runtime.subvolumeDescriptorStore.read({
            objectId: sourceMount.subvolumeDescriptorObjectId,
          });
        let childState: HizoFSFilesystemState;
        switch (childDescriptor.access) {
        case 'read':
          childState = await loadHizoFSFixedSubvolumeState({
            subvolumeDescriptorObjectId:
              sourceMount.subvolumeDescriptorObjectId,
            commitStore: this.runtime.commitStore,
            subvolumeDescriptorStore:
              this.runtime.subvolumeDescriptorStore,
            inodeIndex: this.runtime.inodeIndex,
            inodeStore: this.runtime.inodeStore,
          });
          break;
        case 'read_write': {
          const childCore = this.runtime.getReadWriteSubvolumeCore({
            subvolumeId: childDescriptor.subvolumeId,
          });
          childState = await childCore.loadActiveState();
          if (
            childState.subvolumeDescriptorObjectId
            !== sourceMount.subvolumeDescriptorObjectId
          ) {
            throw new HizoFSCorruptionError({
              message:
                'HizoFS snapshot source head references an unexpected descriptor',
              cause: undefined,
            });
          }
          break;
        }
        default: {
          const _ex: never = childDescriptor;
          throw new Error(
            `Unhandled HizoFS snapshot source access: ${String(_ex)}`,
          );
        }
        }
        const clonedChild = await this.cloneSubvolumeGraph({
          sourceState: childState,
          access,
          visitingSubvolumeIds,
          completedSubvolumeIds,
        });
        clonedMounts.push({
          mountId: sourceMount.mountId,
          subvolumeDescriptorObjectId:
            clonedChild.subvolumeDescriptorObjectId,
          parentDirectoryNodeId: sourceMount.parentDirectoryNodeId,
          entryName: sourceMount.entryName,
        });
      }
      const subvolumeId = createHizoFSStableId();
      const subvolumeMountIndexRootObjectId =
        await this.runtime.subvolumeMountIndex.buildFromSortedEntries({
          mounts: clonedMounts,
        });
      const commitObjectId = await this.runtime.commitStore.write({
        commit: {
          revision: 0,
          publicationId: createHizoFSStableId(),
          subvolumeId,
          rootDirectoryNodeId: sourceState.commit.rootDirectoryNodeId,
          inodeIndexRootObjectId:
            sourceState.commit.inodeIndexRootObjectId,
          subvolumeMountIndexRootObjectId,
        },
      });
      const subvolumeDescriptorObjectId =
        await this.runtime.subvolumeDescriptorStore.write({
          descriptor: createSubvolumeDescriptor({
            subvolumeId,
            access,
            commitObjectId,
          }),
        });
      if (isReadWriteSubvolumeAccess(access)) {
        const childCore = this.runtime.getReadWriteSubvolumeCore({
          subvolumeId,
        });
        for (const sequence of [0, 1] as const) {
          await childCore.superblockStore.write({
            value: {
              sequence,
              fileSystemId: this.fileSystemId,
              subvolumeDescriptorObjectId,
              activeCommitObjectId: commitObjectId,
            },
          });
        }
      }
      completedSubvolumeIds.add(sourceSubvolumeId);
      return { subvolumeDescriptorObjectId };
    } finally {
      visitingSubvolumeIds.delete(sourceSubvolumeId);
    }
  }

  private async openMountedSubvolumeSession({
    state,
    entry,
    parentDirectoryNodeId,
  }: {
    state: HizoFSFilesystemState;
    entry: Extract<HizoFSDirectoryEntryDto, { readonly kind: 'subvolume' }>;
    parentDirectoryNodeId: string;
  }): Promise<HizoFSSession> {
    const mount = await this.runtime.subvolumeMountIndex.get({
      rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
      mountId: entry.mountId,
    });
    if (mount === undefined) {
      throw new HizoFSCorruptionError({
        message: `HizoFS subvolume mount is missing: ${entry.mountId}`,
        cause: undefined,
      });
    }
    if (
      mount.parentDirectoryNodeId !== parentDirectoryNodeId
      || mount.entryName !== entry.name
    ) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS subvolume mount location does not match the namespace',
        cause: undefined,
      });
    }
    const existing = this.mountedSubvolumeSessions.get(
      mount.subvolumeDescriptorObjectId,
    );
    if (existing !== undefined) {
      const existingSession = await existing;
      const existingAttachment = existingSession.mountedAttachment;
      if (
        existingAttachment?.parentSession !== this
        || existingAttachment.mountId !== mount.mountId
      ) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS subvolume descriptor is mounted from multiple locations',
          cause: undefined,
        });
      }
      return existingSession;
    }

    let openingSubvolumeId: string | undefined;
    let registeredDescriptorIdentity = false;
    let registeredMountIdentity = false;
    const mountIdentity = `${this.subvolumeId}/${mount.mountId}`;
    const opening = (async () => {
      const descriptor = await this.runtime.subvolumeDescriptorStore.read({
        objectId: mount.subvolumeDescriptorObjectId,
      });
      openingSubvolumeId = descriptor.subvolumeId;
      const previousDescriptorObjectId =
        this.mountedSubvolumeRegistry.descriptorObjectIdBySubvolumeId.get(
          descriptor.subvolumeId,
        );
      if (
        previousDescriptorObjectId !== undefined
        && previousDescriptorObjectId !== mount.subvolumeDescriptorObjectId
      ) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS subvolume identity is bound to multiple descriptors',
          cause: undefined,
        });
      }
      const previousMountIdentity =
        this.mountedSubvolumeRegistry.mountIdentityByDescriptorObjectId.get(
          mount.subvolumeDescriptorObjectId,
        );
      if (
        previousMountIdentity !== undefined
        && previousMountIdentity !== mountIdentity
      ) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS subvolume descriptor is mounted from multiple locations',
          cause: undefined,
        });
      }
      if (previousDescriptorObjectId === undefined) {
        this.mountedSubvolumeRegistry.descriptorObjectIdBySubvolumeId.set(
          descriptor.subvolumeId,
          mount.subvolumeDescriptorObjectId,
        );
        registeredDescriptorIdentity = true;
      }
      if (previousMountIdentity === undefined) {
        this.mountedSubvolumeRegistry.mountIdentityByDescriptorObjectId.set(
          mount.subvolumeDescriptorObjectId,
          mountIdentity,
        );
        registeredMountIdentity = true;
      }
      let childCore = this.core;
      let fixedState: HizoFSFilesystemState | undefined;
      let childState: HizoFSFilesystemState;
      switch (descriptor.access) {
      case 'read':
        fixedState = await loadHizoFSFixedSubvolumeState({
          subvolumeDescriptorObjectId: mount.subvolumeDescriptorObjectId,
          commitStore: this.runtime.commitStore,
          subvolumeDescriptorStore: this.runtime.subvolumeDescriptorStore,
          inodeIndex: this.runtime.inodeIndex,
          inodeStore: this.runtime.inodeStore,
        });
        childState = fixedState;
        break;
      case 'read_write':
        childCore = this.runtime.getReadWriteSubvolumeCore({
          subvolumeId: descriptor.subvolumeId,
        });
        childState = await childCore.loadActiveState();
        if (
          childState.subvolumeDescriptorObjectId
          !== mount.subvolumeDescriptorObjectId
        ) {
          throw new HizoFSCorruptionError({
            message: 'HizoFS child head references an unexpected descriptor',
            cause: undefined,
          });
        }
        break;
      default: {
        const _ex: never = descriptor;
        throw new Error(`Unhandled HizoFS child access: ${String(_ex)}`);
      }
      }
      const childSession = new HizoFSSession({
        runtime: this.runtime,
        core: childCore,
        subvolumeId: childState.subvolumeDescriptor.subvolumeId,
        rootDirectoryNodeId: childState.commit.rootDirectoryNodeId,
        rootName: entry.name,
        workerMountContext: {
          ...this.workerMountContext,
          subvolumeDescriptorObjectId:
            childState.subvolumeDescriptorObjectId,
        },
        fixedState,
        sessionLease: undefined,
        mountedAttachment: {
          parentSession: this,
          mountId: entry.mountId,
          subvolumeDescriptorObjectId: mount.subvolumeDescriptorObjectId,
        },
        subvolumeRuntimePin: await acquireHizoFSSubvolumeRuntimePin({
          instanceId: this.instanceId,
          subvolumeId: childState.subvolumeDescriptor.subvolumeId,
          subvolumeDescriptorObjectId: mount.subvolumeDescriptorObjectId,
        }),
        mountedSubvolumeRegistry: this.mountedSubvolumeRegistry,
      });
      if (this.closed) {
        await childSession.close();
        throw new Error('HizoFS session closed while opening a subvolume');
      }
      this.resources.add({ dispose: () => childSession.close() });
      return childSession;
    })();
    this.mountedSubvolumeSessions.set(
      mount.subvolumeDescriptorObjectId,
      opening,
    );
    try {
      return await opening;
    } catch (error) {
      if (
        this.mountedSubvolumeSessions.get(
          mount.subvolumeDescriptorObjectId,
        ) === opening
      ) {
        this.mountedSubvolumeSessions.delete(
          mount.subvolumeDescriptorObjectId,
        );
      }
      if (
        registeredDescriptorIdentity
        && openingSubvolumeId !== undefined
        && this.mountedSubvolumeRegistry.descriptorObjectIdBySubvolumeId.get(
          openingSubvolumeId,
        ) === mount.subvolumeDescriptorObjectId
      ) {
        this.mountedSubvolumeRegistry.descriptorObjectIdBySubvolumeId.delete(
          openingSubvolumeId,
        );
      }
      if (
        registeredMountIdentity
        && this.mountedSubvolumeRegistry.mountIdentityByDescriptorObjectId.get(
          mount.subvolumeDescriptorObjectId,
        ) === mountIdentity
      ) {
        this.mountedSubvolumeRegistry.mountIdentityByDescriptorObjectId.delete(
          mount.subvolumeDescriptorObjectId,
        );
      }
      throw error;
    }
  }

  private async openMountedSubvolumeSessionAfterPublication({
    entry,
    parentDirectoryNodeId,
  }: {
    entry: Extract<HizoFSDirectoryEntryDto, { readonly kind: 'subvolume' }>;
    parentDirectoryNodeId: string;
  }): Promise<HizoFSSession> {
    const lease = await acquireHizoFSResourceLease({
      instanceId: this.instanceId,
    });
    try {
      return await this.openMountedSubvolumeSession({
        state: await this.loadFilesystemState(),
        entry,
        parentDirectoryNodeId,
      });
    } finally {
      await lease.release();
    }
  }

  private async readDirectory({
    state,
    nodeId,
    directoryCache,
  }: {
    state: HizoFSFilesystemState;
    nodeId: string;
    directoryCache: HizoFSDirectoryHandleCache | undefined;
  }): Promise<LoadedHizoFSDirectory> {
    const cached = directoryCache?.loadedDirectory;
    if (cached?.commitObjectId === state.commitObjectId) {
      return cached.directory;
    }
    const directory = await this.runtime.nodeService.readDirectory({
      state,
      nodeId,
    });
    this.rememberDirectory({
      state,
      directory,
      directoryCache,
    });
    return directory;
  }

  private rememberDirectory({
    state,
    directory,
    directoryCache,
  }: {
    state: HizoFSFilesystemState;
    directory: LoadedHizoFSDirectory;
    directoryCache: HizoFSDirectoryHandleCache | undefined;
  }): void {
    if (directoryCache === undefined) return;
    const cached = directoryCache.loadedDirectory;
    if (
      cached !== undefined
      && cached.commitRevision > state.commit.revision
    ) {
      return;
    }
    if (cached?.directory.inodeObjectId !== directory.inodeObjectId) {
      directoryCache.entryLookupCache.value = undefined;
    }
    directoryCache.loadedDirectory = {
      commitObjectId: state.commitObjectId,
      commitRevision: state.commit.revision,
      directory,
    };
  }

  createWorkerMountSource({
    rootDirectoryNodeId,
  }: {
    rootDirectoryNodeId: string;
  }): StorageDirectoryWorkerMountSource {
    this.assertOpen();
    return {
      ...this.workerMountContext,
      rootDirectoryNodeId,
    };
  }

  async openWorkerMountDirectory({
    source,
  }: {
    source: StorageDirectoryWorkerMountSource;
  }): Promise<StorageDirectoryHandle> {
    this.assertOpen();
    if (
      source.fileSystemId !== this.fileSystemId
      || source.instanceId !== this.instanceId
    ) {
      throw new Error("HizoFS Worker mount belongs to a different file system");
    }
    if (
      source.subvolumeDescriptorObjectId
      !== this.workerMountContext.subvolumeDescriptorObjectId
    ) {
      throw new Error(
        'HizoFS Worker mount belongs to a different subvolume',
      );
    }
    if (
      !(await this.workerMountContext.backingDirectory.isSameEntry(
        source.backingDirectory,
      ))
    ) {
      throw new Error(
        "HizoFS Worker mount belongs to a different backing directory",
      );
    }
    return await this.runWithReadLease({
      operation: async () => {
        const state = await this.loadFilesystemState();
        await this.runtime.nodeService.readDirectory({
          state,
          nodeId: source.rootDirectoryNodeId,
        });
        return new HizoFSDirectoryHandle({
          session: this,
          nodeId: source.rootDirectoryNodeId,
          name: "",
        });
      },
    });
  }

  async getFileHandle({
    directoryNodeId,
    name,
    create,
  }: {
    directoryNodeId: string;
    name: string;
    create: boolean;
  }): Promise<StorageFileHandle> {
    this.assertOpen();
    const directoryCache = this.directoryReadCache.get({
      nodeId: directoryNodeId,
    });
    assertHizoFSEntryName({ name });
    if (create) this.assertMutable();
    if (!create) {
      return await this.runWithReadLease({
        operation: async () => {
          const state = await this.loadFilesystemState();
          const directory = await this.readDirectory({
            state,
            nodeId: directoryNodeId,
            directoryCache,
          });
          const entry = await this.runtime.directoryStorage.getEntryWithCache({
            inode: directory.inode,
            name,
            lookupCache: directoryCache.entryLookupCache,
          });
          if (entry === undefined) {
            throw createStorageEntryNotFoundError({
              message: `File '${name}' was not found`,
            });
          }
          const fileEntry = requireFileEntry({ entry, name });
          return new HizoFSFileHandle({
            session: this,
            nodeId: fileEntry.nodeId,
            name,
          });
        },
      });
    }

    const mutation = await this.core.mutateAndReturnState<HizoFSFileHandleMutationResult>({
      operation: async ({ state }) => {
        const directory = await this.readDirectory({
          state,
          nodeId: directoryNodeId,
          directoryCache,
        });
        const existing = await this.runtime.directoryStorage.getEntryWithCache({
          inode: directory.inode,
          name,
          lookupCache: directoryCache.entryLookupCache,
        });
        if (existing !== undefined) {
          const fileEntry = requireFileEntry({ entry: existing, name });
          return {
            changed: "no" as const,
            inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
            result: {
              nodeId: fileEntry.nodeId,
              directory,
            },
          };
        }

        const childNodeId = createHizoFSStableId();
        const timestamp = this.runtime.now();
        const fileInode: HizoFSFileInodeDto = {
          nodeId: childNodeId,
          revision: 0,
          createdAt: timestamp,
          modifiedAt: timestamp,
          size: 0,
          storage: { type: "inline" },
        };
        const [fileInodeObjectId, changedDirectory] =
          await awaitIndependentWrites({
            left: this.runtime.inodeStore.writeFile({
              inode: fileInode,
              binaryPayload: new Uint8Array(),
            }),
            right: this.runtime.directoryStorage.writeChangedInode({
              inode: directory.inode,
              changes: [
                {
                  type: "set",
                  entry: { name, kind: "file", nodeId: childNodeId },
                },
              ],
              modifiedAt: timestamp,
            }),
          });
        const inodeIndexRootObjectId = await this.runtime.nodeService.setInodes({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          entries: [
            { nodeId: childNodeId, inodeObjectId: fileInodeObjectId },
            {
              nodeId: directoryNodeId,
              inodeObjectId: changedDirectory.inodeObjectId,
            },
          ],
        });
        return {
          changed: "yes" as const,
          inodeIndexRootObjectId,
          result: {
            nodeId: childNodeId,
            directory: changedDirectory,
          },
        };
      },
    });
    this.rememberDirectory({
      state: mutation.state,
      directory: mutation.result.directory,
      directoryCache,
    });
    return new HizoFSFileHandle({
      session: this,
      nodeId: mutation.result.nodeId,
      name,
    });
  }

  async getDirectoryHandle({
    directoryNodeId,
    name,
    create,
  }: {
    directoryNodeId: string;
    name: string;
    create: boolean;
  }): Promise<StorageDirectoryHandle> {
    this.assertOpen();
    const directoryCache = this.directoryReadCache.get({
      nodeId: directoryNodeId,
    });
    assertHizoFSEntryName({ name });
    if (create) this.assertMutable();
    if (!create) {
      return await this.runWithReadLease({
        operation: async () => {
          const state = await this.loadFilesystemState();
          const directory = await this.readDirectory({
            state,
            nodeId: directoryNodeId,
            directoryCache,
          });
          const entry = await this.runtime.directoryStorage.getEntryWithCache({
            inode: directory.inode,
            name,
            lookupCache: directoryCache.entryLookupCache,
          });
          if (entry === undefined) {
            throw createStorageEntryNotFoundError({
              message: `Directory '${name}' was not found`,
            });
          }
          if (isSubvolumeDirectoryEntry(entry)) {
            const childSession = await this.openMountedSubvolumeSession({
              state,
              entry,
              parentDirectoryNodeId: directoryNodeId,
            });
            return new HizoFSDirectoryHandle({
              session: childSession,
              nodeId: childSession.rootDirectoryNodeId,
              name,
            });
          }
          const directoryEntry = requireDirectoryEntry({ entry, name });
          return new HizoFSDirectoryHandle({
            session: this,
            nodeId: directoryEntry.nodeId,
            name,
          });
        },
      });
    }

    const mutation = await this.core.mutateAndReturnState<HizoFSDirectoryHandleMutationResult>({
      operation: async ({ state }) => {
        const directory = await this.readDirectory({
          state,
          nodeId: directoryNodeId,
          directoryCache,
        });
        const existing = await this.runtime.directoryStorage.getEntryWithCache({
          inode: directory.inode,
          name,
          lookupCache: directoryCache.entryLookupCache,
        });
        if (existing !== undefined) {
          if (isSubvolumeDirectoryEntry(existing)) {
            return {
              changed: 'no' as const,
              inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
              result: {
                type: 'subvolume' as const,
                entry: existing,
                parentDirectory: directory,
              },
            };
          }
          const directoryEntry = requireDirectoryEntry({
            entry: existing,
            name,
          });
          return {
            changed: "no" as const,
            inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
            result: {
              type: 'node' as const,
              nodeId: directoryEntry.nodeId,
              parentDirectory: directory,
              childDirectory: undefined,
            },
          };
        }

        const childNodeId = createHizoFSStableId();
        const timestamp = this.runtime.now();
        const childInode: HizoFSDirectoryInodeDto = {
          nodeId: childNodeId,
          revision: 0,
          createdAt: timestamp,
          modifiedAt: timestamp,
          storage: { type: "inline", entries: [] },
        };
        const [childInodeObjectId, changedDirectory] =
          await awaitIndependentWrites({
            left: this.runtime.inodeStore.writeDirectory({ inode: childInode }),
            right: this.runtime.directoryStorage.writeChangedInode({
              inode: directory.inode,
              changes: [
                {
                  type: "set",
                  entry: { name, kind: "directory", nodeId: childNodeId },
                },
              ],
              modifiedAt: timestamp,
            }),
          });
        const inodeIndexRootObjectId = await this.runtime.nodeService.setInodes({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          entries: [
            { nodeId: childNodeId, inodeObjectId: childInodeObjectId },
            {
              nodeId: directoryNodeId,
              inodeObjectId: changedDirectory.inodeObjectId,
            },
          ],
        });
        return {
          changed: "yes" as const,
          inodeIndexRootObjectId,
          result: {
            type: 'node' as const,
            nodeId: childNodeId,
            parentDirectory: changedDirectory,
            childDirectory: {
              inodeObjectId: childInodeObjectId,
              inode: childInode,
            },
          },
        };
      },
    });
    this.rememberDirectory({
      state: mutation.state,
      directory: mutation.result.parentDirectory,
      directoryCache,
    });
    switch (mutation.result.type) {
    case 'subvolume': {
      const childSession = await this.openMountedSubvolumeSessionAfterPublication({
        entry: mutation.result.entry,
        parentDirectoryNodeId: directoryNodeId,
      });
      return new HizoFSDirectoryHandle({
        session: childSession,
        nodeId: childSession.rootDirectoryNodeId,
        name,
      });
    }
    case 'node':
      break;
    default: {
      const _ex: never = mutation.result;
      throw new Error(`Unhandled HizoFS directory result: ${String(_ex)}`);
    }
    }
    if (mutation.result.childDirectory !== undefined) {
      this.rememberDirectory({
        state: mutation.state,
        directory: mutation.result.childDirectory,
        directoryCache: this.directoryReadCache.get({
          nodeId: mutation.result.nodeId,
        }),
      });
    }
    return new HizoFSDirectoryHandle({
      session: this,
      nodeId: mutation.result.nodeId,
      name,
    });
  }

  async *entries({
    directoryNodeId,
  }: {
    directoryNodeId: string;
  }): AsyncIterable<readonly [string, StorageEntryHandle]> {
    this.assertOpen();
    const lease = this.sessionLease === undefined
      ? await acquireHizoFSResourceLease({ instanceId: this.instanceId })
      : undefined;
    const resource: HizoFSSessionResource | undefined = lease === undefined
      ? undefined
      : { dispose: () => lease.release() };
    if (resource !== undefined) {
      this.resources.add(resource);
    }
    try {
      const state = await this.loadFilesystemState();
      const directory = await this.readDirectory({
        state,
        nodeId: directoryNodeId,
        directoryCache: this.directoryReadCache.get({
          nodeId: directoryNodeId,
        }),
      });
      for await (const batch of this.runtime.directoryStorage.entryBatches({
        inode: directory.inode,
      })) {
        for (const entry of batch) {
          this.assertOpen();
          switch (entry.kind) {
          case "file":
            yield [
              entry.name,
              new HizoFSFileHandle({
                session: this,
                nodeId: entry.nodeId,
                name: entry.name,
              }),
            ];
            break;
          case "directory":
            yield [
              entry.name,
              new HizoFSDirectoryHandle({
                session: this,
                nodeId: entry.nodeId,
                name: entry.name,
              }),
            ];
            break;
          case "symlink":
            yield [
              entry.name,
              new HizoFSSymlinkHandle({
                session: this,
                nodeId: entry.nodeId,
                name: entry.name,
              }),
            ];
            break;
          case 'subvolume': {
            const childSession = await this.openMountedSubvolumeSession({
              state,
              entry,
              parentDirectoryNodeId: directoryNodeId,
            });
            yield [
              entry.name,
              new HizoFSDirectoryHandle({
                session: childSession,
                nodeId: childSession.rootDirectoryNodeId,
                name: entry.name,
              }),
            ];
            break;
          }
          default: {
            const _ex: never = entry;
            throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
          }
          }
        }
      }
    } finally {
      if (resource !== undefined) {
        this.resources.delete(resource);
      }
      await lease?.release();
    }
  }

  async createSymlink({
    directoryNodeId,
    name,
    target,
  }: {
    directoryNodeId: string;
    name: string;
    target: string;
  }): Promise<StorageSymlinkHandle> {
    this.assertOpen();
    this.assertMutable();
    assertHizoFSEntryName({ name });
    const nodeId = await this.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: directoryNodeId,
        });
        if (
          (await this.runtime.directoryStorage.getEntry({
            inode: directory.inode,
            name,
          })) !== undefined
        ) {
          throw createNamedError({
            name: "InvalidModificationError",
            message: `'${name}' already exists`,
          });
        }
        const childNodeId = createHizoFSStableId();
        const timestamp = this.runtime.now();
        const inode: HizoFSSymlinkInodeDto = {
          nodeId: childNodeId,
          revision: 0,
          createdAt: timestamp,
          modifiedAt: timestamp,
          target,
        };
        const [inodeObjectId, changedDirectory] =
          await awaitIndependentWrites({
            left: this.runtime.inodeStore.writeSymlink({ inode }),
            right: this.runtime.directoryStorage.writeChangedInode({
              inode: directory.inode,
              changes: [
                {
                  type: "set",
                  entry: { name, kind: "symlink", nodeId: childNodeId },
                },
              ],
              modifiedAt: timestamp,
            }),
          });
        const inodeIndexRootObjectId = await this.runtime.nodeService.setInodes({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          entries: [
            { nodeId: childNodeId, inodeObjectId },
            { nodeId: directoryNodeId, inodeObjectId: changedDirectory.inodeObjectId },
          ],
        });
        return {
          changed: "yes" as const,
          inodeIndexRootObjectId,
          result: childNodeId,
        };
      },
    });
    return new HizoFSSymlinkHandle({ session: this, nodeId, name });
  }

  async removeEntry({
    directoryNodeId,
    name,
    recursive,
  }: {
    directoryNodeId: string;
    name: string;
    recursive: boolean;
  }): Promise<void> {
    this.assertOpen();
    this.assertMutable();
    assertHizoFSEntryName({ name });
    await this.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: directoryNodeId,
        });
        const entry = await this.runtime.directoryStorage.getEntry({
          inode: directory.inode,
          name,
        });
        if (entry === undefined) {
          throw createStorageEntryNotFoundError({
            message: `Entry '${name}' was not found`,
          });
        }
        if (isSubvolumeDirectoryEntry(entry)) {
          throw createNamedError({
            name: 'InvalidModificationError',
            message:
              `Subvolume '${name}' must be removed with deleteHizoFSSubvolume()`,
          });
        }
        if (entry.kind === "directory" && !recursive) {
          const child = await this.runtime.nodeService.readDirectory({
            state,
            nodeId: entry.nodeId,
          });
          if (
            !(await this.runtime.directoryStorage.isEmpty({
              inode: child.inode,
            }))
          ) {
            throw createNamedError({
              name: "InvalidModificationError",
              message: `Directory '${name}' is not empty`,
            });
          }
        }
        const deletedNodeIds = await this.collectSubtreeNodeIds({
          state,
          entry,
        });
        const changedDirectory =
          await this.runtime.directoryStorage.writeChangedInode({
            inode: directory.inode,
            changes: [{ type: "delete", name }],
            modifiedAt: this.runtime.now(),
          });
        let inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId: directoryNodeId,
          inodeObjectId: changedDirectory.inodeObjectId,
        });
        inodeIndexRootObjectId = await this.runtime.nodeService.deleteInodes({
          inodeIndexRootObjectId,
          nodeIds: new Set(deletedNodeIds),
        });
        return {
          changed: "yes" as const,
          inodeIndexRootObjectId,
          result: undefined,
        };
      },
    });
  }

  async moveEntry({
    sourceDirectoryNodeId,
    name,
    destination,
    newName,
    replace,
  }: {
    sourceDirectoryNodeId: string;
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<void> {
    this.assertOpen();
    this.assertMutable();
    assertHizoFSEntryName({ name });
    assertHizoFSEntryName({ name: newName });
    if (
      !(destination instanceof HizoFSDirectoryHandle) ||
      destination.session !== this
    ) {
      throw new HizoFSCrossDeviceError({
        message: 'HizoFS atomic move cannot cross a subvolume boundary',
      });
    }
    const destinationNodeId = destination.nodeId;
    if (sourceDirectoryNodeId === destinationNodeId && name === newName) {
      return;
    }

    await this.core.mutateTopologyAndReturnState({
      operation: async ({ state }) => {
        const sourceDirectory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: sourceDirectoryNodeId,
        });
        const sourceEntry = await this.runtime.directoryStorage.getEntry({
          inode: sourceDirectory.inode,
          name,
        });
        if (sourceEntry === undefined) {
          throw createStorageEntryNotFoundError({
            message: `Entry '${name}' was not found`,
          });
        }
        const destinationDirectory =
          sourceDirectoryNodeId === destinationNodeId
            ? sourceDirectory
            : await this.runtime.nodeService.readDirectory({
              state,
              nodeId: destinationNodeId,
            });

        if (
          sourceEntry.kind === "directory" &&
          (await this.directoryContains({
            state,
            rootDirectoryNodeId: sourceEntry.nodeId,
            candidateNodeId: destinationNodeId,
          }))
        ) {
          throw createNamedError({
            name: "InvalidModificationError",
            message:
              "A directory cannot be moved into itself or its descendant",
          });
        }

        const destinationEntry = await this.runtime.directoryStorage.getEntry({
          inode: destinationDirectory.inode,
          name: newName,
        });
        const replacedNodeIds: string[] = [];
        if (destinationEntry !== undefined) {
          if (!replace) {
            throw createNamedError({
              name: "InvalidModificationError",
              message: `Destination '${newName}' already exists`,
            });
          }
          if (
            isDirectoryEntry({ entry: sourceEntry }) !==
            isOrdinaryDirectoryEntry(destinationEntry)
          ) {
            throw createNamedError({
              name: "TypeMismatchError",
              message: "Move replacement kinds are incompatible",
            });
          }
          if (
            isSubvolumeDirectoryEntry(sourceEntry)
            || isSubvolumeDirectoryEntry(destinationEntry)
          ) {
            throw createNamedError({
              name: 'InvalidModificationError',
              message:
                'A subvolume entry cannot replace or be replaced by another entry',
            });
          }
          if (isOrdinaryDirectoryEntry(destinationEntry)) {
            const targetDirectory =
              await this.runtime.nodeService.readDirectory({
                state,
                nodeId: destinationEntry.nodeId,
              });
            if (
              !(await this.runtime.directoryStorage.isEmpty({
                inode: targetDirectory.inode,
              }))
            ) {
              throw createNamedError({
                name: "InvalidModificationError",
                message: "A non-empty destination directory cannot be replaced",
              });
            }
          }
          replacedNodeIds.push(
            ...(await this.collectSubtreeNodeIds({
              state,
              entry: destinationEntry,
            })),
          );
        }

        const timestamp = this.runtime.now();
        const movedEntry = renameHizoFSDirectoryEntry({
          entry: sourceEntry,
          name: newName,
        });
        let inodeIndexRootObjectId = state.commit.inodeIndexRootObjectId;
        if (sourceDirectoryNodeId === destinationNodeId) {
          const changes: HizoFSDirectoryChange[] = [{ type: "delete", name }];
          if (destinationEntry !== undefined && newName !== name) {
            changes.push({ type: "delete", name: newName });
          }
          changes.push({ type: "set", entry: movedEntry });
          const changedDirectory =
            await this.runtime.directoryStorage.writeChangedInode({
              inode: sourceDirectory.inode,
              changes,
              modifiedAt: timestamp,
            });
          inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
            inodeIndexRootObjectId,
            nodeId: sourceDirectoryNodeId,
            inodeObjectId: changedDirectory.inodeObjectId,
          });
        } else {
          const changedSource =
            await this.runtime.directoryStorage.writeChangedInode({
              inode: sourceDirectory.inode,
              changes: [{ type: "delete", name }],
              modifiedAt: timestamp,
            });
          const destinationChanges: HizoFSDirectoryChange[] = [];
          if (destinationEntry !== undefined) {
            destinationChanges.push({ type: "delete", name: newName });
          }
          destinationChanges.push({ type: "set", entry: movedEntry });
          const changedDestination =
            await this.runtime.directoryStorage.writeChangedInode({
              inode: destinationDirectory.inode,
              changes: destinationChanges,
              modifiedAt: timestamp,
            });
          inodeIndexRootObjectId = await this.runtime.nodeService.setInodes({
            inodeIndexRootObjectId,
            entries: [
              { nodeId: sourceDirectoryNodeId, inodeObjectId: changedSource.inodeObjectId },
              { nodeId: destinationNodeId, inodeObjectId: changedDestination.inodeObjectId },
            ],
          });
        }
        inodeIndexRootObjectId = await this.runtime.nodeService.deleteInodes({
          inodeIndexRootObjectId,
          nodeIds: new Set(replacedNodeIds),
        });
        let subvolumeMountIndexRootObjectId =
          state.commit.subvolumeMountIndexRootObjectId;
        if (isSubvolumeDirectoryEntry(sourceEntry)) {
          const mount = await this.runtime.subvolumeMountIndex.get({
            rootObjectId: subvolumeMountIndexRootObjectId,
            mountId: sourceEntry.mountId,
          });
          if (mount === undefined) {
            throw new HizoFSCorruptionError({
              message: 'HizoFS moved subvolume is absent from the mount index',
              cause: undefined,
            });
          }
          if (
            mount.parentDirectoryNodeId !== sourceDirectoryNodeId
            || mount.entryName !== name
          ) {
            throw new HizoFSCorruptionError({
              message: 'HizoFS moved subvolume mount location is inconsistent',
              cause: undefined,
            });
          }
          subvolumeMountIndexRootObjectId =
            await this.runtime.subvolumeMountIndex.set({
              rootObjectId: subvolumeMountIndexRootObjectId,
              mount: {
                ...mount,
                parentDirectoryNodeId: destinationNodeId,
                entryName: newName,
              },
            });
        }
        return {
          changed: "yes" as const,
          inodeIndexRootObjectId,
          subvolumeMountIndexRootObjectId,
          result: undefined,
        };
      },
    });
  }

  async cloneFile({
    sourceDirectoryNodeId,
    name,
    destination,
    newName,
    replace,
  }: {
    sourceDirectoryNodeId: string;
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<StorageFileHandle> {
    this.assertOpen();
    this.assertMutable();
    assertHizoFSEntryName({ name });
    assertHizoFSEntryName({ name: newName });
    if (
      !(destination instanceof HizoFSDirectoryHandle) ||
      destination.session !== this
    ) {
      throw new Error(
        "HizoFS whole-file clone requires a destination from the same session",
      );
    }
    const destinationNodeId = destination.nodeId;
    if (sourceDirectoryNodeId === destinationNodeId && name === newName) {
      throw createNamedError({
        name: "InvalidModificationError",
        message: "A file cannot be cloned over itself",
      });
    }

    const clonedNodeId = await this.core.mutate({
      operation: async ({ state }) => {
        const sourceDirectory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: sourceDirectoryNodeId,
        });
        const sourceEntry = await this.runtime.directoryStorage.getEntry({
          inode: sourceDirectory.inode,
          name,
        });
        if (sourceEntry === undefined) {
          throw createStorageEntryNotFoundError({
            message: `File '${name}' was not found`,
          });
        }
        const sourceFileEntry = requireFileEntry({ entry: sourceEntry, name });
        const sourceFile = await this.runtime.nodeService.readFile({
          state,
          nodeId: sourceFileEntry.nodeId,
        });
        const destinationDirectory =
          sourceDirectoryNodeId === destinationNodeId
            ? sourceDirectory
            : await this.runtime.nodeService.readDirectory({
              state,
              nodeId: destinationNodeId,
            });
        const destinationEntry = await this.runtime.directoryStorage.getEntry({
          inode: destinationDirectory.inode,
          name: newName,
        });
        if (destinationEntry !== undefined) {
          if (!replace) {
            throw createNamedError({
              name: "InvalidModificationError",
              message: `Destination '${newName}' already exists`,
            });
          }
          switch (destinationEntry.kind) {
          case "file":
          case "symlink":
            break;
          case "directory":
          case 'subvolume':
            throw createNamedError({
              name: "TypeMismatchError",
              message: "A file clone cannot replace a directory or subvolume",
            });
          default: {
            const _ex: never = destinationEntry;
            throw new Error(
              `Unhandled HizoFS destination entry kind: ${String(_ex)}`,
            );
          }
          }
          if (destinationEntry.nodeId === sourceFileEntry.nodeId) {
            throw createNamedError({
              name: "InvalidModificationError",
              message:
                "A file cannot be cloned over another reference to itself",
            });
          }
        }

        const nodeId = createHizoFSStableId();
        const timestamp = this.runtime.now();
        const clonedFile = createClonedFileRecord({
          source: sourceFile,
          nodeId,
          timestamp,
        });
        const directoryChanges: HizoFSDirectoryChange[] = [];
        if (destinationEntry !== undefined) {
          directoryChanges.push({ type: "delete", name: newName });
        }
        directoryChanges.push({
          type: "set",
          entry: { name: newName, kind: "file", nodeId },
        });
        const [inodeObjectId, changedDestination] =
          await awaitIndependentWrites({
            left: this.runtime.inodeStore.writeFile(clonedFile),
            right: this.runtime.directoryStorage.writeChangedInode({
              inode: destinationDirectory.inode,
              changes: directoryChanges,
              modifiedAt: timestamp,
            }),
          });
        let inodeIndexRootObjectId = await this.runtime.nodeService.setInodes({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          entries: [
            { nodeId, inodeObjectId },
            { nodeId: destinationNodeId, inodeObjectId: changedDestination.inodeObjectId },
          ],
        });
        if (destinationEntry !== undefined) {
          inodeIndexRootObjectId = await this.runtime.nodeService.deleteInode({
            inodeIndexRootObjectId,
            nodeId: destinationEntry.nodeId,
          });
        }
        return {
          changed: "yes" as const,
          inodeIndexRootObjectId,
          result: nodeId,
        };
      },
    });
    return new HizoFSFileHandle({
      session: this,
      nodeId: clonedNodeId,
      name: newName,
    });
  }

  async getEntryHandle({
    directoryNodeId,
    name,
  }: {
    directoryNodeId: string;
    name: string;
  }): Promise<StorageEntryHandle> {
    assertHizoFSEntryName({ name });
    return await this.runWithReadLease({
      operation: async () => {
        const state = await this.loadFilesystemState();
        const directoryCache = this.directoryReadCache.get({
          nodeId: directoryNodeId,
        });
        const directory = await this.readDirectory({
          state,
          nodeId: directoryNodeId,
          directoryCache,
        });
        const entry = await this.runtime.directoryStorage.getEntryWithCache({
          inode: directory.inode,
          name,
          lookupCache: directoryCache.entryLookupCache,
        });
        if (entry === undefined) {
          throw createStorageEntryNotFoundError({
            message: `Entry '${name}' was not found`,
          });
        }
        switch (entry.kind) {
        case "file":
          return new HizoFSFileHandle({
            session: this,
            nodeId: entry.nodeId,
            name,
          });
        case "directory":
          return new HizoFSDirectoryHandle({
            session: this,
            nodeId: entry.nodeId,
            name,
          });
        case "symlink":
          return new HizoFSSymlinkHandle({
            session: this,
            nodeId: entry.nodeId,
            name,
          });
        case 'subvolume': {
          const childSession = await this.openMountedSubvolumeSession({
            state,
            entry,
            parentDirectoryNodeId: directoryNodeId,
          });
          return new HizoFSDirectoryHandle({
            session: childSession,
            nodeId: childSession.rootDirectoryNodeId,
            name,
          });
        }
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
        }
        }
      },
    });
  }

  async statDirectory({
    nodeId,
  }: {
    nodeId: string;
  }): Promise<StorageFileStat> {
    return await this.runWithReadLease({
      operation: async () => {
        const state = await this.loadFilesystemState();
        const { inode } = await this.readDirectory({
          state,
          nodeId,
          directoryCache: this.directoryReadCache.get({ nodeId }),
        });
        return {
          size: 0,
          createdAt: inode.createdAt ?? undefined,
          modifiedAt: inode.modifiedAt ?? undefined,
        };
      },
    });
  }

  async statFile({ nodeId }: { nodeId: string }): Promise<StorageFileStat> {
    return await this.runWithReadLease({
      operation: async () => {
        const state = await this.loadFilesystemState();
        const { inode } = await this.runtime.nodeService.readFile({
          state,
          nodeId,
        });
        return {
          size: inode.size,
          createdAt: inode.createdAt ?? undefined,
          modifiedAt: inode.modifiedAt ?? undefined,
        };
      },
    });
  }

  async openFileReader({
    nodeId,
    mimeType,
  }: {
    nodeId: string;
    mimeType: string;
  }): Promise<StorageBinaryObjectReadHandle> {
    this.assertOpen();
    const maintenanceLease = await acquireHizoFSResourceLease({
      instanceId: this.instanceId,
    });
    let file;
    try {
      const state = await this.loadFilesystemState();
      file = await this.runtime.nodeService.readFile({ state, nodeId });
    } catch (error) {
      await maintenanceLease.release();
      throw error;
    }
    const reader = new HizoFSFileReader({
      file,
      extentIndex: this.runtime.extentIndex,
      chunkStore: this.runtime.chunkStore,
      mimeType,
      streamChunkSize: this.runtime.policy.readerStreamChunkSize,
      prefetchConcurrency: this.runtime.policy.fileChunkReadPrefetchConcurrency,
      maintenanceLease,
      diagnostics: this.runtime.diagnostics,
      onSettled: () => this.resources.delete(resource),
    });
    const resource: HizoFSSessionResource = { dispose: () => reader.close() };
    this.resources.add(resource);
    return reader;
  }

  async createFileWriter({
    nodeId,
    keepExistingData,
  }: {
    nodeId: string;
    keepExistingData: boolean;
  }): Promise<StorageWritableFile> {
    this.assertOpen();
    this.assertMutable();
    const maintenanceLease = await acquireHizoFSResourceLease({
      instanceId: this.instanceId,
    });
    let baseFile;
    try {
      const state = await this.loadFilesystemState();
      baseFile = await this.runtime.nodeService.readFile({ state, nodeId });
    } catch (error) {
      await maintenanceLease.release();
      throw error;
    }
    const writer = new HizoFSFileWriter({
      core: this.core,
      nodeService: this.runtime.nodeService,
      inodeStore: this.runtime.inodeStore,
      extentIndex: this.runtime.extentIndex,
      chunkStore: this.runtime.chunkStore,
      policy: this.runtime.policy,
      baseFile,
      keepExistingData,
      now: this.runtime.now,
      maintenanceLease,
      diagnostics: this.runtime.diagnostics,
      onSettled: () => this.resources.delete(resource),
    });
    const resource: HizoFSSessionResource = {
      dispose: () =>
        writer.abort({ reason: new Error("HizoFS session closed") }),
    };
    this.resources.add(resource);
    return writer;
  }

  async statSymlink({ nodeId }: { nodeId: string }): Promise<StorageFileStat> {
    return await this.runWithReadLease({
      operation: async () => {
        const state = await this.loadFilesystemState();
        const { inode } = await this.runtime.nodeService.readSymlink({
          state,
          nodeId,
        });
        return {
          size: new TextEncoder().encode(inode.target).byteLength,
          createdAt: inode.createdAt ?? undefined,
          modifiedAt: inode.modifiedAt ?? undefined,
        };
      },
    });
  }

  async readSymlinkTarget({ nodeId }: { nodeId: string }): Promise<string> {
    return await this.runWithReadLease({
      operation: async () => {
        const state = await this.loadFilesystemState();
        return (await this.runtime.nodeService.readSymlink({ state, nodeId }))
          .inode.target;
      },
    });
  }

  private async collectSubtreeNodeIds({
    state,
    entry,
  }: {
    state: HizoFSActiveState;
    entry: HizoFSDirectoryEntryDto;
  }): Promise<readonly string[]> {
    if (isSubvolumeDirectoryEntry(entry)) {
      throw createNamedError({
        name: 'InvalidModificationError',
        message: 'Subvolume entries require explicit subvolume deletion',
      });
    }
    const result: string[] = [];
    const pending: Array<{
      readonly entry: Exclude<
        HizoFSDirectoryEntryDto,
        { readonly kind: 'subvolume' }
      >;
      readonly visitedChildren: boolean;
    }> = [{ entry, visitedChildren: false }];
    const discovered = new Set<string>();

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (current.visitedChildren) {
        result.push(current.entry.nodeId);
        continue;
      }
      if (discovered.has(current.entry.nodeId)) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS namespace contains a cycle or duplicate inode reference',
          cause: undefined,
        });
      }
      discovered.add(current.entry.nodeId);
      pending.push({ entry: current.entry, visitedChildren: true });

      switch (current.entry.kind) {
      case 'directory': {
        const directory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: current.entry.nodeId,
        });
        const children: HizoFSDirectoryEntryDto[] = [];
        for await (const child of this.runtime.directoryStorage.entries({
          inode: directory.inode,
        })) {
          children.push(child);
        }
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child !== undefined) {
            if (isSubvolumeDirectoryEntry(child)) {
              throw createNamedError({
                name: 'InvalidModificationError',
                message: 'Subvolume entries require explicit subvolume deletion',
              });
            }
            pending.push({ entry: child, visitedChildren: false });
          }
        }
        break;
      }
      case 'file':
      case 'symlink':
        break;
      default: {
        const _ex: never = current.entry;
        throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
      }
      }
    }

    return result;
  }

  private async directoryContains({
    state,
    rootDirectoryNodeId,
    candidateNodeId,
  }: {
    state: HizoFSActiveState;
    rootDirectoryNodeId: string;
    candidateNodeId: string;
  }): Promise<boolean> {
    if (rootDirectoryNodeId === candidateNodeId) {
      return true;
    }
    const directory = await this.runtime.nodeService.readDirectory({
      state,
      nodeId: rootDirectoryNodeId,
    });
    for await (const entry of this.runtime.directoryStorage.entries({
      inode: directory.inode,
    })) {
      if (
        entry.kind === "directory" &&
        (await this.directoryContains({
          state,
          rootDirectoryNodeId: entry.nodeId,
          candidateNodeId,
        }))
      ) {
        return true;
      }
    }
    return false;
  }
}

class HizoFSDirectoryHandle implements StorageDirectoryHandle {
  readonly kind = "directory" as const;

  constructor({
    session,
    nodeId,
    name,
  }: {
    session: HizoFSSession;
    nodeId: string;
    name: string;
  }) {
    this.session = session;
    this.nodeId = nodeId;
    this.name = name;
  }

  readonly session: HizoFSSession;
  readonly nodeId: string;
  readonly name: string;
  stat(): Promise<StorageFileStat> {
    return this.session.statDirectory({ nodeId: this.nodeId });
  }

  getFileHandle({
    name,
    create,
  }: {
    name: string;
    create: boolean;
  }): Promise<StorageFileHandle> {
    return this.session.getFileHandle({
      directoryNodeId: this.nodeId,
      name,
      create,
    });
  }

  getDirectoryHandle({
    name,
    create,
  }: {
    name: string;
    create: boolean;
  }): Promise<StorageDirectoryHandle> {
    return this.session.getDirectoryHandle({
      directoryNodeId: this.nodeId,
      name,
      create,
    });
  }

  getEntryHandle({
    name,
  }: {
    name: string;
  }): Promise<StorageEntryHandle> {
    return this.session.getEntryHandle({
      directoryNodeId: this.nodeId,
      name,
    });
  }

  entries(): AsyncIterable<readonly [string, StorageEntryHandle]> {
    return this.session.entries({ directoryNodeId: this.nodeId });
  }

  removeEntry({
    name,
    recursive,
  }: {
    name: string;
    recursive: boolean;
  }): Promise<void> {
    return this.session.removeEntry({
      directoryNodeId: this.nodeId,
      name,
      recursive,
    });
  }

  createSymlink({
    name,
    target,
  }: {
    name: string;
    target: string;
  }): Promise<StorageSymlinkHandle> {
    return this.session.createSymlink({
      directoryNodeId: this.nodeId,
      name,
      target,
    });
  }

  moveEntry({
    name,
    destination,
    newName,
    replace,
  }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<void> {
    return this.session.moveEntry({
      sourceDirectoryNodeId: this.nodeId,
      name,
      destination,
      newName,
      replace,
    });
  }

  cloneFile({
    name,
    destination,
    newName,
    replace,
  }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<StorageFileHandle> {
    return this.session.cloneFile({
      sourceDirectoryNodeId: this.nodeId,
      name,
      destination,
      newName,
      replace,
    });
  }

  createWorkerMountSource(): StorageDirectoryWorkerMountSource {
    return this.session.createWorkerMountSource({
      rootDirectoryNodeId: this.nodeId,
    });
  }
}

class HizoFSFileHandle implements StorageFileHandle {
  readonly kind = "file" as const;

  constructor({
    session,
    nodeId,
    name,
  }: {
    session: HizoFSSession;
    nodeId: string;
    name: string;
  }) {
    this.session = session;
    this.nodeId = nodeId;
    this.name = name;
  }

  readonly name: string;
  private readonly session: HizoFSSession;
  private readonly nodeId: string;

  stat(): Promise<StorageFileStat> {
    return this.session.statFile({ nodeId: this.nodeId });
  }

  openReadable({
    mimeType,
  }: {
    mimeType: string;
  }): Promise<StorageBinaryObjectReadHandle> {
    return this.session.openFileReader({ nodeId: this.nodeId, mimeType });
  }

  createWritable({
    keepExistingData,
  }: {
    keepExistingData: boolean;
  }): Promise<StorageWritableFile> {
    return this.session.createFileWriter({
      nodeId: this.nodeId,
      keepExistingData,
    });
  }
}

class HizoFSSymlinkHandle implements StorageSymlinkHandle {
  readonly kind = "symlink" as const;

  constructor({
    session,
    nodeId,
    name,
  }: {
    session: HizoFSSession;
    nodeId: string;
    name: string;
  }) {
    this.session = session;
    this.nodeId = nodeId;
    this.name = name;
  }

  readonly name: string;
  private readonly session: HizoFSSession;
  private readonly nodeId: string;

  stat(): Promise<StorageFileStat> {
    return this.session.statSymlink({ nodeId: this.nodeId });
  }

  readTarget(): Promise<string> {
    return this.session.readSymlinkTarget({ nodeId: this.nodeId });
  }
}

export function getHizoFSDirectoryHandleContext({
  handle,
}: {
  handle: StorageDirectoryHandle;
}): {
  readonly session: HizoFSSession;
  readonly nodeId: string;
  readonly subvolumeRoot: boolean;
} | undefined {
  if (!(handle instanceof HizoFSDirectoryHandle)) return undefined;
  return {
    session: handle.session,
    nodeId: handle.nodeId,
    subvolumeRoot: handle.nodeId === handle.session.rootDirectoryNodeId,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  HizoFSDirectoryHandle,
};
