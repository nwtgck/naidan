import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createUInt64,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  MaintenanceRootCaptureError,
  captureCompleteMaintenanceRoots,
} from "@/00-storage/service/hizofs/maintenance/maintenance-root-capture";
import { prepareMaintenanceCandidateSnapshot } from "@/00-storage/service/hizofs/maintenance/prepared-maintenance-candidate-snapshot";

function root({ offset, seed }: { offset: bigint; seed: number }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

function pageRoot({ offset, seed }: { offset: bigint; seed: number }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

function relocationRoot({ offset, seed }: { offset: bigint; seed: number }) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

function candidate({ seed }: { seed: number }) {
  const id = parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
  return Object.freeze({
    frameCount: 1,
    frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
      frames: [{
        frameLength: 96,
        physicalOffset: 64n,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      }],
      segmentId: id,
    }),
    ownership: "sealed" as const,
    segmentId: id,
    totalFrameBytes: 96,
  });
}

const emptyCandidateSnapshot = prepareMaintenanceCandidateSnapshot({
  candidateSegments: [],
  policy: createMaintenancePolicy(),
});

describe("complete maintenance root capture", () => {
  it("retains logical authority roots and physical relocation authority roots", () => {
    const roots = Array.from({ length: 6 }, (_, index) => root({ offset: 64n + BigInt(index * 96), seed: index + 1 }));
    const captured = captureCompleteMaintenanceRoots({
      candidateSnapshot: emptyCandidateSnapshot,
      maintenanceRootEpoch: 4,
      policy: createMaintenancePolicy(),
      rootSets: {
        activeCommitRoots: [roots[0]!],
        fallbackCommitRoots: [roots[1]!],
        inspectorPinnedRoots: [roots[3]!],
        readerPinnedRoots: [roots[2]!],
        relocationIndexRoots: [relocationRoot({ offset: 704n, seed: 8 })],
        unknownFeatureRoots: [roots[5]!],
        writerDependencyRoots: [roots[4]!],
        writerWorkingPageRoots: [pageRoot({ offset: 896n, seed: 9 })],
      },
    });
    expect(captured.snapshot.roots).toHaveLength(8);
    expect(captured.snapshot.roots).toContainEqual(expect.objectContaining({
      kind: "physical_relocation_page",
      pageRole: "root",
    }));
    expect(captured.snapshot.roots).toContainEqual(expect.objectContaining({
      kind: "logical_home",
      pageRole: "root",
      reference: pageRoot({ offset: 896n, seed: 9 }),
    }));
    expect(captured.counts).toEqual({
      activeCommit: 1,
      fallbackCommit: 1,
      inspectorPinned: 1,
      readerPinned: 1,
      relocationIndex: 1,
      unknownFeature: 1,
      writerDependency: 1,
      writerWorkingPage: 1,
    });
  });

  it("requires active authority and rejects the total root set before unbounded cloning", () => {
    const base = {
      fallbackCommitRoots: [],
      inspectorPinnedRoots: [],
      readerPinnedRoots: [],
      relocationIndexRoots: [],
      unknownFeatureRoots: [],
      writerDependencyRoots: [],
      writerWorkingPageRoots: [],
    };
    const oversizedCandidateSnapshot = prepareMaintenanceCandidateSnapshot({
      candidateSegments: [candidate({ seed: 8 }), candidate({ seed: 9 })],
      policy: createMaintenancePolicy({ maxCandidateSegmentsPerBatch: 2 }),
    });
    expect(() => captureCompleteMaintenanceRoots({
      candidateSnapshot: oversizedCandidateSnapshot,
      maintenanceRootEpoch: 1,
      policy: createMaintenancePolicy({ maxCandidateSegmentsPerBatch: 1 }),
      rootSets: { ...base, activeCommitRoots: [root({ offset: 64n, seed: 7 })] },
    })).toThrowError(expect.objectContaining({ code: "candidate_budget_exceeded" }));

    expect(() => captureCompleteMaintenanceRoots({
      candidateSnapshot: emptyCandidateSnapshot,
      maintenanceRootEpoch: 1,
      policy: createMaintenancePolicy(),
      rootSets: { ...base, activeCommitRoots: [] },
    })).toThrowError(MaintenanceRootCaptureError);
    expect(() => captureCompleteMaintenanceRoots({
      candidateSnapshot: emptyCandidateSnapshot,
      maintenanceRootEpoch: 1,
      policy: createMaintenancePolicy({ maxCapturedRoots: 1 }),
      rootSets: {
        ...base,
        activeCommitRoots: [root({ offset: 64n, seed: 1 })],
        relocationIndexRoots: [relocationRoot({ offset: 160n, seed: 2 })],
      },
    })).toThrowError(MaintenanceRootCaptureError);
  });
});
