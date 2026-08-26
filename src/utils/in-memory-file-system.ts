function createFileSystemDomException({
  name,
  message,
}: {
  name: string;
  message: string;
}): DOMException {
  return new DOMException(message, name);
}

const CHROME_NOT_FOUND_MESSAGE = 'A requested file or directory could not be found at the time an operation was processed.';
const CHROME_TYPE_MISMATCH_MESSAGE = 'The path supplied exists, but was not an entry of requested type.';
const CHROME_INVALID_MODIFICATION_MESSAGE = 'The object can not be modified in this way.';

type DirectoryEntryOperation = 'getDirectoryHandle' | 'getFileHandle' | 'removeEntry';
// TypeScript's DOM declarations currently narrow FileSystemWriteChunkType to
// ArrayBuffer-backed views, while Wesh test helpers also carry ordinary
// Uint8Array<ArrayBufferLike> values. Accept that wider typed-array surface at
// the emulator boundary and copy its bytes; this is a typing accommodation,
// not a browser-behavior profile difference.
type MockFileSystemWriteChunkType = FileSystemWriteChunkType | Uint8Array<ArrayBufferLike>;

function validateEntryName({ name, operation }: { name: string; operation: DirectoryEntryOperation }): void {
  // Chrome, Firefox, and Safari were all observed to reject empty names,
  // ".", "..", and names containing "/" with TypeError. Chrome also rejected
  // a backslash while Firefox and Safari accepted it. This emulator deliberately
  // follows Chrome for browser-specific behavior; callers must not rely on
  // the backslash rule as a portable OPFS contract.
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new TypeError(`Failed to execute '${operation}' on 'FileSystemDirectoryHandle': Name is not allowed.`);
  }
}

function assertNonNegativeInteger({ value, label }: { value: number; label: string }): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

function isWriteParams(data: MockFileSystemWriteChunkType): data is WriteParams {
  if (typeof data !== 'object' || data === null) return false;
  const type = (data as { type?: unknown }).type;
  return type === 'write' || type === 'seek' || type === 'truncate';
}

export class MockFileSystemHandle<TKind extends FileSystemHandleKind = FileSystemHandleKind> implements FileSystemHandle {
  public kind: TKind;
  public name: string;
  private removed = false;

  constructor({ kind, name }: { kind: TKind, name: string }) {
    this.kind = kind;
    this.name = name;
  }

  isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return Promise.resolve(this === other);
  }

  protected assertEntryPresent(): void {
    if (this.removed) {
      throw createFileSystemDomException({ name: 'NotFoundError', message: CHROME_NOT_FOUND_MESSAGE });
    }
  }

  markEntryRemoved(): void {
    this.removed = true;
  }
}

export class MockFile implements File {
  private content: Uint8Array;
  public name: string;
  public lastModified: number;
  public readonly type: string;
  public readonly webkitRelativePath = '';

  constructor({ content, name, lastModified }: { content: Uint8Array, name: string, lastModified: number }) {
    // Browser File objects are snapshots. Keep a private copy so later writes to
    // the backing file handle cannot mutate a File that was already returned.
    this.content = new Uint8Array(content);
    this.name = name;
    this.lastModified = lastModified;
    // Chrome, Firefox, and Safari all returned "text/plain" for the observed
    // OPFS .txt files. Keep the mapping deliberately narrow instead of
    // inventing a complete browser MIME database that the observer did not
    // establish.
    this.type = name.toLowerCase().endsWith('.txt') ? 'text/plain' : '';
  }

  get size(): number {
    return this.content.length;
  }

  slice(start?: number, end?: number, _contentType?: string): MockFile {
    const s = start ?? 0;
    const e = end ?? this.content.length;
    return new MockFile({ content: this.content.slice(s, e), name: this.name, lastModified: this.lastModified });
  }

  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const content = new Uint8Array(this.content);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    });
  }

  text(): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(this.content));
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.content.buffer.slice(this.content.byteOffset, this.content.byteOffset + this.content.byteLength) as ArrayBuffer);
  }

  bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return Promise.resolve(new Uint8Array(this.content) as Uint8Array<ArrayBuffer>);
  }
}

export class MockFileSystemWritableFileStream extends WritableStream<FileSystemWriteChunkType> implements FileSystemWritableFileStream {
  public fileHandle: MockFileSystemFileHandle;
  private cursor = 0;
  private pendingContent: Uint8Array;
  private isCommitted = false;

  constructor({ fileHandle, options }: { fileHandle: MockFileSystemFileHandle, options?: FileSystemCreateWritableOptions }) {
    super({
      write: async (chunk) => {
        await this.write(chunk);
      },
      close: async () => {
        this.commit();
      },
    });
    this.fileHandle = fileHandle;
    this.pendingContent = options?.keepExistingData
      ? new Uint8Array(fileHandle.content)
      : new Uint8Array(0);

    // Chrome, Firefox, and Safari were observed to keep writes invisible to
    // getFile() until close(). The mock therefore edits a private working copy
    // and commits it atomically when the writable stream closes.
    this.cursor = 0;
  }

  private assertOpen(): void {
    if (this.isCommitted) {
      throw new TypeError('Writable file stream is closed');
    }
  }

  private commit(): void {
    if (this.isCommitted) return;
    this.fileHandle.content = new Uint8Array(this.pendingContent);
    this.fileHandle.lastModified = Date.now();
    this.isCommitted = true;
  }

  async seek(position: number): Promise<void> {
    this.assertOpen();
    assertNonNegativeInteger({ value: position, label: 'position' });
    this.cursor = position;
  }

  async truncate(size: number): Promise<void> {
    this.assertOpen();
    assertNonNegativeInteger({ value: size, label: 'size' });
    if (this.pendingContent.length > size) {
      this.pendingContent = this.pendingContent.slice(0, size);
    } else if (this.pendingContent.length < size) {
      const newContent = new Uint8Array(size);
      newContent.set(this.pendingContent);
      this.pendingContent = newContent;
    }
    if (this.cursor > size) this.cursor = size;
  }

  async write(data: MockFileSystemWriteChunkType): Promise<void> {
    this.assertOpen();

    if (isWriteParams(data)) {
      switch (data.type) {
      case 'seek':
        if (data.position === undefined || data.position === null) {
          throw new TypeError('seek command requires position');
        }
        await this.seek(data.position);
        return;
      case 'truncate':
        if (data.size === undefined || data.size === null) {
          throw new TypeError('truncate command requires size');
        }
        await this.truncate(data.size);
        return;
      case 'write':
        if (data.position !== undefined && data.position !== null) {
          await this.seek(data.position);
        }
        if (data.data === undefined || data.data === null) {
          throw new TypeError('write command requires data');
        }
        await this.writeBytes({ data: data.data });
        return;
      default: {
        const _ex: never = data;
        throw new TypeError(`Unsupported writable command: ${String(_ex)}`);
      }
      }
    }

    await this.writeBytes({ data });
  }

  private async writeBytes({ data }: { data: BufferSource | Blob | string | Uint8Array<ArrayBufferLike> }): Promise<void> {
    const bytes = await this.toBytes({ data });
    const requiredSize = this.cursor + bytes.length;
    if (this.pendingContent.length < requiredSize) {
      const newContent = new Uint8Array(requiredSize);
      newContent.set(this.pendingContent);
      this.pendingContent = newContent;
    }

    this.pendingContent.set(bytes, this.cursor);
    this.cursor += bytes.length;
  }

  private async toBytes({ data }: { data: BufferSource | Blob | string | Uint8Array<ArrayBufferLike> }): Promise<Uint8Array> {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }
    if (data instanceof Uint8Array) {
      return new Uint8Array(data);
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'object' && data !== null && 'arrayBuffer' in data && typeof data.arrayBuffer === 'function') {
      return new Uint8Array(await data.arrayBuffer());
    }
    throw new TypeError('Unsupported write data type');
  }
}

export class MockFileSystemFileHandle extends MockFileSystemHandle<'file'> implements FileSystemFileHandle {
  public content: Uint8Array;
  public lastModified: number;

  constructor({ name, content = new Uint8Array(0) }: { name: string, content?: Uint8Array }) {
    super({ kind: 'file', name });
    this.content = new Uint8Array(content);
    this.lastModified = Date.now();
  }

  async getFile(): Promise<MockFile> {
    // Chrome and Firefox were observed to reject getFile() on a removed file
    // handle with NotFoundError. Safari still returned a File. The emulator
    // follows Chrome here.
    this.assertEntryPresent();
    return new MockFile({ content: this.content, name: this.name, lastModified: this.lastModified });
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<MockFileSystemWritableFileStream> {
    // Chrome was observed to allow createWritable() on a removed file handle,
    // while Firefox and Safari rejected it with NotFoundError. Do not add an
    // entry-presence check here: this emulator intentionally follows Chrome.
    return new MockFileSystemWritableFileStream({ fileHandle: this, options });
  }
}

type MockFileSystemDirectoryChild = MockFileSystemFileHandle | MockFileSystemDirectoryHandle;

export class MockFileSystemDirectoryHandle extends MockFileSystemHandle<'directory'> implements FileSystemDirectoryHandle {
  private children: Map<string, MockFileSystemDirectoryChild>;

  constructor({ name }: { name: string }) {
    super({ kind: 'directory', name });
    this.children = new Map();
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<MockFileSystemFileHandle> {
    this.assertEntryPresent();
    validateEntryName({ name, operation: 'getFileHandle' });
    const child = this.children.get(name);
    if (child) {
      switch (child.kind) {
      case 'file':
        return child as MockFileSystemFileHandle;
      case 'directory':
        // Chrome, Firefox, and Safari agree on DOMException/TypeMismatchError
        // here, while their human-readable messages differ. The message below
        // is the one observed in Chrome.
        throw createFileSystemDomException({ name: 'TypeMismatchError', message: CHROME_TYPE_MISMATCH_MESSAGE });
      default: {
        const _ex: never = child;
        throw new Error(`Unhandled case: ${(_ex as { readonly kind: string }).kind}`);
      }
      }
    }
    if (options?.create) {
      const newFile = new MockFileSystemFileHandle({ name });
      this.children.set(name, newFile);
      return newFile;
    }
    // All three observed engines use DOMException.name === "NotFoundError" for
    // missing OPFS entries. Their message strings differ and are not portable;
    // this is the message observed in Chrome.
    throw createFileSystemDomException({ name: 'NotFoundError', message: CHROME_NOT_FOUND_MESSAGE });
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<MockFileSystemDirectoryHandle> {
    this.assertEntryPresent();
    validateEntryName({ name, operation: 'getDirectoryHandle' });
    const child = this.children.get(name);
    if (child) {
      switch (child.kind) {
      case 'directory':
        return child as MockFileSystemDirectoryHandle;
      case 'file':
        // Chrome, Firefox, and Safari agree on DOMException/TypeMismatchError
        // here, while their human-readable messages differ. The message below
        // is the one observed in Chrome.
        throw createFileSystemDomException({ name: 'TypeMismatchError', message: CHROME_TYPE_MISMATCH_MESSAGE });
      default: {
        const _ex: never = child;
        throw new Error(`Unhandled case: ${(_ex as { readonly kind: string }).kind}`);
      }
      }
    }
    if (options?.create) {
      const newDir = new MockFileSystemDirectoryHandle({ name });
      this.children.set(name, newDir);
      return newDir;
    }
    // All three observed engines use DOMException.name === "NotFoundError" for
    // missing OPFS entries. Their message strings differ and are not portable;
    // this is the message observed in Chrome.
    throw createFileSystemDomException({ name: 'NotFoundError', message: CHROME_NOT_FOUND_MESSAGE });
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    this.assertEntryPresent();
    validateEntryName({ name, operation: 'removeEntry' });
    const child = this.children.get(name);
    if (!child) {
      // Chrome, Firefox, and Safari agree on NotFoundError for a missing entry.
      throw createFileSystemDomException({ name: 'NotFoundError', message: CHROME_NOT_FOUND_MESSAGE });
    }

    switch (child.kind) {
    case 'directory': {
      const dir = child as MockFileSystemDirectoryHandle;
      if (!options?.recursive && dir.children.size > 0) {
        // Chrome and Firefox were observed to use InvalidModificationError;
        // Safari used UnknownError. The emulator follows Chrome, including
        // Chrome's observed message, so production code must not treat the
        // exact error name or message here as a cross-browser contract.
        throw createFileSystemDomException({ name: 'InvalidModificationError', message: CHROME_INVALID_MODIFICATION_MESSAGE });
      }
      break;
    }
    case 'file':
      break;
    default: {
      const _ex: never = child;
      throw new Error(`Unhandled file kind: ${(_ex as { readonly kind: string }).kind}`);
    }
    }
    this.children.delete(name);
    child.markEntryRemoved();
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    this.assertEntryPresent();
    if (possibleDescendant === this) return [];

    for (const [name, child] of this.children) {
      if (child === possibleDescendant) return [name];
      switch (child.kind) {
      case 'directory': {
        const path = await (child as MockFileSystemDirectoryHandle).resolve(possibleDescendant);
        if (path) return [name, ...path];
        break;
      }
      case 'file':
        break;
      default: {
        const _ex: never = child;
        throw new Error(`Unhandled case: ${(_ex as { readonly kind: string }).kind}`);
      }
      }
    }
    // Chrome and Firefox returned null for an unrelated handle in the browser
    // observations; Safari returned an empty array. Returning null is therefore
    // an emulator policy, not a portable cross-browser OPFS contract.
    return null;
  }

  private async *iterateEntries(): AsyncGenerator<[string, MockFileSystemDirectoryChild]> {
    // Chrome and Firefox were observed to throw NotFoundError when iterating
    // a removed directory handle; Safari returned an empty iterator. This
    // emulator follows Chrome.
    this.assertEntryPresent();
    // Browser engines were observed to enumerate the same entries in different
    // orders. Consumers must not treat this mock's Map insertion order as an
    // OPFS ordering guarantee.
    for (const [name, handle] of this.children) {
      yield [name, handle];
    }
  }

  private async *iterateKeys(): AsyncGenerator<string> {
    this.assertEntryPresent();
    for (const name of this.children.keys()) {
      yield name;
    }
  }

  private async *iterateValues(): AsyncGenerator<MockFileSystemDirectoryChild> {
    this.assertEntryPresent();
    for (const handle of this.children.values()) {
      yield handle;
    }
  }

  entries(): FileSystemDirectoryHandleAsyncIterator<[string, MockFileSystemDirectoryChild]> {
    return this.iterateEntries() as FileSystemDirectoryHandleAsyncIterator<[string, MockFileSystemDirectoryChild]>;
  }

  keys(): FileSystemDirectoryHandleAsyncIterator<string> {
    return this.iterateKeys() as FileSystemDirectoryHandleAsyncIterator<string>;
  }

  values(): FileSystemDirectoryHandleAsyncIterator<MockFileSystemDirectoryChild> {
    return this.iterateValues() as FileSystemDirectoryHandleAsyncIterator<MockFileSystemDirectoryChild>;
  }

  [Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator<[string, MockFileSystemDirectoryChild]> {
    return this.entries();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
