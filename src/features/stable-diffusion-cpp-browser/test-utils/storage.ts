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
  async createWritable() {
    const chunks: Uint8Array[] = []; let closed = false;
    return {
      write: async (data: Uint8Array | string) => {
        if (closed || this.failWrite) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
      },
      close: async () => {
        this.data = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
        let offset = 0; for (const chunk of chunks) {
          this.data.set(chunk, offset); offset += chunk.length;
        }
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
