/** Focused native-handle stand-in: writes publish on close and abort preserves
 * the previous file. It is not used to claim real-browser OPFS compatibility.
 */
export function createWorkflowTestFileSystem() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(['']);
  const calls: string[] = [];
  const directoryPaths = new WeakMap<FileSystemHandle, string>();
  let closeHook: (() => Promise<void>) | undefined;
  let removeHook: (() => Promise<void>) | undefined;

  function pathFor({ parent, name }: { parent: string, name: string }): string {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new TypeError('Invalid filename');
    }
    return parent ? `${parent}/${name}` : name;
  }
  async function encode({ data }: { data: FileSystemWriteChunkType }): Promise<Uint8Array> {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }
    if (data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data).slice();
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    }
    throw new Error('Tests do not use seek or truncate writes.');
  }
  function fileHandle({ path }: { path: string }): FileSystemFileHandle {
    return {
      kind: 'file',
      name: path.split('/').at(-1)!,
      async getFile() {
        const bytes = files.get(path);
        if (!bytes) {
          throw new DOMException('Missing file', 'NotFoundError');
        }
        return new File([Uint8Array.from(bytes)], path.split('/').at(-1)!, { lastModified: 1 });
      },
      async createWritable() {
        const chunks: Uint8Array[] = [];
        const stream = new WritableStream<FileSystemWriteChunkType>({
          async write(data) {
            calls.push(`write:${path}`);
            chunks.push(await encode({ data }));
          },
          async close() {
            calls.push(`close:${path}`);
            const hook = closeHook;
            closeHook = undefined;
            await hook?.();
            const bytes = new Uint8Array(chunks.reduce((total, item) => total + item.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            files.set(path, bytes);
          },
          abort() {
            calls.push(`abort:${path}`);
            chunks.length = 0;
          },
        });
        // Native convenience methods acquire no permanently held stream writer.
        return Object.assign(stream, {
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemWritableFileStream.write.
          async write(data: FileSystemWriteChunkType) {
            const writer = stream.getWriter();
            try {
              await writer.write(data);
            } finally {
              writer.releaseLock();
            }
          },
          async close() {
            const writer = stream.getWriter();
            try {
              await writer.close();
            } finally {
              writer.releaseLock();
            }
          },
        }) as FileSystemWritableFileStream;
      },
    } as FileSystemFileHandle;
  }
  function directoryHandle({ path }: { path: string }): FileSystemDirectoryHandle {
    const handle = {
      kind: 'directory' as const,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemDirectoryHandle.resolve.
      async resolve(child: FileSystemHandle): Promise<string[] | null> {
        const target = directoryPaths.get(child);
        const prefix = path ? path + '/' : '';
        if (target === path) {
          return [];
        }
        return target !== undefined && target.startsWith(prefix) ? target.slice(prefix.length).split('/') : null;
      },
      name: path.split('/').at(-1) || 'test-folder',
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemDirectoryHandle.getFileHandle.
      async getFileHandle(name: string, options: FileSystemGetFileOptions | undefined) {
        const child = pathFor({ parent: path, name });
        if (directories.has(child)) {
          throw new DOMException('Directory exists', 'TypeMismatchError');
        }
        if (!files.has(child)) {
          if (!options?.create) {
            throw new DOMException('Missing file', 'NotFoundError');
          }
          files.set(child, new Uint8Array());
        }
        return fileHandle({ path: child });
      },
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemDirectoryHandle.getDirectoryHandle.
      async getDirectoryHandle(name: string, options: FileSystemGetDirectoryOptions | undefined) {
        const child = pathFor({ parent: path, name });
        if (files.has(child)) {
          throw new DOMException('File exists', 'TypeMismatchError');
        }
        if (!directories.has(child)) {
          if (!options?.create) {
            throw new DOMException('Missing directory', 'NotFoundError');
          }
          directories.add(child);
        }
        return directoryHandle({ path: child });
      },
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemDirectoryHandle.removeEntry.
      async removeEntry(name: string, options: FileSystemRemoveOptions | undefined) {
        const child = pathFor({ parent: path, name });
        const hook = removeHook;
        removeHook = undefined;
        await hook?.();
        if (files.delete(child)) {
          return;
        }
        if (!directories.has(child)) {
          throw new DOMException('Missing entry', 'NotFoundError');
        }
        const nested = [...files.keys(), ...directories].filter(key => key.startsWith(child + '/'));
        if (nested.length && !options?.recursive) {
          throw new DOMException('Not empty', 'InvalidModificationError');
        }
        nested.forEach(key => {
          files.delete(key);
          directories.delete(key);
        });
        directories.delete(child);
      },
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        const prefix = path ? path + '/' : '';
        for (const key of [...directories, ...files.keys()]) {
          const suffix = key.slice(prefix.length);
          if (key.startsWith(prefix) && suffix && !suffix.includes('/')) {
            yield [suffix, directories.has(key) ? directoryHandle({ path: key }) : fileHandle({ path: key })];
          }
        }
      },
      async *values(): AsyncGenerator<FileSystemHandle> {
        for await (const [, value] of handle.entries()) {
          yield value;
        }
      },
    };
    const typed = handle as unknown as FileSystemDirectoryHandle;
    directoryPaths.set(typed, path);
    return typed;
  }
  const root = directoryHandle({ path: '' });
  return {
    root,
    files,
    calls,
    beforeClose({ hook }: { hook: () => Promise<void> }) {
      closeHook = hook;
    },
    failClose({ error }: { error: Error }) {
      closeHook = async () => {
        throw error;
      };
    },
    failRemove({ error }: { error: Error }) {
      removeHook = async () => {
        throw error;
      };
    },
    setText({ path, text }: { path: string, text: string }) {
      files.set(path, new TextEncoder().encode(text));
    },
    text({ path }: { path: string }): string {
      const bytes = files.get(path);
      if (!bytes) {
        throw new Error('Missing fixture file.');
      }
      return new TextDecoder().decode(bytes);
    },
    [Symbol.dispose]() {
      files.clear();
      directories.clear();
    },
  };
}

export const TEST_ONLY = {
};
