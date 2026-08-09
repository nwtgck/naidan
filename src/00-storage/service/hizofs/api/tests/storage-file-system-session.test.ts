import { describe, expect, it, vi } from "vitest";

import {
  createHizoFSStorageFileSystemSession,
  type HizoFSApplicationSessionPort,
  type HizoFSApplicationStat,
} from "@/00-storage/service/hizofs/api/storage-file-system-session";

function key({ path }: { path: readonly string[] }): string {
  return path.join("/");
}

function stat({ kind, size = 0n }: {
  kind: HizoFSApplicationStat["kind"];
  size?: bigint;
}): HizoFSApplicationStat {
  return { createdAt: 10n, kind, modifiedAt: 20n, size };
}

function createPort(): HizoFSApplicationSessionPort & {
  readonly calls: Array<readonly [string, unknown]>;
  readonly stats: Map<string, HizoFSApplicationStat>;
  } {
  const calls: Array<readonly [string, unknown]> = [];
  const stats = new Map<string, HizoFSApplicationStat>([
    ["", stat({ kind: "directory" })],
    ["file", stat({ kind: "file", size: 4n })],
    ["directory", stat({ kind: "directory" })],
    ["link", stat({ kind: "symlink", size: 6n })],
  ]);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    calls,
    stats,
    async cloneFile(request) {
      calls.push(["cloneFile", request]);
      stats.set(key({ path: [...request.destinationPath, request.newName] }), stat({ kind: "file", size: 4n }));
    },
    async close() {
      calls.push(["close", undefined]);
    },
    async createDirectory(request) {
      calls.push(["createDirectory", request]);
      stats.set(key({ path: [...request.path, request.name] }), stat({ kind: "directory" }));
    },
    async createFile(request) {
      calls.push(["createFile", request]);
      stats.set(key({ path: [...request.path, request.name] }), stat({ kind: "file" }));
    },
    async createReadSnapshot() {
      calls.push(["createReadSnapshot", undefined]);
      return createPort();
    },
    async createSymlink(request) {
      calls.push(["createSymlink", request]);
      stats.set(key({ path: [...request.path, request.name] }), stat({ kind: "symlink", size: BigInt(request.target.length) }));
    },
    async ensureDirectory(request) {
      calls.push(["ensureDirectory", request]);
      const destination = key({ path: [...request.path, request.name] });
      const existing = stats.get(destination);
      if (existing === undefined) {
        stats.set(destination, stat({ kind: "directory" }));
        return;
      }
      if (existing.kind !== "directory") {
        throw new TypeError(`Expected directory at ${destination}, found ${existing.kind}`);
      }
    },
    async ensureFile(request) {
      calls.push(["ensureFile", request]);
      const destination = key({ path: [...request.path, request.name] });
      const existing = stats.get(destination);
      if (existing === undefined) {
        stats.set(destination, stat({ kind: "file" }));
        return;
      }
      if (existing.kind !== "file") {
        throw new TypeError(`Expected file at ${destination}, found ${existing.kind}`);
      }
    },
    async listDirectory({ path }) {
      calls.push(["listDirectory", [...path]]);
      return [
        { kind: "directory", name: "directory" },
        { kind: "file", name: "file" },
        { kind: "symlink", name: "link" },
      ];
    },
    async moveEntry(request) {
      calls.push(["moveEntry", request]);
    },
    async openReadable({ path }) {
      calls.push(["openReadable", [...path]]);
      return {
        size: BigInt(bytes.byteLength),
        async close() {
          calls.push(["closeReadable", undefined]);
        },
        async read({ length, offset, signal }) {
          signal?.throwIfAborted();
          const start = Number(offset);
          return bytes.slice(start, start + Number(length));
        },
      };
    },
    async openWritable(request) {
      calls.push(["openWritable", request]);
      return {
        async abort({ reason }) {
          calls.push(["abortWritable", reason]);
        },
        async commit() {
          calls.push(["commitWritable", undefined]);
        },
        async truncate({ size }) {
          calls.push(["truncateWritable", size]);
        },
        async write({ data, position }) {
          calls.push(["writeWritable", { data: [...data], position }]);
        },
      };
    },
    async readlink({ path }) {
      calls.push(["readlink", [...path]]);
      return "target";
    },
    async removeEntry(request) {
      calls.push(["removeEntry", request]);
    },
    async sync() {
      calls.push(["sync", undefined]);
    },
    async stat({ path }) {
      calls.push(["stat", [...path]]);
      const value = stats.get(key({ path }));
      if (value === undefined) throw new DOMException("missing", "NotFoundError");
      return value;
    },
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  } {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

describe("HizoFS StorageFileSystemSession adapter", () => {
  it("projects safe bigint stat fields and rejects lossy numbers", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });

    await expect(session.root.getFileHandle({ create: false, name: "file" }).then(file => file.stat()))
      .resolves.toEqual({ createdAt: 10, modifiedAt: 20, size: 4 });

    port.stats.set("file", stat({ kind: "file", size: BigInt(Number.MAX_SAFE_INTEGER) + 1n }));
    await expect(session.root.getFileHandle({ create: false, name: "file" }))
      .rejects.toThrow("cannot be represented as a safe non-negative number");
  });

  it("preserves entry kinds and immutable logical paths", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const entries = [];
    for await (const [name, handle] of session.root.entries()) entries.push([name, handle.kind]);

    expect(entries).toEqual([
      ["directory", "directory"],
      ["file", "file"],
      ["link", "symlink"],
    ]);
    await expect((await session.root.getEntryHandle({ name: "link" })).kind).toBe("symlink");
  });

  it("returns existing entries for create-if-missing requests without mutating", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });

    await expect(session.root.getFileHandle({ create: true, name: "file" }))
      .resolves.toMatchObject({ kind: "file", name: "file" });
    await expect(session.root.getDirectoryHandle({ create: true, name: "directory" }))
      .resolves.toMatchObject({ kind: "directory", name: "directory" });

    expect(port.calls.filter(([name]) => name === "ensureFile")).toHaveLength(1);
    expect(port.calls.filter(([name]) => name === "ensureDirectory")).toHaveLength(1);
    expect(port.calls.some(([name]) => name === "stat")).toBe(false);
  });

  it("delegates create-if-missing atomically without a separate stat", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    port.stats.delete("new-file");

    await expect(session.root.getFileHandle({ create: true, name: "new-file" }))
      .resolves.toMatchObject({ kind: "file", name: "new-file" });

    expect(port.calls.filter(([name]) => name === "stat")).toHaveLength(0);
    expect(port.calls.filter(([name]) => name === "ensureFile")).toEqual([
      ["ensureFile", { name: "new-file", path: [] }],
    ]);
  });

  it("rejects a create-if-missing request when the atomic ensure observes the wrong kind", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    port.stats.set("raced", stat({ kind: "directory" }));

    await expect(session.root.getFileHandle({ create: true, name: "raced" }))
      .rejects.toThrow("Expected file at raced, found directory");
    expect(port.calls.filter(([name]) => name === "stat")).toHaveLength(0);
  });

  it("does not hide an atomic ensure failure", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const creationFailure = new Error("create failed");
    port.ensureFile = async () => {
      throw creationFailure;
    };

    await expect(session.root.getFileHandle({ create: true, name: "missing" }))
      .rejects.toBe(creationFailure);
  });

  it("routes bounded reads and streams without exposing a direct Blob", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    const buffer = new Uint8Array(6);

    await expect(readable.read({ buffer, length: 3, offset: 1, position: 1, signal: undefined }))
      .resolves.toEqual({ bytesRead: 3 });
    expect([...buffer]).toEqual([0, 2, 3, 4, 0, 0]);
    expect(readable.backing).toEqual({ type: "reader_only" });
    expect([...new Uint8Array(await new Response(readable.stream({ start: 1, end: 3, signal: undefined })).arrayBuffer())])
      .toEqual([2, 3]);
    await readable.close();
  });

  it("copies mutable write input and enforces one terminal writer action", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    const writable = await file.createWritable({ keepExistingData: true });
    const data = new Uint8Array([7, 8]);
    const write = writable.write({ data, position: 2 });
    data.fill(0);
    await write;
    await writable.truncate({ size: 9 });
    await writable.close();

    expect(port.calls).toContainEqual(["writeWritable", { data: [7, 8], position: 2n }]);
    expect(port.calls).toContainEqual(["truncateWritable", 9n]);
    await expect(writable.abort({ reason: "late" })).rejects.toThrow("already committed");
  });

  it("routes mutations but rejects cross-session destination handles", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const directory = await session.root.getDirectoryHandle({ create: false, name: "directory" });
    await session.root.moveEntry({ destination: directory, name: "file", newName: "moved", replace: false });
    await session.root.cloneFile({ destination: directory, name: "file", newName: "clone", replace: false });
    await session.root.createSymlink({ name: "new-link", target: "destination" });
    await session.root.removeEntry({ name: "new-link", recursive: false });

    expect(port.calls.some(([name]) => name === "moveEntry")).toBe(true);
    expect(port.calls.some(([name]) => name === "cloneFile")).toBe(true);

    const other = createHizoFSStorageFileSystemSession({ port: createPort() });
    await expect(session.root.moveEntry({
      destination: other.root,
      name: "file",
      newName: "moved",
      replace: false,
    })).rejects.toThrow("another HizoFS session");
  });

  it("creates an independent read snapshot session and closes through its port", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port, rootName: "root" });
    const snapshot = await session.createReadSnapshot?.();
    expect(snapshot?.root.name).toBe("root");
    await session.close();
    expect(port.calls).toContainEqual(["createReadSnapshot", undefined]);
    expect(port.calls).toContainEqual(["close", undefined]);
  });

  it("allows only one writer per file until the writer reaches a terminal state", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    const first = await file.createWritable({ keepExistingData: true });

    await expect(file.createWritable({ keepExistingData: false }))
      .rejects.toThrow("already has an active writer");

    await first.abort({ reason: "cancelled" });
    const second = await file.createWritable({ keepExistingData: false });
    await second.close();

    expect(port.calls.filter(([name]) => name === "openWritable")).toHaveLength(2);
  });

  it("revokes stale handles and disposes open resources before closing the port", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    const writable = await file.createWritable({ keepExistingData: true });

    await session.close();

    expect(port.calls).toContainEqual(["closeReadable", undefined]);
    expect(port.calls.some(([name]) => name === "abortWritable")).toBe(true);
    expect(port.calls.at(-1)).toEqual(["close", undefined]);
    await expect(file.stat()).rejects.toThrow("session is closed");
    await expect(readable.read({
      buffer: new Uint8Array(1),
      length: 1,
      offset: 0,
      position: 0,
      signal: undefined,
    })).rejects.toThrow("is closed");
    await expect(writable.write({ data: new Uint8Array([1]), position: 0 }))
      .rejects.toThrow("session is closed");
  });

  it("linearizes close after an operation already admitted by the session", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    const pendingStat = deferred<HizoFSApplicationStat>();
    port.stat = async () => await pendingStat.promise;

    const statPromise = file.stat();
    await Promise.resolve();
    const closePromise = session.close();

    expect(port.calls.some(([name]) => name === "close")).toBe(false);
    await expect(session.root.getEntryHandle({ name: "file" }))
      .rejects.toThrow("session is closed");

    pendingStat.resolve(stat({ kind: "file", size: 4n }));
    await expect(statPromise).resolves.toEqual({ createdAt: 10, modifiedAt: 20, size: 4 });
    await closePromise;
    expect(port.calls.at(-1)).toEqual(["close", undefined]);
  });

  it("registers a writer opened during close before disposing session resources", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    const pendingWritable = deferred<Awaited<ReturnType<HizoFSApplicationSessionPort["openWritable"]>>>();
    port.openWritable = async () => await pendingWritable.promise;

    const opening = file.createWritable({ keepExistingData: true });
    await Promise.resolve();
    const closing = session.close();
    const calls: string[] = [];
    pendingWritable.resolve({
      async abort() {
        calls.push("abort");
      },
      async commit() {
        calls.push("commit");
      },
      async truncate() {
        calls.push("truncate");
      },
      async write() {
        calls.push("write");
      },
    });

    await opening;
    await closing;

    expect(calls).toEqual(["abort"]);
    expect(port.calls.at(-1)).toEqual(["close", undefined]);
  });

  it("aggregates close failures without disposing the same authority twice", async () => {
    const port = createPort();
    const abort = vi.fn(async () => {
      throw new Error("abort failed");
    });
    const close = vi.fn(async () => {
      throw new Error("port close failed");
    });
    port.openWritable = async () => ({
      abort,
      async commit() {
        throw new Error("unexpected commit");
      },
      async truncate() {
        throw new Error("unexpected truncate");
      },
      async write() {
        throw new Error("unexpected write");
      },
    });
    port.close = close;
    const session = createHizoFSStorageFileSystemSession({ port });
    const file = await session.root.getFileHandle({ create: false, name: "file" });
    await file.createWritable({ keepExistingData: true });

    const firstClose = session.close();
    await expect(firstClose).rejects.toSatisfy((error: unknown) => {
      return error instanceof AggregateError
        && error.errors.map(value => value instanceof Error ? value.message : String(value)).join(",")
          === "abort failed,port close failed";
    });
    await expect(session.close()).rejects.toBeInstanceOf(AggregateError);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(file.stat()).rejects.toThrow("session is closed");
  });

  it("forwards filesystem-wide sync through the open session", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });

    await session.sync();

    expect(port.calls).toContainEqual(["sync", undefined]);
  });

  it("waits for an admitted sync before closing and rejects later sync calls", async () => {
    const port = createPort();
    const session = createHizoFSStorageFileSystemSession({ port });
    const pendingSync = deferred<void>();
    port.sync = async () => {
      port.calls.push(["sync-start", undefined]);
      await pendingSync.promise;
      port.calls.push(["sync-finish", undefined]);
    };

    const syncing = session.sync();
    await Promise.resolve();
    const closing = session.close();

    expect(port.calls).toContainEqual(["sync-start", undefined]);
    expect(port.calls.some(([name]) => name === "close")).toBe(false);
    await expect(session.sync()).rejects.toMatchObject({
      code: "session_closed",
      implementation: "hizofs",
      retryable: false,
    });

    pendingSync.resolve(undefined);
    await syncing;
    await closing;
    expect(port.calls.slice(-2)).toEqual([
      ["sync-finish", undefined],
      ["close", undefined],
    ]);
  });
});
