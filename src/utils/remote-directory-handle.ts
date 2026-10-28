import { z } from 'zod';

export const remoteDirectoryEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  name: z.string(),
});
export type RemoteDirectoryEntry = z.infer<typeof remoteDirectoryEntrySchema>;

const identifierSchema = z.string().min(1);
const nameSchema = z.string().min(1).refine(name => name !== '.' && name !== '..' && !/[\\/\0]/u.test(name));
const positionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  // Structured-cloned values may come from another VM or browser realm.
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

/** File metadata travels separately because some transports clone File as Blob. */
export const remoteDirectoryFileSnapshotSchema = z.object({
  blob: z.custom<Blob>(value => typeof Blob !== 'undefined' && value instanceof Blob),
  name: z.string(),
  lastModified: z.number(),
});
export type RemoteDirectoryFileSnapshot = z.infer<typeof remoteDirectoryFileSnapshotSchema>;
export const remoteDirectoryWriteDataSchema = z.custom<ArrayBuffer | Blob | string>(value => (
  typeof value === 'string'
  || (typeof Blob !== 'undefined' && value instanceof Blob)
  || isArrayBuffer(value)
));
const fileSystemWriteDataSchema = z.custom<BufferSource | Blob | string>(value => (
  remoteDirectoryWriteDataSchema.safeParse(value).success
  || (ArrayBuffer.isView(value) && isArrayBuffer(value.buffer))
));
const writeCommandSchema = z.object({
  type: z.enum(['write', 'seek', 'truncate']),
  data: fileSystemWriteDataSchema.nullish(),
  position: positionSchema.nullish(),
  size: positionSchema.nullish(),
});

function remoteWriteData({ data }: { data: BufferSource | Blob | string }): ArrayBuffer | Blob | string {
  if (ArrayBuffer.isView(data)) {
    // Transfer only the selected byte range, never unrelated bytes of its backing buffer.
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  return data;
}

export const remoteDirectoryRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('get_directory'), parentId: identifierSchema, name: nameSchema, create: z.boolean() }),
  z.object({ type: z.literal('get_file'), parentId: identifierSchema, name: nameSchema, create: z.boolean() }),
  z.object({ type: z.literal('list'), id: identifierSchema }),
  z.object({ type: z.literal('get_file_content'), id: identifierSchema }),
  z.object({ type: z.literal('remove_entry'), parentId: identifierSchema, name: nameSchema, recursive: z.boolean() }),
  z.object({ type: z.literal('is_same_entry'), firstId: identifierSchema, secondId: identifierSchema }),
  z.object({ type: z.literal('resolve'), directoryId: identifierSchema, targetId: identifierSchema }),
  z.object({ type: z.literal('open_writer'), fileId: identifierSchema, keepExistingData: z.boolean() }),
  z.object({ type: z.literal('write'), writerId: identifierSchema, data: remoteDirectoryWriteDataSchema }),
  z.object({ type: z.literal('seek'), writerId: identifierSchema, position: positionSchema }),
  z.object({ type: z.literal('truncate'), writerId: identifierSchema, size: positionSchema }),
  z.object({ type: z.literal('close'), writerId: identifierSchema }),
  z.object({ type: z.literal('abort'), writerId: identifierSchema }),
]);
export type RemoteDirectoryRequest = z.infer<typeof remoteDirectoryRequestSchema>;

export const remoteDirectoryResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entry'), entry: remoteDirectoryEntrySchema }),
  z.object({ kind: z.literal('entries'), entries: z.array(remoteDirectoryEntrySchema) }),
  z.object({ kind: z.literal('file'), file: remoteDirectoryFileSnapshotSchema }),
  z.object({ kind: z.literal('writer'), writerId: identifierSchema }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({ kind: z.literal('path'), path: z.array(z.string()).nullable() }),
  z.object({ kind: z.literal('void') }),
]);
export type RemoteDirectoryResult = z.infer<typeof remoteDirectoryResultSchema>;

export const remoteDirectoryResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), result: remoteDirectoryResultSchema }),
  z.object({ status: z.literal('error'), name: z.string(), message: z.string() }),
]);
export type RemoteDirectoryResponse = z.infer<typeof remoteDirectoryResponseSchema>;

export interface RemoteDirectoryAccess {
  request({ request }: { request: RemoteDirectoryRequest }): Promise<RemoteDirectoryResponse>,
}

/** Keep native filesystem error names intact across a structured-clone boundary. */
export function createRemoteDirectoryAccess({ dispatch }: {
  dispatch({ request }: { request: RemoteDirectoryRequest }): Promise<RemoteDirectoryResult>,
}): RemoteDirectoryAccess {
  return {
    async request({ request }) {
      try {
        const parsed = remoteDirectoryRequestSchema.parse(request);
        const result = remoteDirectoryResultSchema.parse(await dispatch({ request: parsed }));
        return { status: 'ok', result };
      } catch (error) {
        return {
          status: 'error',
          name: typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : 'Error',
          message: typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : 'Remote filesystem operation failed',
        };
      }
    },
  };
}

const remoteHandleEntries = new WeakMap<FileSystemHandle, { access: RemoteDirectoryAccess, id: string }>();

/** Construct handles in the receiving realm; only entries and File snapshots cross RPC. */
export function createRemoteDirectoryHandle({ access, root }: {
  access: RemoteDirectoryAccess,
  root: RemoteDirectoryEntry,
}): FileSystemDirectoryHandle {
  const handles = new Map<string, FileSystemDirectoryHandle | FileSystemFileHandle>();

  async function call<TKind extends RemoteDirectoryResult['kind']>({ request, kind }: {
    request: RemoteDirectoryRequest,
    kind: TKind,
  }): Promise<Extract<RemoteDirectoryResult, { kind: TKind }>> {
    const response = remoteDirectoryResponseSchema.parse(await access.request({ request: remoteDirectoryRequestSchema.parse(request) }));
    switch (response.status) {
    case 'error':
      throw new DOMException(response.message, response.name);
    case 'ok': {
      if (response.result.kind !== kind) {
        throw new TypeError(`Expected remote filesystem result ${kind}, received ${response.result.kind}`);
      }
      // The runtime discriminant check establishes the generic result relation.
      return response.result as Extract<RemoteDirectoryResult, { kind: TKind }>;
    }
    default: {
      const exhaustive: never = response;
      throw new Error(String(exhaustive));
    }
    }
  }

  function handle({ entry }: { entry: RemoteDirectoryEntry }): FileSystemDirectoryHandle | FileSystemFileHandle {
    const parsed = remoteDirectoryEntrySchema.parse(entry);
    const existing = handles.get(parsed.id);
    if (existing !== undefined) {
      if (existing.kind !== parsed.kind || existing.name !== parsed.name) {
        throw new TypeError('Remote filesystem entry changed its identity');
      }
      return existing;
    }
    const created = (() => {
      switch (parsed.kind) {
      case 'directory': return new DirectoryHandle({ entry: parsed });
      case 'file': return new FileHandle({ entry: parsed });
      default: {
        const exhaustive: never = parsed.kind;
        throw new Error(String(exhaustive));
      }
      }
    })();
    handles.set(parsed.id, created);
    return created;
  }

  abstract class Handle implements FileSystemHandle {
    abstract readonly kind: 'directory' | 'file';
    readonly name: string;
    readonly id: string;

    constructor({ entry }: { entry: RemoteDirectoryEntry }) {
      const { name, id, kind: _kind, ...unhandled } = entry;
      unhandled satisfies Record<PropertyKey, never>;
      this.name = name;
      this.id = id;
      remoteHandleEntries.set(this, { access, id });
    }

    async isSameEntry(other: FileSystemHandle): Promise<boolean> {
      const candidate = remoteHandleEntries.get(other);
      // Node IDs are capability-scoped; do not compare them across access grants.
      if (candidate === undefined || candidate.access !== access) {
        return false;
      }
      return (await call({ request: { type: 'is_same_entry', firstId: this.id, secondId: candidate.id }, kind: 'boolean' })).value;
    }
  }

  class DirectoryHandle extends Handle implements FileSystemDirectoryHandle {
    readonly kind = 'directory' as const;

    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
      const result = await call({ request: { type: 'get_directory', parentId: this.id, name, create: options?.create ?? false }, kind: 'entry' });
      const child = handle({ entry: result.entry });
      switch (child.kind) {
      case 'directory': return child;
      case 'file': throw new TypeError('Remote filesystem returned a file for a directory lookup');
      default: {
        const exhaustive: never = child;
        throw new Error(String(exhaustive));
      }
      }
    }

    async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
      const result = await call({ request: { type: 'get_file', parentId: this.id, name, create: options?.create ?? false }, kind: 'entry' });
      const child = handle({ entry: result.entry });
      switch (child.kind) {
      case 'file': return child;
      case 'directory': throw new TypeError('Remote filesystem returned a directory for a file lookup');
      default: {
        const exhaustive: never = child;
        throw new Error(String(exhaustive));
      }
      }
    }

    async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
      await call({ request: { type: 'remove_entry', parentId: this.id, name, recursive: options?.recursive ?? false }, kind: 'void' });
    }

    async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
      const descendant = remoteHandleEntries.get(possibleDescendant);
      if (descendant === undefined || descendant.access !== access) {
        return null;
      }
      return (await call({ request: { type: 'resolve', directoryId: this.id, targetId: descendant.id }, kind: 'path' })).path;
    }

    async *entries(): AsyncGenerator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
      const result = await call({ request: { type: 'list', id: this.id }, kind: 'entries' });
      for (const entry of result.entries) {
        yield [entry.name, handle({ entry })];
      }
    }

    async *keys(): AsyncGenerator<string> {
      for await (const [name] of this.entries()) {
        yield name;
      }
    }

    async *values(): AsyncGenerator<FileSystemDirectoryHandle | FileSystemFileHandle> {
      for await (const [, child] of this.entries()) {
        yield child;
      }
    }

    [Symbol.asyncIterator](): ReturnType<FileSystemDirectoryHandle['entries']> {
      return this.entries();
    }
  }

  class FileHandle extends Handle implements FileSystemFileHandle {
    readonly kind = 'file' as const;

    async getFile(): Promise<File> {
      const result = await call({ request: { type: 'get_file_content', id: this.id }, kind: 'file' });
      const { blob, name, lastModified, ...unhandled } = result.file;
      unhandled satisfies Record<PropertyKey, never>;
      return new File([blob], name, { type: blob.type, lastModified });
    }

    async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
      const result = await call({ request: { type: 'open_writer', fileId: this.id, keepExistingData: options?.keepExistingData ?? false }, kind: 'writer' });
      return new RemoteWritable({ writerId: result.writerId });
    }
  }

  class RemoteWritable extends WritableStream<FileSystemWriteChunkType> implements FileSystemWritableFileStream {
    constructor({ writerId }: { writerId: string }) {
      const sink = {
        async write(chunk) {
          const parsed = fileSystemWriteDataSchema.safeParse(chunk);
          if (parsed.success) {
            await call({ request: { type: 'write', writerId, data: remoteWriteData({ data: parsed.data }) }, kind: 'void' });
            return;
          }
          const command = writeCommandSchema.parse(chunk);
          switch (command.type) {
          case 'write':
            if (command.data === undefined || command.data === null) {
              throw new TypeError('A filesystem write command requires data');
            }
            if (command.position !== undefined && command.position !== null) {
              await call({ request: { type: 'seek', writerId, position: command.position }, kind: 'void' });
            }
            await call({ request: { type: 'write', writerId, data: remoteWriteData({ data: command.data }) }, kind: 'void' });
            return;
          case 'seek':
            if (command.position === undefined || command.position === null) {
              throw new TypeError('A filesystem seek command requires a position');
            }
            await call({ request: { type: 'seek', writerId, position: command.position }, kind: 'void' });
            return;
          case 'truncate':
            if (command.size === undefined || command.size === null) {
              throw new TypeError('A filesystem truncate command requires a size');
            }
            await call({ request: { type: 'truncate', writerId, size: command.size }, kind: 'void' });
            return;
          default: {
            const exhaustive: never = command.type;
            throw new Error(String(exhaustive));
          }
          }
        },
        async close() {
          await call({ request: { type: 'close', writerId }, kind: 'void' });
        },
        async abort() {
          await call({ request: { type: 'abort', writerId }, kind: 'void' });
        },
      } satisfies UnderlyingSink<FileSystemWriteChunkType>;
      const withCleanup = async ({ operation }: { operation(): Promise<void> }): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          // A failed sink write errors the local stream without calling its abort hook.
          // Release the remote writer explicitly while preserving the original failure.
          await sink.abort().catch(() => {});
          throw error;
        }
      };
      super({
        write: chunk => withCleanup({ operation: () => sink.write(chunk) }),
        close: () => withCleanup({ operation: () => sink.close() }),
        abort: () => sink.abort(),
      });
    }

    async write(data: FileSystemWriteChunkType): Promise<void> {
      const writer = this.getWriter();
      try {
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    }

    async seek(position: number): Promise<void> {
      await this.write({ type: 'seek', position });
    }

    async truncate(size: number): Promise<void> {
      await this.write({ type: 'truncate', size });
    }
  }

  const directory = handle({ entry: root });
  switch (directory.kind) {
  case 'directory': return directory;
  case 'file': throw new TypeError('A remote directory root must be a directory');
  default: {
    const exhaustive: never = directory;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
