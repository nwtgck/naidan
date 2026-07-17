import type {
  HizoFSDirectoryEntryDto,
  HizoFSDirectoryInodeDto,
  HizoFSFileInodeDto,
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
import { HizoFSCorruptionError } from "@/00-storage/service/hizofs/errors";
import type { HizoFSActiveState } from "./core";
import type { HizoFSDirectoryChange } from "./directory-storage";
import { HizoFSFileReader } from "./file-reader";
import { HizoFSFileWriter } from "./file-writer";
import type { LoadedHizoFSFile } from "./node-service";
import type { HizoFSRuntime } from "./runtime";
import { acquireHizoFSResourceLease } from "./maintenance-lock";
import type { HizoFSMaintenanceLease } from "./maintenance-lock";
import { assertHizoFSEntryName } from "./semantic-validation";
import type { StorageBinaryObjectReadHandle } from "@/00-storage/service/binary-object-io";

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

function requireFileEntry({
  entry,
  name,
}: {
  entry: HizoFSDirectoryEntryDto;
  name: string;
}): HizoFSDirectoryEntryDto {
  switch (entry.kind) {
  case "file":
    return entry;
  case "directory":
  case "symlink":
    throw createNamedError({
      name: "TypeMismatchError",
      message: `'${name}' is not a file`,
    });
  default: {
    const _ex: never = entry.kind;
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
}): HizoFSDirectoryEntryDto {
  switch (entry.kind) {
  case "directory":
    return entry;
  case "file":
  case "symlink":
    throw createNamedError({
      name: "TypeMismatchError",
      message: `'${name}' is not a directory`,
    });
  default: {
    const _ex: never = entry.kind;
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
    return true;
  case "file":
  case "symlink":
    return false;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
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
    rootDirectoryNodeId,
    workerMountContext,
    fixedState,
    sessionLease,
  }: {
    runtime: HizoFSRuntime;
    rootDirectoryNodeId: string;
    workerMountContext: Omit<
      StorageDirectoryWorkerMountSource,
      "rootDirectoryNodeId"
    >;
    fixedState: HizoFSActiveState | undefined;
    sessionLease: HizoFSMaintenanceLease | undefined;
  }) {
    this.runtime = runtime;
    this.rootDirectoryNodeId = rootDirectoryNodeId;
    this.fileSystemId = runtime.core.fileSystemId;
    this.workerMountContext = workerMountContext;
    this.fixedState = fixedState;
    this.sessionLease = sessionLease;
    this.root = new HizoFSDirectoryHandle({
      session: this,
      nodeId: rootDirectoryNodeId,
      name: "",
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
  readonly rootDirectoryNodeId: string;
  readonly runtime: HizoFSRuntime;
  private readonly fixedState: HizoFSActiveState | undefined;
  private readonly sessionLease: HizoFSMaintenanceLease | undefined;
  private readonly workerMountContext: Omit<
    StorageDirectoryWorkerMountSource,
    "rootDirectoryNodeId"
  >;
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
    this.runtime.objectStore.clearPlaintextCaches();
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
      fileSystemId: this.fileSystemId,
    });
    try {
      const fixedState = await this.loadActiveState();
      return new HizoFSSession({
        runtime: this.runtime,
        rootDirectoryNodeId: fixedState.commit.rootDirectoryNodeId,
        workerMountContext: this.workerMountContext,
        fixedState,
        sessionLease,
      });
    } catch (error) {
      await sessionLease.release();
      throw error;
    }
  }

  loadActiveState(): Promise<HizoFSActiveState> {
    return this.fixedState === undefined
      ? this.runtime.core.loadActiveState()
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
      fileSystemId: this.fileSystemId,
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
      throw new Error('HizoFS read snapshot is immutable');
    }
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
    if (source.fileSystemId !== this.fileSystemId) {
      throw new Error("HizoFS Worker mount belongs to a different file system");
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
        const state = await this.loadActiveState();
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
    assertHizoFSEntryName({ name });
    if (create) this.assertMutable();
    if (!create) {
      return await this.runWithReadLease({
        operation: async () => {
          const state = await this.loadActiveState();
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

    const nodeId = await this.runtime.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: directoryNodeId,
        });
        const existing = await this.runtime.directoryStorage.getEntry({
          inode: directory.inode,
          name,
        });
        if (existing !== undefined) {
          const fileEntry = requireFileEntry({ entry: existing, name });
          return {
            changed: "no" as const,
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
    return new HizoFSFileHandle({ session: this, nodeId, name });
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
    assertHizoFSEntryName({ name });
    if (create) this.assertMutable();
    if (!create) {
      return await this.runWithReadLease({
        operation: async () => {
          const state = await this.loadActiveState();
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
              message: `Directory '${name}' was not found`,
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

    const nodeId = await this.runtime.core.mutate({
      operation: async ({ state }) => {
        const directory = await this.runtime.nodeService.readDirectory({
          state,
          nodeId: directoryNodeId,
        });
        const existing = await this.runtime.directoryStorage.getEntry({
          inode: directory.inode,
          name,
        });
        if (existing !== undefined) {
          const directoryEntry = requireDirectoryEntry({
            entry: existing,
            name,
          });
          return {
            changed: "no" as const,
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
    return new HizoFSDirectoryHandle({ session: this, nodeId, name });
  }

  async *entries({
    directoryNodeId,
  }: {
    directoryNodeId: string;
  }): AsyncIterable<readonly [string, StorageEntryHandle]> {
    this.assertOpen();
    const lease = this.sessionLease === undefined
      ? await acquireHizoFSResourceLease({ fileSystemId: this.fileSystemId })
      : undefined;
    const resource: HizoFSSessionResource | undefined = lease === undefined
      ? undefined
      : { dispose: () => lease.release() };
    if (resource !== undefined) {
      this.resources.add(resource);
    }
    try {
      const state = await this.loadActiveState();
      const directory = await this.runtime.nodeService.readDirectory({
        state,
        nodeId: directoryNodeId,
      });
      for await (const entry of this.runtime.directoryStorage.entries({
        inode: directory.inode,
      })) {
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
        default: {
          const _ex: never = entry.kind;
          throw new Error(`Unhandled HizoFS entry kind: ${String(_ex)}`);
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
    const nodeId = await this.runtime.core.mutate({
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
    await this.runtime.core.mutate({
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
      throw new Error(
        "HizoFS atomic move requires a destination from the same session",
      );
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
            isDirectoryEntry({ entry: destinationEntry })
          ) {
            throw createNamedError({
              name: "TypeMismatchError",
              message: "Move replacement kinds are incompatible",
            });
          }
          if (isDirectoryEntry({ entry: destinationEntry })) {
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
        const movedEntry: HizoFSDirectoryEntryDto = {
          name: newName,
          kind: sourceEntry.kind,
          nodeId: sourceEntry.nodeId,
        };
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
          nodeIds: new Set(
            replacedNodeIds.filter(nodeId => nodeId !== sourceEntry.nodeId),
          ),
        });
        return {
          changed: "yes" as const,
          inodeIndexRootObjectId,
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
            throw createNamedError({
              name: "TypeMismatchError",
              message: "A file clone cannot replace a directory",
            });
          default: {
            const _ex: never = destinationEntry.kind;
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
        const state = await this.loadActiveState();
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
        default: {
          const _ex: never = entry.kind;
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
        const state = await this.loadActiveState();
        const { inode } = await this.runtime.nodeService.readDirectory({
          state,
          nodeId,
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
        const state = await this.loadActiveState();
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
      fileSystemId: this.fileSystemId,
    });
    let file;
    try {
      const state = await this.loadActiveState();
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
      fileSystemId: this.fileSystemId,
    });
    let baseFile;
    try {
      const state = await this.loadActiveState();
      baseFile = await this.runtime.nodeService.readFile({ state, nodeId });
    } catch (error) {
      await maintenanceLease.release();
      throw error;
    }
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
        const state = await this.loadActiveState();
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
        const state = await this.loadActiveState();
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
    const result: string[] = [];
    const pending: Array<{
      readonly entry: HizoFSDirectoryEntryDto;
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
            pending.push({ entry: child, visitedChildren: false });
          }
        }
        break;
      }
      case 'file':
      case 'symlink':
        break;
      default: {
        const _ex: never = current.entry.kind;
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  HizoFSDirectoryHandle,
};
