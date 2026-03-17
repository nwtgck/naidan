// naidan/src/services/wesh/mocks/InMemoryFileSystem.ts

export class MockFileSystemHandle {
  public kind: 'file' | 'directory';
  public name: string;

  constructor(kind: 'file' | 'directory', name: string) {
    this.kind = kind;
    this.name = name;
  }

  isSameEntry(other: MockFileSystemHandle): boolean {
    return this === other;
  }
}

export class MockFile {
  private content: Uint8Array;
  public name: string;
  public lastModified: number;

  constructor(content: Uint8Array, name: string) {
    this.content = content;
    this.name = name;
    this.lastModified = Date.now();
  }

  get size(): number {
    return this.content.length;
  }

  slice(start?: number, end?: number): MockFile {
    const s = start ?? 0;
    const e = end ?? this.content.length;
    return new MockFile(this.content.slice(s, e), this.name);
  }

  stream(): ReadableStream<Uint8Array> {
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
    return Promise.resolve(this.content.buffer.slice(this.content.byteOffset, this.content.byteOffset + this.content.byteLength));
  }
}

export class MockFileSystemWritableFileStream extends WritableStream<Uint8Array | string | { type: 'write'; data: Uint8Array | string | ArrayBuffer | Blob }> {
  public fileHandle: MockFileSystemFileHandle;
  private cursor: number = 0;

  constructor(fileHandle: MockFileSystemFileHandle, options?: { keepExistingData?: boolean }) {
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
      const d = (data as { data: unknown }).data;
      if (typeof d === 'string') bytes = new TextEncoder().encode(d);
      else if (d instanceof Uint8Array) bytes = d;
      else if (d instanceof ArrayBuffer) bytes = new Uint8Array(d);
      else throw new Error("Unsupported write data type in mock");
    } else {
      // fallback
      try {
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
  }
}

export class MockFileSystemFileHandle extends MockFileSystemHandle {
  public content: Uint8Array;

  constructor(name: string, content: Uint8Array = new Uint8Array(0)) {
    super('file', name);
    this.content = content;
  }

  getFile(): Promise<MockFile> {
    return Promise.resolve(new MockFile(this.content, this.name));
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<MockFileSystemWritableFileStream> {
    return new MockFileSystemWritableFileStream(this, options);
  }
}

export class MockFileSystemDirectoryHandle extends MockFileSystemHandle {
  private children: Map<string, MockFileSystemHandle>;

  constructor(name: string) {
    super('directory', name);
    this.children = new Map();
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileSystemFileHandle> {
    const child = this.children.get(name);
    if (child) {
      if (child.kind !== 'file') throw new Error(`TypeMismatchError: Entry '${name}' is not a file.`);
      return child as MockFileSystemFileHandle;
    }
    if (options?.create) {
      const newFile = new MockFileSystemFileHandle(name);
      this.children.set(name, newFile);
      return newFile;
    }
    throw new Error(`NotFoundError: File '${name}' not found.`);
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockFileSystemDirectoryHandle> {
    const child = this.children.get(name);
    if (child) {
      if (child.kind !== 'directory') throw new Error(`TypeMismatchError: Entry '${name}' is not a directory.`);
      return child as MockFileSystemDirectoryHandle;
    }
    if (options?.create) {
      const newDir = new MockFileSystemDirectoryHandle(name);
      this.children.set(name, newDir);
      return newDir;
    }
    throw new Error(`NotFoundError: Directory '${name}' not found.`);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
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

  async resolve(possibleDescendant: MockFileSystemHandle): Promise<string[] | null> {
    if (possibleDescendant === this) return [];

    for (const [name, child] of this.children) {
      if (child === possibleDescendant) return [name];
      if (child.kind === 'directory') {
        const path = await (child as MockFileSystemDirectoryHandle).resolve(possibleDescendant);
        if (path) return [name, ...path];
      }
    }
    return null;
  }

  async *entries() {
    for (const [name, handle] of this.children) {
      yield [name, handle];
    }
  }

  async *keys() {
    for (const name of this.children.keys()) {
      yield name;
    }
  }

  async *values() {
    for (const handle of this.children.values()) {
      yield handle;
    }
  }
}
