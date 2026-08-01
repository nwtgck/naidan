import { describe, expect, it } from "vitest";
import {
  createInodeNumber,
  createInodeRevision,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import {
  appendAuthenticatedInodeTablePage,
  readAuthenticatedInodeTablePage,
} from "@/00-storage/service/hizofs/authenticated-store/inode-table-page-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { createAuthenticatedSegmentWriter } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function rootEntry() {
  return {
    content: { entries: [], type: "inline" as const },
    inodeKind: "directory" as const,
    inodeNumber: createInodeNumber({ value: 1n }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

describe("authenticated Inode Table page store", () => {
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
    const homeReference = await appendAuthenticatedInodeTablePage({
      isRoot: true,
      page: { entries: [rootEntry()], level: 0, type: "leaf" },
      writer,
    });
    writer.abandon();

    await expect(readAuthenticatedInodeTablePage({
      backend,
      fileSystemId,
      homeReference,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual({ entries: [rootEntry()], level: 0, type: "leaf" });
    rootKey.destroy();
  });

  it("preserves the root context needed to reject an empty non-root page", async () => {
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
    const homeReference = await appendAuthenticatedInodeTablePage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
      writer,
    });
    writer.abandon();

    await expect(readAuthenticatedInodeTablePage({
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
