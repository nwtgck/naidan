// naidan/src/services/wesh/mocks/InMemoryFileSystem.ts

export class MockFileSystemHandle<TKind extends FileSystemHandleKind = FileSystemHandleKind> implements FileSystemHandle {
  public kind: TKind;
  public name: string;

  constructor({ kind, name }: { kind: TKind; name: string }) {
    this.kind = kind;
    this.name = name;
  }

  isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return Promise.resolve(this === other);
  }
}

export class MockFile implements File {
  private content: Uint8Array;
  public name: string;
  public lastModified: number;
  public readonly type = '';
  public readonly webkitRelativePath = '';

  constructor({ content, name, lastModified }: { content: Uint8Array; name: string; lastModified: number }) {
    this.content = content;
    this.name = name;
    this.lastModified = lastModified;
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
      }
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
  private cursor: number = 0;

  constructor({ fileHandle, options }: { fileHandle: MockFileSystemFileHandle; options?: FileSystemCreateWritableOptions }) {
    super({
      write: async (chunk) => {
        await this.write(chunk);
      },
      close: async () => {
        // Content is already updated in fileHandle during write
      }
    });
    this.fileHandle = fileHandle;
    if (!options?.keepExistingData) {
      this.fileHandle.content = new Uint8Array(0);
      this.fileHandle.lastModified = Date.now();
      this.cursor = 0;
    } else {
      this.cursor = 0;
    }
    // Logic note: keepExistingData=true usually means open existing. Cursor starts at 0.
    // If keepExistingData=false, it truncates.
  }

  async seek(position: number): Promise<void> {
    this.cursor = position;
  }

  async truncate(size: number): Promise<void> {
    if (this.fileHandle.content.length === size) return;
    if (this.fileHandle.content.length > size) {
      this.fileHandle.content = this.fileHandle.content.slice(0, size);
    } else {
      const newContent = new Uint8Array(size);
      newContent.set(this.fileHandle.content);
      this.fileHandle.content = newContent;
    }
    if (this.cursor > size) this.cursor = size;
    this.fileHandle.lastModified = Date.now();
  }

  async write(data: unknown): Promise<void> {
    let bytes: Uint8Array;

    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data && typeof data === 'object' && 'type' in data && (data as { type: string }).type === 'write') {
      const d = (data as unknown as { data: string | Uint8Array | ArrayBuffer }).data;
      if (typeof d === 'string') bytes = new TextEncoder().encode(d);
      else if (d instanceof Uint8Array) bytes = d;
      else if (d instanceof ArrayBuffer) bytes = new Uint8Array(d);
      else throw new Error("Unsupported write data type in mock");
    } else if (data && typeof data === 'object' && 'arrayBuffer' in data && typeof (data as { arrayBuffer: unknown }).arrayBuffer === 'function') {
      const arrayBuffer = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
      bytes = new Uint8Array(arrayBuffer);
    } else {
      // fallback
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes = new Uint8Array(data as any);
      } catch {
        throw new Error("Invalid data type");
      }
    }

    const requiredSize = this.cursor + bytes.length;
    if (this.fileHandle.content.length < requiredSize) {
      const newContent = new Uint8Array(requiredSize);
      newContent.set(this.fileHandle.content);
      this.fileHandle.content = newContent;
    }

    this.fileHandle.content.set(bytes, this.cursor);
    this.cursor += bytes.length;
    this.fileHandle.lastModified = Date.now();
  }
}

export class MockFileSystemFileHandle extends MockFileSystemHandle<'file'> implements FileSystemFileHandle {
  public content: Uint8Array;
  public lastModified: number;

  constructor({ name, content = new Uint8Array(0) }: { name: string; content?: Uint8Array }) {
    super({ kind: 'file', name });
    this.content = content;
    this.lastModified = Date.now();
  }

  getFile(): Promise<MockFile> {
    return Promise.resolve(new MockFile({ content: this.content, name: this.name, lastModified: this.lastModified }));
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<MockFileSystemWritableFileStream> {
    return new MockFileSystemWritableFileStream({ fileHandle: this, options });
  }
}

export class MockFileSystemDirectoryHandle extends MockFileSystemHandle<'directory'> implements FileSystemDirectoryHandle {
  private children: Map<string, MockFileSystemHandle>;

  constructor({ name }: { name: string }) {
    super({ kind: 'directory', name });
    this.children = new Map();
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<MockFileSystemFileHandle> {
    const child = this.children.get(name);
    if (child) {
      switch (child.kind) {
      case 'file':
        return child as MockFileSystemFileHandle;
      case 'directory':
        throw new Error(`TypeMismatchError: Entry '${name}' is not a file.`);
      default: {
        const _ex: never = child.kind;
        throw new Error(`Unhandled case: ${_ex}`);
      }
      }
    }
    if (options?.create) {
      const newFile = new MockFileSystemFileHandle({ name });
      this.children.set(name, newFile);
      return newFile;
    }
    throw new Error(`NotFoundError: File '${name}' not found.`);
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<MockFileSystemDirectoryHandle> {
    const child = this.children.get(name);
    if (child) {
      switch (child.kind) {
      case 'directory':
        return child as MockFileSystemDirectoryHandle;
      case 'file':
        throw new Error(`TypeMismatchError: Entry '${name}' is not a directory.`);
      default: {
        const _ex: never = child.kind;
        throw new Error(`Unhandled case: ${_ex}`);
      }
      }
    }
    if (options?.create) {
      const newDir = new MockFileSystemDirectoryHandle({ name });
      this.children.set(name, newDir);
      return newDir;
    }
    throw new Error(`NotFoundError: Directory '${name}' not found.`);
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const child = this.children.get(name);
    if (!child) throw new Error(`NotFoundError: Entry '${name}' not found.`);

    switch (child.kind) {
    case 'directory': {
      const dir = child as MockFileSystemDirectoryHandle;
      if (!options?.recursive && dir.children.size > 0) {
        throw new Error(`InvalidModificationError: Directory not empty`);
      }
      break;
    }
    case 'file':
      break;
    default: {
      const _ex: never = child.kind;
      throw new Error(`Unhandled file kind: ${_ex}`);
    }
    }
    this.children.delete(name);
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
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
        const _ex: never = child.kind;
        throw new Error(`Unhandled case: ${_ex}`);
      }
      }
    }
    return null;
  }

  entries(): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemHandle]> {
    const children = this.children;
    return (async function* (): AsyncGenerator<[string, FileSystemHandle]> {
      for (const [name, handle] of children) {
        yield [name, handle];
      }
    })() as FileSystemDirectoryHandleAsyncIterator<[string, FileSystemHandle]>;
  }

  keys(): FileSystemDirectoryHandleAsyncIterator<string> {
    const children = this.children;
    return (async function* (): AsyncGenerator<string> {
      for (const name of children.keys()) {
        yield name;
      }
    })() as FileSystemDirectoryHandleAsyncIterator<string>;
  }

  values(): FileSystemDirectoryHandleAsyncIterator<FileSystemHandle> {
    const children = this.children;
    return (async function* (): AsyncGenerator<FileSystemHandle> {
      for (const handle of children.values()) {
        yield handle;
      }
    })() as FileSystemDirectoryHandleAsyncIterator<FileSystemHandle>;
  }

  [Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemHandle]> {
    return this.entries();
  }
}
