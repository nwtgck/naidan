import type {
  HizoFSDevelopmentWritableBackend,
  HizoFSDevelopmentWritableBackendCapabilities,
  HizoFSDirectoryCursorBackend,
  HizoFSPhysicalDirectoryCursor,
  HizoFSWritableFile,
  PhysicalEntry,
  PhysicalDirectoryCursorPage,
} from '@/00-storage/service/hizofs/physical-store/backend';
import { PhysicalStoreError, physicalStoreError } from '@/00-storage/service/hizofs/physical-store/errors';
import {
  CANONICAL_CONTAINER_ROOT,
  type CanonicalContainerDirectory,
  type CanonicalContainerPath,
  canonicalContainerDirectory,
  containerEntryName,
  containerPathSegments,
  parentContainerDirectory,
} from '@/00-storage/service/hizofs/physical-store/paths';

interface OpfsSyncAccessHandle {
  close(): void;
  flush(): void;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemSyncAccessHandle.read.
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemSyncAccessHandle.truncate.
  truncate(newSize: number): void;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemSyncAccessHandle.write.
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
}

type OpfsWritableStream = Pick<FileSystemWritableFileStream, 'abort' | 'close' | 'truncate' | 'write'>;

type OpfsWritableFileHandle = Omit<FileSystemFileHandle, 'createWritable'> & {
  createSyncAccessHandle?: () => Promise<OpfsSyncAccessHandle>;
  createWritable?: FileSystemFileHandle['createWritable'];
};

type OpfsWritableFileState = {
  access:
    | {
        handle: OpfsSyncAccessHandle;
        type: 'sync_access';
      }
    | {
        fileHandle: OpfsWritableFileHandle;
        pending: Promise<void>;
        type: 'writable_stream';
      };
  closed: boolean;
  closing: Promise<void> | undefined;
  path: CanonicalContainerPath;
};

const CAPABILITIES: HizoFSDevelopmentWritableBackendCapabilities = Object.freeze({
  directoryEntryDurability: 'not-demonstrated',
  fileDataDurability: 'not-demonstrated',
});

function isDomExceptionNamed({ error, name }: { error: unknown; name: string }): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === name;
}

function isPhysicalStoreErrorCode({ error, code }: {
  error: unknown;
  code: PhysicalStoreError["code"];
}): boolean {
  return error instanceof PhysicalStoreError && error.code === code;
}

function compareEntryNames({ left, right }: { left: string; right: string }): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parentDirectoryOfDirectory({
  path,
}: {
  path: CanonicalContainerDirectory;
}): CanonicalContainerDirectory {
  const separatorIndex = path.lastIndexOf('/');
  return separatorIndex < 0
    ? CANONICAL_CONTAINER_ROOT
    : canonicalContainerDirectory({ value: path.slice(0, separatorIndex) });
}

class OpfsPhysicalDirectoryCursor implements HizoFSPhysicalDirectoryCursor {
  #closed = false;
  #done = false;
  readonly #iterator: AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;

  public constructor({ iterator }: { iterator: AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> }) {
    this.#iterator = iterator;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#iterator.return?.();
  }

  public async read({ maximumEntries }: { maximumEntries: number }): Promise<PhysicalDirectoryCursorPage> {
    if (this.#closed) throw new TypeError('physical directory cursor is closed');
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError('physical directory cursor page size must be a positive safe integer');
    }
    if (this.#done) return Object.freeze({ done: true, entries: Object.freeze([]) });

    const entries: PhysicalEntry[] = [];
    while (entries.length < maximumEntries) {
      const next = await this.#iterator.next();
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
        entries.push({ byteLength: BigInt((await entry.getFile()).size), kind: 'file', name });
        break;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled OPFS entry kind: ${String((_ex satisfies never) as FileSystemHandle)}`);
      }
      }
    }
    return Object.freeze({ done: this.#done, entries: Object.freeze(entries) });
  }
}

// OPFS exposes file flush but no parent-directory durability primitive. This adapter
// therefore performs the real operation without promoting it to an unproven crash guarantee.
export class OpfsWritableBackend<AuthenticatedPhysicalBytes extends Uint8Array>
implements HizoFSDevelopmentWritableBackend<AuthenticatedPhysicalBytes>, HizoFSDirectoryCursorBackend {
  public readonly capabilities = CAPABILITIES;

  readonly #handles = new WeakMap<HizoFSWritableFile, OpfsWritableFileState>();
  readonly #openPathCounts = new Map<CanonicalContainerPath, number>();
  readonly #root: FileSystemDirectoryHandle;

  public constructor({ root }: { root: FileSystemDirectoryHandle }) {
    this.#root = root;
  }

  public async createDirectoryExclusive({
    path,
  }: {
    path: CanonicalContainerDirectory;
  }): Promise<Readonly<{ parentEntrySyncRequired: boolean }>> {
    if (path === CANONICAL_CONTAINER_ROOT) return { parentEntrySyncRequired: false };
    const parent = await this.#resolveDirectory({ path: parentDirectoryOfDirectory({ path }) });
    const name = containerEntryName({ path });
    try {
      await parent.getDirectoryHandle(name);
      return { parentEntrySyncRequired: false };
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'not_directory',
          message: `physical entry is not a directory: ${path}`,
          path,
        });
      }
      if (!isDomExceptionNamed({ error, name: 'NotFoundError' })) throw error;
    }
    try {
      await parent.getDirectoryHandle(name, { create: true });
      return { parentEntrySyncRequired: true };
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'not_directory',
          message: `physical entry is not a directory: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  public async createFileExclusive({
    path,
  }: {
    path: CanonicalContainerPath;
  }): Promise<HizoFSWritableFile> {
    const parent = await this.#resolveDirectory({ path: parentContainerDirectory({ path }) });
    const name = containerEntryName({ path });
    await this.#assertEntryAbsent({ name, parent, path });

    try {
      const fileHandle = await parent.getFileHandle(name, { create: true }) as OpfsWritableFileHandle;
      return await this.#openNativeHandle({ fileHandle, path });
    } catch (error) {
      // OPFS has no atomic exclusive-create primitive. After the absence check, an
      // acquisition failure does not prove ownership of the entry, so never delete it here.
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'already_exists',
          message: `physical entry already exists: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  public async openFileForUpdate({
    path,
  }: {
    path: CanonicalContainerPath;
  }): Promise<HizoFSWritableFile> {
    try {
      const { fileHandle } = await this.#resolveFile({ path });
      return await this.#openNativeHandle({ fileHandle, path });
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'NotFoundError' })) {
        throw physicalStoreError({
          code: 'not_found',
          message: `physical file does not exist: ${path}`,
          path,
        });
      }
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'is_directory',
          message: `physical entry is a directory: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  public async getFileSize({
    path,
  }: {
    path: CanonicalContainerPath;
  }): Promise<bigint | undefined> {
    try {
      const { fileHandle } = await this.#resolveFile({ path });
      return BigInt((await fileHandle.getFile()).size);
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'NotFoundError' })
        || isPhysicalStoreErrorCode({ error, code: 'not_found' })) return undefined;
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'is_directory',
          message: `physical entry is a directory: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  public async readExact({
    length,
    offset,
    path,
  }: {
    length: number;
    offset: bigint;
    path: CanonicalContainerPath;
  }): Promise<Uint8Array> {
    return (await this.#readSnapshotRange({ length, offset, path })).bytes;
  }

  public async readExactWithFileSize({
    length,
    offset,
    path,
  }: {
    length: number;
    offset: bigint;
    path: CanonicalContainerPath;
  }): Promise<Readonly<{ bytes: Uint8Array; fileSize: bigint }>> {
    return await this.#readSnapshotRange({ length, offset, path });
  }

  async #readSnapshotRange({
    length,
    offset,
    path,
  }: {
    length: number;
    offset: bigint;
    path: CanonicalContainerPath;
  }): Promise<Readonly<{ bytes: Uint8Array; fileSize: bigint }>> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError('exact read length must be a non-negative safe integer');
    }
    const start = this.#checkedSafeInteger({ label: 'exact read offset', value: offset });
    const end = start + length;
    if (!Number.isSafeInteger(end)) throw new RangeError('exact read end exceeds safe integer range');

    try {
      const { fileHandle } = await this.#resolveFile({ path });
      const snapshot = await fileHandle.getFile();
      if (end > snapshot.size) {
        throw physicalStoreError({
          code: 'unexpected_end',
          message: `exact read exceeds physical file length: ${path}`,
          path,
        });
      }
      return {
        bytes: new Uint8Array(await snapshot.slice(start, end).arrayBuffer()),
        fileSize: BigInt(snapshot.size),
      };
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'NotFoundError' })) {
        throw physicalStoreError({
          code: 'not_found',
          message: `physical file does not exist: ${path}`,
          path,
        });
      }
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'is_directory',
          message: `physical entry is a directory: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  public async readFileBounded({
    maximumByteLength,
    path,
  }: {
    maximumByteLength: number;
    path: CanonicalContainerPath;
  }): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 0) {
      throw new RangeError('bounded read maximum must be a non-negative safe integer');
    }

    try {
      const { fileHandle } = await this.#resolveFile({ path });
      const snapshot = await fileHandle.getFile();
      if (snapshot.size > maximumByteLength) {
        throw physicalStoreError({
          code: 'file_too_large',
          message: `physical file exceeds bounded read maximum: ${path}`,
          path,
        });
      }
      return new Uint8Array(await snapshot.arrayBuffer());
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'NotFoundError' })
        || isPhysicalStoreErrorCode({ error, code: 'not_found' })) return undefined;
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'is_directory',
          message: `physical entry is a directory: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  public async writeAt({
    bytes,
    file,
    offset,
  }: {
    bytes: AuthenticatedPhysicalBytes;
    file: HizoFSWritableFile;
    offset: bigint;
  }): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('physical write bytes must be a Uint8Array');
    const state = this.#requireOpenHandle({ file });
    let position = this.#checkedSafeInteger({ label: 'write offset', value: offset });
    const writeEnd = position + bytes.byteLength;
    if (!Number.isSafeInteger(writeEnd)) {
      throw physicalStoreError({
        code: 'out_of_range',
        message: `physical write exceeds safe integer range: ${state.path}`,
        path: state.path,
      });
    }

    switch (state.access.type) {
    case 'sync_access': {
      let consumed = 0;
      while (consumed < bytes.byteLength) {
        const written = state.access.handle.write(bytes.subarray(consumed), { at: position });
        if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - consumed) {
          throw physicalStoreError({
            code: 'write_stalled',
            message: `physical write made invalid progress: ${state.path}`,
            path: state.path,
          });
        }
        consumed += written;
        position += written;
      }
      return;
    }
    case 'writable_stream':
      await this.#runWritableStreamOperation({
        access: state.access,
        operation: async ({ stream }) => await stream.write({
          data: bytes.slice(),
          position,
          type: 'write',
        }),
        state,
      });
      return;
    default: return state.access satisfies never;
    }
  }

  public async truncate({
    file,
    length,
  }: {
    file: HizoFSWritableFile;
    length: bigint;
  }): Promise<void> {
    const state = this.#requireOpenHandle({ file });
    const checkedLength = this.#checkedSafeInteger({ label: 'truncate length', value: length });
    switch (state.access.type) {
    case 'sync_access':
      state.access.handle.truncate(checkedLength);
      return;
    case 'writable_stream':
      await this.#runWritableStreamOperation({
        access: state.access,
        operation: async ({ stream }) => await stream.truncate(checkedLength),
        state,
      });
      return;
    default: return state.access satisfies never;
    }
  }

  public async syncFileData({
    file,
  }: {
    file: HizoFSWritableFile;
  }): Promise<void> {
    const state = this.#requireOpenHandle({ file });
    switch (state.access.type) {
    case 'sync_access':
      state.access.handle.flush();
      return;
    case 'writable_stream':
      await state.access.pending;
      // Each fallback mutation closes its FileSystemWritableFileStream before
      // returning. Reacquiring the file snapshot confirms live-namespace
      // visibility without promoting it to an unproven crash-durability claim.
      await state.access.fileHandle.getFile();
      return;
    default: return state.access satisfies never;
    }
  }

  public async closeFile({
    file,
  }: {
    file: HizoFSWritableFile;
  }): Promise<void> {
    const state = this.#handles.get(file);
    if (state === undefined) {
      throw physicalStoreError({
        code: 'foreign_handle',
        message: 'writable file handle belongs to another backend',
      });
    }
    if (state.closed) return;
    if (state.closing !== undefined) {
      await state.closing;
      return;
    }

    const closing = this.#closeNativeHandle({ state });
    state.closing = closing;
    try {
      await closing;
      state.closed = true;
      this.#decrementOpenPath({ path: state.path });
    } finally {
      state.closing = undefined;
    }
  }

  public async syncDirectoryEntries({
    parent,
  }: {
    parent: CanonicalContainerDirectory;
  }): Promise<void> {
    // OPFS has no directory fsync. The unreleased development profile still
    // performs an independent parent reacquire/readback instead of a no-op or
    // file-flush alias. This confirms that the mutation is observable in the
    // live namespace but intentionally does not upgrade the capability beyond
    // `not-demonstrated` crash durability.
    await this.list({ directory: parent });
  }

  public async removeFile({
    path,
  }: {
    path: CanonicalContainerPath;
  }): Promise<void> {
    if ((this.#openPathCounts.get(path) ?? 0) !== 0) {
      throw physicalStoreError({
        code: 'file_open',
        message: `physical file still has open handles: ${path}`,
        path,
      });
    }

    try {
      const { name, parent } = await this.#resolveFile({ path });
      await parent.removeEntry(name);
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'NotFoundError' })) {
        throw physicalStoreError({
          code: 'not_found',
          message: `physical file does not exist: ${path}`,
          path,
        });
      }
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'is_directory',
          message: `physical entry is a directory: ${path}`,
          path,
        });
      }
      throw error;
    }
  }


  public async openDirectoryCursor({ directory }: {
    directory: CanonicalContainerDirectory;
  }): Promise<HizoFSPhysicalDirectoryCursor> {
    const handle = await this.#resolveDirectory({ path: directory });
    return new OpfsPhysicalDirectoryCursor({ iterator: handle.entries() });
  }

  public async list({
    directory,
  }: {
    directory: CanonicalContainerDirectory;
  }): Promise<readonly PhysicalEntry[]> {
    const handle = await this.#resolveDirectory({ path: directory });
    const entries: PhysicalEntry[] = [];
    for await (const [name, entry] of handle.entries()) {
      switch (entry.kind) {
      case 'directory':
        entries.push({ kind: 'directory', name });
        break;
      case 'file':
        entries.push({
          byteLength: BigInt((await entry.getFile()).size),
          kind: 'file',
          name,
        });
        break;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled OPFS entry kind: ${String((_ex satisfies never) as FileSystemHandle)}`);
      }
      }
    }
    entries.sort((left, right) => compareEntryNames({ left: left.name, right: right.name }));
    return entries;
  }

  async #assertEntryAbsent({
    name,
    parent,
    path,
  }: {
    name: string;
    parent: FileSystemDirectoryHandle;
    path: CanonicalContainerPath;
  }): Promise<void> {
    try {
      await parent.getFileHandle(name);
      throw physicalStoreError({
        code: 'already_exists',
        message: `physical entry already exists: ${path}`,
        path,
      });
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'NotFoundError' })) return;
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'already_exists',
          message: `physical entry already exists: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  #checkedSafeInteger({
    label,
    value,
  }: {
    label: string;
    value: bigint;
  }): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw physicalStoreError({
        code: 'out_of_range',
        message: `${label} must be a non-negative safe integer`,
      });
    }
    return Number(value);
  }

  #decrementOpenPath({
    path,
  }: {
    path: CanonicalContainerPath;
  }): void {
    const count = this.#openPathCounts.get(path);
    if (count === undefined || count <= 1) this.#openPathCounts.delete(path);
    else this.#openPathCounts.set(path, count - 1);
  }

  async #openNativeHandle({
    fileHandle,
    path,
  }: {
    fileHandle: OpfsWritableFileHandle;
    path: CanonicalContainerPath;
  }): Promise<HizoFSWritableFile> {
    const createSyncAccessHandle = fileHandle.createSyncAccessHandle;
    let access: OpfsWritableFileState['access'] | undefined;
    if (createSyncAccessHandle !== undefined) {
      try {
        access = {
          handle: await createSyncAccessHandle.call(fileHandle),
          type: 'sync_access',
        };
      } catch (error) {
        if (isDomExceptionNamed({ error, name: 'InvalidStateError' })) {
          throw physicalStoreError({
            code: 'file_open',
            message: `physical file is already open: ${path}`,
            path,
          });
        }
        if (!isDomExceptionNamed({ error, name: 'NotSupportedError' })) throw error;
      }
    }

    if (access === undefined) {
      if (fileHandle.createWritable === undefined) {
        throw physicalStoreError({
          code: 'sync_access_unavailable',
          message: `OPFS file supports neither synchronous access nor writable streams: ${path}`,
          path,
        });
      }
      access = {
        fileHandle,
        pending: Promise.resolve(),
        type: 'writable_stream',
      };
    }

    const file = Object.freeze({ path }) as HizoFSWritableFile;
    this.#handles.set(file, { access, closed: false, closing: undefined, path });
    this.#openPathCounts.set(path, (this.#openPathCounts.get(path) ?? 0) + 1);
    return file;
  }

  async #closeNativeHandle({
    state,
  }: {
    state: OpfsWritableFileState;
  }): Promise<void> {
    switch (state.access.type) {
    case 'sync_access':
      state.access.handle.close();
      return;
    case 'writable_stream':
      await state.access.pending;
      return;
    default: return state.access satisfies never;
    }
  }

  async #runWritableStreamOperation({
    access,
    operation,
    state,
  }: {
    access: Extract<OpfsWritableFileState['access'], { type: 'writable_stream' }>;
    operation: ({ stream }: { stream: OpfsWritableStream }) => Promise<void>;
    state: OpfsWritableFileState;
  }): Promise<void> {
    const previous = access.pending;
    const completion = Promise.withResolvers<void>();
    access.pending = completion.promise;
    await previous;
    try {
      if (state.closed || state.closing !== undefined) {
        throw physicalStoreError({
          code: 'closed_handle',
          message: `physical file handle is closed: ${state.path}`,
          path: state.path,
        });
      }
      const createWritable = access.fileHandle.createWritable;
      if (createWritable === undefined) {
        throw physicalStoreError({
          code: 'sync_access_unavailable',
          message: `OPFS writable stream became unavailable: ${state.path}`,
          path: state.path,
        });
      }
      let stream: OpfsWritableStream;
      try {
        stream = await createWritable.call(access.fileHandle, { keepExistingData: true });
      } catch (error) {
        if (isDomExceptionNamed({ error, name: 'InvalidStateError' })
          || isDomExceptionNamed({ error, name: 'NoModificationAllowedError' })) {
          throw physicalStoreError({
            code: 'file_open',
            message: `physical file is already open: ${state.path}`,
            path: state.path,
          });
        }
        if (isDomExceptionNamed({ error, name: 'NotSupportedError' })) {
          throw physicalStoreError({
            code: 'sync_access_unavailable',
            message: `OPFS writable stream is unavailable: ${state.path}`,
            path: state.path,
          });
        }
        throw error;
      }
      try {
        await operation({ stream });
        await stream.close();
      } catch (cause: unknown) {
        try {
          await stream.abort(cause);
        } catch (abortCause: unknown) {
          throw new AggregateError(
            [cause, abortCause],
            `OPFS writable stream operation and abort both failed: ${state.path}`,
          );
        }
        throw cause;
      }
    } finally {
      completion.resolve();
    }
  }

  #requireOpenHandle({
    file,
  }: {
    file: HizoFSWritableFile;
  }): OpfsWritableFileState {
    const state = this.#handles.get(file);
    if (state === undefined) {
      throw physicalStoreError({
        code: 'foreign_handle',
        message: 'writable file handle belongs to another backend',
      });
    }
    if (state.closed || state.closing !== undefined) {
      throw physicalStoreError({
        code: 'closed_handle',
        message: `physical file handle is closed: ${state.path}`,
        path: state.path,
      });
    }
    return state;
  }

  async #resolveDirectory({
    path,
  }: {
    path: CanonicalContainerDirectory;
  }): Promise<FileSystemDirectoryHandle> {
    let directory = this.#root;
    try {
      for (const segment of containerPathSegments({ path })) {
        directory = await directory.getDirectoryHandle(segment);
      }
      return directory;
    } catch (error) {
      if (isDomExceptionNamed({ error, name: 'NotFoundError' })) {
        throw physicalStoreError({
          code: 'not_found',
          message: `physical directory does not exist: ${path}`,
          path,
        });
      }
      if (isDomExceptionNamed({ error, name: 'TypeMismatchError' })) {
        throw physicalStoreError({
          code: 'not_directory',
          message: `physical entry is not a directory: ${path}`,
          path,
        });
      }
      throw error;
    }
  }

  async #resolveFile({
    path,
  }: {
    path: CanonicalContainerPath;
  }): Promise<{
    fileHandle: OpfsWritableFileHandle;
    name: string;
    parent: FileSystemDirectoryHandle;
  }> {
    const parent = await this.#resolveDirectory({ path: parentContainerDirectory({ path }) });
    const name = containerEntryName({ path });
    const fileHandle = await parent.getFileHandle(name) as OpfsWritableFileHandle;
    return { fileHandle, name, parent };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
