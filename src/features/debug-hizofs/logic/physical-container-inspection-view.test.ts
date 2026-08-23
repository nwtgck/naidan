import { describe, expect, it } from "vitest";
import type { HizoFSPhysicalContainerInspection } from "@/00-storage/service/hizofs/inspection";
import { createHizoFSPhysicalContainerInspectionView } from "./physical-container-inspection-view";

function inspection(): HizoFSPhysicalContainerInspection {
  return {
    physicalAnomalies: ["segments/data/ff: unexpected physical entry"],
    rootDirectoryShortcut: {
      activeCommit: {
        byteOffset: "64",
        frameLength: 200,
        recordKind: 1,
        segmentId: "00000000000000000000000000000001",
      },
      activeFailureReason: "active Commit authentication failed",
      commitSequence: "7",
      mode: "fallback_read_only",
      nestedSubvolumeTableRoot: undefined,
      rootDirectoryInodeNumber: "1",
      rootInodeTableRoot: {
        byteOffset: "256",
        frameLength: 180,
        recordKind: 3,
        segmentId: "00000000000000000000000000000001",
      },
      state: "available",
    },
    segments: [{
      fileSize: "4096",
      footerHeader: undefined,
      footerIndexEntries: undefined,
      footerPhysicalOffset: undefined,
      footerTotalLength: undefined,
      footerTrailer: undefined,
      frames: [{
        flags: 0,
        frameLength: 200,
        homeOffset: "64",
        homeReference: {
          byteOffset: "64",
          frameLength: 200,
          recordKind: 1,
          segmentId: "00000000000000000000000000000001",
        },
        homeSegmentId: "00000000000000000000000000000001",
        header: {
          flags: 0,
          frameLength: 200,
          homeOffset: 64n as never,
          homeSegmentId: Uint8Array.from({ length: 16 }, () => 1) as never,
          nonce: new Uint8Array(12),
          plaintextLength: 80,
          recordCodecVersion: 1,
          recordKind: 1,
          sealedLength: 96,
        },
        physicalOffset: "64",
        plaintextLength: 80,
        recordKind: 1,
      }],
      header: undefined,
      path: "segments/metadata/01/00000000000000000000000000000001.enc",
      physicalSegmentId: "00000000000000000000000000000001",
      reason: "Segment Footer is unusable; valid prefix retained",
      segmentClass: "metadata",
      state: "unsealed_incomplete",
    }],
    superblockCopies: [{
      activeCommit: undefined,
      activeCommitSequence: "7",
      fallbackCommit: undefined,
      copy: 0,
      header: undefined,
      minimumUnlockSequence: undefined,
      path: "control/superblock-0.bin",
      plaintext: undefined,
      publicationSequence: "9",
      relocationIndexRoot: undefined,
      reason: "Superblock authentication failed",
      requiredFeatureBits: undefined,
      selected: false,
      state: "proof_invalid",
    }],
    superblockSelection: {
      code: "control_plane_corrupt",
      message: "no authenticated Superblock authority exists",
      state: "rejected",
    },
    unlockEnvelopeCopies: [{
      copy: 1,
      credentialSlotCount: 2,
      envelope: undefined,
      fileSystemId: "filesystem-id",
      path: "control/unlock-envelope-1.json",
      reason: undefined,
      selected: true,
      sequence: "4",
      state: "proof_valid",
    }],
    unlockSelection: {
      copy: 1,
      redundancy: "degraded",
      sequence: "4",
      state: "selected",
    },
  };
}

describe("HizoFS physical container inspection view", () => {
  it("preserves rejected authority, corruption reasons, and physical anomalies", () => {
    const view = createHizoFSPhysicalContainerInspectionView({ inspection: inspection() });
    expect(view.unlockSelectionSummary).toBe("copy 1, sequence 4, degraded");
    expect(view.superblockSelectionSummary).toBe(
      "control_plane_corrupt: no authenticated Superblock authority exists",
    );
    expect(view.copyRows).toEqual([
      {
        copy: 1,
        credentialSlotCount: 2,
        envelope: undefined,
        envelopeJson: "unavailable",
        fileSystemId: "filesystem-id",
        kind: "unlock_envelope",
        path: "control/unlock-envelope-1.json",
        reason: undefined,
        selected: true,
        sequence: "4",
        state: "proof_valid",
      },
      {
        activeCommit: undefined,
        activeCommitSequence: "7",
        fallbackCommit: undefined,
        copy: 0,
        header: undefined,
        headerJson: "unavailable",
        kind: "superblock",
        minimumUnlockSequence: undefined,
        path: "control/superblock-0.bin",
        plaintext: undefined,
        plaintextJson: "unavailable",
        publicationSequence: "9",
        reason: "Superblock authentication failed",
        relocationIndexRoot: undefined,
        requiredFeatureBits: undefined,
        selected: false,
        state: "proof_invalid",
      },
    ]);
    expect(view.physicalAnomalies).toEqual(["segments/data/ff: unexpected physical entry"]);
  });

  it("retains exact persisted copy DTOs and renders bigint and byte fields losslessly", () => {
    const source = inspection();
    const unlockCopy = source.unlockEnvelopeCopies[0];
    const superblockCopy = source.superblockCopies[0];
    if (unlockCopy === undefined || superblockCopy === undefined) throw new Error("expected copy fixtures");
    const envelope = {
      authenticatorNonce: "nonce-value",
      authenticatorTag: "tag-value",
      copy: 1,
      credentialSlots: [{
        method: "passphrase_pbkdf2_hmac_sha256_aes_256_gcm",
        methodParameters: "parameters",
        methodVersion: 1,
        slotId: "slot-id",
        type: "credential",
        wrappedFileSystemRootKey: "wrapped-root-key",
      }],
      fileSystemId: "filesystem-id",
      format: "hizofs-unlock",
      formatVersion: 1,
      sequence: 4,
    } as never;
    const header = {
      activeCommitSequence: 7n,
      copy: 0,
      fileSystemId: "filesystem-id",
      flags: 3,
      nonce: Uint8Array.of(1, 2, 255),
      publicationSequence: 9n,
    } as never;
    const plaintext = {
      activeCommitHomeRef: { byteOffset: 64n, frameLength: 200, recordKind: 1, segmentId: 1n },
      activeMutationId: Uint8Array.of(3, 4),
      fallbackCommitHomeRef: null,
      minimumUnlockSequence: 4n,
      publicationId: Uint8Array.of(5, 6),
      relocationIndexRootPhysicalRef: null,
      requiredFeatureBits: 5n,
    } as never;

    const view = createHizoFSPhysicalContainerInspectionView({
      inspection: {
        ...source,
        superblockCopies: [{ ...superblockCopy, header, plaintext }],
        unlockEnvelopeCopies: [{ ...unlockCopy, envelope }],
      },
    });
    const unlockRow = view.copyRows.find(row => row.kind === "unlock_envelope");
    const superblockRow = view.copyRows.find(row => row.kind === "superblock");
    expect(unlockRow?.envelope).toBe(envelope);
    expect(unlockRow?.envelopeJson).toContain('"wrappedFileSystemRootKey": "wrapped-root-key"');
    expect(superblockRow?.header).toBe(header);
    expect(superblockRow?.plaintext).toBe(plaintext);
    expect(superblockRow?.headerJson).toContain('"activeCommitSequence": "7"');
    expect(superblockRow?.headerJson).toContain('"hex": "0102ff"');
    expect(superblockRow?.plaintextJson).toContain('"requiredFeatureBits": "5"');
  });

  it("bounds frame rows independently from the physical Inspector inventory", () => {
    const source = inspection();
    const segment = source.segments[0];
    if (segment === undefined) throw new Error("expected segment fixture");
    const frame = segment.frames[0];
    if (frame === undefined) throw new Error("expected frame fixture");
    const view = createHizoFSPhysicalContainerInspectionView({
      inspection: { ...source, segments: [{ ...segment, frames: [frame, { ...frame, physicalOffset: "264" }] }] },
      maximumFrameRows: 1,
    });
    expect(view).toMatchObject({
      displayedFrameCount: 1,
      frameRowsTruncated: true,
      totalFrameCount: 2,
    });
    expect(view.segmentRows[0]).toMatchObject({
      frameCount: 2,
      frameRowsTruncated: true,
      frames: [{ physicalOffset: "64" }],
    });
  });

  it("navigates only the selected Superblock relocation authority", () => {
    const source = inspection();
    const relocationIndexRoot = {
      byteOffset: "640",
      frameLength: 176,
      recordKind: 48,
      segmentId: "00000000000000000000000000000041",
    };
    const rejectedCopy = source.superblockCopies[0];
    if (rejectedCopy === undefined) throw new Error("expected rejected Superblock fixture");
    const view = createHizoFSPhysicalContainerInspectionView({
      inspection: {
        ...source,
        superblockCopies: [
          { ...rejectedCopy, relocationIndexRoot },
          {
            ...rejectedCopy,
            copy: 1,
            reason: undefined,
            relocationIndexRoot,
            selected: true,
            state: "proof_valid",
          },
        ],
        superblockSelection: { copy: 1, redundancy: "degraded", sequence: "10", state: "selected" },
      },
    });

    expect(view.authorityNavigationTargets).toEqual([{
      label: "Relocation Index",
      request: {
        frameLength: 176,
        pageIsRoot: true,
        physicalOffset: "640",
        physicalSegmentId: "00000000000000000000000000000041",
        recordKind: 48,
      },
    }]);
  });

  it("exposes only the selected authenticated Superblock fallback as a recovery reference", () => {
    const source = inspection();
    const rejectedCopy = source.superblockCopies[0];
    if (rejectedCopy === undefined) throw new Error("expected Superblock fixture");
    const rejectedFallback = {
      byteOffset: "11",
      frameLength: 128,
      recordKind: 1,
      segmentId: "0000000000000000000000000000000a",
    };
    const selectedFallback = {
      byteOffset: "32",
      frameLength: 160,
      recordKind: 1,
      segmentId: "00000000000000000000000000000009",
    };
    const view = createHizoFSPhysicalContainerInspectionView({
      inspection: {
        ...source,
        superblockCopies: [
          { ...rejectedCopy, fallbackCommit: rejectedFallback },
          {
            ...rejectedCopy,
            copy: 1,
            fallbackCommit: selectedFallback,
            reason: undefined,
            selected: true,
            state: "proof_valid",
          },
        ],
        superblockSelection: { copy: 1, redundancy: "degraded", sequence: "10", state: "selected" },
      },
    });

    expect(view.recoveryNavigationTargets).toEqual([{
      label: "Fallback Commit candidate",
      request: {
        frameLength: 160,
        homeOffset: "32",
        homeSegmentId: "00000000000000000000000000000009",
        recordKind: 1,
      },
    }]);
    expect(view.copyRows.find(row => row.kind === "superblock" && row.copy === 1)).toMatchObject({
      fallbackCommit: selectedFallback,
      selected: true,
    });
  });

  it("retains root shortcut and segment valid-prefix diagnostics", () => {
    const source = inspection();
    const frameHeader = source.segments[0]?.frames[0]?.header;
    if (frameHeader === undefined) throw new Error("expected Segment Frame header fixture");
    const view = createHizoFSPhysicalContainerInspectionView({ inspection: source });
    expect(view.rootDirectorySummary).toBe("fallback_read_only, commit 7, root inode 1");
    expect(view.rootRecoveryReason).toBe("active Commit authentication failed");
    expect(view.rootNavigationTargets).toEqual([
      {
        label: "Fallback Commit",
        request: {
          frameLength: 200,
          homeOffset: "64",
          homeSegmentId: "00000000000000000000000000000001",
          recordKind: 1,
        },
      },
      {
        label: "Root Inode Table",
        request: {
          frameLength: 180,
          homeOffset: "256",
          homeSegmentId: "00000000000000000000000000000001",
          pageIsRoot: true,
          recordKind: 3,
        },
      },
    ]);
    expect(view.segmentRows).toEqual([{
      fileSize: "4096",
      footerHeader: undefined,
      footerHeaderJson: "unavailable",
      footerIndexEntries: undefined,
      footerIndexEntriesJson: "unavailable",
      footerPhysicalOffset: undefined,
      footerTotalLength: undefined,
      footerTrailer: undefined,
      footerTrailerJson: "unavailable",
      frameCount: 1,
      frameRowsTruncated: false,
      frames: [{
        flags: 0,
        frameLength: 200,
        homeOffset: "64",
        homeReference: {
          byteOffset: "64",
          frameLength: 200,
          recordKind: 1,
          segmentId: "00000000000000000000000000000001",
        },
        homeSegmentId: "00000000000000000000000000000001",
        header: frameHeader,
        headerJson: expect.any(String),
        physicalOffset: "64",
        physicalSegmentId: "00000000000000000000000000000001",
        plaintextLength: 80,
        recordKind: 1,
      }],
      header: undefined,
      headerJson: "unavailable",
      path: "segments/metadata/01/00000000000000000000000000000001.enc",
      physicalSegmentId: "00000000000000000000000000000001",
      reason: "Segment Footer is unusable; valid prefix retained",
      segmentClass: "metadata",
      state: "unsealed_incomplete",
    }]);
  });
});
