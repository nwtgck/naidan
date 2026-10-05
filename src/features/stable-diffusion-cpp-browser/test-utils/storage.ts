/* eslint-disable local-rules-named-args/require-named-args -- Test doubles implement the browser File System Access API signatures. */
let stamp = 0;
export class MemoryFile {
  readonly kind = 'file';
  name: string; data = new Uint8Array(0); modified = ++stamp;
  failWrite = false;
  constructor(name: string) {
    this.name = name;
  }
  async getFile(): Promise<File> {
    return new File([this.data], this.name, { lastModified: this.modified });
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
  private opened = false;
  async createSyncAccessHandle() {
    if (this.opened) throw new DOMException('Locked', 'NoModificationAllowedError');
    this.opened = true;
    let closed = false;
    const check = () => {
      if (closed) throw new Error('Closed sync handle');
    };
    return {
      getSize: () => {
        check(); return this.data.length;
      },
      read: (bytes: Uint8Array, { at }: { at: number }) => {
        check(); const data = this.data.subarray(at, at + bytes.length); bytes.set(data); return data.length;
      },
      write: (bytes: Uint8Array, { at }: { at: number }) => {
        check(); if (this.failWrite) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        const next = new Uint8Array(Math.max(this.data.length, at + bytes.length)); next.set(this.data); next.set(bytes, at);
        this.data = next; this.modified = ++stamp; return bytes.length;
      },
      truncate: (size: number) => {
        check(); const next = new Uint8Array(size); next.set(this.data.subarray(0, size)); this.data = next; this.modified = ++stamp;
      },
      flush: () => {
        check();
      },
      close: () => {
        closed = true; this.opened = false;
      },
    };
  }
  async createWritable(options?: { keepExistingData?: boolean }) {
    let data = options?.keepExistingData ? this.data.slice() : new Uint8Array(0);
    let position = 0, closed = false;
    const truncate = async (size: number) => {
      if (closed || this.failWrite) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      const next = new Uint8Array(size); next.set(data.subarray(0, size)); data = next;
      position = Math.min(position, size);
    };
    return {
      write: async (input: Uint8Array | string | { type: 'write', position: number, data: Uint8Array }) => {
        if (closed || this.failWrite) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        let bytes: Uint8Array;
        if (typeof input === 'string') bytes = new TextEncoder().encode(input);
        else if ('type' in input) {
          position = input.position; bytes = input.data;
        } else bytes = input;
        const next = new Uint8Array(Math.max(data.length, position + bytes.length)); next.set(data); next.set(bytes, position);
        data = next; position += bytes.length;
      },
      truncate,
      close: async () => {
        this.data = data;
        this.modified = ++stamp; closed = true;
      },
      abort: async () => {
        closed = true;
      },
    };
  }
}
export class MemoryDirectory {
  readonly kind = 'directory';
  name: string; children = new Map<string, MemoryFile | MemoryDirectory>();
  constructor(name: string) {
    this.name = name;
  }
  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    let entry = this.children.get(name);
    if (!entry && options?.create) {
      entry = new MemoryDirectory(name); this.children.set(name, entry);
    }
    if (!entry) throw new DOMException(name, 'NotFoundError');
    switch (entry.kind) {
    case 'directory': return entry;
    case 'file': throw new DOMException(name, 'TypeMismatchError');
    default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
    }
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    let entry = this.children.get(name);
    if (!entry && options?.create) {
      entry = new MemoryFile(name); this.children.set(name, entry);
    }
    if (!entry) throw new DOMException(name, 'NotFoundError');
    switch (entry.kind) {
    case 'file': return entry;
    case 'directory': throw new DOMException(name, 'TypeMismatchError');
    default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
    }
  }
  async *entries(): AsyncGenerator<[string, MemoryFile | MemoryDirectory]> {
    yield* this.children.entries();
  }
  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) throw new Error('Rollback must never recursively delete a repository');
    const entry = this.children.get(name);
    if (!entry) throw new DOMException(name, 'NotFoundError');
    if (entry.kind === 'directory' && entry.children.size) throw new DOMException(name, 'InvalidModificationError');
    this.children.delete(name);
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
}
export const TEST_ONLY = {
};
