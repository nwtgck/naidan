import type {
  HizoFSDirectoryEntryDto,
  HizoFSDirectoryInodeDto,
  HizoFSFileExtentDto,
  HizoFSFileInodeDto,
  HizoFSSymlinkInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type {
  StorageDirectoryHandle,
  StorageFileHandle,
  StorageSymlinkHandle,
} from '@/00-storage/service/storage-file-system/types';
import { createHizoFSStableId } from '@/00-storage/service/hizofs/id';
import { Semaphore } from '@/utils/concurrency';
import type { HizoFSActiveState } from './core';
import { acquireHizoFSResourceLease, type HizoFSMaintenanceLease } from './maintenance-lock';
import type { HizoFSInodeIndexEntry } from './inode-index';
import { compareHizoFSStrings } from './ordering';
import type { HizoFSRuntime } from './runtime';
import { assertHizoFSEntryName } from './semantic-validation';

const BULK_READ_BUFFER_BYTE_LENGTH = 256 * 1024;
const EMPTY_BINARY_PAYLOAD = new Uint8Array();

export type HizoFSBulkImportProgressListener = ({
  byteLength,
  completedEntries,
}: {
  byteLength: number;
  completedEntries: number;
}) => void;

type ImportedNode = {
  readonly entry: HizoFSDirectoryEntryDto;
};

type PendingObjectWriteResult =
  | { readonly status: 'fulfilled' }
  | { readonly status: 'rejected'; readonly error: unknown };

type PendingObjectWrite = {
  readonly result: Promise<PendingObjectWriteResult>;
};

type ObjectWriteFailure = {
  readonly error: unknown;
};

function resolveTimestamp({
  primary,
  secondary,
  fallback,
}: {
  primary: number | undefined;
  secondary: number | undefined;
  fallback: number;
}): number {
  return primary ?? secondary ?? fallback;
}

export class HizoFSBulkBuilder {
  static async create({
    runtime,
    rootDirectoryNodeId,
    onSettled,
  }: {
    runtime: HizoFSRuntime;
    rootDirectoryNodeId: string;
    onSettled: () => void;
  }): Promise<HizoFSBulkBuilder> {
    const maintenanceLease = await acquireHizoFSResourceLease({
      instanceId: runtime.core.instanceId,
    });
    try {
      const baseState = await runtime.core.loadActiveState();
      switch (baseState.stateSelection) {
      case 'current':
        break;
      case 'fallback':
        throw new Error('Cannot bulk-build into a fallback HizoFS generation');
      default: {
        const _ex: never = baseState.stateSelection;
        throw new Error(`Unhandled HizoFS active state mode: ${String(_ex)}`);
      }
      }
      const rootDirectory = await runtime.nodeService.readDirectory({
        state: baseState,
        nodeId: rootDirectoryNodeId,
      });
      const inodeIndex = await runtime.inodeIndex.validateStructure({
        rootObjectId: baseState.commit.inodeIndexRootObjectId,
      });
      if (
        baseState.commit.revision !== 0
        || rootDirectory.inode.revision !== 0
        || inodeIndex.entryCount !== 1
        || !(await runtime.directoryStorage.isEmpty({ inode: rootDirectory.inode }))
      ) {
        throw new Error('HizoFS bulk builder requires a fresh empty target');
      }
      return new HizoFSBulkBuilder({
        runtime,
        rootDirectoryNodeId,
        baseState,
        rootCreatedAt: rootDirectory.inode.createdAt,
        rootModifiedAt: rootDirectory.inode.modifiedAt,
        maintenanceLease,
        onSettled,
      });
    } catch (error) {
      await maintenanceLease.release();
      throw error;
    }
  }

  private constructor({
    runtime,
    rootDirectoryNodeId,
    baseState,
    rootCreatedAt,
    rootModifiedAt,
    maintenanceLease,
    onSettled,
  }: {
    runtime: HizoFSRuntime;
    rootDirectoryNodeId: string;
    baseState: HizoFSActiveState;
    rootCreatedAt: number | null;
    rootModifiedAt: number | null;
    maintenanceLease: HizoFSMaintenanceLease;
    onSettled: () => void;
  }) {
    this.runtime = runtime;
    this.rootDirectoryNodeId = rootDirectoryNodeId;
    this.baseState = baseState;
    this.rootCreatedAt = rootCreatedAt;
    this.rootModifiedAt = rootModifiedAt;
    this.maintenanceLease = maintenanceLease;
    this.onSettled = onSettled;
    this.objectWriteConcurrency = runtime.policy.fileChunkWriteConcurrency;
    if (
      !Number.isSafeInteger(this.objectWriteConcurrency)
      || this.objectWriteConcurrency < 1
    ) {
      throw new Error('HizoFS bulk object-write concurrency must be positive');
    }
  }

  private readonly runtime: HizoFSRuntime;
  private readonly rootDirectoryNodeId: string;
  private readonly baseState: HizoFSActiveState;
  private rootCreatedAt: number | null;
  private rootModifiedAt: number | null;
  private readonly maintenanceLease: HizoFSMaintenanceLease;
  private readonly onSettled: () => void;
  private readonly objectWriteConcurrency: number;
  private readonly objectWriteEnqueueSemaphore = new Semaphore({ maxConcurrency: 1 });
  private readonly rootEntries: HizoFSDirectoryEntryDto[] = [];
  private readonly rootEntryNames = new Set<string>();
  private readonly inodeIndexEntries: HizoFSInodeIndexEntry[] = [];
  private readonly pendingObjectWrites = new Map<number, PendingObjectWrite>();
  private nextPendingObjectWriteId = 0;
  private objectWriteFailure: ObjectWriteFailure | undefined;
  private settled = false;
  private operationActive = false;
  private operationSettled: PromiseWithResolvers<void> | undefined;

  async importRootMetadata({
    source,
  }: {
    source: StorageDirectoryHandle;
  }): Promise<void> {
    const finishOperation = this.beginOperation();
    try {
      const stat = await source.stat();
      this.assertOpen();
      this.rootCreatedAt = stat.createdAt ?? stat.modifiedAt ?? this.rootCreatedAt;
      this.rootModifiedAt = stat.modifiedAt ?? stat.createdAt ?? this.rootModifiedAt;
    } finally {
      finishOperation();
    }
  }

  async importDirectory({
    source,
    name,
    excludedNames,
    signal,
    onProgress,
  }: {
    source: StorageDirectoryHandle;
    name: string;
    excludedNames: ReadonlySet<string>;
    signal: AbortSignal | undefined;
    onProgress: HizoFSBulkImportProgressListener | undefined;
  }): Promise<void> {
    const finishOperation = this.beginOperation();
    this.reserveUniqueRootName({ name });
    try {
      const imported = await this.importDirectoryNode({
        source,
        name,
        excludedNames,
        signal,
        onProgress,
      });
      signal?.throwIfAborted();
      this.assertOpen();
      this.rootEntries.push(imported.entry);
    } catch (error) {
      this.rootEntryNames.delete(name);
      throw error;
    } finally {
      finishOperation();
    }
  }

  async createEmptyDirectory({
    name,
  }: {
    name: string;
  }): Promise<void> {
    const finishOperation = this.beginOperation();
    this.reserveUniqueRootName({ name });
    try {
      const timestamp = this.runtime.now();
      const nodeId = createHizoFSStableId();
      const inode: HizoFSDirectoryInodeDto = {
        nodeId,
        revision: 0,
        createdAt: timestamp,
        modifiedAt: timestamp,
        storage: { type: 'inline', entries: [] },
      };
      await this.scheduleInodeObjectWrite({
        nodeId,
        operation: async () => await this.runtime.inodeStore.writeDirectory({ inode }),
      });
      this.assertOpen();
      this.rootEntries.push({ name, kind: 'directory', nodeId });
    } catch (error) {
      this.rootEntryNames.delete(name);
      throw error;
    } finally {
      finishOperation();
    }
  }

  async createEmptyFile({
    name,
  }: {
    name: string;
  }): Promise<void> {
    const finishOperation = this.beginOperation();
    this.reserveUniqueRootName({ name });
    try {
      const timestamp = this.runtime.now();
      const nodeId = createHizoFSStableId();
      const inode: HizoFSFileInodeDto = {
        nodeId,
        revision: 0,
        createdAt: timestamp,
        modifiedAt: timestamp,
        size: 0,
        storage: { type: 'inline' },
      };
      this.assertOpen();
      await this.scheduleInodeObjectWrite({
        nodeId,
        operation: async () => await this.runtime.inodeStore.writeFile({
          inode,
          binaryPayload: EMPTY_BINARY_PAYLOAD,
        }),
      });
      this.assertOpen();
      this.rootEntries.push({ name, kind: 'file', nodeId });
    } catch (error) {
      this.rootEntryNames.delete(name);
      throw error;
    } finally {
      finishOperation();
    }
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.assertNoActiveOperation();
    this.settled = true;
    await this.operationSettled?.promise;
    try {
      await this.waitForAllPendingObjectWrites({ failureMode: 'throw' });
      this.rootEntries.sort((left, right) => compareHizoFSStrings({
        left: left.name,
        right: right.name,
      }));
      const rootInode = await this.writeDirectoryInode({
        nodeId: this.rootDirectoryNodeId,
        revision: 1,
        createdAt: this.rootCreatedAt,
        modifiedAt: this.rootModifiedAt,
        entries: this.rootEntries,
      });
      this.inodeIndexEntries.push({
        nodeId: this.rootDirectoryNodeId,
        inodeObjectId: rootInode,
      });
      this.inodeIndexEntries.sort((left, right) => compareHizoFSStrings({
        left: left.nodeId,
        right: right.nodeId,
      }));
      const inodeIndexRootObjectId = await this.runtime.inodeIndex
        .buildFromSortedEntries({ entries: this.inodeIndexEntries });

      await this.runtime.core.mutateWithResourceLeaseHeld({
        operation: async ({ state }) => {
          if (state.commitObjectId !== this.baseState.commitObjectId) {
            throw new Error('HizoFS bulk-build target changed before publication');
          }
          return {
            changed: 'yes' as const,
            inodeIndexRootObjectId,
            result: undefined,
          };
        },
      });
    } finally {
      try {
        await this.maintenanceLease.release();
      } finally {
        this.onSettled();
      }
    }
  }

  async abort({ reason: _reason }: { reason: unknown }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    try {
      await this.waitForAllPendingObjectWrites({ failureMode: 'ignore' });
    } finally {
      try {
        await this.maintenanceLease.release();
      } finally {
        this.onSettled();
      }
    }
  }

  private async importDirectoryNode({
    source,
    name,
    excludedNames,
    signal,
    onProgress,
  }: {
    source: StorageDirectoryHandle;
    name: string;
    excludedNames: ReadonlySet<string>;
    signal: AbortSignal | undefined;
    onProgress: HizoFSBulkImportProgressListener | undefined;
  }): Promise<ImportedNode> {
    signal?.throwIfAborted();
    assertHizoFSEntryName({ name });
    const nodeId = createHizoFSStableId();
    const entries: HizoFSDirectoryEntryDto[] = [];
    for await (const [childName, child] of source.entries()) {
      signal?.throwIfAborted();
      if (excludedNames.has(childName)) continue;
      switch (child.kind) {
      case 'directory': {
        const imported = await this.importDirectoryNode({
          source: child,
          name: childName,
          excludedNames: new Set(),
          signal,
          onProgress,
        });
        entries.push(imported.entry);
        break;
      }
      case 'file':
        entries.push((await this.importFileNode({
          source: child,
          name: childName,
          signal,
          onProgress,
        })).entry);
        break;
      case 'symlink':
        entries.push((await this.importSymlinkNode({
          source: child,
          name: childName,
          signal,
          onProgress,
        })).entry);
        break;
      default: {
        const _ex: never = child;
        throw new Error(`Unhandled HizoFS bulk source entry: ${String(_ex)}`);
      }
      }
    }
    entries.sort((left, right) => compareHizoFSStrings({
      left: left.name,
      right: right.name,
    }));
    const stat = await source.stat();
    signal?.throwIfAborted();
    this.assertOpen();
    const now = this.runtime.now();
    await this.scheduleInodeObjectWrite({
      nodeId,
      operation: async () => await this.writeDirectoryInode({
        nodeId,
        revision: 0,
        createdAt: resolveTimestamp({
          primary: stat.createdAt,
          secondary: stat.modifiedAt,
          fallback: now,
        }),
        modifiedAt: resolveTimestamp({
          primary: stat.modifiedAt,
          secondary: stat.createdAt,
          fallback: now,
        }),
        entries,
      }),
      onFulfilled: () => onProgress?.({ byteLength: 0, completedEntries: 1 }),
    });
    return {
      entry: { name, kind: 'directory', nodeId },
    };
  }

  private async importFileNode({
    source,
    name,
    signal,
    onProgress,
  }: {
    source: StorageFileHandle;
    name: string;
    signal: AbortSignal | undefined;
    onProgress: HizoFSBulkImportProgressListener | undefined;
  }): Promise<ImportedNode> {
    assertHizoFSEntryName({ name });
    const stat = await source.stat();
    signal?.throwIfAborted();
    this.assertOpen();
    const nodeId = createHizoFSStableId();
    const readable = await source.openReadable({
      mimeType: 'application/octet-stream',
    });
    signal?.throwIfAborted();
    this.assertOpen();
    try {
      const now = this.runtime.now();
      const createdAt = resolveTimestamp({
        primary: stat.createdAt,
        secondary: stat.modifiedAt,
        fallback: now,
      });
      const modifiedAt = resolveTimestamp({
        primary: stat.modifiedAt,
        secondary: stat.createdAt,
        fallback: now,
      });
      let inode: HizoFSFileInodeDto;
      let binaryPayload: Uint8Array;
      if (stat.size <= this.runtime.policy.inlineFileByteLimit) {
        binaryPayload = new Uint8Array(stat.size);
        await this.readExactly({
          readable,
          buffer: binaryPayload,
          position: 0,
          signal,
          onBytesRead: ({ byteLength }) => onProgress?.({
            byteLength,
            completedEntries: 0,
          }),
        });
        inode = {
          nodeId,
          revision: 0,
          createdAt,
          modifiedAt,
          size: stat.size,
          storage: { type: 'inline' },
        };
      } else {
        const { runtime } = this;
        const readExactly = this.readExactly.bind(this);
        async function* streamExtents(): AsyncIterable<HizoFSFileExtentDto> {
          const buffer = new Uint8Array(runtime.policy.fileChunkSize);
          let position = 0;
          let chunkIndex = 0;
          while (position < stat.size) {
            signal?.throwIfAborted();
            const length = Math.min(buffer.byteLength, stat.size - position);
            await readExactly({
              readable,
              buffer: buffer.subarray(0, length),
              position,
              signal,
              onBytesRead: ({ byteLength }) => onProgress?.({
                byteLength,
                completedEntries: 0,
              }),
            });
            let storedLength = length;
            while (storedLength > 0 && buffer[storedLength - 1] === 0) {
              storedLength -= 1;
            }
            if (storedLength > 0) {
              yield {
                chunkIndex,
                chunkObjectId: await runtime.chunkStore.write({
                  binaryPayload: buffer.slice(0, storedLength),
                  chunkSize: runtime.policy.fileChunkSize,
                }),
              };
            }
            buffer.fill(0, 0, length);
            position += length;
            chunkIndex += 1;
          }
        }
        const extentIndexRootObjectId = await this.runtime.extentIndex
          .buildFromSortedExtents({ extents: streamExtents() });
        binaryPayload = new Uint8Array();
        inode = {
          nodeId,
          revision: 0,
          createdAt,
          modifiedAt,
          size: stat.size,
          storage: {
            type: 'extents',
            chunkSize: this.runtime.policy.fileChunkSize,
            extentIndexRootObjectId,
          },
        };
      }
      await this.scheduleInodeObjectWrite({
        nodeId,
        operation: async () => await this.runtime.inodeStore.writeFile({
          inode,
          binaryPayload,
        }),
        onFulfilled: () => onProgress?.({ byteLength: 0, completedEntries: 1 }),
      });
      return {
        entry: { name, kind: 'file', nodeId },
      };
    } finally {
      await readable.close();
    }
  }

  private async importSymlinkNode({
    source,
    name,
    signal,
    onProgress,
  }: {
    source: StorageSymlinkHandle;
    name: string;
    signal: AbortSignal | undefined;
    onProgress: HizoFSBulkImportProgressListener | undefined;
  }): Promise<ImportedNode> {
    assertHizoFSEntryName({ name });
    const stat = await source.stat();
    signal?.throwIfAborted();
    this.assertOpen();
    const now = this.runtime.now();
    const nodeId = createHizoFSStableId();
    const inode: HizoFSSymlinkInodeDto = {
      nodeId,
      revision: 0,
      createdAt: resolveTimestamp({
        primary: stat.createdAt,
        secondary: stat.modifiedAt,
        fallback: now,
      }),
      modifiedAt: resolveTimestamp({
        primary: stat.modifiedAt,
        secondary: stat.createdAt,
        fallback: now,
      }),
      target: await source.readTarget(),
    };
    signal?.throwIfAborted();
    this.assertOpen();
    await this.scheduleInodeObjectWrite({
      nodeId,
      operation: async () => await this.runtime.inodeStore.writeSymlink({ inode }),
      onFulfilled: () => onProgress?.({ byteLength: 0, completedEntries: 1 }),
    });
    return {
      entry: { name, kind: 'symlink', nodeId },
    };
  }

  private async writeDirectoryInode({
    nodeId,
    revision,
    createdAt,
    modifiedAt,
    entries,
  }: {
    nodeId: string;
    revision: number;
    createdAt: number | null;
    modifiedAt: number | null;
    entries: readonly HizoFSDirectoryEntryDto[];
  }): Promise<string> {
    let storage: HizoFSDirectoryInodeDto['storage'];
    if (entries.length <= this.runtime.policy.inlineDirectoryEntryLimit) {
      storage = { type: 'inline', entries };
    } else {
      storage = {
        type: 'indexed',
        directoryIndexRootObjectId: await this.runtime.directoryIndex
          .buildFromSortedEntries({ entries }),
      };
    }
    return await this.runtime.inodeStore.writeDirectory({
      inode: {
        nodeId,
        revision,
        createdAt,
        modifiedAt,
        storage,
      },
    });
  }

  private async scheduleInodeObjectWrite({
    nodeId,
    operation,
    onFulfilled,
  }: {
    nodeId: string;
    operation: () => Promise<string>;
    onFulfilled?: () => void;
  }): Promise<void> {
    await this.objectWriteEnqueueSemaphore.run({
      task: async () => {
        this.assertOpen();
        this.throwIfObjectWriteFailed();
        await this.waitForPendingObjectWriteCapacity();
        this.assertOpen();
        this.throwIfObjectWriteFailed();
        const pendingObjectWriteId = this.nextPendingObjectWriteId;
        this.nextPendingObjectWriteId += 1;
        const result = (async (): Promise<PendingObjectWriteResult> => {
          try {
            const inodeObjectId = await operation();
            this.inodeIndexEntries.push({ nodeId, inodeObjectId });
            onFulfilled?.();
            return { status: 'fulfilled' };
          } catch (error) {
            this.objectWriteFailure ??= { error };
            return { status: 'rejected', error };
          }
        })();
        this.pendingObjectWrites.set(pendingObjectWriteId, { result });
      },
    });
  }

  private async waitForPendingObjectWriteCapacity(): Promise<void> {
    while (this.pendingObjectWrites.size >= this.objectWriteConcurrency) {
      const oldestPendingObjectWriteId = this.pendingObjectWrites.keys().next().value as
        number | undefined;
      if (oldestPendingObjectWriteId === undefined) return;
      await this.waitForPendingObjectWrite({
        pendingObjectWriteId: oldestPendingObjectWriteId,
      });
    }
  }

  private async waitForPendingObjectWrite({
    pendingObjectWriteId,
  }: {
    pendingObjectWriteId: number;
  }): Promise<void> {
    const pending = this.pendingObjectWrites.get(pendingObjectWriteId);
    if (pending === undefined) return;
    let result: PendingObjectWriteResult;
    try {
      result = await pending.result;
    } finally {
      if (this.pendingObjectWrites.get(pendingObjectWriteId) === pending) {
        this.pendingObjectWrites.delete(pendingObjectWriteId);
      }
    }
    switch (result.status) {
    case 'fulfilled':
      return;
    case 'rejected':
      throw result.error;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS bulk object-write result: ${String(_ex)}`);
    }
    }
  }

  private async waitForAllPendingObjectWrites({
    failureMode,
  }: {
    failureMode: 'ignore' | 'throw';
  }): Promise<void> {
    const entries = [...this.pendingObjectWrites.entries()];
    const results = await Promise.allSettled(
      entries.map(([, pending]) => pending.result),
    );
    for (const [pendingObjectWriteId, pending] of entries) {
      if (this.pendingObjectWrites.get(pendingObjectWriteId) === pending) {
        this.pendingObjectWrites.delete(pendingObjectWriteId);
      }
    }
    for (const result of results) {
      switch (result.status) {
      case 'fulfilled':
        switch (result.value.status) {
        case 'fulfilled':
          break;
        case 'rejected':
          this.objectWriteFailure ??= { error: result.value.error };
          break;
        default: {
          const _ex: never = result.value;
          throw new Error(`Unhandled HizoFS bulk object-write result: ${String(_ex)}`);
        }
        }
        break;
      case 'rejected':
        this.objectWriteFailure ??= { error: result.reason };
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled HizoFS bulk write settlement: ${String(_ex)}`);
      }
      }
    }
    switch (failureMode) {
    case 'ignore':
      return;
    case 'throw':
      this.throwIfObjectWriteFailed();
      return;
    default: {
      const _ex: never = failureMode;
      throw new Error(`Unhandled HizoFS bulk failure mode: ${String(_ex)}`);
    }
    }
  }

  private throwIfObjectWriteFailed(): void {
    if (this.objectWriteFailure !== undefined) {
      throw new Error('HizoFS bulk object write failed', {
        cause: this.objectWriteFailure.error,
      });
    }
  }

  private async readExactly({
    readable,
    buffer,
    position,
    signal,
    onBytesRead,
  }: {
    readable: StorageBinaryObjectReadHandle;
    buffer: Uint8Array;
    position: number;
    signal: AbortSignal | undefined;
    onBytesRead: (({ byteLength }: { byteLength: number }) => void) | undefined;
  }): Promise<void> {
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await readable.read({
        buffer,
        offset,
        length: buffer.byteLength - offset,
        position: position + offset,
        signal,
      });
      signal?.throwIfAborted();
      this.assertOpen();
      if (result.bytesRead <= 0) {
        throw new Error('HizoFS bulk source ended before its declared size');
      }
      offset += result.bytesRead;
      onBytesRead?.({ byteLength: result.bytesRead });
    }
  }

  private beginOperation(): () => void {
    this.assertOpen();
    this.assertNoActiveOperation();
    this.operationActive = true;
    this.operationSettled = Promise.withResolvers<void>();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.operationActive = false;
      this.operationSettled?.resolve();
      this.operationSettled = undefined;
    };
  }

  private assertNoActiveOperation(): void {
    if (this.operationActive) {
      throw new Error('HizoFS bulk builder does not allow overlapping operations');
    }
  }

  private reserveUniqueRootName({ name }: { name: string }): void {
    assertHizoFSEntryName({ name });
    if (this.rootEntryNames.has(name)) {
      throw new Error(`HizoFS bulk root entry already exists: ${name}`);
    }
    this.rootEntryNames.add(name);
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new Error('HizoFS bulk builder is already committed');
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  BULK_READ_BUFFER_BYTE_LENGTH,
};
