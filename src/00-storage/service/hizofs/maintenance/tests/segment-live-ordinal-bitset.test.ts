import { describe, expect, it } from "vitest";
import { HIZOFS_V1_FORMAT_CONSTANTS } from "@/00-storage/service/hizofs/00-format";
import { SegmentLiveOrdinalBitset, SegmentLiveOrdinalBitsetError } from "@/00-storage/service/hizofs/maintenance/segment-live-ordinal-bitset";

describe("segment live ordinal bitset", () => {
  it("uses exactly 8,192 bytes for the maximum authoritative frame count", () => {
    const marks = new SegmentLiveOrdinalBitset({
      frameCount: HIZOFS_V1_FORMAT_CONSTANTS.limits.framesPerSegment,
    });
    expect(marks.byteLength).toBe(8192);
    expect(marks.liveCount).toBe(0);
  });

  it("marks zero-based boundary ordinals idempotently", () => {
    const marks = new SegmentLiveOrdinalBitset({ frameCount: 9 });
    expect(marks.markLive({ ordinal: 0 })).toBe(true);
    expect(marks.markLive({ ordinal: 8 })).toBe(true);
    expect(marks.markLive({ ordinal: 8 })).toBe(false);
    expect(marks.isLive({ ordinal: 0 })).toBe(true);
    expect(marks.isLive({ ordinal: 7 })).toBe(false);
    expect(marks.isLive({ ordinal: 8 })).toBe(true);
    expect(marks.liveCount).toBe(2);
  });

  it.each([-1, 3, 1.5])("rejects out-of-range ordinal %s", ordinal => {
    const marks = new SegmentLiveOrdinalBitset({ frameCount: 3 });
    expect(() => marks.markLive({ ordinal })).toThrowError(SegmentLiveOrdinalBitsetError);
  });

  it("returns detached diagnostic bytes", () => {
    const marks = new SegmentLiveOrdinalBitset({ frameCount: 8 });
    marks.markLive({ ordinal: 1 });
    const snapshot = marks.snapshotBytes();
    snapshot[0] = 0;
    expect(marks.isLive({ ordinal: 1 })).toBe(true);
  });

  it.each([0, -1, 1.5, HIZOFS_V1_FORMAT_CONSTANTS.limits.framesPerSegment + 1])(
    "rejects invalid frame count %s",
    frameCount => {
      expect(() => new SegmentLiveOrdinalBitset({ frameCount }))
        .toThrowError(SegmentLiveOrdinalBitsetError);
    },
  );
});
