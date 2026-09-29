export type FileActivity = { phase: string, operation: string, path: string, bytes: number | undefined };

/** Filesystem API fixture only: production code owns writes and .complete. */
export function createMemoryFiles() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(['']);
  const activity: FileActivity[] = [];
  const writerCloseErrors = new Map<string, Error>();
  let phase = 'unassigned';
  let policy: 'read-write' | 'read-only' = 'read-write';
  function record({ operation, path, bytes }: { operation: string, path: string, bytes: number | undefined }) {
    activity.push({ phase, operation, path, bytes });
  }
  function mutate({ operation, path }: { operation: string, path: string }) {
    record({ operation, path, bytes: undefined });
    switch (policy) {
    case 'read-only': throw new Error(`Offline filesystem mutation: ${operation} ${path}`);
    case 'read-write': return;
    default: {
      const _ex: never = policy;
      throw new Error(`Unhandled filesystem policy ${_ex}`);
    }
    }
  }
  function directory({ prefix }: { prefix: string }): FileSystemDirectoryHandle {
    return {
      kind: 'directory', name: prefix.split('/').at(-2) ?? '',
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the native FileSystemDirectoryHandle API.
      async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
        const path = `${prefix}${name}/`;
        if (options?.create) {
          mutate({ operation: 'create-directory', path }); directories.add(path);
        }
        if (!directories.has(path)) throw new DOMException(`Missing directory ${path}`, 'NotFoundError');
        return directory({ prefix: path });
      },
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the native FileSystemDirectoryHandle API.
      async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
        const path = `${prefix}${name}`;
        if (options?.create) {
          mutate({ operation: 'create-file', path });
          if (!files.has(path)) files.set(path, new Uint8Array());
        }
        if (!files.has(path)) throw new DOMException(`Missing file ${path}`, 'NotFoundError');
        return {
          kind: 'file', name,
          async getFile() {
            const bytes = files.get(path);
            if (!bytes) throw new DOMException(`Missing file ${path}`, 'NotFoundError');
            record({ operation: 'stat', path, bytes: bytes.byteLength });
            const snapshot = Uint8Array.from(bytes);
            const file = new File([snapshot], name);
            Object.defineProperty(file, 'arrayBuffer', { value: async () => {
              record({ operation: 'body-read', path, bytes: snapshot.byteLength });
              return Uint8Array.from(snapshot).buffer;
            } });
            Object.defineProperty(file, 'text', { value: async () => {
              record({ operation: 'body-read', path, bytes: snapshot.byteLength });
              return new TextDecoder().decode(snapshot);
            } });
            Object.defineProperty(file, 'stream', { value: () => new ReadableStream<Uint8Array>({
              pull(controller) {
                record({ operation: 'body-read', path, bytes: snapshot.byteLength });
                controller.enqueue(Uint8Array.from(snapshot)); controller.close();
              },
            }, { highWaterMark: 0 }) });
            return file;
          },
          async createWritable() {
            mutate({ operation: 'writer-open', path });
            const chunks: Uint8Array[] = [];
            return new WritableStream<Uint8Array>({
              write(chunk) {
                mutate({ operation: 'writer-write', path });
                chunks.push(Uint8Array.from(chunk));
              },
              close() {
                mutate({ operation: 'writer-close', path });
                const error = writerCloseErrors.get(path);
                if (error) throw error;
                const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset); offset += chunk.byteLength;
                }
                files.set(path, bytes);
              },
              abort() {
                mutate({ operation: 'writer-abort', path });
              },
            });
          },
        };
      },
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the native FileSystemDirectoryHandle API.
      async removeEntry(name: string) {
        const path = `${prefix}${name}`;
        mutate({ operation: 'remove', path });
        if (!files.delete(path)) throw new DOMException(`Missing file ${path}`, 'NotFoundError');
      },
      async *entries() {
        for (const path of directories) {
          if (path.startsWith(prefix) && path !== prefix && !path.slice(prefix.length, -1).includes('/')) {
            const name = path.slice(prefix.length, -1);
            yield [name, directory({ prefix: path })];
          }
        }
        for (const path of files.keys()) {
          if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
            const name = path.slice(prefix.length);
            yield [name, await directory({ prefix }).getFileHandle(name)];
          }
        }
      },
    } as unknown as FileSystemDirectoryHandle;
  }
  return {
    files, activity, writerCloseErrors, root: directory({ prefix: '' }),
    enter({ nextPhase, mutationPolicy }: { nextPhase: string, mutationPolicy: typeof policy }) {
      phase = nextPhase; policy = mutationPolicy;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
