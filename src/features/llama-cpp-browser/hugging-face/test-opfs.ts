import { File as NodeFile } from 'node:buffer';
type MemoryDirectory = {
  kind: 'directory', name: string,
  children: Map<string, MemoryDirectory | ReturnType<typeof memoryFile>>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserves the native OPFS argument tuple.
  getDirectoryHandle: FileSystemDirectoryHandle['getDirectoryHandle'] extends (...args: infer Args) => unknown ? (...args: Args) => Promise<MemoryDirectory> : never,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserves the native OPFS argument tuple.
  getFileHandle: FileSystemDirectoryHandle['getFileHandle'] extends (...args: infer Args) => unknown ? (...args: Args) => Promise<ReturnType<typeof memoryFile>> : never,
  removeEntry: FileSystemDirectoryHandle['removeEntry'],
  entries: () => AsyncGenerator<[string, MemoryDirectory | ReturnType<typeof memoryFile>]>,
};
export function memoryDirectory({ name }: { name: string }): MemoryDirectory {
  const children = new Map<string, ReturnType<typeof memoryDirectory> | ReturnType<typeof memoryFile>>();
  return {
    kind: 'directory' as const, name, children,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Test implementation of the native OPFS API.
    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ReturnType<typeof memoryDirectory>> {
      let entry = children.get(name); if (!entry && options?.create) {
        entry = memoryDirectory({ name }); children.set(name, entry);
      }
      if (!entry) throw new DOMException('missing', 'NotFoundError'); switch (entry.kind) {
      case 'file': throw new DOMException('type', 'TypeMismatchError'); case 'directory': return entry; default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
      }
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Test implementation of the native OPFS API.
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<ReturnType<typeof memoryFile>> {
      let entry = children.get(name); if (!entry && options?.create) {
        entry = memoryFile({ name }); children.set(name, entry);
      }
      if (!entry) throw new DOMException('missing', 'NotFoundError'); switch (entry.kind) {
      case 'directory': throw new DOMException('type', 'TypeMismatchError'); case 'file': return entry; default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
      }
    },


    async removeEntry(name: string, options?: { recursive?: boolean }) {
      const entry = children.get(name);
      if (entry?.kind === 'directory' && entry.children.size && !options?.recursive) throw new DOMException('not empty', 'InvalidModificationError');
      if (!children.delete(name)) throw new DOMException('missing', 'NotFoundError');
    },
    async *entries() {
      yield* children.entries();
    },
  };
}
function memoryFile({ name }: { name: string }) {
  let bytes = new Uint8Array(); let opened = false;
  return {
    kind: 'file' as const, name,
    async getFile() {
      return new NodeFile([bytes], name, { lastModified: 123 });
    },
    async createWritable() {
      let pending = new Uint8Array();
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Test implementation of the native OPFS API.
      return { async write(value: string) {
        pending = new TextEncoder().encode(value);
      }, async close() {
        bytes = pending;
      }, async abort() {} };
    },
    async createSyncAccessHandle() {
      if (opened) throw new Error('locked'); opened = true;
      return {
        getSize() {
          return bytes.length;
        },
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Test implementation of the native OPFS API.
        truncate(size: number) {
          const next = new Uint8Array(size); next.set(bytes.subarray(0, size)); bytes = next;
        },
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Test implementation of the native OPFS API.
        write(value: Uint8Array, { at }: { at: number }) {
          const next = new Uint8Array(Math.max(bytes.length, at + value.length)); next.set(bytes); next.set(value, at); bytes = next; return value.length;
        },
        flush() {}, close() {
          opened = false;
        },
      };
    },
  };
}
export function ggufBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(128); bytes.set([71, 71, 85, 70, 3, 0, 0, 0]); return bytes;
}
export const TEST_ONLY = {
};
