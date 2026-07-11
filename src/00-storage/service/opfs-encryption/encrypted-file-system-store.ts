import type {
  EncryptedDirectoryManifestDto,
  EncryptedDirectoryShardContentsDto,
  EncryptedFileSystemEntryDto,
} from '@/00-storage/00-dto/encryption.dto';
import {
  EncryptedDirectoryManifestSchemaDto,
  EncryptedDirectoryShardContentsSchemaDto,
} from '@/00-storage/00-dto/encryption.dto';
import { writeReadableStreamToFileHandle } from '@/utils/file-system-stream';
import { encodeBase64Url } from './base64-url';
import { EncryptedFileStore } from './encrypted-file-store';
import { EncryptedJsonObjectStore } from './encrypted-json-object-store';
import { EncryptedObjectStore } from './encrypted-object-store';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

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

function assertFileSystemEntry({
  entry,
}: {
  entry: EncryptedFileSystemEntryDto,
}): void {
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
  assertNonNegativeSafeInteger({
    value: manifest.modifiedAt,
    fieldName: 'Encrypted directory modifiedAt',
  });
  const seenShardIds = new Set<string>();
  for (const shardId of manifest.shardIds) {
    if (!/^[A-Za-z0-9_-]{2}$/u.test(shardId)) {
      throw new Error(`Encrypted directory shard ID is invalid: ${JSON.stringify(shardId)}`);
    }
    if (seenShardIds.has(shardId)) {
      throw new Error(`Encrypted directory manifest contains a duplicate shard ID: ${shardId}`);
    }
    seenShardIds.add(shardId);
  }
}

function normalizePath({ path }: { path: string }): string {
  const parts = path.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
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

type EncryptedFileEntry = Extract<
  EncryptedFileSystemEntryDto,
  { type: 'file' }
>;

type EncryptedDirectoryEntry = Extract<
  EncryptedFileSystemEntryDto,
  { type: 'directory' }
>;

function requireFileEntry({
  entry,
  path,
}: {
  entry: EncryptedFileSystemEntryDto | undefined,
  path: string,
}): EncryptedFileEntry {
  if (entry === undefined) {
    throw new Error(`Encrypted filesystem path is not a file: ${path}`);
  }
  switch (entry.type) {
  case 'file':
    return entry;
  case 'directory':
  case 'symlink':
    throw new Error(`Encrypted filesystem path is not a file: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(
      `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

function requireDirectoryEntry({
  entry,
  path,
}: {
  entry: EncryptedFileSystemEntryDto | undefined,
  path: string,
}): EncryptedDirectoryEntry {
  if (entry === undefined) {
    throw new Error(`Encrypted filesystem path is not a directory: ${path}`);
  }
  switch (entry.type) {
  case 'directory':
    return entry;
  case 'file':
  case 'symlink':
    throw new Error(`Encrypted filesystem path is not a directory: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(
      `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
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
  if (entry === undefined) {
    return rootDirectoryId;
  }
  return requireDirectoryEntry({ entry, path }).directoryId;
}

function getFileIdForWrite({
  entry,
  name,
}: {
  entry: EncryptedFileSystemEntryDto | undefined,
  name: string,
}): string {
  if (entry === undefined) {
    return createOpaqueId();
  }
  return requireFileEntry({ entry, path: name }).fileId;
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
      && left.modifiedAt === right.modifiedAt;
  default: {
    const _ex: never = left;
    throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
  }
  }
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

  async createFileSystem(): Promise<string> {
    const rootDirectoryId = createOpaqueId();
    await this.writeDirectoryManifest({
      manifest: {
        directoryId: rootDirectoryId,
        modifiedAt: Date.now(),
        shardIds: [],
      },
    });
    return rootDirectoryId;
  }

  async deleteFileSystem({
    rootDirectoryId,
  }: {
    rootDirectoryId: string,
  }): Promise<void> {
    const children: EncryptedFileSystemEntryDto[] = [];
    for await (const child of this.readDirectory({ directoryId: rootDirectoryId })) {
      children.push(child);
    }
    for (const child of children) {
      await this.remove({
        rootDirectoryId,
        path: `/${child.name}`,
        recursive: true,
      });
    }
    await this.deleteDirectoryStorage({ directoryId: rootDirectoryId });
  }

  async resolve({
    rootDirectoryId,
    path,
  }: {
    rootDirectoryId: string,
    path: string,
  }): Promise<EncryptedFileSystemResolvedEntry> {
    const normalized = normalizePath({ path });
    const parts = splitPath({ path: normalized });
    let directoryId = rootDirectoryId;
    let parentDirectoryId: string | undefined;
    let entry: EncryptedFileSystemEntryDto | undefined;

    for (const [index, name] of parts.entries()) {
      parentDirectoryId = directoryId;
      entry = await this.getEntry({ directoryId, name });
      if (entry === undefined) {
        throw new Error(`Encrypted filesystem path not found: ${normalized}`);
      }
      if (index === parts.length - 1) {
        break;
      }
      directoryId = requireDirectoryEntry({ entry, path: name }).directoryId;
    }

    if (entry !== undefined) {
      switch (entry.type) {
      case 'directory':
        directoryId = entry.directoryId;
        break;
      case 'file':
      case 'symlink':
        break;
      default: {
        const _ex: never = entry;
        throw new Error(
          `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
        );
      }
      }
    }

    return {
      parentDirectoryId,
      entry,
      directoryId,
      fullPath: normalized,
    };
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
    directoryId,
  }: {
    directoryId: string,
  }): AsyncIterable<EncryptedFileSystemEntryDto> {
    const manifest = await this.readDirectoryManifest({ directoryId });
    if (manifest === undefined) {
      throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
    }
    const seenNames = new Set<string>();
    for (const shardId of manifest.shardIds) {
      const contents = await this.readDirectoryShardIfPresent({
        directoryId,
        shardId,
      });
      if (contents === undefined) {
        throw new Error(`Encrypted directory shard is missing: ${directoryId}/${shardId}`);
      }
      for (const [opaqueId, entry] of Object.entries(contents.entries)) {
        assertFileSystemEntry({ entry });
        if (opaqueId.slice(0, 2) !== shardId) {
          throw new Error(`Encrypted directory entry is stored in the wrong shard: ${entry.name}`);
        }
        const expectedOpaqueId = await this.getEntryOpaqueId({
          directoryId,
          name: entry.name,
        });
        if (opaqueId !== expectedOpaqueId) {
          throw new Error(`Encrypted directory entry address mismatch: ${entry.name}`);
        }
        if (seenNames.has(entry.name)) {
          throw new Error(`Encrypted directory contains a duplicate entry name: ${entry.name}`);
        }
        seenNames.add(entry.name);
        yield entry;
      }
    }
  }

  async openFile({
    rootDirectoryId,
    path,
    mimeType = 'application/octet-stream',
  }: {
    rootDirectoryId: string,
    path: string,
    mimeType?: string,
  }) {
    const resolved = await this.resolve({ rootDirectoryId, path });
    const fileEntry = requireFileEntry({ entry: resolved.entry, path });
    return await this.fileStore.open({
      fileId: fileEntry.fileId,
      mimeType,
    });
  }

  async getFileManifest({
    rootDirectoryId,
    path,
  }: {
    rootDirectoryId: string,
    path: string,
  }) {
    const resolved = await this.resolve({ rootDirectoryId, path });
    const fileEntry = requireFileEntry({ entry: resolved.entry, path });
    const manifest = await this.fileStore.readManifest({
      fileId: fileEntry.fileId,
    });
    if (manifest === undefined) {
      throw new Error(`Encrypted filesystem file manifest is missing: ${path}`);
    }
    return manifest;
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
    const resolved = await this.resolve({ rootDirectoryId, path });
    const fileEntry = requireFileEntry({ entry: resolved.entry, path });
    await this.fileStore.writeRange({
      fileId: fileEntry.fileId,
      bytes,
      position,
      modifiedAt,
      signal,
    });
  }

  async truncateFile({
    rootDirectoryId,
    path,
    logicalSize,
    modifiedAt,
  }: {
    rootDirectoryId: string,
    path: string,
    logicalSize: number,
    modifiedAt: number,
  }): Promise<void> {
    const resolved = await this.resolve({ rootDirectoryId, path });
    const fileEntry = requireFileEntry({ entry: resolved.entry, path });
    await this.fileStore.truncate({
      fileId: fileEntry.fileId,
      logicalSize,
      modifiedAt,
    });
  }

  async createDirectory({
    rootDirectoryId,
    path,
    recursive,
  }: {
    rootDirectoryId: string,
    path: string,
    recursive: boolean,
  }): Promise<string> {
    const parts = splitPath({ path });
    let directoryId = rootDirectoryId;
    for (const [index, name] of parts.entries()) {
      const existing = await this.getEntry({ directoryId, name });
      if (existing !== undefined) {
        directoryId = requireDirectoryEntry({
          entry: existing,
          path: name,
        }).directoryId;
        continue;
      }
      if (!recursive && index !== parts.length - 1) {
        throw new Error(`Encrypted filesystem parent directory does not exist: ${name}`);
      }
      const childDirectoryId = createOpaqueId();
      await this.writeDirectoryManifest({
        manifest: {
          directoryId: childDirectoryId,
          modifiedAt: Date.now(),
          shardIds: [],
        },
      });
      try {
        await this.setEntry({
          directoryId,
          entry: {
            type: 'directory',
            name,
            directoryId: childDirectoryId,
          },
        });
      } catch (error) {
        await this.deleteDirectoryStorage({ directoryId: childDirectoryId });
        throw error;
      }
      directoryId = childDirectoryId;
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
    const { parentDirectoryId, name } = await this.resolveParent({
      rootDirectoryId,
      path,
    });
    const existing = await this.getEntry({
      directoryId: parentDirectoryId,
      name,
    });
    if (existing !== undefined) {
      const fileEntry = requireFileEntry({ entry: existing, path: name });
      if (!overwrite) {
        throw new Error(`Encrypted filesystem file already exists: ${name}`);
      }
      await this.fileStore.createEmpty({ fileId: fileEntry.fileId, modifiedAt });
      return fileEntry.fileId;
    }

    const fileId = createOpaqueId();
    await this.fileStore.createEmpty({ fileId, modifiedAt });
    try {
      await this.setEntry({
        directoryId: parentDirectoryId,
        entry: { type: 'file', name, fileId },
      });
    } catch (error) {
      await this.fileStore.delete({ fileId });
      throw error;
    }
    return fileId;
  }

  async writeFile({
    rootDirectoryId,
    path,
    source,
    logicalSize,
    modifiedAt,
    signal,
  }: {
    rootDirectoryId: string,
    path: string,
    source: ReadableStream<Uint8Array>,
    logicalSize: number,
    modifiedAt: number,
    signal: AbortSignal | undefined,
  }): Promise<string> {
    const { parentDirectoryId, name } = await this.resolveParent({
      rootDirectoryId,
      path,
    });
    const existing = await this.getEntry({ directoryId: parentDirectoryId, name });
    const fileId = getFileIdForWrite({ entry: existing, name });
    await this.fileStore.write({
      fileId,
      source,
      logicalSize,
      modifiedAt,
      signal,
    });
    if (existing === undefined) {
      try {
        await this.setEntry({
          directoryId: parentDirectoryId,
          entry: { type: 'file', name, fileId },
        });
      } catch (error) {
        await this.fileStore.delete({ fileId });
        throw error;
      }
    }
    return fileId;
  }

  async createSymlink({
    rootDirectoryId,
    path,
    targetPath,
    modifiedAt,
  }: {
    rootDirectoryId: string,
    path: string,
    targetPath: string,
    modifiedAt: number,
  }): Promise<void> {
    const { parentDirectoryId, name } = await this.resolveParent({
      rootDirectoryId,
      path,
    });
    if (await this.getEntry({ directoryId: parentDirectoryId, name }) !== undefined) {
      throw new Error(`Encrypted filesystem entry already exists: ${name}`);
    }
    await this.setEntry({
      directoryId: parentDirectoryId,
      entry: {
        type: 'symlink',
        name,
        targetPath,
        modifiedAt,
      },
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
    const { parentDirectoryId, name } = await this.resolveParent({
      rootDirectoryId,
      path,
    });
    const entry = await this.getEntry({ directoryId: parentDirectoryId, name });
    if (entry === undefined) {
      return;
    }
    let directoryChildren: EncryptedFileSystemEntryDto[] | undefined;
    switch (entry.type) {
    case 'file':
    case 'symlink':
      break;
    case 'directory': {
      directoryChildren = [];
      for await (const child of this.readDirectory({ directoryId: entry.directoryId })) {
        if (!recursive) {
          throw new Error(`Encrypted filesystem directory is not empty: ${path}`);
        }
        directoryChildren.push(child);
      }
      break;
    }
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
    }
    }

    // Remove the reachable directory entry before best-effort payload cleanup.
    // An interrupted cleanup may leave encrypted orphan objects, but must not
    // leave a visible entry whose authenticated payload has already vanished.
    await this.deleteEntry({ directoryId: parentDirectoryId, name });

    switch (entry.type) {
    case 'file':
      await this.fileStore.delete({ fileId: entry.fileId });
      break;
    case 'symlink':
      break;
    case 'directory':
      for (const child of directoryChildren ?? []) {
        await this.remove({
          rootDirectoryId: entry.directoryId,
          path: `/${child.name}`,
          recursive: true,
        });
      }
      await this.deleteDirectoryStorage({ directoryId: entry.directoryId });
      break;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
    }
    }
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
    const oldParent = await this.resolveParent({ rootDirectoryId, path: oldPath });
    const newParent = await this.resolveParent({ rootDirectoryId, path: newPath });
    const entry = await this.getEntry({
      directoryId: oldParent.parentDirectoryId,
      name: oldParent.name,
    });
    if (entry === undefined) {
      throw new Error(`Encrypted filesystem path not found: ${oldPath}`);
    }
    if (
      entry.type === 'directory'
      && normalizedNewPath.startsWith(`${normalizedOldPath}/`)
    ) {
      throw new Error('Encrypted filesystem directory cannot be moved into itself');
    }
    const destination = await this.getEntry({
      directoryId: newParent.parentDirectoryId,
      name: newParent.name,
    });
    if (destination !== undefined) {
      if (isSameEntryTarget({ left: entry, right: destination })) {
        await this.deleteEntry({
          directoryId: oldParent.parentDirectoryId,
          name: oldParent.name,
        });
        return;
      }
      throw new Error(`Encrypted filesystem destination already exists: ${newPath}`);
    }
    await this.setEntry({
      directoryId: newParent.parentDirectoryId,
      entry: { ...entry, name: newParent.name },
    });
    await this.deleteEntry({
      directoryId: oldParent.parentDirectoryId,
      name: oldParent.name,
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
          logicalSize: file.size,
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
    const directoryId = getDirectoryId({
      entry: resolved.entry,
      rootDirectoryId,
      path: sourcePath,
    });
    for await (const entry of this.readDirectory({ directoryId })) {
      signal?.throwIfAborted();
      switch (entry.type) {
      case 'directory': {
        const childDestination = await destination.getDirectoryHandle(
          entry.name,
          { create: true },
        );
        await this.exportDirectory({
          rootDirectoryId: entry.directoryId,
          sourcePath: '/',
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
          const target = await destination.getFileHandle(
            entry.name,
            { create: true },
          ) as FileSystemFileHandleWithWritable;
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

  async getEntry({
    directoryId,
    name,
  }: {
    directoryId: string,
    name: string,
  }): Promise<EncryptedFileSystemEntryDto | undefined> {
    assertEntryName({ name });
    const opaqueId = await this.getEntryOpaqueId({ directoryId, name });
    const contents = await this.readDirectoryShard({
      directoryId,
      shardId: opaqueId.slice(0, 2),
    });
    const entry = contents.entries[opaqueId];
    if (entry !== undefined) {
      assertFileSystemEntry({ entry });
      if (entry.name !== name) {
        throw new Error('Encrypted directory entry address collision');
      }
    }
    return entry;
  }

  private async resolveParent({
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
    let parentDirectoryId = rootDirectoryId;
    for (const part of parts) {
      const entry = await this.getEntry({ directoryId: parentDirectoryId, name: part });
      parentDirectoryId = requireDirectoryEntry({
        entry,
        path: part,
      }).directoryId;
    }
    return { parentDirectoryId, name };
  }

  private async setEntry({
    directoryId,
    entry,
  }: {
    directoryId: string,
    entry: EncryptedFileSystemEntryDto,
  }): Promise<void> {
    assertEntryName({ name: entry.name });
    const opaqueId = await this.getEntryOpaqueId({
      directoryId,
      name: entry.name,
    });
    const shardId = opaqueId.slice(0, 2);
    const contents = await this.readDirectoryShard({ directoryId, shardId });
    contents.entries[opaqueId] = entry;
    await this.writeDirectoryShard({ directoryId, shardId, contents });

    const manifest = await this.readDirectoryManifest({ directoryId });
    if (manifest === undefined) {
      throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
    }
    if (!manifest.shardIds.includes(shardId)) {
      await this.writeDirectoryManifest({
        manifest: {
          ...manifest,
          modifiedAt: Date.now(),
          shardIds: [...manifest.shardIds, shardId].sort(),
        },
      });
    }
  }

  private async deleteEntry({
    directoryId,
    name,
  }: {
    directoryId: string,
    name: string,
  }): Promise<void> {
    const opaqueId = await this.getEntryOpaqueId({ directoryId, name });
    const shardId = opaqueId.slice(0, 2);
    const contents = await this.readDirectoryShard({ directoryId, shardId });
    delete contents.entries[opaqueId];
    const isEmpty = Object.keys(contents.entries).length === 0;
    if (isEmpty) {
      await this.objectStore.delete({
        locator: { namespace: 'directory_shard', key: `${directoryId}/${shardId}` },
      });
    } else {
      await this.writeDirectoryShard({ directoryId, shardId, contents });
    }

    const manifest = await this.readDirectoryManifest({ directoryId });
    if (manifest === undefined) {
      throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
    }
    await this.writeDirectoryManifest({
      manifest: {
        ...manifest,
        modifiedAt: Date.now(),
        shardIds: isEmpty
          ? manifest.shardIds.filter(value => value !== shardId)
          : manifest.shardIds,
      },
    });
  }

  private async getEntryOpaqueId({
    directoryId,
    name,
  }: {
    directoryId: string,
    name: string,
  }): Promise<string> {
    return await this.objectStore.getObjectId({
      locator: {
        namespace: 'directory_entry',
        key: `${directoryId}\0${name}`,
      },
    });
  }

  private async readDirectoryManifest({
    directoryId,
  }: {
    directoryId: string,
  }): Promise<EncryptedDirectoryManifestDto | undefined> {
    const manifest = await this.jsonStore.read({
      locator: { namespace: 'directory_manifest', key: directoryId },
      schema: EncryptedDirectoryManifestSchemaDto,
    });
    if (manifest !== undefined) {
      assertDirectoryManifest({
        manifest,
        expectedDirectoryId: directoryId,
      });
    }
    return manifest;
  }

  private async writeDirectoryManifest({
    manifest,
  }: {
    manifest: EncryptedDirectoryManifestDto,
  }): Promise<void> {
    assertDirectoryManifest({
      manifest,
      expectedDirectoryId: manifest.directoryId,
    });
    await this.jsonStore.write({
      locator: { namespace: 'directory_manifest', key: manifest.directoryId },
      value: manifest,
    });
  }

  private async readDirectoryShard({
    directoryId,
    shardId,
  }: {
    directoryId: string,
    shardId: string,
  }): Promise<EncryptedDirectoryShardContentsDto> {
    return await this.readDirectoryShardIfPresent({ directoryId, shardId })
      ?? { entries: {} };
  }

  private async readDirectoryShardIfPresent({
    directoryId,
    shardId,
  }: {
    directoryId: string,
    shardId: string,
  }): Promise<EncryptedDirectoryShardContentsDto | undefined> {
    return await this.jsonStore.read({
      locator: { namespace: 'directory_shard', key: `${directoryId}/${shardId}` },
      schema: EncryptedDirectoryShardContentsSchemaDto,
    });
  }

  private async writeDirectoryShard({
    directoryId,
    shardId,
    contents,
  }: {
    directoryId: string,
    shardId: string,
    contents: EncryptedDirectoryShardContentsDto,
  }): Promise<void> {
    await this.jsonStore.write({
      locator: { namespace: 'directory_shard', key: `${directoryId}/${shardId}` },
      value: contents,
    });
  }

  private async deleteDirectoryStorage({
    directoryId,
  }: {
    directoryId: string,
  }): Promise<void> {
    const manifest = await this.readDirectoryManifest({ directoryId });
    for (const shardId of manifest?.shardIds ?? []) {
      await this.objectStore.delete({
        locator: { namespace: 'directory_shard', key: `${directoryId}/${shardId}` },
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
  assertEntryName,
  assertFileSystemEntry,
  normalizePath,
  splitPath,
};
