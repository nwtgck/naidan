import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPhysicalRecordReference,
  createUInt64,
  parseSegmentId,
  segmentIdToLowercaseHex,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import {
  CandidateSegmentBatch,
  CandidateSegmentBatchError,
  type CapturedCandidateSegment,
} from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

function segmentId({ seed }: { seed: number }): SegmentId {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff) });
}

function candidate({ frameCount, seed, totalFrameBytes = frameCount * 128 }: {
  frameCount: number;
  seed: number;
  totalFrameBytes?: number;
}): CapturedCandidateSegment {
  const id = segmentId({ seed });
  return {
    frameCount,
    frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
      frames: Array.from({ length: frameCount }, (_, ordinal) => ({
        frameLength: 128,
        physicalOffset: 64n + BigInt(ordinal * 128),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      })),
      segmentId: id,
    }),
    ownership: "sealed",
    segmentId: id,
    totalFrameBytes,
  };
}

function physicalReference({ frameLength = 128, ordinal = 0, seed }: {
  frameLength?: number;
  ordinal?: number;
  seed: number;
}) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + BigInt(ordinal * 128) }),
    frameLength,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: segmentId({ seed }),
  } });
}

describe("candidate segment batch", () => {
  it("classifies whole-dead, partial-live, and all-live segments deterministically", () => {
    const batch = new CandidateSegmentBatch({
      candidates: [candidate({ frameCount: 2, seed: 41 }), candidate({ frameCount: 2, seed: 1 }), candidate({ frameCount: 2, seed: 21 })],
      policy: createMaintenancePolicy(),
    });
    expect(batch.markLive({ physicalReference: physicalReference({ seed: 21 }) })).toBe("marked");
    expect(batch.markLive({ physicalReference: physicalReference({ seed: 41 }) })).toBe("marked");
    expect(batch.markLive({ physicalReference: physicalReference({ ordinal: 1, seed: 41 }) })).toBe("marked");
    const plan = batch.plan();
    expect(plan.map(entry => [
      segmentIdToLowercaseHex({ id: entry.segmentId }),
      entry.disposition,
      entry.liveFrameCount,
      entry.liveBytes,
    ])).toEqual([
      [segmentIdToLowercaseHex({ id: segmentId({ seed: 1 }) }), "remove", 0, 0],
      [segmentIdToLowercaseHex({ id: segmentId({ seed: 21 }) }), "compact", 1, 128],
      [segmentIdToLowercaseHex({ id: segmentId({ seed: 41 }) }), "retain", 2, 256],
    ]);
  });

  it("ignores resolved records outside the current candidate batch", () => {
    const batch = new CandidateSegmentBatch({ candidates: [candidate({ frameCount: 1, seed: 1 })], policy: createMaintenancePolicy() });
    expect(batch.markLive({ physicalReference: physicalReference({ seed: 2 }) })).toBe("outside_batch");
    expect(batch.plan()[0]).toMatchObject({ disposition: "remove", liveFrameCount: 0 });
  });

  it("rejects a same-Segment reference absent from the authenticated frame table", () => {
    const batch = new CandidateSegmentBatch({ candidates: [candidate({ frameCount: 1, seed: 1 })], policy: createMaintenancePolicy() });
    expect(() => batch.markLive({ physicalReference: physicalReference({ ordinal: 1, seed: 1 }) }))
      .toThrowError(expect.objectContaining<Partial<CandidateSegmentBatchError>>({ code: "invalid_live_location" }));
  });

  it("counts duplicate references only once", () => {
    const batch = new CandidateSegmentBatch({ candidates: [candidate({ frameCount: 1, seed: 1 })], policy: createMaintenancePolicy() });
    expect(batch.markLive({ physicalReference: physicalReference({ seed: 1 }) })).toBe("marked");
    expect(batch.markLive({ physicalReference: physicalReference({ seed: 1 }) })).toBe("previously_marked");
    expect(batch.plan()[0]).toMatchObject({ liveBytes: 128, liveFrameCount: 1 });
  });

  it("rejects duplicate candidate identities", () => {
    expect(() => new CandidateSegmentBatch({
      candidates: [candidate({ frameCount: 1, seed: 1 }), candidate({ frameCount: 2, seed: 1 })],
      policy: createMaintenancePolicy(),
    })).toThrowError(CandidateSegmentBatchError);
  });

  it("rejects candidate batches beyond explicit count and bitset budgets", () => {
    expect(() => new CandidateSegmentBatch({
      candidates: [candidate({ frameCount: 1, seed: 1 }), candidate({ frameCount: 1, seed: 21 })],
      policy: createMaintenancePolicy({ maxCandidateSegmentsPerBatch: 1 }),
    })).toThrowError(CandidateSegmentBatchError);
    expect(() => new CandidateSegmentBatch({
      candidates: [candidate({ frameCount: HIZOFS_V1_FORMAT_CONSTANTS.limits.framesPerSegment, seed: 1 })],
      policy: createMaintenancePolicy({ maxBitsetBytesPerBatch: 8191, maxCandidateSegmentsPerBatch: 1 }),
    })).toThrowError();
    expect(() => new CandidateSegmentBatch({
      candidates: [candidate({ frameCount: 1, seed: 1 })],
      policy: createMaintenancePolicy({ maxFrameOrdinalAuthorityBytesPerBatch: 8 }),
    })).toThrowError(expect.objectContaining<Partial<CandidateSegmentBatchError>>({ code: "batch_budget_exceeded" }));
  });

  it("fails closed when marked frame bytes exceed the authenticated segment total", () => {
    const batch = new CandidateSegmentBatch({ candidates: [candidate({ frameCount: 1, seed: 1, totalFrameBytes: 100 })], policy: createMaintenancePolicy() });
    expect(() => batch.markLive({ physicalReference: physicalReference({ seed: 1 }) }))
      .toThrowError(CandidateSegmentBatchError);
  });
});
