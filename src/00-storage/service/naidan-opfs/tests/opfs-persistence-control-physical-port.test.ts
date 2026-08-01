import { describe, expect, it, vi } from "vitest";
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from "@/00-storage/service/naidan-persistence-control/00-format";
import { createOpfsPersistenceControlPhysicalPort } from "@/00-storage/service/naidan-opfs/opfs-persistence-control-readable-port";
import type { NaidanPersistenceControlExclusiveGate } from "@/00-storage/service/naidan-opfs/opfs-transition-progress-physical-port";

function notFound({ message }: { message: string }): Error {
  const error = new Error(message);
  error.name = "NotFoundError";
  return error;
}

class MemoryFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  bytes = new Uint8Array();
  aborts = 0;
  failWrite: unknown | undefined;

  constructor({ name }: { name: string }) {
    this.name = name;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let staged = new Uint8Array();
    return {
      abort: async () => {
        this.aborts += 1;
      },
      close: async () => {
        this.bytes = staged;
      },
      write: async value => {
        if (this.failWrite !== undefined) throw this.failWrite;
        if (!(value instanceof Uint8Array)) throw new TypeError("test writable accepts only Uint8Array");
        staged = Uint8Array.from(value);
      },
    } as unknown as FileSystemWritableFileStream;
  }

  async getFile(): Promise<File> {
    const snapshot = this.bytes.slice();
    return {
      arrayBuffer: async () => snapshot.buffer.slice(
        snapshot.byteOffset,
        snapshot.byteOffset + snapshot.byteLength,
      ),
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
    const create = options?.create ?? false;
    this.directoryRequests.push([name, create]);
    let directory = this.directories.get(name);
    if (directory === undefined && create) {
      directory = new MemoryDirectoryHandle({ name });
      this.directories.set(name, directory);
    }
    if (directory === undefined) throw notFound({ message: `missing directory: ${name}` });
    return directory as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    const create = options?.create ?? false;
    this.fileRequests.push([name, create]);
    let file = this.files.get(name);
    if (file === undefined && create) {
      file = new MemoryFileHandle({ name });
      this.files.set(name, file);
    }
    if (file === undefined) throw notFound({ message: `missing file: ${name}` });
    return file as unknown as FileSystemFileHandle;
  }
}

function exclusiveGate(): NaidanPersistenceControlExclusiveGate & { calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn();
  return {
    calls,
    async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
      calls();
      return await operation();
    },
  };
}

describe("native OPFS Persistence Control physical port", () => {
  it("publishes exact fixed paths and shares the owner exclusive gate", async () => {
    const root = new MemoryDirectoryHandle({ name: "root" });
    const gate = exclusiveGate();
    const physical = createOpfsPersistenceControlPhysicalPort({
      exclusiveGate: gate,
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });

    await physical.runExclusive({
      operation: async () => await physical.publishWholeFileDurably({ bytes: Uint8Array.of(1, 2, 3), copy: 1 }),
    });

    const storage = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage;
    const collection = root.directories.get(storage.collectionDirectoryName);
    expect(gate.calls).toHaveBeenCalledTimes(1);
    expect(root.directoryRequests).toEqual([[storage.collectionDirectoryName, true]]);
    expect(collection?.fileRequests).toEqual([[storage.controlFiles[1], true]]);
    await expect(physical.readFileBounded({ copy: 1, maximumByteLength: 3 }))
      .resolves.toEqual(Uint8Array.of(1, 2, 3));
  });

  it("aborts failed writes while preserving the primary error", async () => {
    const root = new MemoryDirectoryHandle({ name: "root" });
    const gate = exclusiveGate();
    const physical = createOpfsPersistenceControlPhysicalPort({
      exclusiveGate: gate,
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });
    const storage = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage;
    const collection = new MemoryDirectoryHandle({ name: storage.collectionDirectoryName });
    const file = new MemoryFileHandle({ name: storage.controlFiles[0] });
    const failure = new Error("write failed");
    file.failWrite = failure;
    collection.files.set(file.name, file);
    root.directories.set(collection.name, collection);

    await expect(physical.publishWholeFileDurably({ bytes: Uint8Array.of(9), copy: 0 }))
      .rejects.toBe(failure);
    expect(file.aborts).toBe(1);
  });
});
