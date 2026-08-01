import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createFileOffset,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createPublicationSequence,
  createSubvolumeId,
  createUInt64,
  createUnlockSequence,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  type HomeRecordReference,
  type InodeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { OpenedSuperblockCopies } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import type { PreparedMutationCommitPublicationPort } from "@/00-storage/service/hizofs/filesystem/mutation/prepared-mutation-commit-publisher";
import {
  publishRootInodeTableMutation,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation-publisher";
import type {
  RootInodeTablePage,
  RootInodeTablePagePort,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import { WriterMutationLifecycleError } from "@/00-storage/service/hizofs/filesystem/mutation/writer-mutation-lifecycle";

function reference({ kind, offset }: { kind: number; offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function rootEntry(): InodeLeafEntry {
  return {
    content: { entries: [], type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: 1n }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function fileEntry(): InodeLeafEntry {
  return {
    content: { bytes: new TextEncoder().encode("hello"), type: "inline" },
    fileSize: createFileOffset({ value: 5n }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 2n }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function fixture() {
  const inodeRoot = reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page, offset: 64n });
  const activeCommit = reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit, offset: 192n });
  const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(3) });
  const baseCommit = createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 1n }),
    mutationId,
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: inodeRoot,
  } });
  const logicalState = {
    activeCommitHomeRef: activeCommit,
    activeCommitSequence: baseCommit.commitSequence,
    activeMutationId: mutationId,
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  };
  const baseSuperblock: OpenedSuperblockCopies = {
    authenticatedLogicalStates: [logicalState],
    copyState: "normal",
    historicalRootFeatureState: "supported_or_absent",
    logicalState,
    maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 2n }),
    selectedCopy: 1,
    selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(4) }),
    selectedPublicationSequence: createPublicationSequence({ value: 2n }),
  };
  const pages = new Map<HomeRecordReference, RootInodeTablePage>([
    [inodeRoot, { entries: [rootEntry()], level: 0, type: "leaf" }],
  ]);
  let nextOffset = 320n;
  const readPage = vi.fn(async ({ reference: pageReference }: { isRoot: boolean; reference: HomeRecordReference }) => {
    const page = pages.get(pageReference);
    if (page === undefined) throw new Error("missing page");
    return page;
  });
  const writePage = vi.fn(async ({ page }: { isRoot: boolean; page: RootInodeTablePage }) => {
    const pageReference = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: nextOffset,
    });
    nextOffset += 128n;
    pages.set(pageReference, page);
    return pageReference;
  });
  const pagePort: RootInodeTablePagePort = { readPage, writePage };
  const publish = vi.fn(async (request: Parameters<PreparedMutationCommitPublicationPort["publish"]>[0]) => {
    request.beforeFirstAuthorityWrite();
    return {
      commitHomeRef: reference({
        kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
        offset: 960n,
      }),
      superblock: {
        ...request.base,
        logicalState: {
          ...request.base.logicalState,
          activeCommitSequence: request.commitPayload.commitSequence,
          activeMutationId: request.commitPayload.mutationId,
        },
      },
    };
  });
  const publicationPort: PreparedMutationCommitPublicationPort = { publish };
  return { baseCommit, baseSuperblock, pagePort, publicationPort, publish, readPage, writePage };
}

describe("root Inode Table mutation publisher", () => {
  it("prepares a new root page and publishes the matching Commit", async () => {
    const value = fixture();
    const result = await publishRootInodeTableMutation({
      assertPublicationAllowed: () => undefined,
      baseCommit: value.baseCommit,
      baseSuperblock: value.baseSuperblock,
      changes: [{ entry: fileEntry(), type: "set" }],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      pagePort: value.pagePort,
      publicationPort: value.publicationPort,
    });

    expect(result.type).toBe("published");
    if (result.type !== "published") throw new Error("expected published mutation");
    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(value.writePage).toHaveBeenCalledWith(expect.objectContaining({ isRoot: true }));
    expect(value.publish).toHaveBeenCalledWith(expect.objectContaining({
      commitPayload: result.commitPayload,
      firstPublicationSequence: 3n,
      secondPublicationSequence: 4n,
    }));
  });

  it("does not publish a byte-identical mutation", async () => {
    const value = fixture();
    const result = await publishRootInodeTableMutation({
      assertPublicationAllowed: () => undefined,
      baseCommit: value.baseCommit,
      baseSuperblock: value.baseSuperblock,
      changes: [{ entry: rootEntry(), type: "set" }],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      pagePort: value.pagePort,
      publicationPort: value.publicationPort,
    });
    expect(result).toEqual({ type: "unchanged" });
    expect(value.writePage).not.toHaveBeenCalled();
    expect(value.publish).not.toHaveBeenCalled();
  });

  it("rejects a stale Commit before reading the Inode Table", async () => {
    const value = fixture();
    const staleCommit = createFileSystemCommitPayload({ payload: {
      ...value.baseCommit,
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(9) }),
    } });
    await expect(publishRootInodeTableMutation({
      assertPublicationAllowed: () => undefined,
      baseCommit: staleCommit,
      baseSuperblock: value.baseSuperblock,
      changes: [{ entry: fileEntry(), type: "set" }],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      pagePort: value.pagePort,
      publicationPort: value.publicationPort,
    })).rejects.toThrow("does not match");
    expect(value.readPage).not.toHaveBeenCalled();
  });

  it("leaves prepared pages unreachable when owner closing revokes Commit publication", async () => {
    const value = fixture();
    let checks = 0;
    await expect(publishRootInodeTableMutation({
      assertPublicationAllowed: () => {
        checks += 1;
        if (checks === 2) {
          throw new WriterMutationLifecycleError({ code: "publication_revoked", message: "owner is closing" });
        }
      },
      baseCommit: value.baseCommit,
      baseSuperblock: value.baseSuperblock,
      changes: [{ entry: fileEntry(), type: "set" }],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      pagePort: value.pagePort,
      publicationPort: value.publicationPort,
    })).rejects.toMatchObject({ code: "publication_revoked" });
    expect(value.writePage).toHaveBeenCalled();
    expect(value.publish).not.toHaveBeenCalled();
  });
});
