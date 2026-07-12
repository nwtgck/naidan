import {
  EncryptedDirectoryManifestSchemaDto,
  EncryptedDirectoryShardContentsSchemaDto,
  EncryptedFileSystemDescriptorSchemaDto,
  type EncryptedDirectoryManifestDto,
  type EncryptedDirectoryShardContentsDto,
  type EncryptedFileSystemDescriptorDto,
  type EncryptedFileSystemEntryDto,
} from '@/00-storage/00-dto/encryption.dto';
import { writeReadableStreamToFileHandle } from '@/utils/file-system-stream';
import { encodeBase64Url } from './base64-url';
import { EncryptedFileStore } from './encrypted-file-store';
import { EncryptedJsonObjectStore } from './encrypted-json-object-store';
import {
  EncryptedObjectStore,
  type EncryptedObjectLocator,
} from './encrypted-object-store';
import {
  EncryptedObjectTransactionCoordinator,
  type EncryptedObjectMutationOperation,
  type PreparedEncryptedObjectMutation,
} from './encrypted-object-transaction-coordinator';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

const UTF8 = new TextEncoder();
const MAX_SYMBOLIC_LINK_DEPTH = 40;

function createOpaqueId(): string {
  return encodeBase64Url({
    bytes: crypto.getRandomValues(new Uint8Array(16)),
  });
}

function assertEntryName({ name }: { name: string }): void {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\0')
  ) {
    throw new Error(`Invalid encrypted filesystem entry name: ${JSON.stringify(name)}`);
  }
}

function assertNonNegativeSafeInteger({
  value,
  fieldName,
}: {
  value: number,
  fieldName: string,
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function assertNullableNonNegativeSafeInteger({
  value,
  fieldName,
}: {
  value: number | null,
  fieldName: string,
}): void {
  if (value !== null) {
    assertNonNegativeSafeInteger({ value, fieldName });
  }
}

function assertFileSystemDescriptor({
  descriptor,
  expectedFileSystemId,
}: {
  descriptor: EncryptedFileSystemDescriptorDto,
  expectedFileSystemId: string,
}): void {
  if (descriptor.id !== expectedFileSystemId) {
    throw new Error(`Encrypted filesystem descriptor ID mismatch: ${expectedFileSystemId}`);
  }
  if (descriptor.id.length === 0 || descriptor.rootDirectoryId.length === 0) {
    throw new Error(`Encrypted filesystem descriptor contains an empty identity: ${expectedFileSystemId}`);
  }
  assertNonNegativeSafeInteger({
    value: descriptor.createdAt,
    fieldName: 'Encrypted filesystem creation time',
  });
}

function assertFileSystemEntry({ entry }: { entry: EncryptedFileSystemEntryDto }): void {
  assertEntryName({ name: entry.name });
  switch (entry.type) {
  case 'file':
    if (entry.fileId.length === 0) {
      throw new Error('Encrypted filesystem file ID must not be empty');
    }
    break;
  case 'directory':
    if (entry.directoryId.length === 0) {
      throw new Error('Encrypted filesystem directory ID must not be empty');
    }
    break;
  case 'symlink':
    if (entry.targetPath.includes('\0')) {
      throw new Error('Encrypted filesystem symlink target must not contain NUL');
    }
    assertNullableNonNegativeSafeInteger({
      value: entry.createdAt,
      fieldName: 'Encrypted filesystem symlink createdAt',
    });
    assertNonNegativeSafeInteger({
      value: entry.modifiedAt,
      fieldName: 'Encrypted filesystem symlink modifiedAt',
    });
    break;
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
  }
  }
}

function assertDirectoryManifest({
  manifest,
  expectedDirectoryId,
}: {
  manifest: EncryptedDirectoryManifestDto,
  expectedDirectoryId: string,
}): void {
  if (manifest.directoryId !== expectedDirectoryId) {
    throw new Error(`Encrypted directory manifest ID mismatch: ${expectedDirectoryId}`);
  }
  assertNonNegativeSafeInteger({ value: manifest.revision, fieldName: 'Encrypted directory revision' });
  assertNullableNonNegativeSafeInteger({ value: manifest.createdAt, fieldName: 'Encrypted directory createdAt' });
  assertNonNegativeSafeInteger({ value: manifest.modifiedAt, fieldName: 'Encrypted directory modifiedAt' });
  const seenShardIds = new Set<string>();
  const seenObjectIds = new Set<string>();
  for (const shard of manifest.shards) {
    if (!/^[0-9a-f]{2}$/u.test(shard.shardId)) {
      throw new Error(`Encrypted directory shard ID is invalid: ${JSON.stringify(shard.shardId)}`);
    }
    if (shard.objectId.length === 0) {
      throw new Error('Encrypted directory shard object ID must not be empty');
    }
    if (seenShardIds.has(shard.shardId) || seenObjectIds.has(shard.objectId)) {
      throw new Error(`Encrypted directory manifest contains a duplicate shard: ${shard.shardId}`);
    }
    seenShardIds.add(shard.shardId);
    seenObjectIds.add(shard.objectId);
  }
}

function normalizePath({ path }: { path: string }): string {
  const normalized: string[] = [];
  for (const part of path.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      normalized.pop();
      continue;
    }
    assertEntryName({ name: part });
    normalized.push(part);
  }
  return `/${normalized.join('/')}`;
}

function splitPath({ path }: { path: string }): string[] {
  return normalizePath({ path }).split('/').filter(Boolean);
}

export interface EncryptedFileSystemResolvedEntry {
  readonly parentDirectoryId: string | undefined,
  readonly entry: EncryptedFileSystemEntryDto | undefined,
  readonly directoryId: string,
  readonly fullPath: string,
}

type EncryptedFileEntry = Extract<EncryptedFileSystemEntryDto, { type: 'file' }>;
type EncryptedDirectoryEntry = Extract<EncryptedFileSystemEntryDto, { type: 'directory' }>;

type DirectoryChange =
  | { readonly type: 'set', readonly entry: EncryptedFileSystemEntryDto }
  | { readonly type: 'delete', readonly name: string };

function requireFileEntry({
  entry,
  path,
}: {
  entry: EncryptedFileSystemEntryDto | undefined,
  path: string,
}): EncryptedFileEntry {
  if (entry === undefined || entry.type !== 'file') {
    throw new Error(`Encrypted filesystem path is not a file: ${path}`);
  }
  return entry;
}

function requireDirectoryEntry({
  entry,
  path,
}: {
  entry: EncryptedFileSystemEntryDto | undefined,
  path: string,
}): EncryptedDirectoryEntry {
  if (entry === undefined || entry.type !== 'directory') {
    throw new Error(`Encrypted filesystem path is not a directory: ${path}`);
  }
  return entry;
}

function getDirectoryId({
  entry,
  rootDirectoryId,
  path,
}: {
  entry: EncryptedFileSystemEntryDto | undefined,
  rootDirectoryId: string,
  path: string,
}): string {
  return entry === undefined
    ? rootDirectoryId
    : requireDirectoryEntry({ entry, path }).directoryId;
}

function isSameEntryTarget({
  left,
  right,
}: {
  left: EncryptedFileSystemEntryDto,
  right: EncryptedFileSystemEntryDto,
}): boolean {
  if (left.type !== right.type) {
    return false;
  }
  switch (left.type) {
  case 'file':
    return right.type === 'file' && left.fileId === right.fileId;
  case 'directory':
    return right.type === 'directory' && left.directoryId === right.directoryId;
  case 'symlink':
    return right.type === 'symlink'
      && left.targetPath === right.targetPath
      && left.createdAt === right.createdAt
      && left.modifiedAt === right.modifiedAt;
  default: {
    const _ex: never = left;
    throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
  }
  }
}

function combineCleanup({
  cleanups,
}: {
  cleanups: Array<(() => Promise<void>) | undefined>,
}): (() => Promise<void>) | undefined {
  const present = cleanups.filter((cleanup): cleanup is () => Promise<void> => cleanup !== undefined);
  return present.length === 0
    ? undefined
    : async () => {
      for (const cleanup of present) {
        await cleanup();
      }
    };
}

export class EncryptedFileSystemStore {
  constructor({
    objectStore,
    fileStore,
  }: {
    objectStore: EncryptedObjectStore,
    fileStore: EncryptedFileStore,
  }) {
    this.objectStore = objectStore;
    this.jsonStore = new EncryptedJsonObjectStore({ objectStore });
    this.fileStore = fileStore;
  }

  private readonly objectStore: EncryptedObjectStore;
  private readonly jsonStore: EncryptedJsonObjectStore;
  private readonly fileStore: EncryptedFileStore;
  private readonly coordinators = new Map<string, EncryptedObjectTransactionCoordinator>();
  private readonly descriptorCoordinators = new Map<string, EncryptedObjectTransactionCoordinator>();

  async createFileSystem({
    fileSystemId,
    createdAt,
  }: {
    fileSystemId: string,
    createdAt: number,
  }): Promise<EncryptedFileSystemDescriptorDto> {
    if (fileSystemId.length === 0) {
      throw new Error('Encrypted filesystem ID must not be empty');
    }
    const coordinator = this.getFileSystemDescriptorCoordinator({ fileSystemId });
    let resultDescriptor: EncryptedFileSystemDescriptorDto | undefined;
    return await coordinator.mutate({
      prepare: async () => {
        if (await this.readFileSystemDescriptorUnsafe({ fileSystemId }) !== undefined) {
          throw new Error(`Encrypted filesystem already exists: ${fileSystemId}`);
        }
        const prepared = this.prepareFileSystemCreation({ fileSystemId, createdAt });
        resultDescriptor = prepared.descriptor;
        return prepared;
      },
      result: async () => {
        if (resultDescriptor === undefined) {
          throw new Error('Encrypted filesystem creation produced no descriptor');
        }
        return resultDescriptor;
      },
    });
  }

  async openFileSystem({
    fileSystemId,
  }: {
    fileSystemId: string,
  }): Promise<EncryptedFileSystemDescriptorDto | undefined> {
    return await this.getFileSystemDescriptorCoordinator({ fileSystemId }).read({
      run: async () => await this.readFileSystemDescriptorUnsafe({ fileSystemId }),
    });
  }

  async getOrCreateFileSystem({
    fileSystemId,
    createdAt,
  }: {
    fileSystemId: string,
    createdAt: number,
  }): Promise<EncryptedFileSystemDescriptorDto> {
    if (fileSystemId.length === 0) {
      throw new Error('Encrypted filesystem ID must not be empty');
    }
    const coordinator = this.getFileSystemDescriptorCoordinator({ fileSystemId });
    let resultDescriptor: EncryptedFileSystemDescriptorDto | undefined;
    return await coordinator.mutate({
      prepare: async () => {
        const existing = await this.readFileSystemDescriptorUnsafe({ fileSystemId });
        if (existing !== undefined) {
          resultDescriptor = existing;
          return { operations: [] };
        }
        const prepared = this.prepareFileSystemCreation({ fileSystemId, createdAt });
        resultDescriptor = prepared.descriptor;
        return prepared;
      },
      result: async () => {
        if (resultDescriptor === undefined) {
          throw new Error('Encrypted filesystem get-or-create produced no descriptor');
        }
        return resultDescriptor;
      },
    });
  }

  async deleteFileSystem({
    fileSystemId,
  }: {
    fileSystemId: string,
  }): Promise<void> {
    const coordinator = this.getFileSystemDescriptorCoordinator({ fileSystemId });
    await coordinator.mutate({
      prepare: async () => {
        const descriptor = await this.readFileSystemDescriptorUnsafe({ fileSystemId });
        if (descriptor === undefined) {
          return { operations: [] };
        }
        return {
          operations: [{
            type: 'delete',
            locator: this.getFileSystemDescriptorLocator({ fileSystemId }),
          }],
          cleanupAfterCommit: async () => {
            await this.getCoordinator({ rootDirectoryId: descriptor.rootDirectoryId }).runExclusive({
              run: async () => {
                await this.cleanupDirectoryTreeUnsafe({
                  directoryId: descriptor.rootDirectoryId,
                });
              },
            });
          },
        };
      },
      result: async () => undefined,
    });
  }

  async resolve({
    rootDirectoryId,
    path,
  }: {
    rootDirectoryId: string,
    path: string,
  }): Promise<EncryptedFileSystemResolvedEntry> {
    return await this.getCoordinator({ rootDirectoryId }).read({
      run: async () => await this.resolveUnsafe({ rootDirectoryId, path }),
    });
  }

  async tryResolve({
    rootDirectoryId,
    path,
  }: {
    rootDirectoryId: string,
    path: string,
  }): Promise<EncryptedFileSystemResolvedEntry | undefined> {
    try {
      return await this.resolve({ rootDirectoryId, path });
    } catch (error) {
      if (error instanceof Error && error.message.includes('path not found')) {
        return undefined;
      }
      throw error;
    }
  }

  async *readDirectory({
    rootDirectoryId,
    directoryId,
  }: {
    rootDirectoryId: string,
    directoryId: string,
  }): AsyncIterable<EncryptedFileSystemEntryDto> {
    const entries = await this.getCoordinator({ rootDirectoryId }).read({
      run: async () => await this.readDirectoryEntriesUnsafe({ directoryId }),
    });
    for (const entry of entries) {
      yield entry;
    }
  }

  async openFile({
    rootDirectoryId,
    path,
    mimeType,
  }: {
    rootDirectoryId: string,
    path: string,
    mimeType: string | undefined,
  }) {
    return await this.getCoordinator({ rootDirectoryId }).read({
      run: async () => {
        const resolved = await this.resolveUnsafe({
          rootDirectoryId,
          path,
          followFinalSymlink: true,
        });
        const fileEntry = requireFileEntry({ entry: resolved.entry, path });
        return await this.fileStore.open({
          fileId: fileEntry.fileId,
          mimeType: mimeType ?? 'application/octet-stream',
        });
      },
    });
  }

  async getFileManifest({
    rootDirectoryId,
    path,
  }: {
    rootDirectoryId: string,
    path: string,
  }) {
    return await this.getCoordinator({ rootDirectoryId }).read({
      run: async () => {
        const resolved = await this.resolveUnsafe({
          rootDirectoryId,
          path,
          followFinalSymlink: true,
        });
        const fileEntry = requireFileEntry({ entry: resolved.entry, path });
        const manifest = await this.fileStore.readManifest({ fileId: fileEntry.fileId });
        if (manifest === undefined) {
          throw new Error(`Encrypted filesystem file manifest is missing: ${path}`);
        }
        return manifest;
      },
    });
  }

  async getDirectoryManifest({
    rootDirectoryId,
    directoryId,
  }: {
    rootDirectoryId: string,
    directoryId: string,
  }): Promise<EncryptedDirectoryManifestDto> {
    return await this.getCoordinator({ rootDirectoryId }).read({
      run: async () => {
        const manifest = await this.readDirectoryManifestUnsafe({ directoryId });
        if (manifest === undefined) {
          throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
        }
        return manifest;
      },
    });
  }

  async writeFileRange({
    rootDirectoryId,
    path,
    bytes,
    position,
    modifiedAt,
    signal,
  }: {
    rootDirectoryId: string,
    path: string,
    bytes: Uint8Array,
    position: number,
    modifiedAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    await this.getCoordinator({ rootDirectoryId }).mutate({
      prepare: async () => {
        const resolved = await this.resolveUnsafe({
          rootDirectoryId,
          path,
          followFinalSymlink: true,
        });
        const fileEntry = requireFileEntry({ entry: resolved.entry, path });
        await this.fileStore.writeRange({
          fileId: fileEntry.fileId,
          bytes,
          position,
          modifiedAt,
          signal,
        });
        return { operations: [] };
      },
      result: async () => undefined,
    });
  }

  async truncateFile({
    rootDirectoryId,
    path,
    size,
    modifiedAt,
  }: {
    rootDirectoryId: string,
    path: string,
    size: number,
    modifiedAt: number,
  }): Promise<void> {
    await this.getCoordinator({ rootDirectoryId }).mutate({
      prepare: async () => {
        const resolved = await this.resolveUnsafe({
          rootDirectoryId,
          path,
          followFinalSymlink: true,
        });
        const fileEntry = requireFileEntry({ entry: resolved.entry, path });
        await this.fileStore.truncate({ fileId: fileEntry.fileId, size, modifiedAt });
        return { operations: [] };
      },
      result: async () => undefined,
    });
  }

  async createDirectory({
    rootDirectoryId,
    path,
    recursive,
    createdAt,
  }: {
    rootDirectoryId: string,
    path: string,
    recursive: boolean,
    createdAt?: number | null,
  }): Promise<string> {
    const parts = splitPath({ path });
    let directoryId = rootDirectoryId;
    for (const [index, name] of parts.entries()) {
      const currentPath = `/${parts.slice(0, index + 1).join('/')}`;
      let preparedDirectoryId: string | undefined;
      const nextDirectoryId = await this.getCoordinator({ rootDirectoryId }).mutate({
        prepare: async () => {
          const existing = await this.getEntryUnsafe({ directoryId, name });
          if (existing !== undefined) {
            const resolved = await this.resolveUnsafe({
              rootDirectoryId,
              path: currentPath,
              followFinalSymlink: true,
            });
            preparedDirectoryId = getDirectoryId({
              entry: resolved.entry,
              rootDirectoryId,
              path: currentPath,
            });
            return { operations: [] };
          }
          if (!recursive && index !== parts.length - 1) {
            throw new Error(`Encrypted filesystem parent directory does not exist: ${name}`);
          }
          const childDirectoryId = createOpaqueId();
          preparedDirectoryId = childDirectoryId;
          const timestamp = Date.now();
          const childCreatedAt = createdAt === undefined ? timestamp : createdAt;
          await this.writeDirectoryManifestUnsafe({
            manifest: {
              directoryId: childDirectoryId,
              revision: 0,
              createdAt: childCreatedAt,
              modifiedAt: timestamp,
              shards: [],
            },
          });
          const parentMutation = await this.prepareDirectoryChangesUnsafe({
            directoryId,
            changes: [{
              type: 'set',
              entry: { type: 'directory', name, directoryId: childDirectoryId },
            }],
          });
          return {
            operations: parentMutation.operations,
            cleanupAfterCommit: parentMutation.cleanupAfterCommit,
            cleanupAfterFailure: combineCleanup({
              cleanups: [
                parentMutation.cleanupAfterFailure,
                async () => await this.deleteDirectoryStorageUnsafe({ directoryId: childDirectoryId }),
              ],
            }),
          };
        },
        result: async () => {
          if (preparedDirectoryId === undefined) {
            throw new Error('Encrypted directory creation produced no directory ID');
          }
          return preparedDirectoryId;
        },
      });
      directoryId = nextDirectoryId;
    }
    return directoryId;
  }

  async createFile({
    rootDirectoryId,
    path,
    overwrite,
    modifiedAt,
  }: {
    rootDirectoryId: string,
    path: string,
    overwrite: boolean,
    modifiedAt: number,
  }): Promise<string> {
    let resultFileId: string | undefined;
    return await this.getCoordinator({ rootDirectoryId }).mutate({
      prepare: async () => {
        const { parentDirectoryId, name } = await this.resolveParentUnsafe({ rootDirectoryId, path });
        const existing = await this.getEntryUnsafe({ directoryId: parentDirectoryId, name });
        if (existing !== undefined) {
          const file = requireFileEntry({ entry: existing, path });
          if (!overwrite) {
            throw new Error(`Encrypted filesystem entry already exists: ${name}`);
          }
          resultFileId = file.fileId;
          await this.fileStore.createEmpty({ fileId: file.fileId, modifiedAt });
          return { operations: [] };
        }
        const fileId = createOpaqueId();
        resultFileId = fileId;
        await this.fileStore.createEmpty({ fileId, modifiedAt });
        const parentMutation = await this.prepareDirectoryChangesUnsafe({
          directoryId: parentDirectoryId,
          changes: [{ type: 'set', entry: { type: 'file', name, fileId } }],
        });
        return {
          operations: parentMutation.operations,
          cleanupAfterCommit: parentMutation.cleanupAfterCommit,
          cleanupAfterFailure: combineCleanup({
            cleanups: [
              parentMutation.cleanupAfterFailure,
              async () => await this.fileStore.delete({ fileId }),
            ],
          }),
        };
      },
      result: async () => {
        if (resultFileId === undefined) {
          throw new Error('Encrypted file creation produced no file ID');
        }
        return resultFileId;
      },
    });
  }

  async writeFile({
    rootDirectoryId,
    path,
    source,
    size,
    createdAt,
    modifiedAt,
    signal,
  }: {
    rootDirectoryId: string,
    path: string,
    source: ReadableStream<Uint8Array>,
    size: number,
    createdAt?: number | null,
    modifiedAt: number,
    signal: AbortSignal | undefined,
  }): Promise<string> {
    let resultFileId: string | undefined;
    return await this.getCoordinator({ rootDirectoryId }).mutate({
      prepare: async () => {
        const parent = await this.resolveParentUnsafe({ rootDirectoryId, path });
        const existing = await this.getEntryUnsafe({
          directoryId: parent.parentDirectoryId,
          name: parent.name,
        });
        const fileId = existing === undefined
          ? createOpaqueId()
          : requireFileEntry({ entry: existing, path }).fileId;
        resultFileId = fileId;
        await this.fileStore.write({ fileId, source, size, createdAt, modifiedAt, signal });
        if (existing !== undefined) {
          return { operations: [] };
        }
        const parentMutation = await this.prepareDirectoryChangesUnsafe({
          directoryId: parent.parentDirectoryId,
          changes: [{
            type: 'set',
            entry: { type: 'file', name: parent.name, fileId },
          }],
        });
        return {
          operations: parentMutation.operations,
          cleanupAfterCommit: parentMutation.cleanupAfterCommit,
          cleanupAfterFailure: combineCleanup({
            cleanups: [
              parentMutation.cleanupAfterFailure,
              async () => await this.fileStore.delete({ fileId }),
            ],
          }),
        };
      },
      result: async () => {
        if (resultFileId === undefined) {
          throw new Error('Encrypted file write produced no file ID');
        }
        return resultFileId;
      },
    });
  }

  async createSymlink({
    rootDirectoryId,
    path,
    targetPath,
    createdAt,
    modifiedAt,
  }: {
    rootDirectoryId: string,
    path: string,
    targetPath: string,
    createdAt?: number | null,
    modifiedAt: number,
  }): Promise<void> {
    await this.getCoordinator({ rootDirectoryId }).mutate({
      prepare: async () => {
        const parent = await this.resolveParentUnsafe({ rootDirectoryId, path });
        if (await this.getEntryUnsafe({ directoryId: parent.parentDirectoryId, name: parent.name }) !== undefined) {
          throw new Error(`Encrypted filesystem entry already exists: ${parent.name}`);
        }
        return await this.prepareDirectoryChangesUnsafe({
          directoryId: parent.parentDirectoryId,
          changes: [{
            type: 'set',
            entry: {
              type: 'symlink',
              name: parent.name,
              targetPath,
              createdAt: createdAt === undefined ? modifiedAt : createdAt,
              modifiedAt,
            },
          }],
        });
      },
      result: async () => undefined,
    });
  }

  async remove({
    rootDirectoryId,
    path,
    recursive,
  }: {
    rootDirectoryId: string,
    path: string,
    recursive: boolean,
  }): Promise<void> {
    await this.getCoordinator({ rootDirectoryId }).mutate({
      prepare: async () => {
        const parent = await this.resolveParentUnsafe({ rootDirectoryId, path });
        const entry = await this.getEntryUnsafe({
          directoryId: parent.parentDirectoryId,
          name: parent.name,
        });
        if (entry === undefined) {
          return { operations: [] };
        }
        switch (entry.type) {
        case 'file':
        case 'symlink':
          break;
        case 'directory': {
          const children = await this.readDirectoryEntriesUnsafe({ directoryId: entry.directoryId });
          if (!recursive && children.length > 0) {
            throw new Error(`Encrypted filesystem directory is not empty: ${path}`);
          }
          break;
        }
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
        }
        }
        const parentMutation = await this.prepareDirectoryChangesUnsafe({
          directoryId: parent.parentDirectoryId,
          changes: [{ type: 'delete', name: parent.name }],
        });
        return {
          operations: parentMutation.operations,
          cleanupAfterFailure: parentMutation.cleanupAfterFailure,
          cleanupAfterCommit: combineCleanup({
            cleanups: [
              parentMutation.cleanupAfterCommit,
              async () => await this.cleanupEntryPayloadUnsafe({ entry }),
            ],
          }),
        };
      },
      result: async () => undefined,
    });
  }

  async rename({
    rootDirectoryId,
    oldPath,
    newPath,
  }: {
    rootDirectoryId: string,
    oldPath: string,
    newPath: string,
  }): Promise<void> {
    const normalizedOldPath = normalizePath({ path: oldPath });
    const normalizedNewPath = normalizePath({ path: newPath });
    if (normalizedOldPath === normalizedNewPath) {
      return;
    }
    await this.getCoordinator({ rootDirectoryId }).mutate({
      prepare: async () => {
        const oldParent = await this.resolveParentUnsafe({ rootDirectoryId, path: oldPath });
        const newParent = await this.resolveParentUnsafe({ rootDirectoryId, path: newPath });
        const entry = await this.getEntryUnsafe({
          directoryId: oldParent.parentDirectoryId,
          name: oldParent.name,
        });
        if (entry === undefined) {
          throw new Error(`Encrypted filesystem path not found: ${oldPath}`);
        }
        if (
          entry.type === 'directory'
          && (
            normalizedNewPath.startsWith(`${normalizedOldPath}/`)
            || await this.directoryContainsDirectoryUnsafe({
              ancestorDirectoryId: entry.directoryId,
              candidateDirectoryId: newParent.parentDirectoryId,
            })
          )
        ) {
          throw new Error('Encrypted filesystem directory cannot be moved into itself');
        }
        const destination = await this.getEntryUnsafe({
          directoryId: newParent.parentDirectoryId,
          name: newParent.name,
        });
        if (destination !== undefined && !isSameEntryTarget({ left: entry, right: destination })) {
          throw new Error(`Encrypted filesystem destination already exists: ${newPath}`);
        }
        if (oldParent.parentDirectoryId === newParent.parentDirectoryId) {
          return await this.prepareDirectoryChangesUnsafe({
            directoryId: oldParent.parentDirectoryId,
            changes: [
              { type: 'delete', name: oldParent.name },
              { type: 'set', entry: { ...entry, name: newParent.name } },
            ],
          });
        }
        const destinationMutation = destination === undefined
          ? await this.prepareDirectoryChangesUnsafe({
            directoryId: newParent.parentDirectoryId,
            changes: [{ type: 'set', entry: { ...entry, name: newParent.name } }],
          })
          : { operations: [] } satisfies PreparedEncryptedObjectMutation;
        const sourceMutation = await this.prepareDirectoryChangesUnsafe({
          directoryId: oldParent.parentDirectoryId,
          changes: [{ type: 'delete', name: oldParent.name }],
        });
        return {
          operations: [...destinationMutation.operations, ...sourceMutation.operations],
          cleanupAfterCommit: combineCleanup({
            cleanups: [destinationMutation.cleanupAfterCommit, sourceMutation.cleanupAfterCommit],
          }),
          cleanupAfterFailure: combineCleanup({
            cleanups: [destinationMutation.cleanupAfterFailure, sourceMutation.cleanupAfterFailure],
          }),
        };
      },
      result: async () => undefined,
    });
  }

  async importDirectory({
    rootDirectoryId,
    source,
    destinationPath,
    signal,
    onFile,
  }: {
    rootDirectoryId: string,
    source: FileSystemDirectoryHandle,
    destinationPath: string,
    signal: AbortSignal | undefined,
    onFile?: () => void,
  }): Promise<void> {
    await this.createDirectory({
      rootDirectoryId,
      path: destinationPath,
      recursive: true,
      createdAt: null,
    });
    for await (const entry of source.values()) {
      signal?.throwIfAborted();
      const childPath = `${normalizePath({ path: destinationPath })}/${entry.name}`;
      switch (entry.kind) {
      case 'file': {
        const file = await entry.getFile();
        await this.writeFile({
          rootDirectoryId,
          path: childPath,
          source: file.stream(),
          size: file.size,
          createdAt: null,
          modifiedAt: file.lastModified,
          signal,
        });
        onFile?.();
        break;
      }
      case 'directory':
        await this.importDirectory({
          rootDirectoryId,
          source: entry,
          destinationPath: childPath,
          signal,
          onFile,
        });
        break;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled native filesystem entry: ${String(_ex)}`);
      }
      }
    }
  }

  async exportDirectory({
    rootDirectoryId,
    sourcePath,
    destination,
    signal,
  }: {
    rootDirectoryId: string,
    sourcePath: string,
    destination: FileSystemDirectoryHandle,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const resolved = await this.resolve({ rootDirectoryId, path: sourcePath });
    const directoryId = getDirectoryId({ entry: resolved.entry, rootDirectoryId, path: sourcePath });
    for await (const entry of this.readDirectory({ rootDirectoryId, directoryId })) {
      signal?.throwIfAborted();
      switch (entry.type) {
      case 'directory': {
        const childDestination = await destination.getDirectoryHandle(entry.name, { create: true });
        await this.exportDirectory({
          rootDirectoryId,
          sourcePath: `${normalizePath({ path: sourcePath })}/${entry.name}`,
          destination: childDestination,
          signal,
        });
        break;
      }
      case 'file': {
        const handle = await this.fileStore.open({
          fileId: entry.fileId,
          mimeType: 'application/octet-stream',
        });
        if (handle === null) {
          throw new Error(`Encrypted filesystem file is missing: ${entry.fileId}`);
        }
        try {
          const target = await destination.getFileHandle(entry.name, { create: true }) as FileSystemFileHandleWithWritable;
          await writeReadableStreamToFileHandle({
            source: handle.stream({ start: 0, end: undefined, signal }),
            targetHandle: target,
            signal,
          });
        } finally {
          await handle.close();
        }
        break;
      }
      case 'symlink':
        throw new Error('Native OPFS export cannot represent symbolic links');
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
      }
      }
    }
  }

  private getCoordinator({
    rootDirectoryId,
  }: {
    rootDirectoryId: string,
  }): EncryptedObjectTransactionCoordinator {
    let coordinator = this.coordinators.get(rootDirectoryId);
    if (coordinator === undefined) {
      coordinator = new EncryptedObjectTransactionCoordinator({
        objectStore: this.objectStore,
        scopeId: `file-system/${rootDirectoryId}`,
        lockName: `naidan/opfs-encryption/file-system/${rootDirectoryId}`,
      });
      this.coordinators.set(rootDirectoryId, coordinator);
    }
    return coordinator;
  }

  private getFileSystemDescriptorCoordinator({
    fileSystemId,
  }: {
    fileSystemId: string,
  }): EncryptedObjectTransactionCoordinator {
    let coordinator = this.descriptorCoordinators.get(fileSystemId);
    if (coordinator === undefined) {
      coordinator = new EncryptedObjectTransactionCoordinator({
        objectStore: this.objectStore,
        scopeId: `file-system-descriptor/${fileSystemId}`,
        lockName: `naidan/opfs-encryption/file-system-descriptor/${fileSystemId}`,
      });
      this.descriptorCoordinators.set(fileSystemId, coordinator);
    }
    return coordinator;
  }

  private prepareFileSystemCreation({
    fileSystemId,
    createdAt,
  }: {
    fileSystemId: string,
    createdAt: number,
  }): PreparedEncryptedObjectMutation & {
    readonly descriptor: EncryptedFileSystemDescriptorDto,
  } {
    const rootDirectoryId = createOpaqueId();
    const descriptor: EncryptedFileSystemDescriptorDto = {
      id: fileSystemId,
      rootDirectoryId,
      createdAt,
    };
    const rootManifest: EncryptedDirectoryManifestDto = {
      directoryId: rootDirectoryId,
      revision: 0,
      createdAt,
      modifiedAt: createdAt,
      shards: [],
    };
    assertFileSystemDescriptor({
      descriptor,
      expectedFileSystemId: fileSystemId,
    });
    assertDirectoryManifest({
      manifest: rootManifest,
      expectedDirectoryId: rootDirectoryId,
    });
    return {
      descriptor,
      operations: [
        {
          type: 'write',
          locator: { namespace: 'directory_manifest', key: rootDirectoryId },
          plaintext: UTF8.encode(JSON.stringify(rootManifest)),
        },
        {
          type: 'write',
          locator: this.getFileSystemDescriptorLocator({ fileSystemId }),
          plaintext: UTF8.encode(JSON.stringify(descriptor)),
        },
      ],
    };
  }

  private async readFileSystemDescriptorUnsafe({
    fileSystemId,
  }: {
    fileSystemId: string,
  }): Promise<EncryptedFileSystemDescriptorDto | undefined> {
    const descriptor = await this.jsonStore.read({
      locator: this.getFileSystemDescriptorLocator({ fileSystemId }),
      schema: EncryptedFileSystemDescriptorSchemaDto,
    });
    if (descriptor !== undefined) {
      assertFileSystemDescriptor({
        descriptor,
        expectedFileSystemId: fileSystemId,
      });
    }
    return descriptor;
  }


  private getFileSystemDescriptorLocator({
    fileSystemId,
  }: {
    fileSystemId: string,
  }): EncryptedObjectLocator {
    return { namespace: 'file_system_descriptor', key: fileSystemId };
  }

  private async resolveUnsafe({
    rootDirectoryId,
    path,
    followFinalSymlink = false,
    symlinkDepth = 0,
  }: {
    rootDirectoryId: string,
    path: string,
    followFinalSymlink?: boolean,
    symlinkDepth?: number,
  }): Promise<EncryptedFileSystemResolvedEntry> {
    const normalized = normalizePath({ path });
    const parts = splitPath({ path: normalized });
    let directoryId = rootDirectoryId;
    let parentDirectoryId: string | undefined;
    let entry: EncryptedFileSystemEntryDto | undefined;
    const resolvedParts: string[] = [];
    for (const [index, name] of parts.entries()) {
      parentDirectoryId = directoryId;
      entry = await this.getEntryUnsafe({ directoryId, name });
      if (entry === undefined) {
        throw new Error(`Encrypted filesystem path not found: ${normalized}`);
      }
      const isFinal = index === parts.length - 1;
      if (entry.type === 'symlink' && (!isFinal || followFinalSymlink)) {
        if (symlinkDepth >= MAX_SYMBOLIC_LINK_DEPTH) {
          throw new Error(`Too many symbolic links: ${normalized}`);
        }
        const parentPath = `/${resolvedParts.join('/')}`;
        const targetPath = entry.targetPath.startsWith('/')
          ? entry.targetPath
          : `${parentPath}/${entry.targetPath}`;
        const remainingPath = parts.slice(index + 1).join('/');
        const resolved = await this.resolveUnsafe({
          rootDirectoryId,
          path: remainingPath.length === 0 ? targetPath : `${targetPath}/${remainingPath}`,
          followFinalSymlink,
          symlinkDepth: symlinkDepth + 1,
        });
        return { ...resolved, fullPath: normalized };
      }
      if (isFinal) {
        break;
      }
      directoryId = requireDirectoryEntry({ entry, path: name }).directoryId;
      resolvedParts.push(name);
    }
    if (entry !== undefined) {
      switch (entry.type) {
      case 'file':
      case 'symlink':
        break;
      case 'directory':
        directoryId = entry.directoryId;
        break;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
      }
      }
    }
    return { parentDirectoryId, entry, directoryId, fullPath: normalized };
  }

  private async resolveParentUnsafe({
    rootDirectoryId,
    path,
  }: {
    rootDirectoryId: string,
    path: string,
  }): Promise<{ parentDirectoryId: string, name: string }> {
    const parts = splitPath({ path });
    const name = parts.pop();
    if (name === undefined) {
      throw new Error('Encrypted filesystem root has no parent entry');
    }
    if (parts.length === 0) {
      return { parentDirectoryId: rootDirectoryId, name };
    }
    const parentPath = `/${parts.join('/')}`;
    const resolved = await this.resolveUnsafe({
      rootDirectoryId,
      path: parentPath,
      followFinalSymlink: true,
    });
    return {
      parentDirectoryId: getDirectoryId({
        entry: resolved.entry,
        rootDirectoryId,
        path: parentPath,
      }),
      name,
    };
  }

  private async directoryContainsDirectoryUnsafe({
    ancestorDirectoryId,
    candidateDirectoryId,
    visited = new Set<string>(),
  }: {
    ancestorDirectoryId: string,
    candidateDirectoryId: string,
    visited?: Set<string>,
  }): Promise<boolean> {
    if (ancestorDirectoryId === candidateDirectoryId) {
      return true;
    }
    if (visited.has(ancestorDirectoryId)) {
      return false;
    }
    visited.add(ancestorDirectoryId);
    const entries = await this.readDirectoryEntriesUnsafe({ directoryId: ancestorDirectoryId });
    for (const entry of entries) {
      if (
        entry.type === 'directory'
        && await this.directoryContainsDirectoryUnsafe({
          ancestorDirectoryId: entry.directoryId,
          candidateDirectoryId,
          visited,
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private async readDirectoryEntriesUnsafe({
    directoryId,
  }: {
    directoryId: string,
  }): Promise<EncryptedFileSystemEntryDto[]> {
    const manifest = await this.readDirectoryManifestUnsafe({ directoryId });
    if (manifest === undefined) {
      throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
    }
    const entries: EncryptedFileSystemEntryDto[] = [];
    const seenNames = new Set<string>();
    for (const shard of manifest.shards) {
      const contents = await this.readDirectoryShardUnsafe({
        directoryId,
        shardId: shard.shardId,
        objectId: shard.objectId,
      });
      for (const [opaqueId, entry] of Object.entries(contents.entries)) {
        assertFileSystemEntry({ entry });
        const address = await this.getEntryAddress({ directoryId, name: entry.name });
        if (address.shardId !== shard.shardId || address.opaqueId !== opaqueId) {
          throw new Error(`Encrypted directory entry address mismatch: ${entry.name}`);
        }
        if (seenNames.has(entry.name)) {
          throw new Error(`Encrypted directory contains a duplicate entry name: ${entry.name}`);
        }
        seenNames.add(entry.name);
        entries.push(entry);
      }
    }
    return entries;
  }

  private async getEntryUnsafe({
    directoryId,
    name,
  }: {
    directoryId: string,
    name: string,
  }): Promise<EncryptedFileSystemEntryDto | undefined> {
    assertEntryName({ name });
    const manifest = await this.readDirectoryManifestUnsafe({ directoryId });
    if (manifest === undefined) {
      throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
    }
    const address = await this.getEntryAddress({ directoryId, name });
    const shard = manifest.shards.find(candidate => candidate.shardId === address.shardId);
    if (shard === undefined) {
      return undefined;
    }
    const contents = await this.readDirectoryShardUnsafe({
      directoryId,
      shardId: shard.shardId,
      objectId: shard.objectId,
    });
    const entry = contents.entries[address.opaqueId];
    if (entry !== undefined) {
      assertFileSystemEntry({ entry });
      if (entry.name !== name) {
        throw new Error('Encrypted directory entry address collision');
      }
    }
    return entry;
  }

  private async prepareDirectoryChangesUnsafe({
    directoryId,
    changes,
  }: {
    directoryId: string,
    changes: readonly DirectoryChange[],
  }): Promise<PreparedEncryptedObjectMutation> {
    const manifest = await this.readDirectoryManifestUnsafe({ directoryId });
    if (manifest === undefined) {
      throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
    }
    const grouped = new Map<string, Array<{ address: { opaqueId: string, shardId: string }, change: DirectoryChange }>>();
    for (const change of changes) {
      const name = (() => {
        switch (change.type) {
        case 'set':
          assertFileSystemEntry({ entry: change.entry });
          return change.entry.name;
        case 'delete':
          assertEntryName({ name: change.name });
          return change.name;
        default: {
          const _ex: never = change;
          throw new Error(`Unhandled directory change: ${String(_ex)}`);
        }
        }
      })();
      const address = await this.getEntryAddress({ directoryId, name });
      const group = grouped.get(address.shardId) ?? [];
      group.push({ address, change });
      grouped.set(address.shardId, group);
    }
    const nextShards = manifest.shards.map(shard => ({ ...shard }));
    const createdObjectIds: string[] = [];
    const replacedObjectIds: string[] = [];
    for (const [shardId, shardChanges] of grouped) {
      const oldDescriptor = nextShards.find(shard => shard.shardId === shardId);
      const oldContents = oldDescriptor === undefined
        ? { entries: {} }
        : await this.readDirectoryShardUnsafe({
          directoryId,
          shardId,
          objectId: oldDescriptor.objectId,
        });
      const entries = { ...oldContents.entries };
      for (const { address, change } of shardChanges) {
        switch (change.type) {
        case 'set':
          entries[address.opaqueId] = change.entry;
          break;
        case 'delete':
          delete entries[address.opaqueId];
          break;
        default: {
          const _ex: never = change;
          throw new Error(`Unhandled encrypted directory change: ${String(_ex)}`);
        }
        }
      }
      const oldIndex = nextShards.findIndex(shard => shard.shardId === shardId);
      if (Object.keys(entries).length === 0) {
        if (oldIndex >= 0) {
          const [removed] = nextShards.splice(oldIndex, 1);
          if (removed !== undefined) {
            replacedObjectIds.push(removed.objectId);
          }
        }
        continue;
      }
      const objectId = createOpaqueId();
      const contents: EncryptedDirectoryShardContentsDto = {
        objectId,
        directoryId,
        shardId,
        entries,
      };
      await this.jsonStore.write({
        locator: { namespace: 'directory_shard', key: objectId },
        value: contents,
      });
      createdObjectIds.push(objectId);
      if (oldIndex >= 0) {
        const old = nextShards[oldIndex];
        if (old !== undefined) {
          replacedObjectIds.push(old.objectId);
        }
        nextShards[oldIndex] = { shardId, objectId };
      } else {
        nextShards.push({ shardId, objectId });
      }
    }
    nextShards.sort((left, right) => left.shardId.localeCompare(right.shardId));
    const nextManifest: EncryptedDirectoryManifestDto = {
      ...manifest,
      revision: manifest.revision + 1,
      modifiedAt: Date.now(),
      shards: nextShards,
    };
    assertDirectoryManifest({ manifest: nextManifest, expectedDirectoryId: directoryId });
    const operations: EncryptedObjectMutationOperation[] = [{
      type: 'write',
      locator: { namespace: 'directory_manifest', key: directoryId },
      plaintext: UTF8.encode(JSON.stringify(nextManifest)),
    }];
    return {
      operations,
      cleanupAfterFailure: async () => {
        for (const objectId of createdObjectIds) {
          await this.objectStore.delete({ locator: { namespace: 'directory_shard', key: objectId } });
        }
      },
      cleanupAfterCommit: async () => {
        for (const objectId of replacedObjectIds) {
          await this.objectStore.delete({ locator: { namespace: 'directory_shard', key: objectId } });
        }
      },
    };
  }

  private async getEntryAddress({
    directoryId,
    name,
  }: {
    directoryId: string,
    name: string,
  }): Promise<{ opaqueId: string, shardId: string }> {
    const address = await this.objectStore.getObjectAddress({
      locator: {
        namespace: 'directory_entry',
        key: `${directoryId}\0${name}`,
      },
    });
    return { opaqueId: address.objectId, shardId: address.shardId };
  }

  private async readDirectoryManifestUnsafe({
    directoryId,
  }: {
    directoryId: string,
  }): Promise<EncryptedDirectoryManifestDto | undefined> {
    const manifest = await this.jsonStore.read({
      locator: { namespace: 'directory_manifest', key: directoryId },
      schema: EncryptedDirectoryManifestSchemaDto,
    });
    if (manifest !== undefined) {
      assertDirectoryManifest({ manifest, expectedDirectoryId: directoryId });
    }
    return manifest;
  }

  private async writeDirectoryManifestUnsafe({
    manifest,
  }: {
    manifest: EncryptedDirectoryManifestDto,
  }): Promise<void> {
    assertDirectoryManifest({ manifest, expectedDirectoryId: manifest.directoryId });
    await this.jsonStore.write({
      locator: { namespace: 'directory_manifest', key: manifest.directoryId },
      value: manifest,
    });
  }

  private async readDirectoryShardUnsafe({
    directoryId,
    shardId,
    objectId,
  }: {
    directoryId: string,
    shardId: string,
    objectId: string,
  }): Promise<EncryptedDirectoryShardContentsDto> {
    const contents = await this.jsonStore.read({
      locator: { namespace: 'directory_shard', key: objectId },
      schema: EncryptedDirectoryShardContentsSchemaDto,
    });
    if (contents === undefined) {
      throw new Error(`Encrypted directory shard is missing: ${directoryId}/${shardId}/${objectId}`);
    }
    if (
      contents.objectId !== objectId
      || contents.directoryId !== directoryId
      || contents.shardId !== shardId
    ) {
      throw new Error(`Encrypted directory shard identity mismatch: ${directoryId}/${shardId}`);
    }
    return contents;
  }

  private async cleanupEntryPayloadUnsafe({
    entry,
  }: {
    entry: EncryptedFileSystemEntryDto,
  }): Promise<void> {
    switch (entry.type) {
    case 'file':
      await this.fileStore.delete({ fileId: entry.fileId });
      break;
    case 'symlink':
      break;
    case 'directory':
      await this.cleanupDirectoryTreeUnsafe({ directoryId: entry.directoryId });
      break;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
    }
    }
  }

  private async cleanupDirectoryTreeUnsafe({
    directoryId,
  }: {
    directoryId: string,
  }): Promise<void> {
    const manifest = await this.readDirectoryManifestUnsafe({ directoryId });
    if (manifest === undefined) {
      return;
    }
    const children = await this.readDirectoryEntriesUnsafe({ directoryId });
    for (const child of children) {
      await this.cleanupEntryPayloadUnsafe({ entry: child });
    }
    await this.deleteDirectoryStorageUnsafe({ directoryId });
  }

  private async deleteDirectoryStorageUnsafe({
    directoryId,
  }: {
    directoryId: string,
  }): Promise<void> {
    const manifest = await this.readDirectoryManifestUnsafe({ directoryId });
    for (const shard of manifest?.shards ?? []) {
      await this.objectStore.delete({
        locator: { namespace: 'directory_shard', key: shard.objectId },
      });
    }
    await this.objectStore.delete({
      locator: { namespace: 'directory_manifest', key: directoryId },
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  assertDirectoryManifest,
  assertFileSystemDescriptor,
  assertEntryName,
  assertFileSystemEntry,
  normalizePath,
  splitPath,
};
