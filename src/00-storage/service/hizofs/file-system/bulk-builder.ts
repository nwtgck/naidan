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
import type { HizoFSActiveState } from './core';
import { acquireHizoFSResourceLease, type HizoFSMaintenanceLease } from './maintenance-lock';
import type { HizoFSInodeIndexEntry } from './inode-index';
import { compareHizoFSStrings } from './ordering';
import type { HizoFSRuntime } from './runtime';
import { assertHizoFSEntryName } from './semantic-validation';

const BULK_READ_BUFFER_BYTE_LENGTH = 256 * 1024;

type ImportedNode = {
  readonly entry: HizoFSDirectoryEntryDto;
  readonly inodeIndexEntry: HizoFSInodeIndexEntry;
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
  }: {
    runtime: HizoFSRuntime;
    rootDirectoryNodeId: string;
  }): Promise<HizoFSBulkBuilder> {
    const maintenanceLease = await acquireHizoFSResourceLease({
      fileSystemId: runtime.core.fileSystemId,
    });
    try {
      const baseState = await runtime.core.loadActiveState();
      switch (baseState.mode) {
      case 'current':
        break;
      case 'fallback_read_only':
        throw new Error('Cannot bulk-build into a fallback HizoFS generation');
      default: {
        const _ex: never = baseState.mode;
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
  }: {
    runtime: HizoFSRuntime;
    rootDirectoryNodeId: string;
    baseState: HizoFSActiveState;
    rootCreatedAt: number | null;
    rootModifiedAt: number | null;
    maintenanceLease: HizoFSMaintenanceLease;
  }) {
    this.runtime = runtime;
    this.rootDirectoryNodeId = rootDirectoryNodeId;
    this.baseState = baseState;
    this.rootCreatedAt = rootCreatedAt;
    this.rootModifiedAt = rootModifiedAt;
    this.maintenanceLease = maintenanceLease;
  }

  private readonly runtime: HizoFSRuntime;
  private readonly rootDirectoryNodeId: string;
  private readonly baseState: HizoFSActiveState;
  private rootCreatedAt: number | null;
  private rootModifiedAt: number | null;
  private readonly maintenanceLease: HizoFSMaintenanceLease;
  private readonly rootEntries: HizoFSDirectoryEntryDto[] = [];
  private readonly inodeIndexEntries: HizoFSInodeIndexEntry[] = [];
  private settled = false;

  async importRootMetadata({
    source,
  }: {
    source: StorageDirectoryHandle;
  }): Promise<void> {
    this.assertOpen();
    const stat = await source.stat();
    this.rootCreatedAt = stat.createdAt ?? stat.modifiedAt ?? this.rootCreatedAt;
    this.rootModifiedAt = stat.modifiedAt ?? stat.createdAt ?? this.rootModifiedAt;
  }

  async importDirectory({
    source,
    name,
    excludedNames,
    signal,
  }: {
    source: StorageDirectoryHandle;
    name: string;
    excludedNames: ReadonlySet<string>;
    signal: AbortSignal | undefined;
  }): Promise<void> {
    this.assertOpen();
    this.assertUniqueRootName({ name });
    const imported = await this.importDirectoryNode({
      source,
      name,
      excludedNames,
      signal,
    });
    this.rootEntries.push(imported.entry);
  }

  async createEmptyDirectory({
    name,
  }: {
    name: string;
  }): Promise<void> {
    this.assertOpen();
    this.assertUniqueRootName({ name });
    assertHizoFSEntryName({ name });
    const timestamp = this.runtime.now();
    const nodeId = createHizoFSStableId();
    const inode: HizoFSDirectoryInodeDto = {
      nodeId,
      revision: 0,
      createdAt: timestamp,
      modifiedAt: timestamp,
      storage: { type: 'inline', entries: [] },
    };
    const inodeObjectId = await this.runtime.inodeStore.writeDirectory({ inode });
    this.inodeIndexEntries.push({ nodeId, inodeObjectId });
    this.rootEntries.push({ name, kind: 'directory', nodeId });
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.settled = true;
    try {
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
      await this.maintenanceLease.release();
    }
  }

  async abort({ reason: _reason }: { reason: unknown }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.maintenanceLease.release();
  }

  private async importDirectoryNode({
    source,
    name,
    excludedNames,
    signal,
  }: {
    source: StorageDirectoryHandle;
    name: string;
    excludedNames: ReadonlySet<string>;
    signal: AbortSignal | undefined;
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
        });
        entries.push(imported.entry);
        break;
      }
      case 'file':
        entries.push((await this.importFileNode({
          source: child,
          name: childName,
          signal,
        })).entry);
        break;
      case 'symlink':
        entries.push((await this.importSymlinkNode({
          source: child,
          name: childName,
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
    const now = this.runtime.now();
    const inodeObjectId = await this.writeDirectoryInode({
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
    });
    const inodeIndexEntry = { nodeId, inodeObjectId };
    this.inodeIndexEntries.push(inodeIndexEntry);
    return {
      entry: { name, kind: 'directory', nodeId },
      inodeIndexEntry,
    };
  }

  private async importFileNode({
    source,
    name,
    signal,
  }: {
    source: StorageFileHandle;
    name: string;
    signal: AbortSignal | undefined;
  }): Promise<ImportedNode> {
    assertHizoFSEntryName({ name });
    const stat = await source.stat();
    const nodeId = createHizoFSStableId();
    const readable = await source.openReadable({
      mimeType: 'application/octet-stream',
    });
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
      const inodeObjectId = await this.runtime.inodeStore.writeFile({
        inode,
        binaryPayload,
      });
      const inodeIndexEntry = { nodeId, inodeObjectId };
      this.inodeIndexEntries.push(inodeIndexEntry);
      return {
        entry: { name, kind: 'file', nodeId },
        inodeIndexEntry,
      };
    } finally {
      await readable.close();
    }
  }

  private async importSymlinkNode({
    source,
    name,
  }: {
    source: StorageSymlinkHandle;
    name: string;
  }): Promise<ImportedNode> {
    assertHizoFSEntryName({ name });
    const stat = await source.stat();
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
    const inodeObjectId = await this.runtime.inodeStore.writeSymlink({ inode });
    const inodeIndexEntry = { nodeId, inodeObjectId };
    this.inodeIndexEntries.push(inodeIndexEntry);
    return {
      entry: { name, kind: 'symlink', nodeId },
      inodeIndexEntry,
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

  private async readExactly({
    readable,
    buffer,
    position,
    signal,
  }: {
    readable: StorageBinaryObjectReadHandle;
    buffer: Uint8Array;
    position: number;
    signal: AbortSignal | undefined;
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
      if (result.bytesRead <= 0) {
        throw new Error('HizoFS bulk source ended before its declared size');
      }
      offset += result.bytesRead;
    }
  }

  private assertUniqueRootName({ name }: { name: string }): void {
    assertHizoFSEntryName({ name });
    if (this.rootEntries.some(entry => entry.name === name)) {
      throw new Error(`HizoFS bulk root entry already exists: ${name}`);
    }
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
