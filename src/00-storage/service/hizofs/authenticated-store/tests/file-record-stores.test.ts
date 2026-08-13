import {
  encodeFileExtentPage,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import {
  appendAuthenticatedFileData,
  readAuthenticatedFileData,
} from "@/00-storage/service/hizofs/authenticated-store/file-data-store";
import {
  appendAuthenticatedFileExtentPage,
  readAuthenticatedFileExtentPage,
  readAuthenticatedFileExtentPageForUpdate,
} from "@/00-storage/service/hizofs/authenticated-store/file-extent-page-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { createAuthenticatedSegmentWriter } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it } from "vitest";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

describe("authenticated file record stores", () => {
  it("round-trips File Data without returning a zeroized alias", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const input = Uint8Array.of(1, 2, 3);
    const append = appendAuthenticatedFileData({ bytes: input, writer });
    // appendAuthenticatedFileData must synchronously establish Record ownership
    // before its first asynchronous boundary, even though File Data encoding is
    // an identity mapping over the validated payload bytes.
    input.fill(9);
    const homeReference = await append;
    writer.abandon();

    const result = await readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    });
    expect(result).toEqual(Uint8Array.of(1, 2, 3));
    rootKey.destroy();
  });

  it("round-trips an empty sparse File Extent root", async () => {
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
    const page = { entries: [], level: 0 as const, type: "leaf" as const };
    const homeReference = await appendAuthenticatedFileExtentPage({ isRoot: true, page, writer });
    writer.abandon();

    await expect(readAuthenticatedFileExtentPage({
      backend,
      fileSystemId,
      homeReference,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(page);
    await expect(readAuthenticatedFileExtentPageForUpdate({
      backend,
      fileSystemId,
      homeReference,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual({
      encodedByteLength: encodeFileExtentPage({ isRoot: true, page }).byteLength,
      localStructureValidated: true,
      page,
    });
    rootKey.destroy();
  });
});

export const TEST_ONLY = {};
