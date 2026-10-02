import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createPublicationSequence,
  createSubvolumeId,
  createUInt64,
  createUnlockSequence,
  parseFileSystemId,
  parseMutationId,
  parsePublicationId,
  parseSegmentIdLowercaseHex,
  type FileSystemCommitPayload,
  type InodeLeafEntry,
  type SuperblockLogicalState,
} from "@/00-storage/service/hizofs/00-format";
import { generateFileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import { authenticatedStoreError } from "@/00-storage/service/hizofs/authenticated-store/errors";
import type { AuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import { HizoFSNamespaceInspectionError } from "@/00-storage/service/hizofs/inspection/namespace-inspection";
import { withBorrowedHizoFSInspectionAuthority, type HizoFSOpenedInspectionAuthority } from "@/00-storage/service/hizofs/inspection/inspection-authority";

function createAuthorityFixture({ fallbackAvailable }: { fallbackAvailable: boolean }) {
  const fileSystemId = parseFileSystemId({ value: "000000000000000000001" });
  const rootKey = generateFileSystemRootKey();
  const reference = ({ offset, recordKind }: { offset: bigint; recordKind: number }) => createHomeRecordReference({
    fields: {
      byteOffset: createUInt64({ value: offset }),
      frameLength: 160,
      recordKind,
      segmentId: parseSegmentIdLowercaseHex({ value: "00000000000000000000000000000001" }),
    },
  });
  const logicalState: SuperblockLogicalState = {
    activeCommitHomeRef: reference({ offset: 320n, recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit }),
    activeCommitSequence: createCommitSequence({ value: 2n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(1) }),
    fallbackCommitHomeRef: fallbackAvailable
      ? reference({ offset: 160n, recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit })
      : null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  };
  const commit: FileSystemCommitPayload = {
    commitSequence: logicalState.activeCommitSequence,
    mutationId: logicalState.activeMutationId,
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: reference({ offset: 480n, recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page }),
  };
  const rootDirectoryInode: InodeLeafEntry = {
    content: { entries: [], type: "inline" },
    inodeKind: "directory",
    inodeNumber: commit.rootDirectoryInodeNumber,
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
  const unexpectedRead = async (): Promise<never> => {
    throw new Error("unexpected inspection port operation");
  };
  const physical: AuthenticatedHizoFSInspectionPort = {
    list: unexpectedRead,
    openSuperblockCopies: vi.fn<AuthenticatedHizoFSInspectionPort["openSuperblockCopies"]>(async () => ({
      authenticatedLogicalStates: [logicalState],
      copyState: "normal",
      historicalRootFeatureState: "supported_or_absent",
      logicalState,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 2n }),
      selectedCopy: 0,
      selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(2) }),
      selectedPublicationSequence: createPublicationSequence({ value: 2n }),
    })),
    openUnlockAuthority: vi.fn<AuthenticatedHizoFSInspectionPort["openUnlockAuthority"]>(),
    openUnlockCopies: unexpectedRead,
    readBootstrapRoot: vi.fn<AuthenticatedHizoFSInspectionPort["readBootstrapRoot"]>(async ({ authority }) => ({
      commit: { ...commit, commitSequence: authority.commitSequence },
      rootDirectoryInode,
    })),
    readFileBounded: unexpectedRead,
    readHomeRecord: unexpectedRead,
    readPhysicalRecord: unexpectedRead,
    readPhysicalRecordWithFrame: unexpectedRead,
    readSegmentIndex: unexpectedRead,
  };
  return { fileSystemId, physical, rootKey };
}

describe("HizoFS inspection authority selection", () => {
  it.each([
    { label: "page budget", failure: new HizoFSNamespaceInspectionError({ code: "page_budget_exceeded", message: "budget exceeded" }) },
    { label: "query corruption", failure: authenticatedStoreError({ code: "control_plane_corrupt", message: "query evidence is corrupt" }) },
    { label: "arbitrary query failure", failure: new Error("query failed") },
  ])("does not retry a $label operation on the fallback Commit", async ({ failure }) => {
    const { fileSystemId, physical, rootKey } = await createAuthorityFixture({ fallbackAvailable: true });
    const readBootstrapRoot = vi.spyOn(physical, "readBootstrapRoot");
    const operation = vi.fn(async () => {
      throw failure;
    });
    try {
      await expect(withBorrowedHizoFSInspectionAuthority({ fileSystemId, operation, physical, rootKey })).rejects.toBe(failure);
      expect(readBootstrapRoot.mock.calls.map(([request]) => request.authority.type)).toEqual(["active"]);
      expect(operation).toHaveBeenCalledExactlyOnceWith({ authority: expect.objectContaining({ mode: "active" }) });
    } finally {
      rootKey.destroy();
    }
  });

  it.each([
    { label: "arbitrary bootstrap failure", failure: new Error("bootstrap unavailable") },
    { label: "credential rejection", failure: authenticatedStoreError({ code: "credential_rejected", message: "credential rejected" }) },
  ])("does not turn $label into a fallback open", async ({ failure }) => {
    const { fileSystemId, physical, rootKey } = await createAuthorityFixture({ fallbackAvailable: true });
    const readBootstrapRoot = vi.spyOn(physical, "readBootstrapRoot").mockRejectedValueOnce(failure);
    const operation = vi.fn(async () => "unexpected query");
    try {
      await expect(withBorrowedHizoFSInspectionAuthority({ fileSystemId, operation, physical, rootKey })).rejects.toBe(failure);
      expect(readBootstrapRoot.mock.calls.map(([request]) => request.authority.type)).toEqual(["active"]);
      expect(operation).not.toHaveBeenCalled();
    } finally {
      rootKey.destroy();
    }
  });

  it("runs the operation once on fallback after active bootstrap corruption", async () => {
    const { fileSystemId, physical, rootKey } = await createAuthorityFixture({ fallbackAvailable: true });
    const readBootstrapRoot = vi.spyOn(physical, "readBootstrapRoot").mockRejectedValueOnce(
      authenticatedStoreError({ code: "control_plane_corrupt", message: "active bootstrap is corrupt" }),
    );
    const operation = vi.fn(async ({ authority }: { authority: HizoFSOpenedInspectionAuthority }) => ({
      commitSequence: authority.commit.commitSequence,
      mode: authority.mode,
    }));
    try {
      await expect(withBorrowedHizoFSInspectionAuthority({ fileSystemId, operation, physical, rootKey })).resolves.toEqual({
        commitSequence: 1n,
        mode: "fallback_read_only",
      });
      expect(readBootstrapRoot.mock.calls.map(([request]) => request.authority.type)).toEqual(["active", "fallback"]);
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      rootKey.destroy();
    }
  });

  it("propagates active bootstrap corruption when there is no fallback", async () => {
    const { fileSystemId, physical, rootKey } = await createAuthorityFixture({ fallbackAvailable: false });
    const failure = authenticatedStoreError({ code: "control_plane_corrupt", message: "active bootstrap is corrupt" });
    const readBootstrapRoot = vi.spyOn(physical, "readBootstrapRoot").mockRejectedValueOnce(failure);
    const operation = vi.fn(async () => "unexpected query");
    try {
      await expect(withBorrowedHizoFSInspectionAuthority({ fileSystemId, operation, physical, rootKey })).rejects.toBe(failure);
      expect(readBootstrapRoot.mock.calls.map(([request]) => request.authority.type)).toEqual(["active"]);
      expect(operation).not.toHaveBeenCalled();
    } finally {
      rootKey.destroy();
    }
  });

  it("propagates a failed fallback bootstrap without running the operation", async () => {
    const { fileSystemId, physical, rootKey } = await createAuthorityFixture({ fallbackAvailable: true });
    const failure = new Error("fallback bootstrap is unavailable");
    const readBootstrapRoot = vi.spyOn(physical, "readBootstrapRoot")
      .mockRejectedValueOnce(authenticatedStoreError({ code: "control_plane_corrupt", message: "active bootstrap is corrupt" }))
      .mockRejectedValueOnce(failure);
    const operation = vi.fn(async () => "unexpected query");
    try {
      await expect(withBorrowedHizoFSInspectionAuthority({ fileSystemId, operation, physical, rootKey })).rejects.toBe(failure);
      expect(readBootstrapRoot.mock.calls.map(([request]) => request.authority.type)).toEqual(["active", "fallback"]);
      expect(operation).not.toHaveBeenCalled();
    } finally {
      rootKey.destroy();
    }
  });
});
