import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileOffset,
  createHomeRecordReference,
  createFeatureBits,
  createFileSystemCommitPayload,
  createInodeNumber,
  createInodeRevision,
  createPublicationSequence,
  createSubvolumeId,
  createUInt64,
  createUnlockSequence,
  parseFileSystemId,
  parseSegmentId,
  parseMutationId,
} from "@/00-storage/service/hizofs/00-format";
import { createInitialBootstrapSegment } from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import { readAuthenticatedDirectoryPage } from "@/00-storage/service/hizofs/authenticated-store/directory-page-store";
import { readAuthenticatedInodeTablePage } from "@/00-storage/service/hizofs/authenticated-store/inode-table-page-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { createAuthenticatedMetadataMutationAuthority } from "@/00-storage/service/hizofs/authenticated-store/metadata-mutation-authority";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
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

describe("authenticated metadata mutation authority", () => {
  it("provides structurally compatible page and Commit publication ports", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const bootstrap = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: {
        activeCommitHomeRef: bootstrap.activeCommitHomeRef,
        activeCommitSequence: bootstrap.activeCommitSequence,
        activeMutationId: bootstrap.activeMutationId,
        fallbackCommitHomeRef: null,
        minimumUnlockSequence: createUnlockSequence({ value: 1n }),
        relocationIndexRootPhysicalRef: null,
        requiredFeatureBits: createFeatureBits({ value: 0n }),
      },
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    await expect(authority.resolvePublication({
      base,
      intendedLogicalState: base.logicalState,
    })).rejects.toThrow("before the mutation authority is closed");
    const directoryRoot = await authority.writeDirectoryPage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
    const newRoot = await authority.writeInodeTablePage({
      isRoot: true,
      page: {
        entries: [{
          content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
          inodeKind: "directory",
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 2n }),
          timestamps: { createdAt: null, modifiedAt: null },
        }],
        level: 0,
        type: "leaf",
      },
    });
    const commitPayload = createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 2n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(17) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: newRoot,
    } });
    const published = await authority.publish({
      base,
      beforeFirstAuthorityWrite: () => undefined,
      commitPayload,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
    });

    expect(authority.state()).toBe("closed");
    expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
    await expect(authority.resolvePublication({
      base,
      intendedLogicalState: published.superblock.logicalState,
    })).resolves.toMatchObject({ type: "published" });
    await expect(authority.readInodeTablePage({ isRoot: true, reference: newRoot })).rejects.toThrow("closed");
    await expect(authority.readDirectoryPage({ isRoot: true, reference: directoryRoot })).rejects.toThrow("closed");
    await expect(readAuthenticatedDirectoryPage({
      backend,
      fileSystemId,
      homeReference: directoryRoot,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual({ entries: [], level: 0, type: "leaf" });
    await expect(readAuthenticatedInodeTablePage({
      backend,
      fileSystemId,
      homeReference: newRoot,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toMatchObject({
      entries: [{ inodeRevision: 2n }],
      type: "leaf",
    });
    await expect(openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ logicalState: { activeCommitSequence: 2n } });
    rootKey.destroy();
  });

  it("rolls metadata page writes into a fresh segment when one mutation exceeds the record area", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const fileDataHomeRef = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(211) }),
    } });
    const page = {
      entries: Array.from({ length: 1_024 }, (_, index) => ({
        byteLength: 1,
        dataOffset: 0,
        fileDataHomeRef,
        fileOffset: createFileOffset({ value: BigInt(index * 2) }),
      })),
      level: 0 as const,
      type: "leaf" as const,
    };

    const references = [];
    for (let index = 0; index < 96; index += 1) {
      references.push(await authority.writeFileExtentPage({ isRoot: false, page }));
    }

    const first = references.at(0);
    const last = references.at(-1);
    if (first === undefined || last === undefined) throw new Error("metadata rollover references are missing");
    expect(last.segmentId).not.toEqual(first.segmentId);
    await expect(authority.readFileExtentPage({ isRoot: false, reference: first })).resolves.toEqual(page);
    await expect(authority.readFileExtentPage({ isRoot: false, reference: last })).resolves.toEqual(page);
    authority.abandon();
    rootKey.destroy();
  });

  it("becomes terminal after explicit abandon", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const authority = await createAuthenticatedMetadataMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    authority.abandon();
    expect(authority.state()).toBe("closed");
    await expect(authority.writeInodeTablePage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    })).rejects.toThrow("closed");
    rootKey.destroy();
  });
});
