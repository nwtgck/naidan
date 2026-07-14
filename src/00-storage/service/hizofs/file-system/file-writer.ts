import type {
  HizoFSFileInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type { StorageWritableFile } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSCore } from './core';
import type { HizoFSExtentIndex } from './extent-index';
import type { HizoFSFileChunkStore } from './file-chunk-store';
import type { HizoFSInodeStore } from './inode-store';
import type {
  HizoFSNodeService,
  LoadedHizoFSFile,
} from './node-service';
import type { HizoFSPolicy } from './policy';

function assertNonNegativeSafeInteger({ value, fieldName }: {
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
    this.onSettled = onSettled;
    this.chunkSize = keepExistingData && baseFile.inode.storage.type === 'extents'
      ? baseFile.inode.storage.chunkSize
      : policy.fileChunkSize;
    this.size = keepExistingData ? baseFile.inode.size : 0;
    this.dirty = keepExistingData ? 'no' : 'yes';
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
  private readonly onSettled: () => void;
  private readonly chunkSize: number;
  private readonly preparedChunks = new Map<number, string | undefined>();
  private size: number;
  private dirty: 'yes' | 'no';
  private settled = false;

  async write({ position, data }: {
    position: number;
    data: Uint8Array;
  }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({ value: position, fieldName: 'Write position' });
    if (position + data.byteLength > Number.MAX_SAFE_INTEGER) {
      throw new Error('HizoFS write end exceeds the safe integer range');
    }
    if (data.byteLength === 0) {
      return;
    }

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
      chunk.set(data.subarray(sourceOffset, sourceOffset + copyLength), offsetInChunk);
      await this.persistWorkingChunk({
        chunkIndex,
        bytes: chunk,
        logicalLength: Math.min(
          this.chunkSize,
          nextSize - chunkIndex * this.chunkSize,
        ),
      });
      sourceOffset += copyLength;
      targetPosition += copyLength;
    }
    this.size = nextSize;
    this.dirty = 'yes';
  }

  async truncate({ size }: {
    size: number;
  }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({ value: size, fieldName: 'Truncate size' });
    if (size === this.size) {
      return;
    }

    if (size < this.size) {
      const retainedChunkCount = Math.ceil(size / this.chunkSize);
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
        await this.persistWorkingChunk({
          chunkIndex,
          bytes: chunk,
          logicalLength: remainder,
        });
      }
    }

    this.size = size;
    this.dirty = 'yes';
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

      await this.core.mutate({
        operation: async ({ state }) => {
          const currentFile = await this.nodeService.readFile({
            state,
            nodeId: this.baseFile.inode.nodeId,
          });
          if (currentFile.inode.revision !== this.baseFile.inode.revision) {
            throw new Error('HizoFS file changed while its writer was open');
          }

          const modifiedAt = this.now();
          let nextInode: HizoFSFileInodeDto;
          let binaryPayload: Uint8Array;
          if (this.size <= this.policy.inlineFileByteLimit) {
            binaryPayload = await this.materializeInlineBytes();
            nextInode = {
              nodeId: currentFile.inode.nodeId,
              revision: currentFile.inode.revision + 1,
              createdAt: currentFile.inode.createdAt,
              modifiedAt,
              size: this.size,
              storage: { type: 'inline' },
            };
          } else {
            const extentIndexRootObjectId = await this.buildExtentIndex();
            binaryPayload = new Uint8Array();
            nextInode = {
              nodeId: currentFile.inode.nodeId,
              revision: currentFile.inode.revision + 1,
              createdAt: currentFile.inode.createdAt,
              modifiedAt,
              size: this.size,
              storage: {
                type: 'extents',
                chunkSize: this.chunkSize,
                extentIndexRootObjectId,
              },
            };
          }

          const inodeObjectId = await this.inodeStore.writeFile({
            inode: nextInode,
            binaryPayload,
          });
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
      this.onSettled();
    }
  }

  async abort({ reason: _reason }: {
    reason: unknown;
  }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.onSettled();
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
      bytes.set(chunk.subarray(offsetInChunk, offsetInChunk + copyLength), position);
      position += copyLength;
    }
    return bytes;
  }

  private async buildExtentIndex(): Promise<string> {
    let rootObjectId: string;
    if (this.keepExistingData && this.baseFile.inode.storage.type === 'extents') {
      rootObjectId = this.baseFile.inode.storage.extentIndexRootObjectId;
    } else {
      rootObjectId = await this.extentIndex.createEmpty();
    }

    if (this.keepExistingData && this.baseFile.inode.storage.type === 'inline') {
      const retainedBaseByteLength = Math.min(
        this.baseFile.binaryPayload.byteLength,
        this.size,
      );
      const retainedBaseChunkCount = Math.ceil(retainedBaseByteLength / this.chunkSize);
      for (let chunkIndex = 0; chunkIndex < retainedBaseChunkCount; chunkIndex += 1) {
        if (this.preparedChunks.has(chunkIndex)) continue;
        const chunkStart = chunkIndex * this.chunkSize;
        const logicalLength = Math.min(
          this.chunkSize,
          this.size - chunkStart,
        );
        const bytes = new Uint8Array(this.chunkSize);
        bytes.set(this.baseFile.binaryPayload.subarray(
          chunkStart,
          Math.min(chunkStart + logicalLength, retainedBaseByteLength),
        ));
        await this.persistWorkingChunk({
          chunkIndex,
          bytes,
          logicalLength,
        });
      }
    }

    if (this.keepExistingData && this.baseFile.inode.storage.type === 'extents') {
      const retainedChunkCount = Math.ceil(this.size / this.chunkSize);
      for await (const extent of this.extentIndex.entries({ rootObjectId })) {
        if (extent.chunkIndex >= retainedChunkCount) {
          rootObjectId = await this.extentIndex.delete({
            rootObjectId,
            chunkIndex: extent.chunkIndex,
          });
        }
      }
    }

    const prepared = [...this.preparedChunks.entries()]
      .sort(([left], [right]) => left - right);
    for (const [chunkIndex, chunkObjectId] of prepared) {
      if (chunkIndex >= Math.ceil(this.size / this.chunkSize)) {
        rootObjectId = await this.extentIndex.delete({ rootObjectId, chunkIndex });
      } else if (chunkObjectId === undefined) {
        rootObjectId = await this.extentIndex.delete({ rootObjectId, chunkIndex });
      } else {
        rootObjectId = await this.extentIndex.set({
          rootObjectId,
          extent: { chunkIndex, chunkObjectId },
        });
      }
    }
    return rootObjectId;
  }

  private async loadWorkingChunk({ chunkIndex }: {
    chunkIndex: number;
  }): Promise<Uint8Array> {
    const preparedObjectId = this.preparedChunks.get(chunkIndex);
    if (this.preparedChunks.has(chunkIndex)) {
      return preparedObjectId === undefined
        ? new Uint8Array(this.chunkSize)
        : this.readChunkObject({ objectId: preparedObjectId, chunkIndex });
    }
    if (!this.keepExistingData) {
      return new Uint8Array(this.chunkSize);
    }

    switch (this.baseFile.inode.storage.type) {
    case 'inline': {
      const bytes = new Uint8Array(this.chunkSize);
      const start = chunkIndex * this.chunkSize;
      if (start < this.baseFile.binaryPayload.byteLength) {
        bytes.set(this.baseFile.binaryPayload.subarray(start, start + this.chunkSize));
      }
      return bytes;
    }
    case 'extents': {
      const extent = await this.extentIndex.get({
        rootObjectId: this.baseFile.inode.storage.extentIndexRootObjectId,
        chunkIndex,
      });
      return extent === undefined
        ? new Uint8Array(this.chunkSize)
        : this.readChunkObject({ objectId: extent.chunkObjectId, chunkIndex });
    }
    default: {
      const _ex: never = this.baseFile.inode.storage;
      throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
    }
    }
  }

  private async readChunkObject({ objectId, chunkIndex }: {
    objectId: string;
    chunkIndex: number;
  }): Promise<Uint8Array> {
    const stored = await this.chunkStore.read({
      objectId,
      expectedNodeId: this.baseFile.inode.nodeId,
      expectedChunkIndex: chunkIndex,
      chunkSize: this.chunkSize,
    });
    const bytes = new Uint8Array(this.chunkSize);
    bytes.set(stored);
    return bytes;
  }

  private async persistWorkingChunk({ chunkIndex, bytes, logicalLength }: {
    chunkIndex: number;
    bytes: Uint8Array;
    logicalLength: number;
  }): Promise<void> {
    let storedLength = Math.min(logicalLength, bytes.byteLength);
    while (storedLength > 0 && bytes[storedLength - 1] === 0) {
      storedLength -= 1;
    }
    if (storedLength === 0) {
      this.preparedChunks.set(chunkIndex, undefined);
      return;
    }
    const chunkObjectId = await this.chunkStore.write({
      chunk: {
        nodeId: this.baseFile.inode.nodeId,
        chunkIndex,
      },
      binaryPayload: bytes.slice(0, storedLength),
      chunkSize: this.chunkSize,
    });
    this.preparedChunks.set(chunkIndex, chunkObjectId);
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new Error('HizoFS file writer is already closed or aborted');
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
