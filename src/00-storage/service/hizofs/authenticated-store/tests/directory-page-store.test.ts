import {
  createInodeNumber,
  encodeDirectoryPage,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import {
  appendAuthenticatedDirectoryPage,
  readAuthenticatedDirectoryPage,
  readAuthenticatedDirectoryPageForUpdate,
} from "@/00-storage/service/hizofs/authenticated-store/directory-page-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { createAuthenticatedSegmentWriter } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it, vi } from "vitest";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function rootLeaf() {
  return {
    entries: [{
      inodeKind: "file" as const,
      inodeNumber: createInodeNumber({ value: 2n }),
      name: "file",
      targetType: "inode" as const,
    }],
    level: 0 as const,
    type: "leaf" as const,
  };
}

describe("authenticated Directory page store", () => {
  it("round-trips a root leaf through authenticated record storage", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const appended = await appendAuthenticatedDirectoryPage({
      isRoot: true,
      page: rootLeaf(),
      writer,
    });
    const { homeReference } = appended;
    writer.abandon();

    await expect(readAuthenticatedDirectoryPage({
      backend,
      fileSystemId,
      homeReference,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(rootLeaf());
    await expect(readAuthenticatedDirectoryPageForUpdate({
      backend,
      fileSystemId,
      homeReference,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual({
      encodedByteLength: encodeDirectoryPage({ isRoot: true, page: rootLeaf() }).byteLength,
      localStructureValidated: true,
      page: rootLeaf(),
    });
    rootKey.destroy();
  });

  it("returns a strongly validated cached page without re-reading its Record", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const appended = await appendAuthenticatedDirectoryPage({ isRoot: true, page: rootLeaf(), writer });
    writer.abandon();
    const cached = Object.freeze({
      encodedByteLength: appended.encodedByteLength,
      localStructureValidated: true as const,
      page: rootLeaf(),
    });
    const getPageForUpdate = vi.fn(() => cached);
    const setPage = vi.fn(() => {
      throw new Error("cache hit must not repopulate the page");
    });

    await expect(readAuthenticatedDirectoryPageForUpdate({
      backend,
      decodedPageCache: {
        getPageForUpdate,
        preparePageAdmission: () => Object.freeze({ commit: () => undefined, discard: () => undefined }),
        setPage,
      },
      fileSystemId,
      homeReference: appended.homeReference,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(cached);
    expect(getPageForUpdate).toHaveBeenCalledTimes(1);
    expect(setPage).not.toHaveBeenCalled();
    rootKey.destroy();
  });

  it("preserves root context when rejecting an empty non-root page", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const appended = await appendAuthenticatedDirectoryPage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
      writer,
    });
    const { homeReference } = appended;
    writer.abandon();

    await expect(readAuthenticatedDirectoryPage({
      backend,
      fileSystemId,
      homeReference,
      isRoot: false,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    rootKey.destroy();
  });
});
