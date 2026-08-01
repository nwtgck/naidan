import { describe, expect, it } from "vitest";
import { HIZOFS_V1_FORMAT_CONSTANTS, parseSegmentId } from "@/00-storage/service/hizofs/00-format";
import type { CapturedCandidateSegment } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  PreparedMaintenanceCandidateSnapshotError,
  prepareMaintenanceCandidateSnapshot,
} from "@/00-storage/service/hizofs/maintenance/prepared-maintenance-candidate-snapshot";

function candidate({ seed }: { seed: number }): CapturedCandidateSegment {
  const id = parseSegmentId({
    bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index),
  });
  return Object.freeze({
    frameCount: 2,
    frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
      frames: [64n, 192n].map(physicalOffset => ({
        frameLength: 128,
        physicalOffset,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      })),
      segmentId: id,
    }),
    ownership: "sealed",
    segmentId: id,
    totalFrameBytes: 256,
  });
}

describe("prepared maintenance candidate snapshot", () => {
  it("detaches and canonically orders one bounded candidate batch", () => {
    const second = candidate({ seed: 2 });
    const first = candidate({ seed: 1 });
    const prepared = prepareMaintenanceCandidateSnapshot({
      candidateSegments: [second, first],
      policy: createMaintenancePolicy({ maxCandidateSegmentsPerBatch: 2 }),
    });

    expect(prepared.candidateSegments.map(value => value.segmentId[0])).toEqual([1, 2]);
    second.segmentId.fill(255);
    expect(prepared.candidateSegments.map(value => value.segmentId[0])).toEqual([1, 2]);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.candidateSegments)).toBe(true);
    expect([...prepared.candidateSegments[0]!.frameOrdinalAuthority.copyPhysicalOffsets()]).toEqual([64, 192]);
  });

  it("allows an empty batch so a cycle can finish without deletion candidates", () => {
    expect(prepareMaintenanceCandidateSnapshot({
      candidateSegments: [],
      policy: createMaintenancePolicy(),
    }).candidateSegments).toEqual([]);
  });

  it("rejects exact frame authorities beyond the explicit resident-memory budget", () => {
    expect(() => prepareMaintenanceCandidateSnapshot({
      candidateSegments: [candidate({ seed: 1 })],
      policy: createMaintenancePolicy({ maxFrameOrdinalAuthorityBytesPerBatch: 17 }),
    })).toThrowError(expect.objectContaining<Partial<PreparedMaintenanceCandidateSnapshotError>>({
      code: "frame_ordinal_budget_exceeded",
    }));
  });

  it("rejects candidate count, identity, and authenticated-summary violations before the short gate", () => {
    const first = candidate({ seed: 1 });
    expect(() => prepareMaintenanceCandidateSnapshot({
      candidateSegments: [first, candidate({ seed: 2 })],
      policy: createMaintenancePolicy({ maxCandidateSegmentsPerBatch: 1 }),
    })).toThrowError(expect.objectContaining({ code: "candidate_budget_exceeded" }));

    expect(() => prepareMaintenanceCandidateSnapshot({
      candidateSegments: [first, first],
      policy: createMaintenancePolicy({ maxCandidateSegmentsPerBatch: 2 }),
    })).toThrowError(expect.objectContaining({ code: "duplicate_candidate" }));

    expect(() => prepareMaintenanceCandidateSnapshot({
      candidateSegments: [{ ...first, frameCount: 0 }],
      policy: createMaintenancePolicy(),
    })).toThrowError(expect.objectContaining({ code: "invalid_candidate" }));
  });
});
