import type {
  HizoFSDirectoryEntryDto,
  HizoFSDirectoryInodeDto,
  HizoFSFileInodeDto,
  HizoFSSymlinkInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountSession,
  StorageDirectoryWorkerMountSource,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileStat,
  StorageSymlinkHandle,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';
import {
  createStorageEntryNotFoundError,
} from '@/00-storage/service/storage-file-system/errors';
import { createHizoFSStableId } from '@/00-storage/service/hizofs/id';
import type { HizoFSActiveState } from './core';
import type { HizoFSDirectoryChange } from './directory-storage';
import { HizoFSFileReader } from './file-reader';
import { HizoFSFileWriter } from './file-writer';
import type { LoadedHizoFSFile } from './node-service';
import type { HizoFSRuntime } from './runtime';
import type { HizoFSMaintenanceLease } from './maintenance-lock';
import { assertHizoFSEntryName } from './semantic-validation';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';

function createNamedError({ name, message }: {
  name: string;
  message: string;
}): Error {
  const error = new Error(`${name}: ${message}`);
  error.name = name;
  return error;
}

type HizoFSSessionResource = {
  dispose(): Promise<void>;
};

function requireFileEntry({ entry, name }: {
  entry: HizoFSDirectoryEntryDto;
  name: string;
}): HizoFSDirectoryEntryDto {
  switch (entry.kind) {
  case 'file':
    return entry;
  case 'directory':
  case 'symlink':
    throw createNamedError({ name: 'TypeMismatchError', message: `'${name}' is not a file` });
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
  }
  }
}

function requireDirectoryEntry({ entry, name }: {
  entry: HizoFSDirectoryEntryDto;
  name: string;
}): HizoFSDirectoryEntryDto {
  switch (entry.kind) {
  case 'directory':
    return entry;
  case 'file':
  case 'symlink':
    throw createNamedError({ name: 'TypeMismatchError', message: `'${name}' is not a directory` });
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
  }
  }
}

function isDirectoryEntry({ entry }: {
  entry: HizoFSDirectoryEntryDto;
}): boolean {
  switch (entry.kind) {
  case 'directory':
    return true;
  case 'file':
  case 'symlink':
    return false;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
  }
  }
}

function createClonedFileRecord({ source, nodeId, timestamp }: {
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
  case 'inline': {
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
  case 'extents': {
    const {
      type,
      chunkSize,
      extentIndexRootObjectId,
      ...unhandledStorage
    } = storage;
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
    rootDirectoryNodeId,
    maintenanceLease,
    workerMountContext,
  }: {
    runtime: HizoFSRuntime;
    rootDirectoryNodeId: string;
    maintenanceLease: HizoFSMaintenanceLease;
    workerMountContext: Omit<StorageDirectoryWorkerMountSource, 'rootDirectoryNodeId'>;
  }) {
    this.runtime = runtime;
    this.fileSystemId = runtime.core.fileSystemId;
    this.maintenanceLease = maintenanceLease;
    this.workerMountContext = workerMountContext;
    this.root = new HizoFSDirectoryHandle({
      session: this,
      nodeId: rootDirectoryNodeId,
      name: '',
    });
  }

  readonly capabilities = {
    directBlob: 'unsupported' as const,
    symbolicLink: 'supported' as const,
    atomicMove: 'supported' as const,
    wholeFileClone: 'supported' as const,
  };
  readonly root: StorageDirectoryHandle;
  readonly fileSystemId: string;
  readonly runtime: HizoFSRuntime;
  private readonly workerMountContext: Omit<StorageDirectoryWorkerMountSource, 'rootDirectoryNodeId'>;
  private readonly maintenanceLease: HizoFSMaintenanceLease;
  private readonly resources = new Set<HizoFSSessionResource>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.resources].map(resource => resource.dispose()),
    );
    await this.maintenanceLease.release();
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close HizoFS session resources');
    }
  }

  assertOpen(): void {
    if (this.closed) {
      throw new Error('HizoFS session is closed');
    }
  }


  createWorkerMountSource({ rootDirectoryNodeId }: {
    rootDirectoryNodeId: string;
  }): StorageDirectoryWorkerMountSource {
    this.assertOpen();
    return {
      ...this.workerMountContext,
      rootDirectoryNodeId,
    };
  }


  async openWorkerMountDirectory({ source }: {
    source: StorageDirectoryWorkerMountSource;
  }): Promise<StorageDirectoryHandle> {
    this.assertOpen();
    if (source.fileSystemId !== this.fileSystemId) {
      throw new Error('HizoFS Worker mount belongs to a different file system');
    }
    if (!await this.workerMountContext.backingDirectory.isSameEntry(
      source.backingDirectory,
    )) {
      throw new Error('HizoFS Worker mount belongs to a different backing directory');
    }
    const state = await this.runtime.core.loadActiveState();
    await this.runtime.nodeService.readDirectory({
      state,
      nodeId: source.rootDirectoryNodeId,
    });
    return new HizoFSDirectoryHandle({
      session: this,
      nodeId: source.rootDirectoryNodeId,
      name: '',
    });
  }

  async getFileHandle({ directoryNodeId, name, create }: {
    directoryNodeId: string;
    name: string;
    create: boolean;
  }): Promise<StorageFileHandle> {
    this.assertOpen();
    assertHizoFSEntryName({ name });
    if (!create) {
      const state = await this.runtime.core.loadActiveState();
      const directory = await this.runtime.nodeService.readDirectory({ state, nodeId: directoryNodeId });
      const entry = await this.runtime.directoryStorage.getEntry({ inode: directory.inode, name });
      if (entry === undefined) {
        throw createStorageEntryNotFoundError({ message: `File '${name}' was not found` });
      }
      const fileEntry = requireFileEntry({ entry, name });
      return new HizoFSFileHandle({ session: this, nodeId: fileEntry.nodeId, name });
    }

    const nodeId = await this.runtime.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({ state, nodeId: directoryNodeId });
        const existing = await this.runtime.directoryStorage.getEntry({ inode: directory.inode, name });
        if (existing !== undefined) {
          const fileEntry = requireFileEntry({ entry: existing, name });
          return {
            changed: 'no' as const,
            inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
            result: fileEntry.nodeId,
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
          storage: { type: 'inline' },
        };
        const fileInodeObjectId = await this.runtime.inodeStore.writeFile({
          inode: fileInode,
          binaryPayload: new Uint8Array(),
        });
        const changedDirectory = await this.runtime.directoryStorage.writeChangedInode({
          inode: directory.inode,
          changes: [{
            type: 'set',
            entry: { name, kind: 'file', nodeId: childNodeId },
          }],
          modifiedAt: timestamp,
        });
        let inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId: childNodeId,
          inodeObjectId: fileInodeObjectId,
        });
        inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId,
          nodeId: directoryNodeId,
          inodeObjectId: changedDirectory.inodeObjectId,
        });
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          result: childNodeId,
        };
      },
    });
    return new HizoFSFileHandle({ session: this, nodeId, name });
  }

  async getDirectoryHandle({ directoryNodeId, name, create }: {
    directoryNodeId: string;
    name: string;
    create: boolean;
  }): Promise<StorageDirectoryHandle> {
    this.assertOpen();
    assertHizoFSEntryName({ name });
    if (!create) {
      const state = await this.runtime.core.loadActiveState();
      const directory = await this.runtime.nodeService.readDirectory({ state, nodeId: directoryNodeId });
      const entry = await this.runtime.directoryStorage.getEntry({ inode: directory.inode, name });
      if (entry === undefined) {
        throw createStorageEntryNotFoundError({ message: `Directory '${name}' was not found` });
      }
      const directoryEntry = requireDirectoryEntry({ entry, name });
      return new HizoFSDirectoryHandle({ session: this, nodeId: directoryEntry.nodeId, name });
    }

    const nodeId = await this.runtime.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({ state, nodeId: directoryNodeId });
        const existing = await this.runtime.directoryStorage.getEntry({ inode: directory.inode, name });
        if (existing !== undefined) {
          const directoryEntry = requireDirectoryEntry({ entry: existing, name });
          return {
            changed: 'no' as const,
            inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
            result: directoryEntry.nodeId,
          };
        }

        const childNodeId = createHizoFSStableId();
        const timestamp = this.runtime.now();
        const childInode: HizoFSDirectoryInodeDto = {
          nodeId: childNodeId,
          revision: 0,
          createdAt: timestamp,
          modifiedAt: timestamp,
          storage: { type: 'inline', entries: [] },
        };
        const childInodeObjectId = await this.runtime.inodeStore.writeDirectory({ inode: childInode });
        const changedDirectory = await this.runtime.directoryStorage.writeChangedInode({
          inode: directory.inode,
          changes: [{
            type: 'set',
            entry: { name, kind: 'directory', nodeId: childNodeId },
          }],
          modifiedAt: timestamp,
        });
        let inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId: childNodeId,
          inodeObjectId: childInodeObjectId,
        });
        inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId,
          nodeId: directoryNodeId,
          inodeObjectId: changedDirectory.inodeObjectId,
        });
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          result: childNodeId,
        };
      },
    });
    return new HizoFSDirectoryHandle({ session: this, nodeId, name });
  }

  async *entries({ directoryNodeId }: {
    directoryNodeId: string;
  }): AsyncIterable<readonly [string, StorageEntryHandle]> {
    this.assertOpen();
    const state = await this.runtime.core.loadActiveState();
    const directory = await this.runtime.nodeService.readDirectory({ state, nodeId: directoryNodeId });
    for await (const entry of this.runtime.directoryStorage.entries({ inode: directory.inode })) {
      switch (entry.kind) {
      case 'file':
        yield [entry.name, new HizoFSFileHandle({
          session: this,
          nodeId: entry.nodeId,
          name: entry.name,
        })];
        break;
      case 'directory':
        yield [entry.name, new HizoFSDirectoryHandle({
          session: this,
          nodeId: entry.nodeId,
          name: entry.name,
        })];
        break;
      case 'symlink':
        yield [entry.name, new HizoFSSymlinkHandle({
          session: this,
          nodeId: entry.nodeId,
          name: entry.name,
        })];
        break;
      default: {
        const _ex: never = entry.kind;
        throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
      }
      }
    }
  }

  async createSymlink({ directoryNodeId, name, target }: {
    directoryNodeId: string;
    name: string;
    target: string;
  }): Promise<StorageSymlinkHandle> {
    this.assertOpen();
    assertHizoFSEntryName({ name });
    const nodeId = await this.runtime.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({ state, nodeId: directoryNodeId });
        if (await this.runtime.directoryStorage.getEntry({ inode: directory.inode, name }) !== undefined) {
          throw createNamedError({ name: 'InvalidModificationError', message: `'${name}' already exists` });
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
        const inodeObjectId = await this.runtime.inodeStore.writeSymlink({ inode });
        const changedDirectory = await this.runtime.directoryStorage.writeChangedInode({
          inode: directory.inode,
          changes: [{
            type: 'set',
            entry: { name, kind: 'symlink', nodeId: childNodeId },
          }],
          modifiedAt: timestamp,
        });
        let inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId: childNodeId,
          inodeObjectId,
        });
        inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId,
          nodeId: directoryNodeId,
          inodeObjectId: changedDirectory.inodeObjectId,
        });
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          result: childNodeId,
        };
      },
    });
    return new HizoFSSymlinkHandle({ session: this, nodeId, name });
  }

  async removeEntry({ directoryNodeId, name, recursive }: {
    directoryNodeId: string;
    name: string;
    recursive: boolean;
  }): Promise<void> {
    this.assertOpen();
    assertHizoFSEntryName({ name });
    await this.runtime.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({ state, nodeId: directoryNodeId });
        const entry = await this.runtime.directoryStorage.getEntry({ inode: directory.inode, name });
        if (entry === undefined) {
          throw createStorageEntryNotFoundError({ message: `Entry '${name}' was not found` });
        }
        if (entry.kind === 'directory' && !recursive) {
          const child = await this.runtime.nodeService.readDirectory({ state, nodeId: entry.nodeId });
          if (!await this.runtime.directoryStorage.isEmpty({ inode: child.inode })) {
            throw createNamedError({
              name: 'InvalidModificationError',
              message: `Directory '${name}' is not empty`,
            });
          }
        }
        const deletedNodeIds = await this.collectSubtreeNodeIds({ state, entry });
        const changedDirectory = await this.runtime.directoryStorage.writeChangedInode({
          inode: directory.inode,
          changes: [{ type: 'delete', name }],
          modifiedAt: this.runtime.now(),
        });
        let inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId: directoryNodeId,
          inodeObjectId: changedDirectory.inodeObjectId,
        });
        for (const nodeId of deletedNodeIds) {
          inodeIndexRootObjectId = await this.runtime.nodeService.deleteInode({
            inodeIndexRootObjectId,
            nodeId,
          });
        }
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          result: undefined,
        };
      },
    });
  }

  async moveEntry({ sourceDirectoryNodeId, name, destination, newName, replace }: {
    sourceDirectoryNodeId: string;
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<void> {
    this.assertOpen();
    assertHizoFSEntryName({ name });
    assertHizoFSEntryName({ name: newName });
    if (!(destination instanceof HizoFSDirectoryHandle) || destination.session !== this) {
      throw new Error('HizoFS atomic move requires a destination from the same session');
    }
    const destinationNodeId = destination.nodeId;
    if (sourceDirectoryNodeId === destinationNodeId && name === newName) {
      return;
    }

    await this.runtime.core.mutate({
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
          throw createStorageEntryNotFoundError({ message: `Entry '${name}' was not found` });
        }
        const destinationDirectory = sourceDirectoryNodeId === destinationNodeId
          ? sourceDirectory
          : await this.runtime.nodeService.readDirectory({ state, nodeId: destinationNodeId });

        if (
          sourceEntry.kind === 'directory'
          && await this.directoryContains({
            state,
            rootDirectoryNodeId: sourceEntry.nodeId,
            candidateNodeId: destinationNodeId,
          })
        ) {
          throw createNamedError({
            name: 'InvalidModificationError',
            message: 'A directory cannot be moved into itself or its descendant',
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
              name: 'InvalidModificationError',
              message: `Destination '${newName}' already exists`,
            });
          }
          if (
            isDirectoryEntry({ entry: sourceEntry }) !== isDirectoryEntry({ entry: destinationEntry })
          ) {
            throw createNamedError({
              name: 'TypeMismatchError',
              message: 'Move replacement kinds are incompatible',
            });
          }
          if (isDirectoryEntry({ entry: destinationEntry })) {
            const targetDirectory = await this.runtime.nodeService.readDirectory({
              state,
              nodeId: destinationEntry.nodeId,
            });
            if (!await this.runtime.directoryStorage.isEmpty({ inode: targetDirectory.inode })) {
              throw createNamedError({
                name: 'InvalidModificationError',
                message: 'A non-empty destination directory cannot be replaced',
              });
            }
          }
          replacedNodeIds.push(...await this.collectSubtreeNodeIds({
            state,
            entry: destinationEntry,
          }));
        }

        const timestamp = this.runtime.now();
        const movedEntry: HizoFSDirectoryEntryDto = {
          name: newName,
          kind: sourceEntry.kind,
          nodeId: sourceEntry.nodeId,
        };
        let inodeIndexRootObjectId = state.commit.inodeIndexRootObjectId;
        if (sourceDirectoryNodeId === destinationNodeId) {
          const changes: HizoFSDirectoryChange[] = [
            { type: 'delete', name },
          ];
          if (destinationEntry !== undefined && newName !== name) {
            changes.push({ type: 'delete', name: newName });
          }
          changes.push({ type: 'set', entry: movedEntry });
          const changedDirectory = await this.runtime.directoryStorage.writeChangedInode({
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
          const changedSource = await this.runtime.directoryStorage.writeChangedInode({
            inode: sourceDirectory.inode,
            changes: [{ type: 'delete', name }],
            modifiedAt: timestamp,
          });
          const destinationChanges: HizoFSDirectoryChange[] = [];
          if (destinationEntry !== undefined) {
            destinationChanges.push({ type: 'delete', name: newName });
          }
          destinationChanges.push({ type: 'set', entry: movedEntry });
          const changedDestination = await this.runtime.directoryStorage.writeChangedInode({
            inode: destinationDirectory.inode,
            changes: destinationChanges,
            modifiedAt: timestamp,
          });
          inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
            inodeIndexRootObjectId,
            nodeId: sourceDirectoryNodeId,
            inodeObjectId: changedSource.inodeObjectId,
          });
          inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
            inodeIndexRootObjectId,
            nodeId: destinationNodeId,
            inodeObjectId: changedDestination.inodeObjectId,
          });
        }
        for (const nodeId of replacedNodeIds) {
          if (nodeId !== sourceEntry.nodeId) {
            inodeIndexRootObjectId = await this.runtime.nodeService.deleteInode({
              inodeIndexRootObjectId,
              nodeId,
            });
          }
        }
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          result: undefined,
        };
      },
    });
  }

  async cloneFile({ sourceDirectoryNodeId, name, destination, newName, replace }: {
    sourceDirectoryNodeId: string;
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<StorageFileHandle> {
    this.assertOpen();
    assertHizoFSEntryName({ name });
    assertHizoFSEntryName({ name: newName });
    if (!(destination instanceof HizoFSDirectoryHandle) || destination.session !== this) {
      throw new Error('HizoFS whole-file clone requires a destination from the same session');
    }
    const destinationNodeId = destination.nodeId;
    if (sourceDirectoryNodeId === destinationNodeId && name === newName) {
      throw createNamedError({
        name: 'InvalidModificationError',
        message: 'A file cannot be cloned over itself',
      });
    }

    const clonedNodeId = await this.runtime.core.mutate({
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
          throw createStorageEntryNotFoundError({ message: `File '${name}' was not found` });
        }
        const sourceFileEntry = requireFileEntry({ entry: sourceEntry, name });
        const sourceFile = await this.runtime.nodeService.readFile({
          state,
          nodeId: sourceFileEntry.nodeId,
        });
        const destinationDirectory = sourceDirectoryNodeId === destinationNodeId
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
              name: 'InvalidModificationError',
              message: `Destination '${newName}' already exists`,
            });
          }
          switch (destinationEntry.kind) {
          case 'file':
          case 'symlink':
            break;
          case 'directory':
            throw createNamedError({
              name: 'TypeMismatchError',
              message: 'A file clone cannot replace a directory',
            });
          default: {
            const _ex: never = destinationEntry.kind;
            throw new Error(`Unhandled HizoFS destination entry kind: ${String(_ex)}`);
          }
          }
          if (destinationEntry.nodeId === sourceFileEntry.nodeId) {
            throw createNamedError({
              name: 'InvalidModificationError',
              message: 'A file cannot be cloned over another reference to itself',
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
        const inodeObjectId = await this.runtime.inodeStore.writeFile(clonedFile);
        const directoryChanges: HizoFSDirectoryChange[] = [];
        if (destinationEntry !== undefined) {
          directoryChanges.push({ type: 'delete', name: newName });
        }
        directoryChanges.push({
          type: 'set',
          entry: { name: newName, kind: 'file', nodeId },
        });
        const changedDestination = await this.runtime.directoryStorage.writeChangedInode({
          inode: destinationDirectory.inode,
          changes: directoryChanges,
          modifiedAt: timestamp,
        });
        let inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId: state.commit.inodeIndexRootObjectId,
          nodeId,
          inodeObjectId,
        });
        inodeIndexRootObjectId = await this.runtime.nodeService.setInode({
          inodeIndexRootObjectId,
          nodeId: destinationNodeId,
          inodeObjectId: changedDestination.inodeObjectId,
        });
        if (destinationEntry !== undefined) {
          inodeIndexRootObjectId = await this.runtime.nodeService.deleteInode({
            inodeIndexRootObjectId,
            nodeId: destinationEntry.nodeId,
          });
        }
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId,
          result: nodeId,
        };
      },
    });
    return new HizoFSFileHandle({ session: this, nodeId: clonedNodeId, name: newName });
  }

  async statDirectory({ nodeId }: {
    nodeId: string;
  }): Promise<StorageFileStat> {
    this.assertOpen();
    const state = await this.runtime.core.loadActiveState();
    const { inode } = await this.runtime.nodeService.readDirectory({ state, nodeId });
    return {
      size: 0,
      createdAt: inode.createdAt ?? undefined,
      modifiedAt: inode.modifiedAt ?? undefined,
    };
  }

  async statFile({ nodeId }: {
    nodeId: string;
  }): Promise<StorageFileStat> {
    this.assertOpen();
    const state = await this.runtime.core.loadActiveState();
    const { inode } = await this.runtime.nodeService.readFile({ state, nodeId });
    return {
      size: inode.size,
      createdAt: inode.createdAt ?? undefined,
      modifiedAt: inode.modifiedAt ?? undefined,
    };
  }

  async openFileReader({ nodeId, mimeType }: {
    nodeId: string;
    mimeType: string;
  }): Promise<StorageBinaryObjectReadHandle> {
    this.assertOpen();
    const state = await this.runtime.core.loadActiveState();
    const file = await this.runtime.nodeService.readFile({ state, nodeId });
    const reader = new HizoFSFileReader({
      file,
      extentIndex: this.runtime.extentIndex,
      chunkStore: this.runtime.chunkStore,
      mimeType,
      streamChunkSize: this.runtime.policy.readerStreamChunkSize,
      onSettled: () => this.resources.delete(resource),
    });
    const resource: HizoFSSessionResource = { dispose: () => reader.close() };
    this.resources.add(resource);
    return reader;
  }

  async createFileWriter({ nodeId, keepExistingData }: {
    nodeId: string;
    keepExistingData: boolean;
  }): Promise<StorageWritableFile> {
    this.assertOpen();
    const state = await this.runtime.core.loadActiveState();
    const baseFile = await this.runtime.nodeService.readFile({ state, nodeId });
    const writer = new HizoFSFileWriter({
      core: this.runtime.core,
      nodeService: this.runtime.nodeService,
      inodeStore: this.runtime.inodeStore,
      extentIndex: this.runtime.extentIndex,
      chunkStore: this.runtime.chunkStore,
      policy: this.runtime.policy,
      baseFile,
      keepExistingData,
      now: this.runtime.now,
      onSettled: () => this.resources.delete(resource),
    });
    const resource: HizoFSSessionResource = {
      dispose: () => writer.abort({ reason: new Error('HizoFS session closed') }),
    };
    this.resources.add(resource);
    return writer;
  }

  async statSymlink({ nodeId }: {
    nodeId: string;
  }): Promise<StorageFileStat> {
    this.assertOpen();
    const state = await this.runtime.core.loadActiveState();
    const { inode } = await this.runtime.nodeService.readSymlink({ state, nodeId });
    return {
      size: new TextEncoder().encode(inode.target).byteLength,
      createdAt: inode.createdAt ?? undefined,
      modifiedAt: inode.modifiedAt ?? undefined,
    };
  }

  async readSymlinkTarget({ nodeId }: {
    nodeId: string;
  }): Promise<string> {
    this.assertOpen();
    const state = await this.runtime.core.loadActiveState();
    return (await this.runtime.nodeService.readSymlink({ state, nodeId })).inode.target;
  }

  private async collectSubtreeNodeIds({ state, entry }: {
    state: HizoFSActiveState;
    entry: HizoFSDirectoryEntryDto;
  }): Promise<readonly string[]> {
    const result: string[] = [];
    const visit = async ({ candidate }: { candidate: HizoFSDirectoryEntryDto }): Promise<void> => {
      switch (candidate.kind) {
      case 'directory': {
        const directory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: candidate.nodeId,
        });
        for await (const child of this.runtime.directoryStorage.entries({ inode: directory.inode })) {
          await visit({ candidate: child });
        }
        break;
      }
      case 'file':
      case 'symlink':
        break;
      default: {
        const _ex: never = candidate.kind;
        throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
      }
      }
      result.push(candidate.nodeId);
    };
    await visit({ candidate: entry });
    return result;
  }

  private async directoryContains({ state, rootDirectoryNodeId, candidateNodeId }: {
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
    for await (const entry of this.runtime.directoryStorage.entries({ inode: directory.inode })) {
      if (entry.kind === 'directory' && await this.directoryContains({
        state,
        rootDirectoryNodeId: entry.nodeId,
        candidateNodeId,
      })) {
        return true;
      }
    }
    return false;
  }
}

class HizoFSDirectoryHandle implements StorageDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor({ session, nodeId, name }: {
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

  getFileHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageFileHandle> {
    return this.session.getFileHandle({ directoryNodeId: this.nodeId, name, create });
  }

  getDirectoryHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageDirectoryHandle> {
    return this.session.getDirectoryHandle({ directoryNodeId: this.nodeId, name, create });
  }

  async getEntryHandle({ name }: {
    name: string;
  }): Promise<StorageEntryHandle> {
    this.session.assertOpen();
    assertHizoFSEntryName({ name });
    const state = await this.session.runtime.core.loadActiveState();
    const directory = await this.session.runtime.nodeService.readDirectory({
      state,
      nodeId: this.nodeId,
    });
    const entry = await this.session.runtime.directoryStorage.getEntry({
      inode: directory.inode,
      name,
    });
    if (entry === undefined) {
      throw createStorageEntryNotFoundError({ message: `Entry '${name}' was not found` });
    }
    switch (entry.kind) {
    case 'file':
      return new HizoFSFileHandle({ session: this.session, nodeId: entry.nodeId, name });
    case 'directory':
      return new HizoFSDirectoryHandle({ session: this.session, nodeId: entry.nodeId, name });
    case 'symlink':
      return new HizoFSSymlinkHandle({ session: this.session, nodeId: entry.nodeId, name });
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
    }
    }
  }

  entries(): AsyncIterable<readonly [string, StorageEntryHandle]> {
    return this.session.entries({ directoryNodeId: this.nodeId });
  }

  removeEntry({ name, recursive }: {
    name: string;
    recursive: boolean;
  }): Promise<void> {
    return this.session.removeEntry({ directoryNodeId: this.nodeId, name, recursive });
  }

  createSymlink({ name, target }: {
    name: string;
    target: string;
  }): Promise<StorageSymlinkHandle> {
    return this.session.createSymlink({ directoryNodeId: this.nodeId, name, target });
  }

  moveEntry({ name, destination, newName, replace }: {
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

  cloneFile({ name, destination, newName, replace }: {
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
  readonly kind = 'file' as const;

  constructor({ session, nodeId, name }: {
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

  openReadable({ mimeType }: {
    mimeType: string;
  }): Promise<StorageBinaryObjectReadHandle> {
    return this.session.openFileReader({ nodeId: this.nodeId, mimeType });
  }

  createWritable({ keepExistingData }: {
    keepExistingData: boolean;
  }): Promise<StorageWritableFile> {
    return this.session.createFileWriter({ nodeId: this.nodeId, keepExistingData });
  }
}

class HizoFSSymlinkHandle implements StorageSymlinkHandle {
  readonly kind = 'symlink' as const;

  constructor({ session, nodeId, name }: {
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  HizoFSDirectoryHandle,
};
