import { vi } from 'vitest';
import { createLazyVolumeManager } from './lazy-volumes';
import type { IStorageProvider } from './interface';
import { createRemoteDirectoryHandle } from '@/utils/remote-directory-handle';
import type { VolumeId } from '@/01-models/ids';

export type MemoryFile = { handle: FileSystemFileHandle, bytes: Uint8Array, present: boolean, opens: number, aborts: number };
type MemoryDirectory = { handle: FileSystemDirectoryHandle, children: Map<string, MemoryDirectory | MemoryFile>, present: boolean };

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  try {
    const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
    return byteLength !== undefined && typeof byteLength.call(value) === 'number';
  } catch {
    return false;
  }
}

function memoryFilesystem({ beforeOpen, beforeWrite }: {
  beforeOpen: (({ name, keepExistingData, count }: { name: string, keepExistingData: boolean, count: number }) => Promise<void>) | undefined,
  beforeWrite: (({ name }: { name: string }) => Promise<void>) | undefined,
}) {
  function assertName({ name }: { name: string }): void {
    if (name.includes('/') || name.length === 0) {
      throw new TypeError('Invalid name');
    }
  }
  function makeFile({ name }: { name: string }): MemoryFile {
    const file: MemoryFile = { handle: undefined as unknown as FileSystemFileHandle, bytes: new Uint8Array(), present: true, opens: 0, aborts: 0 };
    const handle: FileSystemFileHandle = {
      kind: 'file',
      name,
      async isSameEntry(other) {
        return other === handle;
      },
      async getFile() {
        if (!file.present) {
          throw new DOMException('Removed', 'NotFoundError');
        }
        return new File([Uint8Array.from(file.bytes)], name);
      },
      async createWritable(options) {
        file.opens++;
        await beforeOpen?.({ name, keepExistingData: options?.keepExistingData ?? false, count: file.opens });
        let bytes: Uint8Array = options?.keepExistingData ? Uint8Array.from(file.bytes) : new Uint8Array();
        let position = 0;
        let ended = false;
        function active(): void {
          if (ended) {
            throw new TypeError('Closed writer');
          }
        }
        return {
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the native writable stream API.
          async write(data: FileSystemWriteChunkType) {
            active();
            await beforeWrite?.({ name });
            if (typeof data === 'object' && data !== null && 'type' in data && !(data instanceof Blob)) {
              throw new TypeError('Tests use stream write methods directly');
            }
            const chunk = typeof data === 'string' ? new TextEncoder().encode(data)
              : data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
                : isArrayBuffer(data) ? new Uint8Array(data)
                  : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                    : (() => {
                      throw new TypeError('Unsupported data');
                    })();
            const next = new Uint8Array(Math.max(bytes.length, position + chunk.length));
            next.set(bytes);
            next.set(chunk, position);
            bytes = next;
            position += chunk.length;
          },
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the native writable stream API.
          async seek(value: number) {
            active();
            position = value;
          },
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the native writable stream API.
          async truncate(size: number) {
            active();
            const next = new Uint8Array(size);
            next.set(bytes.subarray(0, size));
            bytes = next;
          },
          async close() {
            active();
            file.bytes = bytes;
            ended = true;
          },
          async abort() {
            ended = true;
            file.aborts++;
          },
        } as unknown as FileSystemWritableFileStream;
      },
    };
    file.handle = handle;
    return file;
  }
  function makeDirectory({ name }: { name: string }): MemoryDirectory {
    const directory: MemoryDirectory = { handle: undefined as unknown as FileSystemDirectoryHandle, children: new Map(), present: true };
    const handle: FileSystemDirectoryHandle = {
      kind: 'directory',
      name,
      async isSameEntry(other) {
        return other === handle;
      },
      async getFileHandle(childName, options) {
        assertName({ name: childName });
        let child = directory.children.get(childName);
        if (child === undefined && options?.create) {
          child = makeFile({ name: childName });
          directory.children.set(childName, child);
        }
        if (child === undefined) {
          throw new DOMException('Missing', 'NotFoundError');
        }
        if (!('bytes' in child)) {
          throw new DOMException('Directory', 'TypeMismatchError');
        }
        return child.handle;
      },
      async getDirectoryHandle(childName, options) {
        assertName({ name: childName });
        let child = directory.children.get(childName);
        if (child === undefined && options?.create) {
          child = makeDirectory({ name: childName });
          directory.children.set(childName, child);
        }
        if (child === undefined) {
          throw new DOMException('Missing', 'NotFoundError');
        }
        if ('bytes' in child) {
          throw new DOMException('File', 'TypeMismatchError');
        }
        return child.handle;
      },
      async removeEntry(childName, options) {
        const child = directory.children.get(childName);
        if (child === undefined) {
          throw new DOMException('Missing', 'NotFoundError');
        }
        if ('children' in child && child.children.size > 0 && !options?.recursive) {
          throw new DOMException('Nonempty', 'InvalidModificationError');
        }
        child.present = false;
        directory.children.delete(childName);
      },
      async *entries() {
        for (const [childName, child] of directory.children) {
          yield [childName, child.handle];
        }
        return undefined;
      },
      async *values() {
        for (const child of directory.children.values()) {
          yield child.handle;
        }
        return undefined;
      },
      async *keys() {
        yield* directory.children.keys();
        return undefined;
      },
      async resolve(target) {
        if (target === handle) {
          return [];
        }
        for (const [childName, child] of directory.children) {
          if (child.handle === target) {
            return [childName];
          }
          if ('children' in child) {
            const path = await child.handle.resolve(target);
            if (path !== null) {
              return [childName, ...path];
            }
          }
        }
        return null;
      },
      async *[Symbol.asyncIterator]() {
        yield* handle.entries();
        return undefined;
      },
    };
    directory.handle = handle;
    return directory;
  }
  return makeDirectory({ name: 'volume' });
}

export function createLazyVolumeTestHarness({ beforeOpen, beforeWrite }: {
  beforeOpen: Parameters<typeof memoryFilesystem>[0]['beforeOpen'],
  beforeWrite: Parameters<typeof memoryFilesystem>[0]['beforeWrite'],
}) {
  const disposers: (() => Promise<void>)[] = [];
  const root = memoryFilesystem({ beforeOpen, beforeWrite });
  const publish = vi.fn(async () => {});
  const ensure = vi.fn(async () => root.handle);
  const provider = { ensureVolumeDirectory: ensure, publishVolume: publish, deleteVolume: vi.fn(async () => {}), deleteUnpublishedVolumeDirectory: vi.fn(async () => {}), renameVolume: vi.fn(async () => {}) } as unknown as IStorageProvider;
  const manager = createLazyVolumeManager({ provider });
  async function connect({ volumeId, readOnly }: { volumeId: VolumeId, readOnly: boolean }) {
    const connection = manager.createAccess({ reference: { volumeId }, readOnly });
    disposers.push(() => connection.dispose());
    return { ...connection, handle: createRemoteDirectoryHandle({ access: connection.access, root: connection.root }) };
  }
  return {
    manager,
    root,
    publish,
    ensure,
    connect,
    provider,
    async dispose() {
      await Promise.all(disposers.splice(0).map(dispose => dispose()));
    },
  };
}
