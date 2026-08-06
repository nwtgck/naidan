import { describe, expect, it } from "vitest";

import {
  StorageFileSystemSyncError,
  requireStorageFileSystemSyncDurability,
} from "./sync-error";

describe("storage filesystem sync errors", () => {
  it("accepts a demonstrated durability profile", () => {
    expect(() => requireStorageFileSystemSyncDurability({
      durability: "demonstrated",
      implementation: "hizofs",
    })).not.toThrow();
  });

  it("rejects an unqualified profile with a stable typed error", () => {
    expect(() => requireStorageFileSystemSyncDurability({
      durability: "not-demonstrated",
      implementation: "native_opfs",
    })).toThrow(expect.objectContaining({
      code: "durability_not_demonstrated",
      implementation: "native_opfs",
      name: "StorageFileSystemSyncError",
      retryable: false,
    }));
    try {
      requireStorageFileSystemSyncDurability({
        durability: "not-demonstrated",
        implementation: "native_opfs",
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(StorageFileSystemSyncError);
    }
  });
});
