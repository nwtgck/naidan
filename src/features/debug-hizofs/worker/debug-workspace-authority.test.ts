import { describe, expect, it, vi } from "vitest";
import { MockFileSystemDirectoryHandle } from "@/utils/in-memory-file-system";
import { createInMemoryStorageRoot } from "@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system";
import type { StorageFileSystemSession } from "@/00-storage/service/storage-file-system/types";
import { TEST_ONLY } from "./debug-workspace-authority";

function fileSystemSession(): StorageFileSystemSession {
  return {
    root: createInMemoryStorageRoot({ name: "temporary-root" }),
    capabilities: {
      atomicMove: "supported",
      directBlob: "supported",
      symbolicLink: "supported",
      wholeFileClone: "supported",
    },
    close: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
  };
}

describe("HizoFS debug workspace creation authority", () => {

  it("detaches the application session before disposing its runtime", async () => {
    const order: string[] = [];
    const session = fileSystemSession();
    session.close = vi.fn(async () => {
      order.push("session");
    });

    await TEST_ONLY.disposeSessionAndRuntime({
      fileSystemSession: session,
      disposeRuntime: async () => {
        order.push("runtime");
      },
    });

    expect(order).toEqual(["session", "runtime"]);
  });

  it("allows a failed cleanup attempt to be retried", async () => {
    const dispose = vi.fn()
      .mockRejectedValueOnce(new Error("runtime retained"))
      .mockResolvedValueOnce(undefined);
    const retryableDispose = TEST_ONLY.createRetryableAsyncDisposer({ dispose });

    await expect(retryableDispose()).rejects.toThrow("runtime retained");
    await expect(retryableDispose()).resolves.toBeUndefined();
    await expect(retryableDispose()).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cleanup callers onto one active attempt", async () => {
    let release: (() => void) | undefined;
    const dispose = vi.fn(async () => await new Promise<void>(resolve => {
      release = resolve;
    }));
    const retryableDispose = TEST_ONLY.createRetryableAsyncDisposer({ dispose });

    const first = retryableDispose();
    const second = retryableDispose();
    expect(dispose).toHaveBeenCalledOnce();
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await retryableDispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps credential and runtime construction behind the injected owner", async () => {
    const backingDirectory = new MockFileSystemDirectoryHandle({ name: "temporary.hizofs" });
    const session = fileSystemSession();
    const dispose = vi.fn(async () => undefined);
    const createRuntime = vi.fn(async ({ backingDirectory: received }: {
      backingDirectory: FileSystemDirectoryHandle;
    }) => {
      expect(received).toBe(backingDirectory);
      return {
        fileSystemId: "temporary-file-system",
        fileSystemSession: session,
        dispose,
      };
    });
    const authority = TEST_ONLY.createHizoFSDebugWorkspaceAuthorityWith({ createRuntime });

    const product = await authority.create({ backingDirectory });

    expect(createRuntime).toHaveBeenCalledOnce();
    expect(product.fileSystemId).toBe("temporary-file-system");
    expect(product.fileSystemSession).toBe(session);
    expect(product.authenticatedInspectionSession).toEqual(expect.objectContaining({
      inspectContainer: expect.any(Function),
      inspectHomeRecord: expect.any(Function),
      inspectNamespacePath: expect.any(Function),
      inspectRecord: expect.any(Function),
    }));
    expect(product.generateComprehensiveFixture).toEqual(expect.any(Function));
    await product.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
