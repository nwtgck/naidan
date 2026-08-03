import { describe, expect, it } from "vitest";
import { hasCrashDurableWritableSemantics } from "@/00-storage/service/hizofs/physical-store/backend";
import { canonicalContainerDirectory, canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { OpfsWritableBackend } from "@/00-storage/service/hizofs/physical-store/opfs/opfs-writable-backend";

declare const authenticatedBytesBrand: unique symbol;
type AuthenticatedBytes = Uint8Array & { readonly [authenticatedBytesBrand]: true };

type TestEntry = TestDirectoryHandle | TestFileHandle;

class TestSyncAccessHandle {
  public closed = false;
  public flushCount = 0;
  public maximumWriteLength = Number.POSITIVE_INFINITY;

  public constructor(private readonly file: TestFileHandle) {}

  public close(): void {
    this.closed = true;
    this.file.open = false;
  }

  public flush(): void {
    this.#requireOpen();
    this.flushCount += 1;
  }

  public getSize(): number {
    this.#requireOpen();
    return this.file.bytes.byteLength;
  }

  public read(buffer: ArrayBufferView, options?: { at?: number }): number {
    this.#requireOpen();
    const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const at = options?.at ?? 0;
    const available = Math.max(0, Math.min(target.byteLength, this.file.bytes.byteLength - at));
    target.set(this.file.bytes.subarray(at, at + available));
    return available;
  }

  public truncate(newSize: number): void {
    this.#requireOpen();
    const next = new Uint8Array(newSize);
    next.set(this.file.bytes.subarray(0, newSize));
    this.file.bytes = next;
  }

  public write(buffer: ArrayBufferView, options?: { at?: number }): number {
    this.#requireOpen();
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const written = Math.min(source.byteLength, this.maximumWriteLength);
    const at = options?.at ?? 0;
    const required = at + written;
    if (required > this.file.bytes.byteLength) {
      const next = new Uint8Array(required);
      next.set(this.file.bytes);
      this.file.bytes = next;
    }
    this.file.bytes.set(source.subarray(0, written), at);
    return written;
  }

  #requireOpen(): void {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
  }
}

class TestWritableStream {
  public constructor({ file, keepExistingData }: {
    file: TestFileHandle;
    keepExistingData: boolean;
  }) {
    this.file = file;
    this.draft = keepExistingData ? Uint8Array.from(file.bytes) : new Uint8Array();
  }

  private readonly file: TestFileHandle;
  private draft: Uint8Array;
  private settled = false;

  public async abort(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.file.writableOpen = false;
    this.file.writableAbortCount += 1;
  }

  public async close(): Promise<void> {
    this.#requireOpen();
    this.settled = true;
    this.file.bytes = Uint8Array.from(this.draft);
    this.file.writableOpen = false;
    this.file.writableCloseCount += 1;
  }

  public async truncate(size: number): Promise<void> {
    this.#requireOpen();
    const next = new Uint8Array(size);
    next.set(this.draft.subarray(0, size));
    this.draft = next;
  }

  public async write({ data, position, type }: {
    data: BufferSource;
    position: number;
    type: 'write';
  }): Promise<void> {
    this.#requireOpen();
    expect(type).toBe('write');
    const source = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const required = position + source.byteLength;
    if (required > this.draft.byteLength) {
      const next = new Uint8Array(required);
      next.set(this.draft);
      this.draft = next;
    }
    this.draft.set(source, position);
  }

  #requireOpen(): void {
    if (this.settled) throw new DOMException('settled', 'InvalidStateError');
  }
}

class TestFileHandle {
  public readonly kind = "file" as const;
  public bytes = new Uint8Array();
  public getFileCount = 0;
  public open = false;
  public readonly sync = new TestSyncAccessHandle(this);
  public writableAbortCount = 0;
  public writableAvailable = true;
  public writableCloseCount = 0;
  public writableCreateCount = 0;
  public writableOpen = false;

  public constructor(public readonly name: string, public syncAccessAvailable = true) {}

  public async createSyncAccessHandle(): Promise<TestSyncAccessHandle> {
    if (!this.syncAccessAvailable) throw new DOMException("sync access unavailable", "NotSupportedError");
    if (this.open) throw new DOMException("already open", "InvalidStateError");
    this.open = true;
    this.sync.closed = false;
    return this.sync;
  }

  public async createWritable({ keepExistingData = false }: {
    keepExistingData?: boolean;
  } = {}): Promise<TestWritableStream> {
    if (!this.writableAvailable) throw new DOMException('writable stream unavailable', 'NotSupportedError');
    if (this.open || this.writableOpen) throw new DOMException('already open', 'InvalidStateError');
    this.writableOpen = true;
    this.writableCreateCount += 1;
    return new TestWritableStream({ file: this, keepExistingData });
  }

  public async getFile(): Promise<File> {
    this.getFileCount += 1;
    const snapshot = Uint8Array.from(this.bytes);
    return {
      size: snapshot.byteLength,
      arrayBuffer: async () => snapshot.buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength),
      slice: (start?: number, end?: number) => {
        const part = snapshot.slice(start, end);
        return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) } as Blob;
      },
    } as File;
  }
}

class TestDirectoryHandle {
  public readonly kind = "directory" as const;
  public entriesReadCount = 0;
  readonly #entries = new Map<string, TestEntry>();
  readonly #stats: { directoryHandleLookups: number };

  public constructor(
    public readonly name: string,
    stats: { directoryHandleLookups: number } = { directoryHandleLookups: 0 },
  ) {
    this.#stats = stats;
  }

  public get directoryHandleLookups(): number {
    return this.#stats.directoryHandleLookups;
  }

  public async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<TestDirectoryHandle> {
    this.#stats.directoryHandleLookups += 1;
    const existing = this.#entries.get(name);
    if (existing !== undefined) {
      if (existing.kind !== "directory") throw new DOMException("not a directory", "TypeMismatchError");
      return existing;
    }
    if (options?.create !== true) throw new DOMException("missing", "NotFoundError");
    const created = new TestDirectoryHandle(name, this.#stats);
    this.#entries.set(name, created);
    return created;
  }

  public async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<TestFileHandle> {
    const existing = this.#entries.get(name);
    if (existing !== undefined) {
      if (existing.kind !== "file") throw new DOMException("not a file", "TypeMismatchError");
      return existing;
    }
    if (options?.create !== true) throw new DOMException("missing", "NotFoundError");
    const created = new TestFileHandle(name);
    this.#entries.set(name, created);
    return created;
  }

  public entries(): AsyncIterableIterator<[string, TestEntry]> {
    this.entriesReadCount += 1;
    return this.#entries.entries() as unknown as AsyncIterableIterator<[string, TestEntry]>;
  }

  public async removeEntry(name: string): Promise<void> {
    if (!this.#entries.delete(name)) throw new DOMException("missing", "NotFoundError");
  }
}

function authenticatedBytes(values: readonly number[]): AuthenticatedBytes {
  return Uint8Array.from(values) as AuthenticatedBytes;
}

function createBackend(root = new TestDirectoryHandle("root")): {
  backend: OpfsWritableBackend<AuthenticatedBytes>;
  root: TestDirectoryHandle;
} {
  return {
    backend: new OpfsWritableBackend<AuthenticatedBytes>({ root: root as unknown as FileSystemDirectoryHandle }),
    root,
  };
}

describe("OPFS writable backend", () => {
  it("provisions a directory hierarchy with one prefix traversal", async () => {
    const { backend, root } = createBackend();
    const path = canonicalContainerDirectory({ value: "segments/metadata/ab" });

    await expect(backend.provisionDirectoryHierarchy({ path })).resolves.toEqual({
      parentEntriesRequiringSync: [
        canonicalContainerDirectory({ value: "" }),
        canonicalContainerDirectory({ value: "segments" }),
        canonicalContainerDirectory({ value: "segments/metadata" }),
      ],
    });
    expect(root.directoryHandleLookups).toBe(6);

    await expect(backend.provisionDirectoryHierarchy({ path })).resolves.toEqual({
      parentEntriesRequiringSync: [],
    });
    expect(root.directoryHandleLookups).toBe(9);
  });

  it("reports the exact occupied hierarchy component as not_directory", async () => {
    const { backend } = createBackend();
    const file = await backend.createFileExclusive({
      path: canonicalContainerPath({ value: "segments" }),
    });
    await backend.closeFile({ file });

    await expect(backend.provisionDirectoryHierarchy({
      path: canonicalContainerDirectory({ value: "segments/metadata/ab" }),
    })).rejects.toMatchObject({ code: "not_directory", path: "segments" });
  });

  it("performs development parent readback without claiming crash durability", async () => {
    const { backend, root } = createBackend();
    const parent = canonicalContainerDirectory({ value: "segments" });
    await expect(backend.createDirectoryExclusive({ path: parent })).resolves.toEqual({ parentEntrySyncRequired: true });
    await expect(backend.createDirectoryExclusive({ path: parent })).resolves.toEqual({ parentEntrySyncRequired: false });
    const nativeParent = await root.getDirectoryHandle("segments");

    expect(backend.capabilities).toEqual({
      directoryEntryDurability: "not-demonstrated",
      fileDataDurability: "not-demonstrated",
    });
    expect(hasCrashDurableWritableSemantics(backend)).toBe(false);
    await backend.syncDirectoryEntries({ parent });
    expect(nativeParent.entriesReadCount).toBe(1);
  });

  it("reduces a 500-file shard confirmation from 500 snapshots to one", async () => {
    const { backend, root } = createBackend();
    const parent = canonicalContainerDirectory({ value: "segments" });
    await backend.createDirectoryExclusive({ path: parent });
    const paths = Array.from({ length: 500 }, (_, index) => canonicalContainerPath({
      value: `segments/${String(index).padStart(4, "0")}.enc`,
    }));
    for (const path of paths) {
      const file = await backend.createFileExclusive({ path });
      await backend.closeFile({ file });
    }
    const nativeParent = await root.getDirectoryHandle("segments");
    const nativeFiles = await Promise.all(paths.map(async path => await nativeParent.getFileHandle(path.split("/").at(-1)!)));
    const snapshotsBeforeList = nativeFiles.reduce((total, file) => total + file.getFileCount, 0);

    await backend.syncDirectoryEntries({ parent });

    const snapshotsAfterList = nativeFiles.reduce((total, file) => total + file.getFileCount, 0);
    expect(snapshotsAfterList - snapshotsBeforeList).toBe(500);
    const entriesReadAfterList = nativeParent.entriesReadCount;
    const snapshotsBeforeExact = snapshotsAfterList;

    await backend.syncFileDirectoryEntry({ path: paths[250]! });

    const snapshotsAfterExact = nativeFiles.reduce((total, file) => total + file.getFileCount, 0);
    expect(snapshotsAfterExact - snapshotsBeforeExact).toBe(1);
    expect(nativeParent.entriesReadCount).toBe(entriesReadAfterList);
  });

  it("confirms one created file entry without enumerating sibling files", async () => {
    const { backend, root } = createBackend();
    const parent = canonicalContainerDirectory({ value: "segments" });
    const targetPath = canonicalContainerPath({ value: "segments/target.enc" });
    const siblingPath = canonicalContainerPath({ value: "segments/sibling.enc" });
    await backend.createDirectoryExclusive({ path: parent });
    const target = await backend.createFileExclusive({ path: targetPath });
    const sibling = await backend.createFileExclusive({ path: siblingPath });
    await backend.closeFile({ file: target });
    await backend.closeFile({ file: sibling });

    const nativeParent = await root.getDirectoryHandle("segments");
    const nativeTarget = await nativeParent.getFileHandle("target.enc");
    const nativeSibling = await nativeParent.getFileHandle("sibling.enc");
    const targetSnapshotsBefore = nativeTarget.getFileCount;
    const siblingSnapshotsBefore = nativeSibling.getFileCount;

    await backend.syncFileDirectoryEntry({ path: targetPath });

    expect(nativeParent.entriesReadCount).toBe(0);
    expect(nativeTarget.getFileCount).toBe(targetSnapshotsBefore + 1);
    expect(nativeSibling.getFileCount).toBe(siblingSnapshotsBefore);
    await expect(backend.syncFileDirectoryEntry({
      path: canonicalContainerPath({ value: "segments/missing.enc" }),
    })).rejects.toMatchObject({ code: "not_found" });
    await backend.createDirectoryExclusive({
      path: canonicalContainerDirectory({ value: "segments/directory" }),
    });
    await expect(backend.syncFileDirectoryEntry({
      path: canonicalContainerPath({ value: "segments/directory" }),
    })).rejects.toMatchObject({ code: "is_directory" });
  });

  it("traverses OPFS directories through bounded stateful pages", async () => {
    const { backend } = createBackend();
    const directory = canonicalContainerDirectory({ value: "segments" });
    await backend.createDirectoryExclusive({ path: directory });
    const handles = await Promise.all(["b.enc", "a.enc", "c.enc"].map(async name => await backend.createFileExclusive({
      path: canonicalContainerPath({ value: `segments/${name}` }),
    })));
    await backend.writeAt({ file: handles[0]!, offset: 0n, bytes: authenticatedBytes([1, 2, 3]) });

    const cursor = await backend.openDirectoryCursor({ directory });
    const first = await cursor.read({ maximumEntries: 2 });
    const second = await cursor.read({ maximumEntries: 2 });
    const entries = [...first.entries, ...second.entries];
    expect(first.entries).toHaveLength(2);
    expect(first.done).toBe(false);
    expect(second.done).toBe(true);
    expect(entries.map(entry => entry.name).sort()).toEqual(["a.enc", "b.enc", "c.enc"]);
    expect(entries.find(entry => entry.name === "b.enc")).toMatchObject({ byteLength: 3n, kind: "file" });
    await cursor.close();
    await cursor.close();
    await expect(cursor.read({ maximumEntries: 1 })).rejects.toThrow("closed");
    await Promise.all(handles.map(async file => await backend.closeFile({ file })));
  });

  it("supports scoped random access and explicit handle lifecycle", async () => {
    const { backend, root } = createBackend();
    const directory = canonicalContainerDirectory({ value: "segments" });
    const path = canonicalContainerPath({ value: "segments/data.enc" });
    await backend.createDirectoryExclusive({ path: directory });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({ file, offset: 2n, bytes: authenticatedBytes([7, 8, 9]) });
    await backend.truncate({ file, length: 7n });
    await backend.syncFileData({ file });
    const nativeDirectory = await root.getDirectoryHandle('segments');
    expect((await nativeDirectory.getFileHandle('data.enc')).sync.flushCount).toBe(1);
    expect(await backend.readExact({ path, offset: 0n, length: 7 })).toEqual(
      Uint8Array.from([0, 0, 7, 8, 9, 0, 0]),
    );
    const snapshotReadsBeforeCombinedOperation = (
      await nativeDirectory.getFileHandle('data.enc')
    ).getFileCount;
    await expect(backend.readExactWithFileSize({ path, offset: 2n, length: 3 }))
      .resolves.toEqual({ bytes: Uint8Array.from([7, 8, 9]), fileSize: 7n });
    expect((await nativeDirectory.getFileHandle('data.enc')).getFileCount)
      .toBe(snapshotReadsBeforeCombinedOperation + 1);
    await backend.closeFile({ file });
    await backend.closeFile({ file });
    await expect(backend.writeAt({ file, offset: 0n, bytes: authenticatedBytes([1]) }))
      .rejects.toMatchObject({ code: "closed_handle" });
  });

  it("reads two exact ranges from one immutable file snapshot", async () => {
    const { backend, root } = createBackend();
    const path = canonicalContainerPath({ value: "paired.enc" });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({
      bytes: authenticatedBytes([0, 1, 2, 3, 4, 5, 6, 7]),
      file,
      offset: 0n,
    });
    const native = await root.getFileHandle("paired.enc");

    const snapshotsBefore = native.getFileCount;
    await expect(backend.readExactPairWithFileSize({
      first: { length: 3, offset: 1n },
      path,
      second: { length: 2, offset: 5n },
    })).resolves.toEqual({
      fileSize: 8n,
      first: Uint8Array.from([1, 2, 3]),
      second: Uint8Array.from([5, 6]),
    });
    expect(native.getFileCount).toBe(snapshotsBefore + 1);

    await expect(backend.readExactPairWithFileSize({
      first: { length: 2, offset: 0n },
      path,
      second: { length: 2, offset: 7n },
    })).resolves.toEqual({
      fileSize: 8n,
      first: Uint8Array.from([0, 1]),
      second: undefined,
    });
    expect(native.getFileCount).toBe(snapshotsBefore + 2);

    await expect(backend.readExactPairWithFileSize({
      first: { length: 2, offset: 7n },
      path,
      second: { length: 1, offset: 0n },
    })).rejects.toMatchObject({ code: "unexpected_end" });
    await backend.closeFile({ file });

    await expect(backend.readExactPairWithFileSize({
      first: { length: 0, offset: 0n },
      path: canonicalContainerPath({ value: "missing.enc" }),
      second: { length: 0, offset: 0n },
    })).rejects.toMatchObject({ code: "not_found" });

    await backend.createDirectoryExclusive({ path: canonicalContainerDirectory({ value: "directory" }) });
    await expect(backend.readExactPairWithFileSize({
      first: { length: 0, offset: 0n },
      path: canonicalContainerPath({ value: "directory" }),
      second: { length: 0, offset: 0n },
    })).rejects.toMatchObject({ code: "is_directory" });
  });

  it("completes short writes without losing authenticated bytes", async () => {
    const { backend, root } = createBackend();
    const path = canonicalContainerPath({ value: "segment.enc" });
    const file = await backend.createFileExclusive({ path });
    const native = await root.getFileHandle("segment.enc");
    native.sync.maximumWriteLength = 2;
    await backend.writeAt({ file, offset: 0n, bytes: authenticatedBytes([1, 2, 3, 4, 5]) });
    expect(await backend.readFileBounded({ path, maximumByteLength: 5 })).toEqual(
      Uint8Array.from([1, 2, 3, 4, 5]),
    );
    await backend.closeFile({ file });
  });

  it("enforces exclusive creation and backend-local handle ownership", async () => {
    const first = createBackend().backend;
    const second = createBackend().backend;
    const path = canonicalContainerPath({ value: "exclusive.enc" });
    const file = await first.createFileExclusive({ path });
    await expect(first.createFileExclusive({ path })).rejects.toMatchObject({ code: "already_exists" });
    await expect(second.closeFile({ file })).rejects.toMatchObject({ code: "foreign_handle" });
    await first.closeFile({ file });
  });

  it("distinguishes missing files and rejects reads beyond the snapshot", async () => {
    const { backend } = createBackend();
    const missing = canonicalContainerPath({ value: "missing.enc" });
    const nestedMissing = canonicalContainerPath({ value: "segments/metadata/8e/missing.enc" });
    expect(await backend.getFileSize({ path: missing })).toBeUndefined();
    expect(await backend.readFileBounded({ path: missing, maximumByteLength: 0 })).toBeUndefined();
    expect(await backend.getFileSize({ path: nestedMissing })).toBeUndefined();
    expect(await backend.readFileBounded({ path: nestedMissing, maximumByteLength: 0 })).toBeUndefined();

    const path = canonicalContainerPath({ value: "short.enc" });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({ file, offset: 0n, bytes: authenticatedBytes([1, 2]) });
    await expect(backend.readExact({ path, offset: 1n, length: 2 }))
      .rejects.toMatchObject({ code: "unexpected_end" });
    await backend.closeFile({ file });
  });

  it("checks bounded size before copying whole-file bytes", async () => {
    const { backend } = createBackend();
    const path = canonicalContainerPath({ value: "large.enc" });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({ file, offset: 0n, bytes: authenticatedBytes([1, 2, 3]) });
    await expect(backend.readFileBounded({ path, maximumByteLength: 2 }))
      .rejects.toMatchObject({ code: "file_too_large" });
    await backend.closeFile({ file });
  });

  it("lists sorted physical entries and removes only closed files", async () => {
    const { backend } = createBackend();
    const directory = canonicalContainerDirectory({ value: "segments" });
    await backend.createDirectoryExclusive({ path: directory });
    const bPath = canonicalContainerPath({ value: "segments/b.enc" });
    const aPath = canonicalContainerPath({ value: "segments/a.enc" });
    const b = await backend.createFileExclusive({ path: bPath });
    const a = await backend.createFileExclusive({ path: aPath });
    await backend.writeAt({ file: b, offset: 0n, bytes: authenticatedBytes([1, 2]) });
    expect(await backend.list({ directory })).toEqual([
      { byteLength: 0n, kind: "file", name: "a.enc" },
      { byteLength: 2n, kind: "file", name: "b.enc" },
    ]);
    await expect(backend.removeFile({ path: aPath })).rejects.toMatchObject({ code: "file_open" });
    await backend.closeFile({ file: a });
    await backend.removeFile({ path: aPath });
    await backend.closeFile({ file: b });
  });

  it("falls back to committed writable-stream mutations when synchronous access is unavailable", async () => {
    const root = new TestDirectoryHandle("root");
    const native = await root.getFileHandle("unsupported.enc", { create: true });
    native.syncAccessAvailable = false;
    const { backend } = createBackend(root);
    const file = await backend.openFileForUpdate({
      path: canonicalContainerPath({ value: "unsupported.enc" }),
    });
    await backend.writeAt({ file, offset: 2n, bytes: authenticatedBytes([7, 8, 9]) });
    await backend.truncate({ file, length: 7n });
    await backend.syncFileData({ file });
    expect(native.writableCreateCount).toBe(2);
    expect(native.writableCloseCount).toBe(2);
    expect(native.writableAbortCount).toBe(0);
    expect(await backend.readExact({
      path: canonicalContainerPath({ value: "unsupported.enc" }),
      offset: 0n,
      length: 7,
    })).toEqual(Uint8Array.from([0, 0, 7, 8, 9, 0, 0]));
    const closing = backend.closeFile({ file });
    await expect(backend.writeAt({
      file,
      offset: 0n,
      bytes: authenticatedBytes([1]),
    })).rejects.toMatchObject({ code: 'closed_handle' });
    await closing;
    await backend.closeFile({ file });
  });

  it("rejects file handles without either writable OPFS access mechanism", async () => {
    const root = new TestDirectoryHandle("root");
    const native = await root.getFileHandle("unsupported.enc", { create: true });
    native.syncAccessAvailable = false;
    native.writableAvailable = false;
    const { backend } = createBackend(root);
    const file = await backend.openFileForUpdate({
      path: canonicalContainerPath({ value: "unsupported.enc" }),
    });
    await expect(backend.writeAt({
      bytes: authenticatedBytes([1]),
      file,
      offset: 0n,
    })).rejects.toMatchObject({ code: "sync_access_unavailable" });
    await backend.closeFile({ file });
  });
});
