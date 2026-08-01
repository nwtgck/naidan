import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPhysicalRecordReference,
  createUInt64,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  CandidateFrameOrdinalAuthorityError,
  createCandidateFrameOrdinalAuthority,
  resolveCandidateFrameOrdinal,
  sameCandidateFrameOrdinalAuthority,
  TEST_ONLY,
  type CandidateFrameOrdinalEntry,
} from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";

function segmentId({ seed }: { seed: number }) {
  return parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
}

function frame({ frameLength = 128, physicalOffset, recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page }: {
  frameLength?: number;
  physicalOffset: bigint;
  recordKind?: number;
}): CandidateFrameOrdinalEntry {
  return { frameLength, physicalOffset, recordKind };
}

function physicalReference({
  frameLength = 128,
  offset,
  recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
  seed = 1,
}: {
  frameLength?: number;
  offset: bigint;
  recordKind?: number;
  seed?: number;
}) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength,
    recordKind,
    segmentId: segmentId({ seed }),
  } });
}

describe("candidate frame ordinal authority", () => {
  it("maps exact authenticated frame references without offset arithmetic", () => {
    const authority = createCandidateFrameOrdinalAuthority({
      frames: [
        frame({ frameLength: 112, physicalOffset: 64n }),
        frame({ frameLength: 336, physicalOffset: 176n, recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data }),
        frame({ physicalOffset: 512n, recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page }),
      ],
      segmentId: segmentId({ seed: 1 }),
    });
    expect(resolveCandidateFrameOrdinal({
      authority,
      physicalReference: physicalReference({ frameLength: 112, offset: 64n }),
    })).toBe(0);
    expect(resolveCandidateFrameOrdinal({
      authority,
      physicalReference: physicalReference({
        frameLength: 336,
        offset: 176n,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      }),
    })).toBe(1);
    expect(resolveCandidateFrameOrdinal({
      authority,
      physicalReference: physicalReference({
        offset: 512n,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
      }),
    })).toBe(2);
    expect(resolveCandidateFrameOrdinal({ authority, physicalReference: physicalReference({ offset: 192n }) })).toBeUndefined();
    expect(resolveCandidateFrameOrdinal({
      authority,
      physicalReference: physicalReference({ frameLength: 120, offset: 64n }),
    })).toBeUndefined();
    expect(resolveCandidateFrameOrdinal({
      authority,
      physicalReference: physicalReference({
        frameLength: 112,
        offset: 64n,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      }),
    })).toBeUndefined();
    expect(resolveCandidateFrameOrdinal({
      authority,
      physicalReference: physicalReference({ frameLength: 112, offset: 64n, seed: 2 }),
    })).toBeUndefined();
  });

  it("detaches inputs and compares the exact authenticated table", () => {
    const id = segmentId({ seed: 1 });
    const frames = [frame({ physicalOffset: 64n }), frame({ physicalOffset: 192n })];
    const authority = createCandidateFrameOrdinalAuthority({ frames, segmentId: id });
    id.fill(9);
    const same = createCandidateFrameOrdinalAuthority({ frames, segmentId: segmentId({ seed: 1 }) });
    const changedOffset = createCandidateFrameOrdinalAuthority({
      frames: [frame({ physicalOffset: 64n }), frame({ physicalOffset: 200n })],
      segmentId: segmentId({ seed: 1 }),
    });
    const changedLength = createCandidateFrameOrdinalAuthority({
      frames: [frame({ frameLength: 136, physicalOffset: 64n }), frame({ physicalOffset: 192n })],
      segmentId: segmentId({ seed: 1 }),
    });
    const changedKind = createCandidateFrameOrdinalAuthority({
      frames: [frame({ physicalOffset: 64n, recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data }), frame({ physicalOffset: 192n })],
      segmentId: segmentId({ seed: 1 }),
    });
    expect(authority.segmentIdentity).toBe(same.segmentIdentity);
    expect(sameCandidateFrameOrdinalAuthority({ left: authority, right: same })).toBe(true);
    expect(sameCandidateFrameOrdinalAuthority({ left: authority, right: changedOffset })).toBe(false);
    expect(sameCandidateFrameOrdinalAuthority({ left: authority, right: changedLength })).toBe(false);
    expect(sameCandidateFrameOrdinalAuthority({ left: authority, right: changedKind })).toBe(false);
  });

  it.each([-1n, 56n, 65n, BigInt(TEST_ONLY.UINT32_MAXIMUM) + 1n])(
    "rejects an inadmissible V1 frame start at %s",
    physicalOffset => {
      expect(() => createCandidateFrameOrdinalAuthority({
        frames: [frame({ physicalOffset })],
        segmentId: segmentId({ seed: 1 }),
      })).toThrowError(expect.objectContaining<Partial<CandidateFrameOrdinalAuthorityError>>({
        code: "invalid_frame_offset",
      }));
    },
  );

  it.each([0, 127, TEST_ONLY.UINT32_MAXIMUM])("rejects an inadmissible frame length %s", frameLength => {
    expect(() => createCandidateFrameOrdinalAuthority({
      frames: [frame({ frameLength, physicalOffset: 64n })],
      segmentId: segmentId({ seed: 1 }),
    })).toThrowError(expect.objectContaining<Partial<CandidateFrameOrdinalAuthorityError>>({
      code: "invalid_frame_length",
    }));
  });

  it("rejects an unknown record kind", () => {
    expect(() => createCandidateFrameOrdinalAuthority({
      frames: [frame({ physicalOffset: 64n, recordKind: 0xff })],
      segmentId: segmentId({ seed: 1 }),
    })).toThrowError(expect.objectContaining<Partial<CandidateFrameOrdinalAuthorityError>>({
      code: "invalid_record_kind",
    }));
  });

  it.each([[64n, 64n], [128n, 64n]])("rejects non-increasing offsets", (...physicalOffsets) => {
    expect(() => createCandidateFrameOrdinalAuthority({
      frames: physicalOffsets.map(physicalOffset => frame({ physicalOffset })),
      segmentId: segmentId({ seed: 1 }),
    })).toThrowError(CandidateFrameOrdinalAuthorityError);
  });
});
