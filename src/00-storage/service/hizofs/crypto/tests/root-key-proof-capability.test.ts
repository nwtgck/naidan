import { describe, expect, it } from "vitest";
import {
  FileSystemRootKey,
  withFileSystemRootKeyProofDerivationCapability,
  type FileSystemRootKeyProofDerivationCapability,
} from "@/00-storage/service/hizofs/crypto";

describe("File System Root Key proof derivation capability", () => {
  it("expires immediately after the verification callback", async () => {
    const rootKey = FileSystemRootKey.create({ bytes: Uint8Array.from({ length: 32 }, (_, index) => index + 1) });
    let retained: FileSystemRootKeyProofDerivationCapability | undefined;
    try {
      const key = await withFileSystemRootKeyProofDerivationCapability({
        rootKey,
        useCapability: async ({ capability }) => {
          retained = capability;
          return await capability.deriveAesGcmKey({ info: new TextEncoder().encode("proof-context") });
        },
      });
      expect(key.extractable).toBe(false);
      expect(key.usages).toEqual(["decrypt", "encrypt"]);
      await expect(retained!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow(
        "File System Root Key proof capability has expired",
      );
      expect(rootKey.isDestroyed()).toBe(false);
    } finally {
      rootKey.destroy();
    }
  });

  it("expires after a verification callback rejects", async () => {
    const rootKey = FileSystemRootKey.create({ bytes: new Uint8Array(32).fill(7) });
    let retained: FileSystemRootKeyProofDerivationCapability | undefined;
    try {
      await expect(withFileSystemRootKeyProofDerivationCapability({
        rootKey,
        useCapability: async ({ capability }) => {
          retained = capability;
          throw new Error("proof rejected");
        },
      })).rejects.toThrow("proof rejected");
      await expect(retained!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow(
        "File System Root Key proof capability has expired",
      );
    } finally {
      rootKey.destroy();
    }
  });
});
