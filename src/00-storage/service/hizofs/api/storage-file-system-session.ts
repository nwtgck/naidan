import type { StorageBinaryObjectReadHandle } from "@/00-storage/service/binary-object-io";
import {
  captureFileWriteBytes,
  type CapturedFileWriteBytes,
} from "@/00-storage/service/hizofs/filesystem/file/file-write-input";
import { createStorageFileSystemSyncError } from "@/00-storage/service/storage-file-system/sync-error";
import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountAccessMode,
  StorageDirectoryWorkerMountGrant,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileStat,
  StorageFileSystemSession,
  StorageSymlinkHandle,
  StorageWritableFile,
} from "@/00-storage/service/storage-file-system/types";

export type HizoFSApplicationEntryKind = "directory" | "file" | "symlink";

export type HizoFSApplicationStat = Readonly<{
  createdAt: bigint | undefined;
  kind: HizoFSApplicationEntryKind;
  modifiedAt: bigint | undefined;
  size: bigint;
}>;

export type HizoFSApplicationDirectoryEntry = Readonly<{
  kind: HizoFSApplicationEntryKind;
  name: string;
}>;

export type HizoFSApplicationDirectoryPage = Readonly<{
  entries: readonly HizoFSApplicationDirectoryEntry[];
  truncated: boolean;
}>;

export interface HizoFSApplicationReadableFile {
  readonly size: bigint;
  close(): Promise<void>;
  read({ length, offset, signal }: {
    length: bigint;
    offset: bigint;
    signal: AbortSignal | undefined;
  }): Promise<Uint8Array>;
}

export interface HizoFSApplicationExplicitBulkBuilder {
  abort({ reason }: { reason: unknown }): Promise<void>;
  commit(): Promise<void>;
  createEmptyFile({ name }: { name: string }): Promise<void>;
}

export interface HizoFSApplicationWritableFile {
  abort({ reason }: { reason: unknown }): Promise<void>;
  commit(): Promise<void>;
  truncate({ size }: { size: bigint }): Promise<void>;
  write({ data, position }: { data: CapturedFileWriteBytes; position: bigint }): Promise<void>;
}

/**
 * Naidan-facing filesystem operation port.
 *
 * Container keys, authenticated-store writers, Commit publication, runtime
 * leases, and maintenance authorities stay behind this boundary. The adapter
 * below receives only complete logical operations and cannot bypass runtime
 * close linearization or publication rules.
 *
 * The production composition binds authenticated namespace, mutation,
 * publication, and runtime primitives behind this port. Keeping those
 * authorities here prevents application handles from retaining root keys,
 * physical backends, publication writers, or generation leases.
 */
export interface HizoFSApplicationSessionPort {
  cloneFile({ destinationPath, name, newName, path, replace }: {
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void>;
  close(): Promise<void>;
  createDirectory({ name, path }: { name: string; path: readonly string[] }): Promise<void>;
  createFile({ name, path }: { name: string; path: readonly string[] }): Promise<void>;
  createReadSnapshot?(): Promise<HizoFSApplicationSessionPort>;
  createSymlink({ name, path, target }: {
    name: string;
    path: readonly string[];
    target: string;
  }): Promise<void>;
  ensureDirectory({ name, path }: { name: string; path: readonly string[] }): Promise<void>;
  ensureFile({ name, path }: { name: string; path: readonly string[] }): Promise<void>;
  listDirectory({ path }: { path: readonly string[] }): Promise<readonly HizoFSApplicationDirectoryEntry[]>;
  listDirectoryPage?: ({ afterName, maximumEntries, path }: {
    afterName: string | undefined;
    maximumEntries: number;
    path: readonly string[];
  }) => Promise<HizoFSApplicationDirectoryPage>;
  moveEntry({ destinationPath, name, newName, path, replace }: {
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void>;
  openExplicitBulk?: ({ path }: {
    path: readonly string[];
  }) => Promise<HizoFSApplicationExplicitBulkBuilder>;
  openReadable({ path }: { path: readonly string[] }): Promise<HizoFSApplicationReadableFile>;
  openWritable({ keepExistingData, path }: {
    keepExistingData: boolean;
    path: readonly string[];
  }): Promise<HizoFSApplicationWritableFile>;
  readlink({ path }: { path: readonly string[] }): Promise<string>;
  removeEntry({ name, path, recursive }: {
    name: string;
    path: readonly string[];
    recursive: boolean;
  }): Promise<void>;
  stat({ path }: { path: readonly string[] }): Promise<HizoFSApplicationStat>;
  sync(): Promise<void>;
}


export type HizoFSWorkerMountGrantIssuer = ({ accessMode, path }: {
  accessMode: StorageDirectoryWorkerMountAccessMode;
  path: readonly string[];
}) => Promise<StorageDirectoryWorkerMountGrant>;

const DIRECTORY_ITERATOR_PAGE_ENTRIES = 128;
const READ_STREAM_CHUNK_BYTES = 1024 * 1024;

function safeNumber({ label, value }: { label: string; value: bigint }): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} cannot be represented as a safe non-negative number`);
  }
  return Number(value);
}

function safeBigInt({ label, value }: { label: string; value: number }): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe non-negative integer`);
  }
  return BigInt(value);
}

function storageStat({ stat }: { stat: HizoFSApplicationStat }): StorageFileStat {
  const { createdAt, kind: _kind, modifiedAt, size, ...unhandled } = stat;
  unhandled satisfies Record<PropertyKey, never>;
  return {
    createdAt: createdAt === undefined ? undefined : safeNumber({ label: "createdAt", value: createdAt }),
    modifiedAt: modifiedAt === undefined ? undefined : safeNumber({ label: "modifiedAt", value: modifiedAt }),
    size: safeNumber({ label: "size", value: size }),
  };
}

function childPath({ name, path }: { name: string; path: readonly string[] }): readonly string[] {
  return [...path, name];
}

class HizoFSStorageFileHandle implements StorageFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  private readonly owner: HizoFSStorageFileSystemSession;
  private readonly path: readonly string[];

  constructor({ name, owner, path }: {
    name: string;
    owner: HizoFSStorageFileSystemSession;
    path: readonly string[];
  }) {
    this.name = name;
    this.owner = owner;
    this.path = [...path];
  }

  async stat(): Promise<StorageFileStat> {
    return await this.owner.statExpected({ expectedKind: "file", path: this.path });
  }

  async openReadable({ mimeType }: { mimeType: string }): Promise<StorageBinaryObjectReadHandle> {
    const owner = this.owner;
    let closed = false;
    let releaseResource: () => void = () => undefined;
    const resource = await owner.runOperation({ operation: async () => {
      const readable = await owner.port.openReadable({ path: [...this.path] });
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await readable.close();
        } finally {
          releaseResource();
        }
      };
      releaseResource = owner.registerAdmittedResource({ dispose: close });
      return { close, readable };
    }});
    const { close: closeReadable, readable } = resource;
    const size = safeNumber({ label: "file size", value: readable.size });
    const ensureOpen = () => {
      if (closed) throw new Error("HizoFS readable handle is closed");
      owner.assertOpen();
    };
    return {
      backing: { type: "reader_only" },
      mimeType,
      size,
      async close() {
        await closeReadable();
      },
      async read({ buffer, length, offset, position, signal }) {
        ensureOpen();
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
          throw new RangeError("buffer offset and length must be safe non-negative integers");
        }
        if (offset > buffer.byteLength || length > buffer.byteLength - offset) {
          throw new RangeError("read destination range exceeds the supplied buffer");
        }
        const bytes = await owner.runOperation({ operation: async () => {
          return await readable.read({
            length: safeBigInt({ label: "read length", value: length }),
            offset: safeBigInt({ label: "read position", value: position }),
            signal,
          });
        }});
        signal?.throwIfAborted();
        const bytesRead = Math.min(length, bytes.byteLength);
        buffer.set(bytes.subarray(0, bytesRead), offset);
        return { bytesRead };
      },
      stream({ end, signal, start }) {
        ensureOpen();
        const startOffset = safeBigInt({ label: "stream start", value: start });
        const endOffset = end === undefined
          ? readable.size
          : safeBigInt({ label: "stream end", value: end });
        if (endOffset < startOffset) throw new RangeError("stream end precedes stream start");
        let offset = startOffset;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              signal?.throwIfAborted();
              if (offset >= endOffset) {
                controller.close();
                return;
              }
              const remaining = endOffset - offset;
              const length = remaining < BigInt(READ_STREAM_CHUNK_BYTES)
                ? remaining
                : BigInt(READ_STREAM_CHUNK_BYTES);
              const bytes = await owner.runOperation({ operation: async () => {
                return await readable.read({ length, offset, signal });
              }});
              signal?.throwIfAborted();
              if (bytes.byteLength === 0) {
                controller.close();
                return;
              }
              const bounded = bytes.byteLength > Number(length)
                ? bytes.subarray(0, Number(length))
                : bytes;
              offset += BigInt(bounded.byteLength);
              controller.enqueue(bounded.slice());
            } catch (cause: unknown) {
              controller.error(cause);
            }
          },
        });
      },
    };
  }

  async createWritable({ keepExistingData }: { keepExistingData: boolean }): Promise<StorageWritableFile> {
    const owner = this.owner;
    const releaseWriter = owner.reserveWriter({ path: this.path });
    let state: "aborted" | "committed" | "open" = "open";
    let releaseResource: () => void = () => undefined;
    let resource: {
      abort({ reason }: { reason: unknown }): Promise<void>;
      writable: HizoFSApplicationWritableFile;
    };
    try {
      resource = await owner.runOperation({ operation: async () => {
        const writable = await owner.port.openWritable({
          keepExistingData,
          path: [...this.path],
        });
        const abort = async ({ reason }: { reason: unknown }) => {
          switch (state) {
          case "aborted":
          case "committed": return;
          case "open": break;
          default: return state satisfies never;
          }
          state = "aborted";
          try {
            await writable.abort({ reason });
          } finally {
            releaseResource();
            releaseWriter();
          }
        };
        releaseResource = owner.registerAdmittedResource({
          dispose: async () => await abort({ reason: new Error("HizoFS session closed") }),
        });
        return { abort, writable };
      }});
    } catch (cause: unknown) {
      releaseWriter();
      throw cause;
    }
    const { abort: abortWritable, writable } = resource;
    const requireOpen = () => {
      owner.assertOpen();
      switch (state) {
      case "open": return;
      case "aborted":
      case "committed": throw new Error(`HizoFS writable is already ${state}`);
      default: return state satisfies never;
      }
    };
    return {
      async abort({ reason }) {
        requireOpen();
        await owner.runOperation({ operation: async () => {
          await abortWritable({ reason });
        }});
      },
      async close() {
        requireOpen();
        state = "committed";
        try {
          await owner.runOperation({ operation: async () => {
            await writable.commit();
          }});
        } finally {
          releaseResource();
          releaseWriter();
        }
      },
      async truncate({ size }) {
        requireOpen();
        await owner.runOperation({ operation: async () => {
          await writable.truncate({ size: safeBigInt({ label: "truncate size", value: size }) });
        }});
      },
      async write({ data, position }) {
        requireOpen();
        const captured = captureFileWriteBytes({ bytes: data });
        try {
          await owner.runOperation({ operation: async () => {
            await writable.write({
              data: captured,
              position: safeBigInt({ label: "write position", value: position }),
            });
          }});
        } finally {
          captured.fill(0);
        }
      },
    };
  }

}

class HizoFSStorageSymlinkHandle implements StorageSymlinkHandle {
  readonly kind = "symlink" as const;
  readonly name: string;
  private readonly owner: HizoFSStorageFileSystemSession;
  private readonly path: readonly string[];

  constructor({ name, owner, path }: {
    name: string;
    owner: HizoFSStorageFileSystemSession;
    path: readonly string[];
  }) {
    this.name = name;
    this.owner = owner;
    this.path = [...path];
  }

  async stat(): Promise<StorageFileStat> {
    return await this.owner.statExpected({ expectedKind: "symlink", path: this.path });
  }

  async readTarget(): Promise<string> {
    return await this.owner.runOperation({ operation: async () => {
      return await this.owner.port.readlink({ path: [...this.path] });
    }});
  }
}

class HizoFSStorageDirectoryHandle implements StorageDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;
  private readonly owner: HizoFSStorageFileSystemSession;
  private readonly path: readonly string[];

  constructor({ name, owner, path }: {
    name: string;
    owner: HizoFSStorageFileSystemSession;
    path: readonly string[];
  }) {
    this.name = name;
    this.owner = owner;
    this.path = [...path];
  }

  async stat(): Promise<StorageFileStat> {
    return await this.owner.statExpected({ expectedKind: "directory", path: this.path });
  }

  async getFileHandle({ create, name }: { create: boolean; name: string }): Promise<StorageFileHandle> {
    const path = childPath({ name, path: this.path });
    await this.owner.ensureEntry({
      create,
      expectedKind: "file",
      path,
    });
    return new HizoFSStorageFileHandle({ name, owner: this.owner, path });
  }

  async getDirectoryHandle({ create, name }: { create: boolean; name: string }): Promise<StorageDirectoryHandle> {
    const path = childPath({ name, path: this.path });
    await this.owner.ensureEntry({
      create,
      expectedKind: "directory",
      path,
    });
    return new HizoFSStorageDirectoryHandle({ name, owner: this.owner, path });
  }

  async getEntryHandle({ name }: { name: string }): Promise<StorageEntryHandle> {
    return await this.owner.entryHandle({ name, path: childPath({ name, path: this.path }) });
  }

  async *entries(): AsyncIterable<readonly [name: string, handle: StorageEntryHandle]> {
    const pagedSnapshot = await this.owner.runOperation({ operation: async () => {
      const createReadSnapshot = this.owner.port.createReadSnapshot;
      if (createReadSnapshot === undefined) return undefined;
      const port = await createReadSnapshot();
      if (port.listDirectoryPage === undefined) {
        await port.close();
        return undefined;
      }
      const unregister = this.owner.registerAdmittedResource({
        dispose: async () => await port.close(),
      });
      return { port, unregister };
    }});
    if (pagedSnapshot !== undefined) {
      try {
        let afterName: string | undefined;
        for (;;) {
          const page = await this.owner.runOperation({ operation: async () => {
            if (pagedSnapshot.port.listDirectoryPage === undefined) {
              throw new Error("HizoFS snapshot lost paged directory capability");
            }
            return await pagedSnapshot.port.listDirectoryPage({
              afterName,
              maximumEntries: DIRECTORY_ITERATOR_PAGE_ENTRIES,
              path: [...this.path],
            });
          }});
          for (const entry of page.entries) {
            this.owner.assertOpen();
            const { kind, name, ...unhandled } = entry;
            unhandled satisfies Record<PropertyKey, never>;
            yield [name, await this.owner.entryHandle({
              expectedKind: kind,
              name,
              path: childPath({ name, path: this.path }),
            })] as const;
          }
          if (!page.truncated) return;
          const last = page.entries.at(-1);
          if (last === undefined || last.name === afterName) {
            throw new Error("HizoFS paged directory listing did not advance its cursor");
          }
          afterName = last.name;
        }
      } finally {
        pagedSnapshot.unregister();
        await pagedSnapshot.port.close();
      }
    }

    const entries = await this.owner.runOperation({ operation: async () => {
      return await this.owner.port.listDirectory({ path: [...this.path] });
    }});
    for (const entry of entries) {
      this.owner.assertOpen();
      const { kind, name, ...unhandled } = entry;
      unhandled satisfies Record<PropertyKey, never>;
      yield [name, await this.owner.entryHandle({
        expectedKind: kind,
        name,
        path: childPath({ name, path: this.path }),
      })] as const;
    }
  }

  async removeEntry({ name, recursive }: { name: string; recursive: boolean }): Promise<void> {
    await this.owner.runOperation({ operation: async () => {
      await this.owner.port.removeEntry({ name, path: [...this.path], recursive });
    }});
  }

  async createSymlink({ name, target }: { name: string; target: string }): Promise<StorageSymlinkHandle> {
    await this.owner.runOperation({ operation: async () => {
      await this.owner.port.createSymlink({ name, path: [...this.path], target });
    }});
    return new HizoFSStorageSymlinkHandle({
      name,
      owner: this.owner,
      path: childPath({ name, path: this.path }),
    });
  }

  async moveEntry({ destination, name, newName, replace }: {
    destination: StorageDirectoryHandle;
    name: string;
    newName: string;
    replace: boolean;
  }): Promise<void> {
    const target = this.owner.requireOwnedDirectory({ directory: destination });
    await this.owner.runOperation({ operation: async () => {
      await this.owner.port.moveEntry({
        destinationPath: target.path,
        name,
        newName,
        path: [...this.path],
        replace,
      });
    }});
  }

  async cloneFile({ destination, name, newName, replace }: {
    destination: StorageDirectoryHandle;
    name: string;
    newName: string;
    replace: boolean;
  }): Promise<StorageFileHandle> {
    const target = this.owner.requireOwnedDirectory({ directory: destination });
    await this.owner.runOperation({ operation: async () => {
      await this.owner.port.cloneFile({
        destinationPath: target.path,
        name,
        newName,
        path: [...this.path],
        replace,
      });
    }});
    return new HizoFSStorageFileHandle({
      name: newName,
      owner: this.owner,
      path: childPath({ name: newName, path: target.path }),
    });
  }

  async createWorkerMountGrant({ accessMode }: {
    accessMode: StorageDirectoryWorkerMountAccessMode;
  }): Promise<StorageDirectoryWorkerMountGrant> {
    return await this.owner.issueWorkerMountGrant({ accessMode, path: this.path });
  }

  ownerPath({ owner }: { owner: HizoFSStorageFileSystemSession }): readonly string[] | undefined {
    return owner === this.owner ? [...this.path] : undefined;
  }
}

export class HizoFSStorageFileSystemSession implements StorageFileSystemSession {
  readonly capabilities = {
    atomicMove: "supported",
    directBlob: "unsupported",
    symbolicLink: "supported",
    wholeFileClone: "supported",
  } as const;
  readonly port: HizoFSApplicationSessionPort;
  readonly root: StorageDirectoryHandle;
  private readonly activeWriterPaths = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly resources = new Set<{ dispose(): Promise<void> }>();
  private readonly workerMountGrantIssuer: HizoFSWorkerMountGrantIssuer | undefined;
  private closePromise: Promise<void> | undefined;
  private inFlightOperations = 0;
  private state: "closed" | "closing" | "open" = "open";

  constructor({ port, rootName = "", rootPath = [], workerMountGrantIssuer }: {
    port: HizoFSApplicationSessionPort;
    rootName?: string;
    rootPath?: readonly string[];
    workerMountGrantIssuer?: HizoFSWorkerMountGrantIssuer;
  }) {
    this.port = port;
    this.workerMountGrantIssuer = workerMountGrantIssuer;
    this.root = new HizoFSStorageDirectoryHandle({ name: rootName, owner: this, path: rootPath });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    await this.closePromise;
  }

  async sync(): Promise<void> {
    switch (this.state) {
    case "open": break;
    case "closed":
    case "closing": throw createStorageFileSystemSyncError({
      code: "session_closed",
      implementation: "hizofs",
      message: "HizoFS application session is closed",
      retryable: false,
    });
    default: return this.state satisfies never;
    }
    await this.runOperation({ operation: async () => await this.port.sync() });
  }

  async createReadSnapshot(): Promise<StorageFileSystemSession> {
    if (this.port.createReadSnapshot === undefined) {
      throw new Error("HizoFS application session does not support stable read snapshots");
    }
    const port = await this.runOperation({ operation: async () => {
      return await this.port.createReadSnapshot?.();
    }});
    if (port === undefined) throw new Error("HizoFS application session does not support stable read snapshots");
    const root = this.requireOwnedDirectory({ directory: this.root });
    return new HizoFSStorageFileSystemSession({
      port,
      rootName: this.root.name,
      rootPath: root.path,
    });
  }

  assertOpen(): void {
    switch (this.state) {
    case "open": return;
    case "closed":
    case "closing": throw new Error("HizoFS application session is closed");
    default: return this.state satisfies never;
    }
  }

  registerAdmittedResource({ dispose }: { dispose: () => Promise<void> }): () => void {
    const resource = { dispose };
    this.resources.add(resource);
    return () => this.resources.delete(resource);
  }

  async issueWorkerMountGrant({ accessMode, path }: {
    accessMode: StorageDirectoryWorkerMountAccessMode;
    path: readonly string[];
  }): Promise<StorageDirectoryWorkerMountGrant> {
    this.assertOpen();
    if (this.workerMountGrantIssuer === undefined) {
      throw new Error("HizoFS session does not support Worker-local mount grants");
    }
    return await this.runOperation({
      operation: async () => await this.workerMountGrantIssuer?.({ accessMode, path: [...path] })
        ?? Promise.reject(new Error("HizoFS Worker mount grant issuer disappeared")),
    });
  }

  reserveWriter({ path }: { path: readonly string[] }): () => void {
    this.assertOpen();
    const key = JSON.stringify(path);
    if (this.activeWriterPaths.has(key)) {
      throw new Error(`HizoFS file already has an active writer: ${path.join("/") || "/"}`);
    }
    this.activeWriterPaths.add(key);
    return () => this.activeWriterPaths.delete(key);
  }

  async runOperation<Value>({ operation }: {
    operation: () => Promise<Value>;
  }): Promise<Value> {
    this.assertOpen();
    this.inFlightOperations += 1;
    try {
      return await operation();
    } finally {
      this.inFlightOperations -= 1;
      if (this.inFlightOperations === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  async ensureEntry({ create, expectedKind, path }: {
    create: boolean;
    expectedKind: "directory" | "file";
    path: readonly string[];
  }): Promise<void> {
    if (!create) {
      await this.statExpected({ expectedKind, path });
      return;
    }
    const parentPath = path.slice(0, -1);
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("cannot create the HizoFS root entry");
    await this.runOperation({ operation: async () => {
      switch (expectedKind) {
      case "directory": await this.port.ensureDirectory({ name, path: parentPath }); return;
      case "file": await this.port.ensureFile({ name, path: parentPath }); return;
      default: return expectedKind satisfies never;
      }
    }});
    // The writer may have crossed its durability point before close won the
    // public capability-return race. Preserve the completed mutation, but do
    // not hand a new entry handle to an application after closing began.
    this.assertOpen();
  }

  async statExpected({ expectedKind, path }: {
    expectedKind: HizoFSApplicationEntryKind;
    path: readonly string[];
  }): Promise<StorageFileStat> {
    const stat = await this.runOperation({ operation: async () => {
      return await this.port.stat({ path: [...path] });
    }});
    if (stat.kind !== expectedKind) {
      throw new TypeError(`Expected ${expectedKind} at ${path.join("/") || "/"}, found ${stat.kind}`);
    }
    return storageStat({ stat });
  }

  async entryHandle({ expectedKind, name, path }: {
    expectedKind?: HizoFSApplicationEntryKind;
    name: string;
    path: readonly string[];
  }): Promise<StorageEntryHandle> {
    const kind = expectedKind ?? (await this.runOperation({ operation: async () => {
      return await this.port.stat({ path: [...path] });
    }})).kind;
    switch (kind) {
    case "directory": return new HizoFSStorageDirectoryHandle({ name, owner: this, path });
    case "file": return new HizoFSStorageFileHandle({ name, owner: this, path });
    case "symlink": return new HizoFSStorageSymlinkHandle({ name, owner: this, path });
    default: return kind satisfies never;
    }
  }

  requireOwnedDirectory({ directory }: {
    directory: StorageDirectoryHandle;
  }): { readonly path: readonly string[] } {
    if (!(directory instanceof HizoFSStorageDirectoryHandle)) {
      throw new TypeError("destination directory belongs to another filesystem implementation");
    }
    const path = directory.ownerPath({ owner: this });
    if (path === undefined) {
      throw new TypeError("destination directory belongs to another HizoFS session");
    }
    return { path };
  }

  private async closeInternal(): Promise<void> {
    switch (this.state) {
    case "closed": return;
    case "closing": break;
    case "open": this.state = "closing"; break;
    default: return this.state satisfies never;
    }
    if (this.inFlightOperations !== 0) {
      await new Promise<void>(resolve => this.idleWaiters.add(resolve));
    }
    const failures: unknown[] = [];
    for (const resource of [...this.resources]) {
      try {
        await resource.dispose();
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    try {
      await this.port.close();
    } catch (cause: unknown) {
      failures.push(cause);
    } finally {
      this.resources.clear();
      this.activeWriterPaths.clear();
      this.state = "closed";
    }
    if (failures.length !== 0) {
      throw new AggregateError(failures, "Failed to close HizoFS application session");
    }
  }
}

export function createHizoFSStorageFileSystemSession({
  port,
  rootName,
  rootPath,
  workerMountGrantIssuer,
}: {
  port: HizoFSApplicationSessionPort;
  rootName?: string;
  rootPath?: readonly string[];
  workerMountGrantIssuer?: HizoFSWorkerMountGrantIssuer;
}): StorageFileSystemSession {
  return new HizoFSStorageFileSystemSession({ port, rootName, rootPath, workerMountGrantIssuer });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  safeNumber,
  storageStat,
};
