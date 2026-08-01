import { describe, expect, it, vi } from "vitest";
import { fileSystemIdToNaidanContainerToken } from "@/00-storage/service/naidan-persistence-control/00-format";
import { createNativePlainEnableTransitionDriver, TEST_ONLY } from "@/00-storage/service/naidan-opfs/native-plain-enable-transition-driver";
import { TEST_ONLY as APPLICATION_NAMESPACE_TEST_ONLY } from "@/00-storage/service/naidan-opfs/native-plain-application-namespace";
import type { StorageFileSystemSession } from "@/00-storage/service/storage-file-system/types";
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from "@/00-storage/service/naidan-opfs/opfs-storage-location";
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from "@/00-storage/service/naidan-opfs/persistence-runtime-contract";

const FILE_SYSTEM_ID = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: "0123456789_ABCDEFGHIJ",
}).mode.activeFileSystemId;

function nativeDirectory({ names, removalFault }: {
  names: readonly string[];
  removalFault?: {
    readonly cause: Error;
    readonly name: string;
    readonly timing: "after_commit" | "before_commit";
  };
}) {
  const currentNames = new Set(names);
  let pendingFault = removalFault;
  const removeEntry = vi.fn(async (name: string) => {
    if (pendingFault?.name === name && pendingFault.timing === "before_commit") {
      const cause = pendingFault.cause;
      pendingFault = undefined;
      throw cause;
    }
    currentNames.delete(name);
    if (pendingFault?.name === name && pendingFault.timing === "after_commit") {
      const cause = pendingFault.cause;
      pendingFault = undefined;
      throw cause;
    }
  });
  const storage = {
    keys: async function* () {
      for (const name of currentNames) yield name;
    },
    removeEntry,
  } as unknown as FileSystemDirectoryHandle;
  const root = {
    getDirectoryHandle: vi.fn(async (name: string) => {
      if (name !== NAIDAN_OPFS_STORAGE_DIRECTORY_NAME) throw new DOMException("missing", "NotFoundError");
      return storage;
    }),
  } as unknown as FileSystemDirectoryHandle;
  return { removeEntry, root };
}

describe("native plain enable transition driver", () => {
  it("preserves prototype-backed native root methods through readiness inspection", async () => {
    const nativeNamespaceRoot = { name: "root" } as FileSystemDirectoryHandle;
    const driver = createNativePlainEnableTransitionDriver({ nativeNamespaceRoot });

    await expect(driver.inspectEndpoint({ endpoint: { type: "plain" } })).resolves.toBe("fully_verified");
  });

  it("preserves readiness and session-close failures in order", async () => {
    const readinessFailure = new Error("plain readiness validation failed");
    const closeFailure = new Error("plain readiness session close failed");
    const close = vi.fn(async () => {
      throw closeFailure;
    });
    const session = {
      close,
      root: {
        stat: vi.fn(async () => {
          throw readinessFailure;
        }),
      },
    } as unknown as StorageFileSystemSession;

    await expect(APPLICATION_NAMESPACE_TEST_ONLY.runWithSession({
      failureMessage: "plain readiness and session cleanup both failed",
      operation: async ({ session: opened }) => await opened.root.stat(),
      session,
    })).rejects.toEqual(expect.objectContaining({
      errors: [readinessFailure, closeFailure],
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves a close failure after successful readiness validation", async () => {
    const closeFailure = new Error("plain readiness session close failed");
    const session = {
      close: vi.fn(async () => {
        throw closeFailure;
      }),
      root: { stat: vi.fn(async () => ({ kind: "directory" as const })) },
    } as unknown as StorageFileSystemSession;

    await expect(APPLICATION_NAMESPACE_TEST_ONLY.runWithSession({
      failureMessage: "plain readiness and session cleanup both failed",
      operation: async () => "verified",
      session,
    })).rejects.toBe(closeFailure);
  });
  it("excludes only Persistence Control and canonical HizoFS containers", () => {
    const container = fileSystemIdToNaidanContainerToken({ id: FILE_SYSTEM_ID });
    expect(TEST_ONLY.includeApplicationStorageEntry({ name: "settings.json" })).toBe(true);
    expect(TEST_ONLY.includeApplicationStorageEntry({ name: "persistence-control" })).toBe(false);
    expect(TEST_ONLY.includeApplicationStorageEntry({ name: container })).toBe(false);
    expect(TEST_ONLY.includeApplicationStorageEntry({ name: "user-file.hizofs" })).toBe(true);
  });

  it("cleans application entries while retaining authority and container entries", async () => {
    const container = fileSystemIdToNaidanContainerToken({ id: FILE_SYSTEM_ID });
    const { removeEntry, root } = nativeDirectory({
      names: ["settings.json", "persistence-control", container, "chats"],
    });
    const driver = createNativePlainEnableTransitionDriver({ nativeNamespaceRoot: root });

    await driver.cleanupEndpoint({ endpoint: { type: "plain" } });

    expect(removeEntry.mock.calls).toEqual([
      ["chats", { recursive: true }],
      ["settings.json", { recursive: true }],
    ]);
  });

  it("resumes plain source cleanup from the remaining entry after an interrupted deletion", async () => {
    const failure = new Error("deletion interrupted before commit");
    const { removeEntry, root } = nativeDirectory({
      names: ["settings.json", "chats"],
      removalFault: { cause: failure, name: "settings.json", timing: "before_commit" },
    });
    const driver = createNativePlainEnableTransitionDriver({ nativeNamespaceRoot: root });

    await expect(driver.cleanupEndpoint({ endpoint: { type: "plain" } })).rejects.toBe(failure);
    await expect(driver.cleanupEndpoint({ endpoint: { type: "plain" } })).resolves.toBeUndefined();

    expect(removeEntry.mock.calls).toEqual([
      ["chats", { recursive: true }],
      ["settings.json", { recursive: true }],
      ["settings.json", { recursive: true }],
    ]);
  });

  it("does not delete a plain source entry twice after committed deletion response loss", async () => {
    const failure = new Error("deletion response lost after commit");
    const { removeEntry, root } = nativeDirectory({
      names: ["settings.json", "chats"],
      removalFault: { cause: failure, name: "chats", timing: "after_commit" },
    });
    const driver = createNativePlainEnableTransitionDriver({ nativeNamespaceRoot: root });

    await expect(driver.cleanupEndpoint({ endpoint: { type: "plain" } })).rejects.toBe(failure);
    await expect(driver.cleanupEndpoint({ endpoint: { type: "plain" } })).resolves.toBeUndefined();

    expect(removeEntry.mock.calls).toEqual([
      ["chats", { recursive: true }],
      ["settings.json", { recursive: true }],
    ]);
  });

  it("rejects target lifecycle operations and HizoFS endpoints", async () => {
    const { root } = nativeDirectory({ names: [] });
    const driver = createNativePlainEnableTransitionDriver({ nativeNamespaceRoot: root });
    const hizofs = { fileSystemId: FILE_SYSTEM_ID, type: "hizofs" } as const;

    await expect(driver.inspectEndpoint({ endpoint: hizofs })).rejects.toThrow("plain endpoint");
    await expect(driver.openTargetEndpoint({ binding: {} as never })).rejects.toThrow("cannot open a target");
    await expect(driver.finalizeTarget({ binding: {} as never })).rejects.toThrow("cannot finalize");
    await expect(driver.verifyNormalOpen({ binding: {} as never })).rejects.toThrow("cannot verify");
  });
});
