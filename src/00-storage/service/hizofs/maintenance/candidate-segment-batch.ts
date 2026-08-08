import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  segmentIdToLowercaseHex,
  type PhysicalRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  cloneCandidateFrameOrdinalAuthority,
  resolveCandidateFrameOrdinal,
  type CandidateFrameOrdinalAuthority,
} from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import { SegmentLiveOrdinalBitset } from "@/00-storage/service/hizofs/maintenance/segment-live-ordinal-bitset";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

export type CandidateSegmentOwnership =
  | "abandoned_unsealed"
  | "footer_unusable"
  | "sealed";

export type CapturedCandidateSegment = Readonly<{
  frameCount: number;
  frameOrdinalAuthority: CandidateFrameOrdinalAuthority;
  ownership: CandidateSegmentOwnership;
  segmentId: SegmentId;
  totalFrameBytes: number;
}>;

export type CandidateSegmentDisposition =
  | "compact"
  | "remove"
  | "retain";

export type CandidateSegmentPlanEntry = Readonly<{
  disposition: CandidateSegmentDisposition;
  frameCount: number;
  liveBytes: number;
  liveFrameCount: number;
  ownership: CandidateSegmentOwnership;
  segmentId: SegmentId;
  totalFrameBytes: number;
}>;

export type CandidateSegmentBatchErrorCode =
  | "batch_budget_exceeded"
  | "duplicate_segment"
  | "invalid_candidate"
  | "invalid_live_location"
  | "live_bytes_exceeded";

export class CandidateSegmentBatchError extends Error {
  readonly code: CandidateSegmentBatchErrorCode;

  constructor({ code, message }: { code: CandidateSegmentBatchErrorCode; message: string }) {
    super(message);
    this.name = "CandidateSegmentBatchError";
    this.code = code;
  }
}

type CandidateState = {
  descriptor: CapturedCandidateSegment;
  liveBytes: number;
  liveOrdinals: SegmentLiveOrdinalBitset;
};

function validateCandidate({ candidate }: { candidate: CapturedCandidateSegment }): void {
  if (
    !Number.isSafeInteger(candidate.frameCount)
    || candidate.frameCount <= 0
    || candidate.frameCount > HIZOFS_V1_FORMAT_CONSTANTS.limits.framesPerSegment
    || candidate.frameOrdinalAuthority.frameCount !== candidate.frameCount
    || candidate.frameOrdinalAuthority.segmentIdentity !== segmentIdToLowercaseHex({ id: candidate.segmentId })
    || !Number.isSafeInteger(candidate.totalFrameBytes)
    || candidate.totalFrameBytes <= 0
  ) {
    throw new CandidateSegmentBatchError({
      code: "invalid_candidate",
      message: "candidate segment must have bounded positive frame and byte counts",
    });
  }
}

function detachedSegmentId({ segmentId }: { segmentId: SegmentId }): SegmentId {
  return Uint8Array.from(segmentId) as SegmentId;
}

export class CandidateSegmentBatch {
  private states: Map<string, CandidateState>;

  constructor({ candidates, policy }: {
    candidates: readonly CapturedCandidateSegment[];
    policy: HizoFSMaintenancePolicy;
  }) {
    if (candidates.length < 1 || candidates.length > policy.maxCandidateSegmentsPerBatch) {
      throw new CandidateSegmentBatchError({
        code: "batch_budget_exceeded",
        message: "candidate segment count exceeds the explicit batch bound",
      });
    }
    const states = new Map<string, CandidateState>();
    let bitsetBytes = 0;
    let frameOrdinalBytes = 0;
    for (const candidate of candidates) {
      validateCandidate({ candidate });
      const identity = segmentIdToLowercaseHex({ id: candidate.segmentId });
      if (states.has(identity)) {
        throw new CandidateSegmentBatchError({
          code: "duplicate_segment",
          message: "candidate batch contains the same physical segment more than once",
        });
      }
      const liveOrdinals = new SegmentLiveOrdinalBitset({ frameCount: candidate.frameCount });
      frameOrdinalBytes += candidate.frameOrdinalAuthority.byteLength;
      if (!Number.isSafeInteger(frameOrdinalBytes) || frameOrdinalBytes > policy.maxFrameOrdinalAuthorityBytesPerBatch) {
        throw new CandidateSegmentBatchError({
          code: "batch_budget_exceeded",
          message: "candidate frame ordinal authorities exceed the explicit batch memory budget",
        });
      }
      bitsetBytes += liveOrdinals.byteLength;
      if (!Number.isSafeInteger(bitsetBytes) || bitsetBytes > policy.maxBitsetBytesPerBatch) {
        throw new CandidateSegmentBatchError({
          code: "batch_budget_exceeded",
          message: "candidate ordinal bitsets exceed the explicit batch memory budget",
        });
      }
      states.set(identity, {
        descriptor: Object.freeze({
          ...candidate,
          frameOrdinalAuthority: cloneCandidateFrameOrdinalAuthority({ authority: candidate.frameOrdinalAuthority }),
          segmentId: detachedSegmentId({ segmentId: candidate.segmentId }),
        }),
        liveBytes: 0,
        liveOrdinals,
      });
    }
    this.states = new Map([...states.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  markLive({ physicalReference }: {
    physicalReference: PhysicalRecordReference;
  }): "marked" | "outside_batch" | "previously_marked" {
    const identity = segmentIdToLowercaseHex({ id: physicalReference.segmentId });
    const state = this.states.get(identity);
    if (state === undefined) return "outside_batch";
    const ordinal = resolveCandidateFrameOrdinal({
      authority: state.descriptor.frameOrdinalAuthority,
      physicalReference,
    });
    if (ordinal === undefined) {
      throw new CandidateSegmentBatchError({
        code: "invalid_live_location",
        message: "resolved record location is not present in the authenticated candidate frame table",
      });
    }
    let newlyMarked: boolean;
    try {
      newlyMarked = state.liveOrdinals.markLive({ ordinal });
    } catch (cause: unknown) {
      throw new CandidateSegmentBatchError({
        code: "invalid_live_location",
        message: `resolved record location is not present in the captured frame table: ${String(cause)}`,
      });
    }
    if (!newlyMarked) return "previously_marked";
    const nextLiveBytes = state.liveBytes + physicalReference.frameLength;
    if (!Number.isSafeInteger(nextLiveBytes) || nextLiveBytes > state.descriptor.totalFrameBytes) {
      throw new CandidateSegmentBatchError({
        code: "live_bytes_exceeded",
        message: "marked live frame bytes exceed the authenticated candidate frame total",
      });
    }
    state.liveBytes = nextLiveBytes;
    return "marked";
  }

  plan(): readonly CandidateSegmentPlanEntry[] {
    return Object.freeze([...this.states.values()].map(state => {
      const liveFrameCount = state.liveOrdinals.liveCount;
      const disposition: CandidateSegmentDisposition = liveFrameCount === 0
        ? "remove"
        : liveFrameCount === state.descriptor.frameCount
          ? "retain"
          : "compact";
      return Object.freeze({
        disposition,
        frameCount: state.descriptor.frameCount,
        liveBytes: state.liveBytes,
        liveFrameCount,
        ownership: state.descriptor.ownership,
        segmentId: detachedSegmentId({ segmentId: state.descriptor.segmentId }),
        totalFrameBytes: state.descriptor.totalFrameBytes,
      });
    }));
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
