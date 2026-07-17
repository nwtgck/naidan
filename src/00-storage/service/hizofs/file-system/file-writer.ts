import type { HizoFSFileInodeDto } from "@/00-storage/00-dto/hizofs.dto";
import { Semaphore } from "@/utils/concurrency";
import type { StorageWritableFile } from "@/00-storage/service/storage-file-system/types";
import type { HizoFSCore } from "./core";
import type { HizoFSExtentIndex } from "./extent-index";
import type { HizoFSFileChunkStore } from "./file-chunk-store";
import type { HizoFSInodeStore } from "./inode-store";
import type { HizoFSMaintenanceLease } from "./maintenance-lock";
import type { HizoFSNodeService, LoadedHizoFSFile } from "./node-service";
import type { HizoFSPolicy } from "./policy";
import type { HizoFSRuntimeDiagnostics } from './diagnostics';

type PendingChunkFlushResult =
  | { readonly status: 'fulfilled' }
  | { readonly status: 'rejected'; readonly error: unknown };

type PendingChunkFlush = {
  readonly result: Promise<PendingChunkFlushResult>;
};

function assertNonNegativeSafeInteger({
  value,
  fieldName,
}: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

export class HizoFSFileWriter implements StorageWritableFile {
  constructor({
    core,
    nodeService,
    inodeStore,
    extentIndex,
    chunkStore,
    policy,
    baseFile,
    keepExistingData,
    now,
    maintenanceLease,
    diagnostics,
    onSettled,
  }: {
    core: HizoFSCore;
    nodeService: HizoFSNodeService;
    inodeStore: HizoFSInodeStore;
    extentIndex: HizoFSExtentIndex;
    chunkStore: HizoFSFileChunkStore;
    policy: HizoFSPolicy;
    baseFile: LoadedHizoFSFile;
    keepExistingData: boolean;
    now: () => number;
    maintenanceLease: HizoFSMaintenanceLease;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
    onSettled: () => void;
  }) {
    this.core = core;
    this.nodeService = nodeService;
    this.inodeStore = inodeStore;
    this.extentIndex = extentIndex;
    this.chunkStore = chunkStore;
    this.policy = policy;
    this.baseFile = baseFile;
    this.keepExistingData = keepExistingData;
    this.now = now;
    this.maintenanceLease = maintenanceLease;
    this.diagnostics = diagnostics;
    this.onSettled = onSettled;
    this.chunkSize =
      keepExistingData && baseFile.inode.storage.type === "extents"
        ? baseFile.inode.storage.chunkSize
        : policy.fileChunkSize;
    if (!Number.isSafeInteger(policy.maxDirtyFileBytes) || policy.maxDirtyFileBytes < 1) {
      throw new Error("HizoFS maxDirtyFileBytes must be a positive safe integer");
    }
    if (policy.maxDirtyFileBytes < this.chunkSize) {
      throw new Error("HizoFS maxDirtyFileBytes must retain at least one file chunk");
    }
    this.maxDirtyChunksInMemory = Math.max(
      1,
      Math.floor(policy.maxDirtyFileBytes / this.chunkSize),
    );
    if (
      !Number.isSafeInteger(policy.fileChunkWriteConcurrency)
      || policy.fileChunkWriteConcurrency < 1
    ) {
      throw new Error("HizoFS fileChunkWriteConcurrency must be a positive safe integer");
    }
    this.chunkWriteSemaphore = new Semaphore({
      maxConcurrency: policy.fileChunkWriteConcurrency,
    });
    this.size = keepExistingData ? baseFile.inode.size : 0;
    this.baseRetainedSize = this.size;
    this.dirty = keepExistingData ? "no" : "yes";
  }

  private readonly core: HizoFSCore;
  private readonly nodeService: HizoFSNodeService;
  private readonly inodeStore: HizoFSInodeStore;
  private readonly extentIndex: HizoFSExtentIndex;
  private readonly chunkStore: HizoFSFileChunkStore;
  private readonly policy: HizoFSPolicy;
  private readonly baseFile: LoadedHizoFSFile;
  private readonly keepExistingData: boolean;
  private readonly now: () => number;
  private readonly maintenanceLease: HizoFSMaintenanceLease;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly onSettled: () => void;
  private readonly chunkSize: number;
  private readonly maxDirtyChunksInMemory: number;
  private readonly chunkWriteSemaphore: Semaphore;
  private readonly preparedChunks = new Map<number, string | undefined>();
  private readonly workingChunks = new Map<number, Uint8Array>();
  private readonly pendingChunkFlushes = new Map<number, PendingChunkFlush>();
  private baseRetainedSize: number;
  private size: number;
  private dirty: "yes" | "no";
  private settled = false;

  async write({
    position,
    data,
  }: {
    position: number;
    data: Uint8Array;
  }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({
      value: position,
      fieldName: "Write position",
    });
    if (position + data.byteLength > Number.MAX_SAFE_INTEGER) {
      throw new Error("HizoFS write end exceeds the safe integer range");
    }
    if (data.byteLength === 0) return;

    const nextSize = Math.max(this.size, position + data.byteLength);
    let sourceOffset = 0;
    let targetPosition = position;
    while (sourceOffset < data.byteLength) {
      const chunkIndex = Math.floor(targetPosition / this.chunkSize);
      const offsetInChunk = targetPosition % this.chunkSize;
      const copyLength = Math.min(
        data.byteLength - sourceOffset,
        this.chunkSize - offsetInChunk,
      );
      const chunk = await this.loadWorkingChunk({ chunkIndex });
      chunk.set(
        data.subarray(sourceOffset, sourceOffset + copyLength),
        offsetInChunk,
      );
      await this.retainWorkingChunk({
        chunkIndex,
        bytes: chunk,
        logicalFileSize: nextSize,
      });
      sourceOffset += copyLength;
      targetPosition += copyLength;
    }
    this.size = nextSize;
    this.dirty = "yes";
  }

  async truncate({ size }: { size: number }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({ value: size, fieldName: "Truncate size" });
    if (size === this.size) return;
    await this.waitForAllPendingChunkFlushes({ failureMode: 'throw' });

    if (size < this.size) {
      this.baseRetainedSize = Math.min(this.baseRetainedSize, size);
      const retainedChunkCount = Math.ceil(size / this.chunkSize);
      for (const chunkIndex of [...this.workingChunks.keys()]) {
        if (chunkIndex >= retainedChunkCount) {
          this.takeWorkingChunk({ chunkIndex })?.fill(0);
          this.preparedChunks.set(chunkIndex, undefined);
        }
      }
      for (const chunkIndex of this.preparedChunks.keys()) {
        if (chunkIndex >= retainedChunkCount) {
          this.preparedChunks.set(chunkIndex, undefined);
        }
      }
      const remainder = size % this.chunkSize;
      if (size > 0 && remainder !== 0) {
        const chunkIndex = Math.floor(size / this.chunkSize);
        const chunk = await this.loadWorkingChunk({ chunkIndex });
        chunk.fill(0, remainder);
        await this.retainWorkingChunk({
          chunkIndex,
          bytes: chunk,
          logicalFileSize: size,
        });
      }
    }

    this.size = size;
    this.dirty = "yes";
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.settled = true;
    try {
      switch (this.dirty) {
      case 'no':
        return;
      case 'yes':
        break;
      default: {
        const _ex: never = this.dirty;
        throw new Error(`Unhandled HizoFS writer dirty state: ${String(_ex)}`);
      }
      }

      // Immutable chunks and the replacement inode can be prepared without the
      // mutation lock. A concurrent revision change only leaves unreachable
      // objects, while publication remains guarded by the revision check below.
      const { nextInode, inodeObjectId } = await this.prepareChangedFile();
      await this.core.mutateWithResourceLeaseHeld({
        operation: async ({ state }) => {
          const currentFile = await this.nodeService.readFile({
            state,
            nodeId: this.baseFile.inode.nodeId,
          });
          if (currentFile.inode.revision !== this.baseFile.inode.revision) {
            throw new Error('HizoFS file changed while its writer was open');
          }
          const inodeIndexRootObjectId = await this.nodeService.setInode({
            inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
            nodeId: nextInode.nodeId,
            inodeObjectId,
          });
          return {
            changed: 'yes' as const,
            inodeIndexRootObjectId,
            result: undefined,
          };
        },
      });
    } finally {
      try {
        await this.releaseResources();
      } finally {
        this.onSettled();
      }
    }
  }

  async abort({ reason: _reason }: { reason: unknown }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    try {
      await this.releaseResources();
    } finally {
      this.onSettled();
    }
  }

  private async releaseResources(): Promise<void> {
    try {
      await this.waitForAllPendingChunkFlushes({ failureMode: 'ignore' });
    } finally {
      try {
        this.clearWorkingChunks();
      } finally {
        await this.maintenanceLease.release();
      }
    }
  }

  private async prepareChangedFile(): Promise<{
    readonly nextInode: HizoFSFileInodeDto;
    readonly inodeObjectId: string;
  }> {
    const modifiedAt = this.now();
    let nextInode: HizoFSFileInodeDto;
    let binaryPayload: Uint8Array;
    if (this.size <= this.policy.inlineFileByteLimit) {
      binaryPayload = await this.materializeInlineBytes();
      nextInode = {
        nodeId: this.baseFile.inode.nodeId,
        revision: this.baseFile.inode.revision + 1,
        createdAt: this.baseFile.inode.createdAt,
        modifiedAt,
        size: this.size,
        storage: { type: 'inline' },
      };
    } else {
      const extentIndexRootObjectId = await this.buildExtentIndex();
      binaryPayload = new Uint8Array();
      nextInode = {
        nodeId: this.baseFile.inode.nodeId,
        revision: this.baseFile.inode.revision + 1,
        createdAt: this.baseFile.inode.createdAt,
        modifiedAt,
        size: this.size,
        storage: {
          type: 'extents',
          chunkSize: this.chunkSize,
          extentIndexRootObjectId,
        },
      };
    }
    try {
      const inodeObjectId = await this.inodeStore.writeFile({
        inode: nextInode,
        binaryPayload,
      });
      return { nextInode, inodeObjectId };
    } finally {
      binaryPayload.fill(0);
    }
  }

  private async materializeInlineBytes(): Promise<Uint8Array> {
    const bytes = new Uint8Array(this.size);
    let position = 0;
    while (position < bytes.byteLength) {
      const chunkIndex = Math.floor(position / this.chunkSize);
      const offsetInChunk = position % this.chunkSize;
      const chunk = await this.loadWorkingChunk({ chunkIndex });
      const copyLength = Math.min(
        bytes.byteLength - position,
        this.chunkSize - offsetInChunk,
      );
      bytes.set(
        chunk.subarray(offsetInChunk, offsetInChunk + copyLength),
        position,
      );
      position += copyLength;
    }
    return bytes;
  }

  private async buildExtentIndex(): Promise<string> {
    await this.flushAllWorkingChunks();

    if (
      this.keepExistingData &&
      this.baseFile.inode.storage.type === "inline"
    ) {
      const retainedBaseByteLength = Math.min(
        this.baseFile.binaryPayload.byteLength,
        this.baseRetainedSize,
        this.size,
      );
      const retainedBaseChunkCount = Math.ceil(
        retainedBaseByteLength / this.chunkSize,
      );
      for (
        let chunkIndex = 0;
        chunkIndex < retainedBaseChunkCount;
        chunkIndex += 1
      ) {
        if (this.preparedChunks.has(chunkIndex)) continue;
        const chunkStart = chunkIndex * this.chunkSize;
        const logicalLength = Math.min(this.chunkSize, this.size - chunkStart);
        const bytes = new Uint8Array(this.chunkSize);
        bytes.set(
          this.baseFile.binaryPayload.subarray(
            chunkStart,
            Math.min(chunkStart + logicalLength, retainedBaseByteLength),
          ),
        );
        await this.persistWorkingChunk({ chunkIndex, bytes, logicalLength });
      }
    }

    const finalChunkCount = Math.ceil(this.size / this.chunkSize);
    if (this.canBuildExtentIndexFromPreparedChunks({ finalChunkCount })) {
      return this.extentIndex.buildFromSortedExtents({
        extents: this.iteratePreparedExtents({ finalChunkCount }),
      });
    }

    let rootObjectId: string;
    if (
      this.keepExistingData &&
      this.baseFile.inode.storage.type === "extents"
    ) {
      rootObjectId = this.baseFile.inode.storage.extentIndexRootObjectId;
    } else {
      rootObjectId = await this.extentIndex.createEmpty();
    }

    if (
      this.keepExistingData &&
      this.baseFile.inode.storage.type === "extents"
    ) {
      const retainedChunkCount = Math.ceil(
        this.baseRetainedSize / this.chunkSize,
      );
      rootObjectId =
        retainedChunkCount === 0
          ? await this.extentIndex.createEmpty()
          : await this.extentIndex.truncateAtOrAfter({
            rootObjectId,
            chunkIndex: retainedChunkCount,
          });
    }

    for (const [chunkIndex, chunkObjectId] of [
      ...this.preparedChunks.entries(),
    ].sort(([left], [right]) => left - right)) {
      if (chunkIndex >= finalChunkCount || chunkObjectId === undefined) {
        rootObjectId = await this.extentIndex.delete({
          rootObjectId,
          chunkIndex,
        });
      } else {
        rootObjectId = await this.extentIndex.set({
          rootObjectId,
          extent: { chunkIndex, chunkObjectId },
        });
      }
    }
    return rootObjectId;
  }

  private canBuildExtentIndexFromPreparedChunks({
    finalChunkCount,
  }: {
    finalChunkCount: number;
  }): boolean {
    if (!this.keepExistingData || this.baseFile.inode.storage.type === "inline") {
      return true;
    }
    const retainedChunkCount = Math.min(
      Math.ceil(this.baseRetainedSize / this.chunkSize),
      finalChunkCount,
    );
    if (this.preparedChunks.size < retainedChunkCount) return false;
    for (let chunkIndex = 0; chunkIndex < retainedChunkCount; chunkIndex += 1) {
      if (!this.preparedChunks.has(chunkIndex)) return false;
    }
    return true;
  }

  private *iteratePreparedExtents({
    finalChunkCount,
  }: {
    finalChunkCount: number;
  }): Iterable<{
    readonly chunkIndex: number;
    readonly chunkObjectId: string;
  }> {
    for (const [chunkIndex, chunkObjectId] of [
      ...this.preparedChunks.entries(),
    ].sort(([left], [right]) => left - right)) {
      if (chunkIndex >= finalChunkCount || chunkObjectId === undefined) continue;
      yield { chunkIndex, chunkObjectId };
    }
  }

  private async loadWorkingChunk({
    chunkIndex,
  }: {
    chunkIndex: number;
  }): Promise<Uint8Array> {
    const working = this.workingChunks.get(chunkIndex);
    if (working !== undefined) {
      this.workingChunks.delete(chunkIndex);
      this.workingChunks.set(chunkIndex, working);
      return working;
    }

    await this.waitForPendingChunkFlush({ chunkIndex });
    const preparedObjectId = this.preparedChunks.get(chunkIndex);
    if (this.preparedChunks.has(chunkIndex)) {
      return preparedObjectId === undefined
        ? new Uint8Array(this.chunkSize)
        : this.readChunkObject({ objectId: preparedObjectId });
    }
    if (!this.keepExistingData) {
      return new Uint8Array(this.chunkSize);
    }

    switch (this.baseFile.inode.storage.type) {
    case "inline": {
      const bytes = new Uint8Array(this.chunkSize);
      const start = chunkIndex * this.chunkSize;
      const retainedEnd = Math.min(
        start + this.chunkSize,
        this.baseFile.binaryPayload.byteLength,
        this.baseRetainedSize,
      );
      if (start < retainedEnd) {
        bytes.set(this.baseFile.binaryPayload.subarray(start, retainedEnd));
      }
      return bytes;
    }
    case "extents": {
      const start = chunkIndex * this.chunkSize;
      if (start >= this.baseRetainedSize) {
        return new Uint8Array(this.chunkSize);
      }
      const extent = await this.extentIndex.get({
        rootObjectId: this.baseFile.inode.storage.extentIndexRootObjectId,
        chunkIndex,
      });
      if (extent === undefined) return new Uint8Array(this.chunkSize);
      const bytes = await this.readChunkObject({
        objectId: extent.chunkObjectId,
      });
      const retainedLength = Math.min(
        this.chunkSize,
        this.baseRetainedSize - start,
      );
      bytes.fill(0, retainedLength);
      return bytes;
    }
    default: {
      const _ex: never = this.baseFile.inode.storage;
      throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
    }
    }
  }

  private async retainWorkingChunk({
    chunkIndex,
    bytes,
    logicalFileSize,
  }: {
    chunkIndex: number;
    bytes: Uint8Array;
    logicalFileSize: number;
  }): Promise<void> {
    if (!this.workingChunks.has(chunkIndex)) {
      while (this.workingChunks.size >= this.maxDirtyChunksInMemory) {
        await this.waitForPendingChunkFlushCapacity();
        const oldestChunkIndex = this.workingChunks.keys().next().value as
          number | undefined;
        if (oldestChunkIndex === undefined) break;
        this.scheduleWorkingChunkFlush({
          chunkIndex: oldestChunkIndex,
          logicalFileSize,
        });
      }
    }
    this.setWorkingChunk({ chunkIndex, bytes });
  }

  private async flushAllWorkingChunks(): Promise<void> {
    await this.waitForAllPendingChunkFlushes({ failureMode: 'throw' });
    const tasks = [...this.workingChunks.keys()].map(chunkIndex =>
      this.chunkWriteSemaphore.run({
        task: async () => this.flushWorkingChunk({
          chunkIndex,
          logicalFileSize: this.size,
        }),
      }),
    );
    const results = await Promise.allSettled(tasks);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  }

  private async flushWorkingChunk({
    chunkIndex,
    logicalFileSize,
  }: {
    chunkIndex: number;
    logicalFileSize: number;
  }): Promise<void> {
    const bytes = this.takeWorkingChunk({ chunkIndex });
    if (bytes === undefined) return;
    const logicalLength = Math.max(
      0,
      Math.min(this.chunkSize, logicalFileSize - chunkIndex * this.chunkSize),
    );
    this.adjustPendingChunkWriteUsage({
      byteDelta: bytes.byteLength,
      operationDelta: 1,
    });
    try {
      await this.persistWorkingChunk({ chunkIndex, bytes, logicalLength });
    } finally {
      this.adjustPendingChunkWriteUsage({
        byteDelta: -bytes.byteLength,
        operationDelta: -1,
      });
    }
  }

  private scheduleWorkingChunkFlush({
    chunkIndex,
    logicalFileSize,
  }: {
    chunkIndex: number;
    logicalFileSize: number;
  }): void {
    if (this.pendingChunkFlushes.has(chunkIndex)) {
      throw new Error('HizoFS chunk already has a pending immutable write');
    }
    const bytes = this.takeWorkingChunk({ chunkIndex });
    if (bytes === undefined) return;
    const logicalLength = Math.max(
      0,
      Math.min(this.chunkSize, logicalFileSize - chunkIndex * this.chunkSize),
    );
    this.adjustPendingChunkWriteUsage({
      byteDelta: bytes.byteLength,
      operationDelta: 1,
    });
    const result = this.chunkWriteSemaphore.run({
      task: async (): Promise<PendingChunkFlushResult> => {
        try {
          await this.persistWorkingChunk({ chunkIndex, bytes, logicalLength });
          return { status: 'fulfilled' };
        } catch (error) {
          return { status: 'rejected', error };
        } finally {
          this.adjustPendingChunkWriteUsage({
            byteDelta: -bytes.byteLength,
            operationDelta: -1,
          });
        }
      },
    });
    this.pendingChunkFlushes.set(chunkIndex, { result });
  }

  private async waitForPendingChunkFlushCapacity(): Promise<void> {
    while (
      this.pendingChunkFlushes.size >= this.policy.fileChunkWriteConcurrency
    ) {
      const oldestChunkIndex = this.pendingChunkFlushes.keys().next().value as
        number | undefined;
      if (oldestChunkIndex === undefined) return;
      await this.waitForPendingChunkFlush({ chunkIndex: oldestChunkIndex });
    }
  }

  private async waitForPendingChunkFlush({
    chunkIndex,
  }: {
    chunkIndex: number;
  }): Promise<void> {
    const pending = this.pendingChunkFlushes.get(chunkIndex);
    if (pending === undefined) return;
    let result: PendingChunkFlushResult;
    try {
      result = await pending.result;
    } finally {
      if (this.pendingChunkFlushes.get(chunkIndex) === pending) {
        this.pendingChunkFlushes.delete(chunkIndex);
      }
    }
    switch (result.status) {
    case 'fulfilled':
      return;
    case 'rejected':
      throw result.error;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS chunk flush result: ${String(_ex)}`);
    }
    }
  }

  private async waitForAllPendingChunkFlushes({
    failureMode,
  }: {
    failureMode: 'ignore' | 'throw';
  }): Promise<void> {
    const entries = [...this.pendingChunkFlushes.entries()];
    const results = await Promise.allSettled(
      entries.map(([, pending]) => pending.result),
    );
    for (const [chunkIndex, pending] of entries) {
      if (this.pendingChunkFlushes.get(chunkIndex) === pending) {
        this.pendingChunkFlushes.delete(chunkIndex);
      }
    }
    switch (failureMode) {
    case 'ignore':
      return;
    case 'throw': {
      const directFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (directFailure !== undefined) throw directFailure.reason;
      const flushFailure = results
        .filter(
          (result): result is PromiseFulfilledResult<PendingChunkFlushResult> =>
            result.status === 'fulfilled',
        )
        .map(result => result.value)
        .find(
          (result): result is Extract<
            PendingChunkFlushResult,
            { status: 'rejected' }
          > => result.status === 'rejected',
        );
      if (flushFailure !== undefined) throw flushFailure.error;
      return;
    }
    default: {
      const _ex: never = failureMode;
      throw new Error(`Unhandled HizoFS pending flush failure mode: ${String(_ex)}`);
    }
    }
  }

  private setWorkingChunk({
    chunkIndex,
    bytes,
  }: {
    chunkIndex: number;
    bytes: Uint8Array;
  }): void {
    const previous = this.workingChunks.get(chunkIndex);
    if (previous === undefined) {
      this.adjustDirtyChunkUsage({
        byteDelta: bytes.byteLength,
        operationDelta: 1,
      });
    } else if (previous !== bytes) {
      previous.fill(0);
      this.adjustDirtyChunkUsage({
        byteDelta: bytes.byteLength - previous.byteLength,
        operationDelta: 0,
      });
    }
    this.workingChunks.delete(chunkIndex);
    this.workingChunks.set(chunkIndex, bytes);
  }

  private takeWorkingChunk({
    chunkIndex,
  }: {
    chunkIndex: number;
  }): Uint8Array | undefined {
    const bytes = this.workingChunks.get(chunkIndex);
    if (bytes === undefined) return undefined;
    this.workingChunks.delete(chunkIndex);
    this.adjustDirtyChunkUsage({
      byteDelta: -bytes.byteLength,
      operationDelta: -1,
    });
    return bytes;
  }

  private adjustDirtyChunkUsage({
    byteDelta,
    operationDelta,
  }: {
    byteDelta: number;
    operationDelta: number;
  }): void {
    this.diagnostics?.adjustResourceUsage({
      resource: 'writer_dirty_chunks',
      byteDelta,
      operationDelta,
    });
  }

  private adjustPendingChunkWriteUsage({
    byteDelta,
    operationDelta,
  }: {
    byteDelta: number;
    operationDelta: number;
  }): void {
    this.diagnostics?.adjustResourceUsage({
      resource: 'writer_pending_chunk_writes',
      byteDelta,
      operationDelta,
    });
  }

  private async readChunkObject({
    objectId,
  }: {
    objectId: string;
  }): Promise<Uint8Array> {
    const stored = await this.chunkStore.read({
      objectId,
      chunkSize: this.chunkSize,
    });
    const bytes = new Uint8Array(this.chunkSize);
    bytes.set(stored);
    return bytes;
  }

  private async persistWorkingChunk({
    chunkIndex,
    bytes,
    logicalLength,
  }: {
    chunkIndex: number;
    bytes: Uint8Array;
    logicalLength: number;
  }): Promise<void> {
    try {
      let storedLength = Math.min(logicalLength, bytes.byteLength);
      while (storedLength > 0 && bytes[storedLength - 1] === 0) {
        storedLength -= 1;
      }
      if (storedLength === 0) {
        this.preparedChunks.set(chunkIndex, undefined);
        return;
      }
      const chunkObjectId = await this.chunkStore.write({
        binaryPayload: bytes.slice(0, storedLength),
        chunkSize: this.chunkSize,
      });
      this.preparedChunks.set(chunkIndex, chunkObjectId);
    } finally {
      bytes.fill(0);
    }
  }

  private clearWorkingChunks(): void {
    const entries = [...this.workingChunks.values()];
    for (const bytes of entries) bytes.fill(0);
    try {
      if (entries.length > 0) {
        this.adjustDirtyChunkUsage({
          byteDelta: -entries.reduce(
            (total, bytes) => total + bytes.byteLength,
            0,
          ),
          operationDelta: -entries.length,
        });
      }
    } finally {
      this.workingChunks.clear();
    }
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new Error("HizoFS file writer is already closed or aborted");
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
