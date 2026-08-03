import type {
  HizoFSDirectoryCursorBackend,
  HizoFSPhysicalWriteBackend,
  HizoFSPhysicalDirectoryCursor,
  HizoFSCrashDurableWritableBackendCapabilities,
  HizoFSWritableFile,
  PhysicalEntry,
  PhysicalDirectoryCursorPage,
} from '@/00-storage/service/hizofs/physical-store/backend';
import { physicalStoreError } from '@/00-storage/service/hizofs/physical-store/errors';
import {
  CANONICAL_CONTAINER_ROOT,
  type CanonicalContainerDirectory,
  type CanonicalContainerPath,
  containerEntryName,
  containerPathSegments,
  parentContainerDirectory,
} from '@/00-storage/service/hizofs/physical-store/paths';
import type {
  DeterministicPhysicalStoreFaultInjector,
  PhysicalStoreFaultTiming,
  PhysicalStoreOperation,
} from './deterministic-fault-injector';

type FileNode = {
  bytes: Uint8Array;
  durableBytes: Uint8Array;
  kind: 'file';
  openHandleCount: number;
};

type DirectoryNode = {
  durableEntries: Map<string, PhysicalNode>;
  entries: Map<string, PhysicalNode>;
  kind: 'directory';
};

type PhysicalNode = DirectoryNode | FileNode;

type HandleState = {
  closed: boolean;
  file: FileNode;
  generation: number;
  path: CanonicalContainerPath;
};

const DEFAULT_MAXIMUM_FILE_BYTE_LENGTH = 64n * 1024n * 1024n;
const CAPABILITIES: HizoFSCrashDurableWritableBackendCapabilities = Object.freeze({
  directoryEntryDurability: 'crash-durable',
  fileDataDurability: 'crash-durable',
});

function createDirectoryNode(): DirectoryNode {
  return {
    durableEntries: new Map(),
    entries: new Map(),
    kind: 'directory',
  };
}

function createFileNode(): FileNode {
  return {
    bytes: new Uint8Array(),
    durableBytes: new Uint8Array(),
    kind: 'file',
    openHandleCount: 0,
  };
}

function compareEntryNames({ left, right }: { left: string; right: string }): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

class InMemoryPhysicalDirectoryCursor implements HizoFSPhysicalDirectoryCursor {
  #closed = false;
  #done = false;
  readonly #iterator: Iterator<[string, PhysicalNode]>;

  public constructor({ entries }: { entries: Map<string, PhysicalNode> }) {
    this.#iterator = entries.entries();
  }

  public async close(): Promise<void> {
    this.#closed = true;
  }

  public async read({ maximumEntries }: { maximumEntries: number }): Promise<PhysicalDirectoryCursorPage> {
    if (this.#closed) throw new TypeError('physical directory cursor is closed');
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError('physical directory cursor page size must be a positive safe integer');
    }
    if (this.#done) return Object.freeze({ done: true, entries: Object.freeze([]) });

    const entries: PhysicalEntry[] = [];
    while (entries.length < maximumEntries) {
      const next = this.#iterator.next();
      if (next.done === true) {
        this.#done = true;
        break;
      }
      const [name, entry] = next.value;
      switch (entry.kind) {
      case 'directory':
        entries.push({ kind: 'directory', name });
        break;
      case 'file':
        entries.push({ byteLength: BigInt(entry.bytes.byteLength), kind: 'file', name });
        break;
      default:
        return entry satisfies never;
      }
    }
    return Object.freeze({ done: this.#done, entries: Object.freeze(entries) });
  }
}

export class InMemoryCrashDurabilityBackend<AuthenticatedPhysicalBytes extends Uint8Array>
implements HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes>, HizoFSDirectoryCursorBackend {
  public readonly capabilities = CAPABILITIES;

  readonly #faultInjector: DeterministicPhysicalStoreFaultInjector | undefined;
  readonly #handles = new WeakMap<HizoFSWritableFile, HandleState>();
  readonly #openHandles = new Set<HandleState>();
  readonly #maximumFileByteLength: bigint;
  #generation = 0;
  #root = createDirectoryNode();

  public constructor({ faultInjector, maximumFileByteLength = DEFAULT_MAXIMUM_FILE_BYTE_LENGTH }: {
    faultInjector?: DeterministicPhysicalStoreFaultInjector;
    maximumFileByteLength?: bigint;
  }) {
    if (maximumFileByteLength < 0n || maximumFileByteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('in-memory maximum file byte length must be a non-negative safe integer');
    }
    this.#faultInjector = faultInjector;
    this.#maximumFileByteLength = maximumFileByteLength;
  }

  public async createDirectoryExclusive({ path }: { path: CanonicalContainerDirectory }): Promise<void> {
    if (path === CANONICAL_CONTAINER_ROOT) return;
    const { entryName, parent } = this.#resolveDirectoryParent({ path });
    const existing = parent.entries.get(entryName);
    if (existing !== undefined) {
      switch (existing.kind) {
      case 'directory': return;
      case 'file':
        throw physicalStoreError({ code: 'not_directory', message: `physical entry is not a directory: ${path}`, path });
      default: {
        const _ex: never = existing;
        throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    }
    this.#checkpoint({ operation: 'createDirectoryExclusive', timing: 'before' });
    parent.entries.set(entryName, createDirectoryNode());
    this.#checkpoint({ operation: 'createDirectoryExclusive', timing: 'after' });
  }

  public async createFileExclusive({ path }: { path: CanonicalContainerPath }): Promise<HizoFSWritableFile> {
    const { entryName, parent } = this.#resolveFileParent({ path });
    if (parent.entries.has(entryName)) {
      throw physicalStoreError({ code: 'already_exists', message: `physical entry already exists: ${path}`, path });
    }
    this.#checkpoint({ operation: 'createFileExclusive', timing: 'before' });
    const node = createFileNode();
    parent.entries.set(entryName, node);
    const handle = this.#createHandle({ file: node, path });
    try {
      this.#checkpoint({ operation: 'createFileExclusive', timing: 'after' });
      return handle;
    } catch (error) {
      this.#closeHandleInternal({ file: handle });
      throw error;
    }
  }

  public async openFileForUpdate({ path }: { path: CanonicalContainerPath }): Promise<HizoFSWritableFile> {
    const node = this.#requireFile({ path });
    this.#checkpoint({ operation: 'openFileForUpdate', timing: 'before' });
    const handle = this.#createHandle({ file: node, path });
    try {
      this.#checkpoint({ operation: 'openFileForUpdate', timing: 'after' });
      return handle;
    } catch (error) {
      this.#closeHandleInternal({ file: handle });
      throw error;
    }
  }

  public async getFileSize({ path }: { path: CanonicalContainerPath }): Promise<bigint | undefined> {
    const node = this.#lookupNode({ path });
    if (node === undefined) return undefined;
    const fileNode = (() => {
      switch (node.kind) {
      case 'file': return node;
      case 'directory':
        throw physicalStoreError({ code: 'is_directory', message: `physical entry is a directory: ${path}`, path });
      default: {
        const _ex: never = node;
        throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    this.#checkpoint({ operation: 'getFileSize', timing: 'before' });
    const byteLength = BigInt(fileNode.bytes.byteLength);
    this.#checkpoint({ operation: 'getFileSize', timing: 'after' });
    return byteLength;
  }

  public async readExact({ length, offset, path }: {
    length: number;
    offset: bigint;
    path: CanonicalContainerPath;
  }): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('exact read length must be a non-negative safe integer');
    const node = this.#requireFile({ path });
    const start = this.#checkedBytePosition({ label: 'exact read offset', value: offset });
    const end = start + length;
    if (!Number.isSafeInteger(end) || end > node.bytes.byteLength) {
      throw physicalStoreError({
        code: 'unexpected_end',
        message: `exact read exceeds physical file length: ${path}`,
        path,
      });
    }
    this.#checkpoint({ operation: 'readExact', timing: 'before' });
    const result = node.bytes.slice(start, end);
    this.#checkpoint({ operation: 'readExact', timing: 'after' });
    return result;
  }

  public async readExactWithFileSize({ length, offset, path }: {
    length: number;
    offset: bigint;
    path: CanonicalContainerPath;
  }): Promise<Readonly<{ bytes: Uint8Array; fileSize: bigint }>> {
    const fileSize = await this.getFileSize({ path });
    if (fileSize === undefined) {
      throw physicalStoreError({
        code: 'not_found',
        message: `physical file does not exist: ${path}`,
        path,
      });
    }
    return {
      bytes: await this.readExact({ length, offset, path }),
      fileSize,
    };
  }

  public async readFileBounded({ maximumByteLength, path }: {
    maximumByteLength: number;
    path: CanonicalContainerPath;
  }): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 0) {
      throw new RangeError('bounded read maximum must be a non-negative safe integer');
    }
    const node = this.#lookupNode({ path });
    if (node === undefined) return undefined;
    const fileNode = (() => {
      switch (node.kind) {
      case 'file': return node;
      case 'directory':
        throw physicalStoreError({ code: 'is_directory', message: `physical entry is a directory: ${path}`, path });
      default: {
        const _ex: never = node;
        throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    if (fileNode.bytes.byteLength > maximumByteLength) {
      throw physicalStoreError({
        code: 'file_too_large',
        message: `physical file exceeds bounded read maximum: ${path}`,
        path,
      });
    }
    this.#checkpoint({ operation: 'readFileBounded', timing: 'before' });
    const result = Uint8Array.from(fileNode.bytes);
    this.#checkpoint({ operation: 'readFileBounded', timing: 'after' });
    return result;
  }

  public async writeAt({ bytes, file, offset }: {
    bytes: AuthenticatedPhysicalBytes;
    file: HizoFSWritableFile;
    offset: bigint;
  }): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('physical write bytes must be a Uint8Array');
    const state = this.#requireOpenHandle({ file });
    const start = this.#checkedBytePosition({ label: 'write offset', value: offset });
    const end = BigInt(start) + BigInt(bytes.byteLength);
    const endIndex = this.#checkedFileLength({ label: 'write end', value: end });
    this.#checkpoint({ operation: 'writeAt', timing: 'before' });

    if (bytes.byteLength !== 0) {
      if (endIndex > state.file.bytes.byteLength) {
        const expanded = new Uint8Array(endIndex);
        expanded.set(state.file.bytes);
        state.file.bytes = expanded;
      }
      state.file.bytes.set(bytes, start);
    }
    this.#checkpoint({ operation: 'writeAt', timing: 'after' });
  }

  public async truncate({ file, length }: { file: HizoFSWritableFile; length: bigint }): Promise<void> {
    const state = this.#requireOpenHandle({ file });
    const nextLength = this.#checkedFileLength({ label: 'truncate length', value: length });
    this.#checkpoint({ operation: 'truncate', timing: 'before' });
    if (nextLength !== state.file.bytes.byteLength) {
      const resized = new Uint8Array(nextLength);
      resized.set(state.file.bytes.subarray(0, nextLength));
      state.file.bytes = resized;
    }
    this.#checkpoint({ operation: 'truncate', timing: 'after' });
  }

  public async syncFileData({ file }: { file: HizoFSWritableFile }): Promise<void> {
    const state = this.#requireOpenHandle({ file });
    this.#checkpoint({ operation: 'syncFileData', timing: 'before' });
    state.file.durableBytes = Uint8Array.from(state.file.bytes);
    this.#checkpoint({ operation: 'syncFileData', timing: 'after' });
  }

  public async closeFile({ file }: { file: HizoFSWritableFile }): Promise<void> {
    const state = this.#handles.get(file);
    if (state === undefined) {
      throw physicalStoreError({ code: 'foreign_handle', message: 'writable file handle belongs to another backend' });
    }
    this.#checkpoint({ operation: 'closeFile', timing: 'before' });
    this.#closeHandleState({ state });
    this.#checkpoint({ operation: 'closeFile', timing: 'after' });
  }

  public async syncDirectoryEntries({ parent }: {
    parent: CanonicalContainerDirectory;
  }): Promise<void> {
    const directory = this.#requireDirectory({ path: parent });
    this.#checkpoint({ operation: 'syncDirectoryEntries', timing: 'before' });
    directory.durableEntries = new Map(directory.entries);
    this.#checkpoint({ operation: 'syncDirectoryEntries', timing: 'after' });
  }

  public async removeFile({ path }: { path: CanonicalContainerPath }): Promise<void> {
    const { entryName, parent } = this.#resolveFileParent({ path });
    const node = parent.entries.get(entryName);
    if (node === undefined) {
      throw physicalStoreError({ code: 'not_found', message: `physical file does not exist: ${path}`, path });
    }
    const fileNode = (() => {
      switch (node.kind) {
      case 'file': return node;
      case 'directory':
        throw physicalStoreError({ code: 'is_directory', message: `physical entry is a directory: ${path}`, path });
      default: {
        const _ex: never = node;
        throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    if (fileNode.openHandleCount !== 0) {
      throw physicalStoreError({ code: 'file_open', message: `physical file still has open handles: ${path}`, path });
    }
    this.#checkpoint({ operation: 'removeFile', timing: 'before' });
    parent.entries.delete(entryName);
    this.#checkpoint({ operation: 'removeFile', timing: 'after' });
  }


  public async openDirectoryCursor({ directory }: {
    directory: CanonicalContainerDirectory;
  }): Promise<HizoFSPhysicalDirectoryCursor> {
    const node = this.#requireDirectory({ path: directory });
    return new InMemoryPhysicalDirectoryCursor({ entries: node.entries });
  }

  public async list({ directory }: {
    directory: CanonicalContainerDirectory;
  }): Promise<readonly PhysicalEntry[]> {
    const node = this.#requireDirectory({ path: directory });
    this.#checkpoint({ operation: 'list', timing: 'before' });
    const entries = [...node.entries].map(([name, entry]): PhysicalEntry => {
      switch (entry.kind) {
      case 'directory': return { kind: 'directory', name };
      case 'file': return { byteLength: BigInt(entry.bytes.byteLength), kind: 'file', name };
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    });
    entries.sort((left, right) => compareEntryNames({ left: left.name, right: right.name }));
    this.#checkpoint({ operation: 'list', timing: 'after' });
    return entries;
  }

  public async crashAndRecover(): Promise<void> {
    this.#checkpoint({ operation: 'crashAndRecover', timing: 'before' });
    for (const state of this.#openHandles) this.#closeHandleState({ state });
    this.#generation += 1;
    this.#root = this.#cloneDurableDirectory({ source: this.#root });
    this.#checkpoint({ operation: 'crashAndRecover', timing: 'after' });
  }

  public openHandleCount(): number {
    return this.#openHandles.size;
  }

  #checkpoint({ operation, timing }: {
    operation: PhysicalStoreOperation;
    timing: PhysicalStoreFaultTiming;
  }): void {
    this.#faultInjector?.checkpoint({ operation, timing });
  }

  #resolveDirectoryParent({ path }: { path: CanonicalContainerDirectory }): {
    entryName: string;
    parent: DirectoryNode;
  } {
    const components = containerPathSegments({ path });
    const entryName = components.at(-1);
    if (entryName === undefined) throw new TypeError('container root does not have a parent entry');
    const parentPath = components.slice(0, -1).join('/') as CanonicalContainerDirectory;
    return { entryName, parent: this.#requireDirectory({ path: parentPath }) };
  }

  #resolveFileParent({ path }: { path: CanonicalContainerPath }): {
    entryName: string;
    parent: DirectoryNode;
  } {
    return {
      entryName: containerEntryName({ path }),
      parent: this.#requireDirectory({ path: parentContainerDirectory({ path }) }),
    };
  }

  #lookupNode({ path }: { path: CanonicalContainerDirectory | CanonicalContainerPath }): PhysicalNode | undefined {
    let current: PhysicalNode = this.#root;
    for (const component of containerPathSegments({ path })) {
      const directory: DirectoryNode = ((): DirectoryNode => {
        switch (current.kind) {
        case 'directory': return current;
        case 'file':
          throw physicalStoreError({ code: 'not_directory', message: `physical path parent is not a directory: ${path}`, path });
        default: {
          const _ex: never = current;
          throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      })();
      const next: PhysicalNode | undefined = directory.entries.get(component);
      if (next === undefined) return undefined;
      current = next;
    }
    return current;
  }

  #requireDirectory({ path }: { path: CanonicalContainerDirectory }): DirectoryNode {
    const node = this.#lookupNode({ path });
    if (node === undefined) {
      throw physicalStoreError({ code: 'not_found', message: `physical directory does not exist: ${path}`, path });
    }
    switch (node.kind) {
    case 'directory': return node;
    case 'file':
      throw physicalStoreError({ code: 'not_directory', message: `physical entry is not a directory: ${path}`, path });
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }

  #requireFile({ path }: { path: CanonicalContainerPath }): FileNode {
    const node = this.#lookupNode({ path });
    if (node === undefined) {
      throw physicalStoreError({ code: 'not_found', message: `physical file does not exist: ${path}`, path });
    }
    switch (node.kind) {
    case 'file': return node;
    case 'directory':
      throw physicalStoreError({ code: 'is_directory', message: `physical entry is a directory: ${path}`, path });
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }

  #createHandle({ file, path }: { file: FileNode; path: CanonicalContainerPath }): HizoFSWritableFile {
    const handle = Object.freeze({ path }) as HizoFSWritableFile;
    const state: HandleState = { closed: false, file, generation: this.#generation, path };
    file.openHandleCount += 1;
    this.#handles.set(handle, state);
    this.#openHandles.add(state);
    return handle;
  }

  #requireOpenHandle({ file }: { file: HizoFSWritableFile }): HandleState {
    const state = this.#handles.get(file);
    if (state === undefined) {
      throw physicalStoreError({ code: 'foreign_handle', message: 'writable file handle belongs to another backend' });
    }
    if (state.closed || state.generation !== this.#generation) {
      throw physicalStoreError({ code: 'closed_handle', message: `writable file handle is closed: ${state.path}`, path: state.path });
    }
    return state;
  }

  #closeHandleInternal({ file }: { file: HizoFSWritableFile }): void {
    const state = this.#handles.get(file);
    if (state !== undefined) this.#closeHandleState({ state });
  }

  #closeHandleState({ state }: { state: HandleState }): void {
    if (state.closed) return;
    state.closed = true;
    state.file.openHandleCount -= 1;
    this.#openHandles.delete(state);
  }

  #checkedBytePosition({ label, value }: { label: string; value: bigint }): number {
    if (value < 0n || value > this.#maximumFileByteLength) {
      throw physicalStoreError({ code: 'out_of_range', message: `${label} exceeds the in-memory backend range` });
    }
    return Number(value);
  }

  #checkedFileLength({ label, value }: { label: string; value: bigint }): number {
    if (value < 0n || value > this.#maximumFileByteLength) {
      throw physicalStoreError({ code: 'out_of_range', message: `${label} exceeds the in-memory backend file limit` });
    }
    return Number(value);
  }

  #cloneDurableDirectory({ source }: { source: DirectoryNode }): DirectoryNode {
    const clone = createDirectoryNode();
    for (const [name, durableChild] of source.durableEntries) {
      const child = (() => {
        switch (durableChild.kind) {
        case 'directory': return this.#cloneDurableDirectory({ source: durableChild });
        case 'file': return {
          bytes: Uint8Array.from(durableChild.durableBytes),
          durableBytes: Uint8Array.from(durableChild.durableBytes),
          kind: 'file' as const,
          openHandleCount: 0,
        };
        default: {
          const _ex: never = durableChild;
          throw new Error(`Unhandled physical node kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      })();
      clone.entries.set(name, child);
      clone.durableEntries.set(name, child);
    }
    return clone;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  defaultMaximumFileByteLength: DEFAULT_MAXIMUM_FILE_BYTE_LENGTH,
};
