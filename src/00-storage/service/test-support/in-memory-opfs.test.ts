import { describe, expect, it } from "vitest";
import {
  createInMemoryOpfsStorageManager,
  InMemoryOpfsDirectoryHandle,
} from "@/00-storage/service/test-support/in-memory-opfs";

describe("in-memory OPFS platform", () => {
  it("keeps browser-like methods on class prototypes", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });

    expect(Object.hasOwn(root, "getFileHandle")).toBe(false);
    expect(typeof root.getFileHandle).toBe("function");

    const storage = createInMemoryOpfsStorageManager({ root });
    expect(await storage.getDirectory()).toBe(root);
    expect(await Array.fromAsync(root)).toEqual([]);
  });

  it("models Window writable streams without sync access handles", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    const file = await root.getFileHandle("state.bin", { create: true });

    await expect(file.createSyncAccessHandle()).rejects.toMatchObject({
      name: "NotSupportedError",
    });

    const first = await file.createWritable();
    await first.write(new Uint8Array([1, 2, 3, 4]));
    await first.seek(1);
    await first.write(new Uint8Array([9, 8]));
    await first.close();

    const second = await file.createWritable({ keepExistingData: true });
    await second.truncate(3);
    await second.seek(3);
    await second.write(new Uint8Array([7]));
    await second.close();

    const snapshot = new Uint8Array(await (await file.getFile()).arrayBuffer());
    expect([...snapshot]).toEqual([1, 9, 8, 7]);
  });

  it("models Worker sync access handles over the same persistent root", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "worker",
      name: "opfs-root",
    });
    const file = await root.getFileHandle("segment.bin", { create: true });
    const writer = await file.createSyncAccessHandle();

    expect(writer.write(new Uint8Array([4, 5, 6]), { at: 2 })).toBe(3);
    writer.flush();
    writer.close();

    const reopened = await (await root.getFileHandle("segment.bin")).createSyncAccessHandle();
    const bytes = new Uint8Array(reopened.getSize());
    expect(reopened.read(bytes, { at: 0 })).toBe(5);
    reopened.close();

    expect([...bytes]).toEqual([0, 0, 4, 5, 6]);
  });

  it("persists the same filesystem across application instances", async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      name: "opfs-root",
    });
    const firstStorage = createInMemoryOpfsStorageManager({ root });
    const firstRoot = await firstStorage.getDirectory();
    const directory = await firstRoot.getDirectoryHandle("naidan-storage", { create: true });
    const file = await directory.getFileHandle("settings.json", { create: true });
    const writable = await file.createWritable();
    await writable.write("{\"generation\":1}");
    await writable.close();

    const secondStorage = createInMemoryOpfsStorageManager({ root });
    const secondRoot = await secondStorage.getDirectory();
    const reopenedDirectory = await secondRoot.getDirectoryHandle("naidan-storage");
    const reopenedFile = await reopenedDirectory.getFileHandle("settings.json");

    expect(await (await reopenedFile.getFile()).text()).toBe("{\"generation\":1}");
  });

  it("exposes generic operation hooks for deterministic filesystem faults", async () => {
    const failure = new DOMException("remove blocked", "NoModificationAllowedError");
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: "window",
      faultHooks: {
        beforeRemoveEntry: async ({ name }) => {
          if (name === "blocked") throw failure;
        },
      },
      name: "opfs-root",
    });
    await root.getDirectoryHandle("blocked", { create: true });
    await root.getDirectoryHandle("removable", { create: true });

    await expect(root.removeEntry("blocked", { recursive: true })).rejects.toBe(failure);
    await expect(root.removeEntry("removable", { recursive: true })).resolves.toBeUndefined();
    await expect(root.getDirectoryHandle("blocked")).resolves.toBeDefined();
  });

});
