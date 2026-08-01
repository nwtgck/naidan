import { HIZOFS_V1_FORMAT_CONSTANTS } from "@/00-storage/service/hizofs/00-format";

export type SegmentLiveOrdinalBitsetErrorCode =
  | "invalid_frame_count"
  | "invalid_ordinal";

export class SegmentLiveOrdinalBitsetError extends Error {
  readonly code: SegmentLiveOrdinalBitsetErrorCode;

  constructor({ code, message }: { code: SegmentLiveOrdinalBitsetErrorCode; message: string }) {
    super(message);
    this.name = "SegmentLiveOrdinalBitsetError";
    this.code = code;
  }
}

/**
 * Stores only one candidate segment ordinal set at a time. The format-owned
 * frame limit guarantees the allocation is at most 8,192 bytes; cycle-wide
 * liveness must never be accumulated in an unbounded Set.
 */
export class SegmentLiveOrdinalBitset {
  #bytes: Uint8Array;
  #frameCount: number;
  #liveCount = 0;

  constructor({ frameCount }: { frameCount: number }) {
    if (
      !Number.isSafeInteger(frameCount)
      || frameCount <= 0
      || frameCount > HIZOFS_V1_FORMAT_CONSTANTS.limits.framesPerSegment
    ) {
      throw new SegmentLiveOrdinalBitsetError({
        code: "invalid_frame_count",
        message: "frame count must be within the authoritative per-segment bound",
      });
    }
    this.#frameCount = frameCount;
    this.#bytes = new Uint8Array(Math.ceil(frameCount / 8));
  }

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  get liveCount(): number {
    return this.#liveCount;
  }

  #checkedOrdinal({ ordinal }: { ordinal: number }): number {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= this.#frameCount) {
      throw new SegmentLiveOrdinalBitsetError({
        code: "invalid_ordinal",
        message: "frame ordinal is outside the captured segment frame table",
      });
    }
    return ordinal;
  }

  #byteAt({ byteIndex }: { byteIndex: number }): number {
    const byte = this.#bytes[byteIndex];
    if (byte === undefined) {
      throw new SegmentLiveOrdinalBitsetError({
        code: "invalid_ordinal",
        message: "validated frame ordinal did not map to the allocated segment bitset",
      });
    }
    return byte;
  }

  isLive({ ordinal }: { ordinal: number }): boolean {
    const checked = this.#checkedOrdinal({ ordinal });
    return (this.#byteAt({ byteIndex: checked >>> 3 }) & (1 << (checked & 7))) !== 0;
  }

  markLive({ ordinal }: { ordinal: number }): boolean {
    const checked = this.#checkedOrdinal({ ordinal });
    const byteIndex = checked >>> 3;
    const mask = 1 << (checked & 7);
    const byte = this.#byteAt({ byteIndex });
    if ((byte & mask) !== 0) return false;
    this.#bytes[byteIndex] = byte | mask;
    this.#liveCount += 1;
    return true;
  }

  snapshotBytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
