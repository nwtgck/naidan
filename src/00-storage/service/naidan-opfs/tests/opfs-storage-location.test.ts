import { describe, expect, it, vi } from "vitest";
import { fileSystemIdToNaidanContainerToken } from "@/00-storage/service/naidan-persistence-control/00-format";
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from "@/00-storage/service/naidan-opfs/persistence-runtime-contract";
import { TEST_ONLY as WORKER_MOUNT_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/worker-mount-runtime';
import {
  NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
  naidanOpfsContainerOriginRelativePath,
  openNaidanOpfsContainerDirectory,
  removeNaidanOpfsContainerDirectory,
  reserveNaidanOpfsContainerDirectory,
} from "@/00-storage/service/naidan-opfs/opfs-storage-location";

describe("Naidan OPFS storage location", () => {
  it("derives the runtime backing path from the canonical container token", () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0001",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;

    expect(naidanOpfsContainerOriginRelativePath({ fileSystemId })).toBe(
      `${NAIDAN_OPFS_STORAGE_DIRECTORY_NAME}/${fileSystemIdToNaidanContainerToken({ id: fileSystemId })}`,
    );
  });

  it("binds a Worker grant location to its authenticated File System ID", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0003",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const containerRoot = Object.freeze({ name: "container-root" }) as unknown as FileSystemDirectoryHandle;
    const getContainerDirectory = vi.fn(async () => containerRoot);
    const nativeStorageRoot = { getDirectoryHandle: getContainerDirectory } as unknown as FileSystemDirectoryHandle;
    const getNativeStorageDirectory = vi.fn(async () => nativeStorageRoot);
    const storageRoot = { getDirectoryHandle: getNativeStorageDirectory } as unknown as FileSystemDirectoryHandle;

    await expect(WORKER_MOUNT_RUNTIME_TEST_ONLY.resolveHizoFSWorkerMountBackingDirectory({
      canonicalBackingLocation: naidanOpfsContainerOriginRelativePath({ fileSystemId }),
      fileSystemId,
      storageRoot,
    })).resolves.toBe(containerRoot);

    await expect(WORKER_MOUNT_RUNTIME_TEST_ONLY.resolveHizoFSWorkerMountBackingDirectory({
      canonicalBackingLocation: "naidan-storage/wrong-container",
      fileSystemId,
      storageRoot,
    })).rejects.toThrow("does not match its File System ID");
    expect(getNativeStorageDirectory).toHaveBeenCalledTimes(1);
  });

  it("opens only the existing native storage and container directories", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0002",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const containerRoot = Object.freeze({ name: "container-root" }) as unknown as FileSystemDirectoryHandle;
    const getContainerDirectory = vi.fn(async () => containerRoot);
    const nativeStorageRoot = {
      getDirectoryHandle: getContainerDirectory,
    } as unknown as FileSystemDirectoryHandle;
    const getNativeStorageDirectory = vi.fn(async () => nativeStorageRoot);
    const storageRoot = {
      getDirectoryHandle: getNativeStorageDirectory,
    } as unknown as FileSystemDirectoryHandle;

    await expect(openNaidanOpfsContainerDirectory({ fileSystemId, storageRoot })).resolves.toBe(containerRoot);
    expect(getNativeStorageDirectory).toHaveBeenCalledWith(
      NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
      { create: false },
    );
    expect(getContainerDirectory).toHaveBeenCalledWith(
      fileSystemIdToNaidanContainerToken({ id: fileSystemId }),
      { create: false },
    );
  });

  it("idempotently removes only the exact container directory under the shared gate", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0006",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const removeEntry = vi.fn(async () => undefined);
    const nativeStorageRoot = { removeEntry } as unknown as FileSystemDirectoryHandle;
    const storageRoot = {
      getDirectoryHandle: vi.fn(async () => nativeStorageRoot),
    } as unknown as FileSystemDirectoryHandle;
    const runExclusive = vi.fn(async <T>({ operation }: { operation: () => Promise<T> }) => await operation());

    await removeNaidanOpfsContainerDirectory({
      exclusiveGate: { runExclusive },
      fileSystemId,
      storageRoot,
    });

    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(removeEntry).toHaveBeenCalledWith(
      fileSystemIdToNaidanContainerToken({ id: fileSystemId }),
      { recursive: true },
    );
  });

  it("converges when container deletion committed before its response was lost", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0008",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const responseLoss = new Error("container deletion response lost");
    let removed = false;
    const removeEntry = vi.fn(async () => {
      if (removed) throw new DOMException("missing", "NotFoundError");
      removed = true;
      throw responseLoss;
    });
    const nativeStorageRoot = { removeEntry } as unknown as FileSystemDirectoryHandle;
    const storageRoot = {
      getDirectoryHandle: vi.fn(async () => nativeStorageRoot),
    } as unknown as FileSystemDirectoryHandle;
    let runExclusiveCalls = 0;
    const runExclusive = async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => {
      runExclusiveCalls += 1;
      return await operation();
    };
    const input = {
      exclusiveGate: { runExclusive },
      fileSystemId,
      storageRoot,
    };

    await expect(removeNaidanOpfsContainerDirectory(input)).rejects.toBe(responseLoss);
    await expect(removeNaidanOpfsContainerDirectory(input)).resolves.toBeUndefined();
    expect(removeEntry).toHaveBeenCalledTimes(2);
    expect(runExclusiveCalls).toBe(2);
  });

  it("treats missing storage or container directories as already removed", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0007",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const storageRoot = {
      getDirectoryHandle: vi.fn(async () => {
        throw new DOMException("missing", "NotFoundError");
      }),
    } as unknown as FileSystemDirectoryHandle;
    const runExclusive = vi.fn(async <T>({ operation }: { operation: () => Promise<T> }) => await operation());

    await expect(removeNaidanOpfsContainerDirectory({
      exclusiveGate: { runExclusive },
      fileSystemId,
      storageRoot,
    })).resolves.toBeUndefined();
  });

  it("returns collision without creating an existing container directory", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0004",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const existingRoot = Object.freeze({ name: "existing-root" }) as unknown as FileSystemDirectoryHandle;
    const getContainerDirectory = vi.fn(async (_name: string, options?: FileSystemGetDirectoryOptions) => {
      if (options?.create === false) return existingRoot;
      throw new Error("reservation must not recreate an existing directory");
    });
    const nativeStorageRoot = { getDirectoryHandle: getContainerDirectory } as unknown as FileSystemDirectoryHandle;
    const storageRoot = {
      getDirectoryHandle: vi.fn(async () => nativeStorageRoot),
    } as unknown as FileSystemDirectoryHandle;
    const runExclusive = vi.fn(async <T>({ operation }: { operation: () => Promise<T> }) => await operation());

    await expect(reserveNaidanOpfsContainerDirectory({
      exclusiveGate: { runExclusive },
      fileSystemId,
      storageRoot,
    })).resolves.toEqual({ type: "collision" });
    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(getContainerDirectory).toHaveBeenCalledWith(
      fileSystemIdToNaidanContainerToken({ id: fileSystemId }),
      { create: false },
    );
  });

  it("converges reserved container cleanup after committed deletion response loss", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0008",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const token = fileSystemIdToNaidanContainerToken({ id: fileSystemId });
    const containerRoot = Object.freeze({ name: "reserved-root" }) as unknown as FileSystemDirectoryHandle;
    let exists = false;
    const getContainerDirectory = vi.fn(async (_name: string, options?: FileSystemGetDirectoryOptions) => {
      if (options?.create === false) {
        if (!exists) throw new DOMException("missing", "NotFoundError");
        return containerRoot;
      }
      exists = true;
      return containerRoot;
    });
    const responseLoss = new Error("deletion response lost after commit");
    let responseLossPending = true;
    const removeEntry = vi.fn(async (name: string) => {
      expect(name).toBe(token);
      if (!exists) throw new DOMException("missing", "NotFoundError");
      exists = false;
      if (responseLossPending) {
        responseLossPending = false;
        throw responseLoss;
      }
    });
    const nativeStorageRoot = {
      getDirectoryHandle: getContainerDirectory,
      removeEntry,
    } as unknown as FileSystemDirectoryHandle;
    const storageRoot = {
      getDirectoryHandle: vi.fn(async () => nativeStorageRoot),
    } as unknown as FileSystemDirectoryHandle;
    const runExclusive = vi.fn(async <T>({ operation }: { operation: () => Promise<T> }) => await operation());

    const reservation = await reserveNaidanOpfsContainerDirectory({
      exclusiveGate: { runExclusive },
      fileSystemId,
      storageRoot,
    });
    if (reservation.type !== "reserved") throw new Error("expected a reserved container directory");

    await expect(reservation.cleanup()).rejects.toBe(responseLoss);
    await expect(reservation.cleanup()).resolves.toBeUndefined();
    await expect(reservation.cleanup()).resolves.toBeUndefined();

    expect(removeEntry).toHaveBeenCalledTimes(2);
    expect(removeEntry).toHaveBeenNthCalledWith(1, token, { recursive: true });
    expect(removeEntry).toHaveBeenNthCalledWith(2, token, { recursive: true });
    expect(runExclusive).toHaveBeenCalledTimes(3);
  });

  it("reserves and idempotently cleans only its exact container directory", async () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: "containerLocation0005",
    });
    const fileSystemId = inspection.mode.activeFileSystemId;
    const containerRoot = Object.freeze({ name: "reserved-root" }) as unknown as FileSystemDirectoryHandle;
    const getContainerDirectory = vi.fn(async (_name: string, options?: FileSystemGetDirectoryOptions) => {
      if (options?.create === false) throw new DOMException("missing", "NotFoundError");
      return containerRoot;
    });
    const removeEntry = vi.fn(async () => undefined);
    const nativeStorageRoot = {
      getDirectoryHandle: getContainerDirectory,
      removeEntry,
    } as unknown as FileSystemDirectoryHandle;
    const storageRoot = {
      getDirectoryHandle: vi.fn(async () => nativeStorageRoot),
    } as unknown as FileSystemDirectoryHandle;
    const runExclusive = vi.fn(async <T>({ operation }: { operation: () => Promise<T> }) => await operation());

    const reservation = await reserveNaidanOpfsContainerDirectory({
      exclusiveGate: { runExclusive },
      fileSystemId,
      storageRoot,
    });
    expect(reservation.type).toBe("reserved");
    if (reservation.type !== "reserved") throw new Error("expected a reserved container directory");
    expect(reservation.containerRoot).toBe(containerRoot);

    await reservation.cleanup();
    await reservation.cleanup();

    expect(runExclusive).toHaveBeenCalledTimes(2);
    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(removeEntry).toHaveBeenCalledWith(
      fileSystemIdToNaidanContainerToken({ id: fileSystemId }),
      { recursive: true },
    );
  });

});
