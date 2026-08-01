import { createBlobStorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileStat,
  StorageSymlinkHandle,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';

type InMemoryFileNode = {
  readonly kind: 'file';
  readonly name: string;
  bytes: Uint8Array;
  readonly createdAt: number;
  modifiedAt: number;
};

type InMemoryDirectoryNode = {
  readonly kind: 'directory';
  readonly name: string;
  readonly children: Map<string, InMemoryNode>;
  readonly createdAt: number;
  modifiedAt: number;
};

type InMemorySymlinkNode = {
  readonly kind: 'symlink';
  readonly name: string;
  readonly target: string;
  readonly createdAt: number;
  modifiedAt: number;
};

type InMemoryNode = InMemoryFileNode | InMemoryDirectoryNode | InMemorySymlinkNode;

function createFileNode({ name }: { name: string }): InMemoryFileNode {
  const now = Date.now();
  return {
    kind: 'file',
    name,
    bytes: new Uint8Array(0),
    createdAt: now,
    modifiedAt: now,
  };
}

function createDirectoryNode({ name }: { name: string }): InMemoryDirectoryNode {
  const now = Date.now();
  return {
    kind: 'directory',
    name,
    children: new Map(),
    createdAt: now,
    modifiedAt: now,
  };
}

function createSymlinkNode({ name, target }: {
  name: string;
  target: string;
}): InMemorySymlinkNode {
  const now = Date.now();
  return {
    kind: 'symlink',
    name,
    target,
    createdAt: now,
    modifiedAt: now,
  };
}

function createNotFoundError({ name }: { name: string }): Error {
  const error = new Error(`Entry '${name}' was not found`);
  error.name = 'NotFoundError';
  return error;
}

function createTypeMismatchError({ name, expectedKind }: {
  name: string;
  expectedKind: InMemoryNode['kind'];
}): Error {
  const error = new Error(`Entry '${name}' is not a ${expectedKind}`);
  error.name = 'TypeMismatchError';
  return error;
}

function createPathExistsError({ name }: { name: string }): Error {
  const error = new Error(`Entry '${name}' already exists`);
  error.name = 'InvalidModificationError';
  return error;
}

function statNode({ node }: { node: InMemoryNode }): StorageFileStat {
  const size = (() => {
    switch (node.kind) {
    case 'file':
      return node.bytes.byteLength;
    case 'directory':
    case 'symlink':
      return 0;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled in-memory storage node: ${String(_ex)}`);
    }
    }
  })();
  return {
    size,
    createdAt: node.createdAt,
    modifiedAt: node.modifiedAt,
  };
}

class InMemoryStorageWritableFile implements StorageWritableFile {
  constructor({ node, keepExistingData }: {
    node: InMemoryFileNode;
    keepExistingData: boolean;
  }) {
    this.node = node;
    this.pendingBytes = keepExistingData
      ? new Uint8Array(node.bytes)
      : new Uint8Array(0);
  }

  private readonly node: InMemoryFileNode;
  private pendingBytes: Uint8Array;
  private settled = false;

  async write({ position, data }: {
    position: number;
    data: Uint8Array;
  }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({ value: position, fieldName: 'Write position' });
    const requiredLength = position + data.byteLength;
    if (!Number.isSafeInteger(requiredLength)) {
      throw new Error('Write end position must be a safe integer');
    }
    if (requiredLength > this.pendingBytes.byteLength) {
      const expanded = new Uint8Array(requiredLength);
      expanded.set(this.pendingBytes);
      this.pendingBytes = expanded;
    }
    this.pendingBytes.set(data, position);
  }

  async truncate({ size }: { size: number }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({ value: size, fieldName: 'Truncate size' });
    if (size === this.pendingBytes.byteLength) return;
    const resized = new Uint8Array(size);
    resized.set(this.pendingBytes.subarray(0, size));
    this.pendingBytes = resized;
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.settled = true;
    this.node.bytes = new Uint8Array(this.pendingBytes);
    this.node.modifiedAt = Date.now();
  }

  async abort({ reason: _reason }: { reason: unknown }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new Error('Storage writable file is already closed or aborted');
    }
  }
}

class InMemoryStorageFileHandle implements StorageFileHandle {
  readonly kind = 'file' as const;

  constructor({ node }: { node: InMemoryFileNode }) {
    this.node = node;
    this.name = node.name;
  }

  readonly name: string;
  private readonly node: InMemoryFileNode;

  async stat(): Promise<StorageFileStat> {
    return statNode({ node: this.node });
  }

  async openReadable({ mimeType }: { mimeType: string }) {
    return createBlobStorageBinaryObjectReadHandle({
      blob: new Blob([new Uint8Array(this.node.bytes)], { type: mimeType }),
      mimeType,
    });
  }

  async createWritable({ keepExistingData }: {
    keepExistingData: boolean;
  }): Promise<StorageWritableFile> {
    return new InMemoryStorageWritableFile({
      node: this.node,
      keepExistingData,
    });
  }
}

class InMemoryStorageSymlinkHandle implements StorageSymlinkHandle {
  readonly kind = 'symlink' as const;

  constructor({ node }: { node: InMemorySymlinkNode }) {
    this.node = node;
    this.name = node.name;
  }

  readonly name: string;
  private readonly node: InMemorySymlinkNode;

  async stat(): Promise<StorageFileStat> {
    return statNode({ node: this.node });
  }

  async readTarget(): Promise<string> {
    return this.node.target;
  }
}

class InMemoryStorageDirectoryHandle implements StorageDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor({ node }: { node: InMemoryDirectoryNode }) {
    this.node = node;
    this.name = node.name;
  }

  readonly name: string;
  private readonly node: InMemoryDirectoryNode;

  async stat(): Promise<StorageFileStat> {
    return statNode({ node: this.node });
  }

  async getFileHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageFileHandle> {
    const existing = this.node.children.get(name);
    if (existing !== undefined) {
      switch (existing.kind) {
      case 'file':
        return new InMemoryStorageFileHandle({ node: existing });
      case 'directory':
      case 'symlink':
        throw createTypeMismatchError({ name, expectedKind: 'file' });
      default: {
        const _ex: never = existing;
        throw new Error(`Unhandled in-memory storage node: ${String(_ex)}`);
      }
      }
    }
    if (!create) throw createNotFoundError({ name });
    const created = createFileNode({ name });
    this.node.children.set(name, created);
    this.touch();
    return new InMemoryStorageFileHandle({ node: created });
  }

  async getDirectoryHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageDirectoryHandle> {
    const existing = this.node.children.get(name);
    if (existing !== undefined) {
      switch (existing.kind) {
      case 'directory':
        return new InMemoryStorageDirectoryHandle({ node: existing });
      case 'file':
      case 'symlink':
        throw createTypeMismatchError({ name, expectedKind: 'directory' });
      default: {
        const _ex: never = existing;
        throw new Error(`Unhandled in-memory storage node: ${String(_ex)}`);
      }
      }
    }
    if (!create) throw createNotFoundError({ name });
    const created = createDirectoryNode({ name });
    this.node.children.set(name, created);
    this.touch();
    return new InMemoryStorageDirectoryHandle({ node: created });
  }

  async getEntryHandle({ name }: { name: string }): Promise<StorageEntryHandle> {
    const node = this.node.children.get(name);
    if (node === undefined) throw createNotFoundError({ name });
    return wrapNode({ node });
  }

  async *entries(): AsyncIterable<readonly [string, StorageEntryHandle]> {
    for (const [name, node] of this.node.children) {
      yield [name, wrapNode({ node })];
    }
  }

  async removeEntry({ name, recursive }: {
    name: string;
    recursive: boolean;
  }): Promise<void> {
    const node = this.node.children.get(name);
    if (node === undefined) throw createNotFoundError({ name });
    if (node.kind === 'directory' && !recursive && node.children.size > 0) {
      const error = new Error(`Directory '${name}' is not empty`);
      error.name = 'InvalidModificationError';
      throw error;
    }
    this.node.children.delete(name);
    this.touch();
  }

  async createSymlink({ name, target }: {
    name: string;
    target: string;
  }): Promise<StorageSymlinkHandle> {
    if (this.node.children.has(name)) throw createPathExistsError({ name });
    const created = createSymlinkNode({ name, target });
    this.node.children.set(name, created);
    this.touch();
    return new InMemoryStorageSymlinkHandle({ node: created });
  }

  async moveEntry({ name, destination, newName, replace }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<void> {
    const sourceNode = this.node.children.get(name);
    if (sourceNode === undefined) throw createNotFoundError({ name });
    if (!(destination instanceof InMemoryStorageDirectoryHandle)) {
      throw new Error('In-memory move requires an in-memory destination');
    }
    if (!replace && destination.node.children.has(newName)) {
      throw createPathExistsError({ name: newName });
    }
    const renamed = cloneNodeWithName({ node: sourceNode, name: newName });
    destination.node.children.set(newName, renamed);
    this.node.children.delete(name);
    this.touch();
    destination.touch();
  }

  async cloneFile({ name, destination, newName, replace }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<StorageFileHandle> {
    const sourceNode = this.node.children.get(name);
    if (sourceNode === undefined) throw createNotFoundError({ name });
    switch (sourceNode.kind) {
    case 'file':
      break;
    case 'directory':
    case 'symlink':
      throw createTypeMismatchError({ name, expectedKind: 'file' });
    default: {
      const _ex: never = sourceNode;
      throw new Error(`Unhandled in-memory storage node: ${String(_ex)}`);
    }
    }
    if (!(destination instanceof InMemoryStorageDirectoryHandle)) {
      throw new Error('In-memory clone requires an in-memory destination');
    }
    if (!replace && destination.node.children.has(newName)) {
      throw createPathExistsError({ name: newName });
    }
    const cloned = createFileNode({ name: newName });
    cloned.bytes = new Uint8Array(sourceNode.bytes);
    destination.node.children.set(newName, cloned);
    destination.touch();
    return new InMemoryStorageFileHandle({ node: cloned });
  }

  private touch(): void {
    this.node.modifiedAt = Date.now();
  }
}

function wrapNode({ node }: { node: InMemoryNode }): StorageEntryHandle {
  switch (node.kind) {
  case 'file':
    return new InMemoryStorageFileHandle({ node });
  case 'directory':
    return new InMemoryStorageDirectoryHandle({ node });
  case 'symlink':
    return new InMemoryStorageSymlinkHandle({ node });
  default: {
    const _ex: never = node;
    throw new Error(`Unhandled in-memory storage node: ${String(_ex)}`);
  }
  }
}

function cloneNodeWithName({ node, name }: {
  node: InMemoryNode;
  name: string;
}): InMemoryNode {
  switch (node.kind) {
  case 'file':
    return { ...node, name };
  case 'directory':
    return { ...node, name };
  case 'symlink':
    return { ...node, name };
  default: {
    const _ex: never = node;
    throw new Error(`Unhandled in-memory storage node: ${String(_ex)}`);
  }
  }
}

function assertNonNegativeSafeInteger({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

export function createInMemoryStorageRoot({ name }: {
  name: string;
}): StorageDirectoryHandle {
  return new InMemoryStorageDirectoryHandle({ node: createDirectoryNode({ name }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
