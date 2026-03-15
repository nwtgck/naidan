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

  constructor(fileHandle: MockFileSystemFileHandle) {
    let currentContent = new Uint8Array(0);

    super({
      write: (chunk) => {
        let data: Uint8Array;

        if (typeof chunk === 'string') {
          data = new TextEncoder().encode(chunk);
        } else if (chunk instanceof Uint8Array) {
          data = chunk;
        } else if (chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'write') {
          const d = (chunk as any).data;
          if (typeof d === 'string') data = new TextEncoder().encode(d);
          else if (d instanceof Uint8Array) data = d;
          else if (d instanceof ArrayBuffer) data = new Uint8Array(d);
          else throw new Error("Unsupported write data type in mock");
        } else {
          try {
            data = new Uint8Array(chunk as any);
          } catch {
            throw new Error("Invalid chunk type");
          }
        }

        const newContent = new Uint8Array(currentContent.length + data.length);
        newContent.set(currentContent);
        newContent.set(data, currentContent.length);
        currentContent = newContent;
      },
      close: () => {
        fileHandle.content = currentContent;
      }
    });
    this.fileHandle = fileHandle;
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
    const stream = new MockFileSystemWritableFileStream(this);
    if (options?.keepExistingData) {
      // Not implemented but also not used in tests yet
    }
    return stream;
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

    if (child.kind === 'directory' && !options?.recursive) {
      const dir = child as MockFileSystemDirectoryHandle;
      if (dir.children.size > 0) throw new Error(`InvalidModificationError: Directory not empty`);
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
