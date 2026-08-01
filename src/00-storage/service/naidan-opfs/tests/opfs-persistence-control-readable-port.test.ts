import { describe, expect, it } from "vitest";
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from "@/00-storage/service/naidan-persistence-control/00-format";
import { createOpfsPersistenceControlReadablePhysicalPort } from "@/00-storage/service/naidan-opfs/opfs-persistence-control-readable-port";

function notFound({ message }: { message: string }): Error {
  const error = new Error(message);
  error.name = "NotFoundError";
  return error;
}

class MemoryFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  bytes: Uint8Array;
  arrayBufferReads = 0;

  constructor({ bytes, name }: { bytes: Uint8Array; name: string }) {
    this.bytes = bytes;
    this.name = name;
  }

  async getFile(): Promise<File> {
    const snapshot = new Uint8Array(this.bytes);
    return {
      arrayBuffer: async () => {
        this.arrayBufferReads += 1;
        return snapshot.buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength);
      },
      size: snapshot.byteLength,
    } as File;
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();
  readonly directoryRequests: Array<readonly [string, boolean]> = [];
  readonly fileRequests: Array<readonly [string, boolean]> = [];

  constructor({ name }: { name: string }) {
    this.name = name;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    this.directoryRequests.push([name, options?.create ?? false]);
    const directory = this.directories.get(name);
    if (directory === undefined) throw notFound({ message: `missing directory: ${name}` });
    return directory as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    this.fileRequests.push([name, options?.create ?? false]);
    const file = this.files.get(name);
    if (file === undefined) throw notFound({ message: `missing file: ${name}` });
    return file as unknown as FileSystemFileHandle;
  }
}

function fixture(): {
  collection: MemoryDirectoryHandle;
  first: MemoryFileHandle;
  root: MemoryDirectoryHandle;
  } {
  const storage = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage;
  const root = new MemoryDirectoryHandle({ name: "naidan-storage" });
  const collection = new MemoryDirectoryHandle({ name: storage.collectionDirectoryName });
  const first = new MemoryFileHandle({ bytes: Uint8Array.of(1, 2, 3), name: storage.controlFiles[0] });
  collection.files.set(first.name, first);
  root.directories.set(collection.name, collection);
  return { collection, first, root };
}

describe("native OPFS Persistence Control readable port", () => {
  it("reads exact authority paths without creating entries", async () => {
    const { collection, root } = fixture();
    const physical = createOpfsPersistenceControlReadablePhysicalPort({
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });

    await expect(physical.readFileBounded({ copy: 0, maximumByteLength: 3 }))
      .resolves.toEqual(Uint8Array.of(1, 2, 3));
    const storage = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage;
    expect(root.directoryRequests).toEqual([[storage.collectionDirectoryName, false]]);
    expect(collection.fileRequests).toEqual([[storage.controlFiles[0], false]]);
  });

  it("returns missing for absent collection or copy", async () => {
    const absentRoot = new MemoryDirectoryHandle({ name: "naidan-storage" });
    const absentPhysical = createOpfsPersistenceControlReadablePhysicalPort({
      storageRoot: absentRoot as unknown as FileSystemDirectoryHandle,
    });
    await expect(absentPhysical.readFileBounded({ copy: 0, maximumByteLength: 3 }))
      .resolves.toBeUndefined();

    const { root } = fixture();
    const physical = createOpfsPersistenceControlReadablePhysicalPort({
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });
    await expect(physical.readFileBounded({ copy: 1, maximumByteLength: 3 }))
      .resolves.toBeUndefined();
  });

  it("rejects oversized files before materializing their bytes", async () => {
    const { first, root } = fixture();
    const physical = createOpfsPersistenceControlReadablePhysicalPort({
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });

    await expect(physical.readFileBounded({ copy: 0, maximumByteLength: 2 }))
      .rejects.toThrow("exceeds the requested bounded read limit");
    expect(first.arrayBufferReads).toBe(0);
  });

  it("returns a detached snapshot", async () => {
    const { first, root } = fixture();
    const physical = createOpfsPersistenceControlReadablePhysicalPort({
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });
    const bytes = await physical.readFileBounded({ copy: 0, maximumByteLength: 3 });
    first.bytes.fill(9);
    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
  });
});
