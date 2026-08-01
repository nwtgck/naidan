import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  segmentIdToLowercaseHex,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { CapturedCandidateSegment } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { cloneCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

declare const preparedMaintenanceCandidateSnapshotBrand: unique symbol;

/**
 * Detached, bounded candidate data prepared before the short root gate.
 *
 * Inventory traversal and Segment authentication are intentionally absent from
 * this type. The gate may clone this small immutable batch into the root
 * snapshot, but it must never perform directory traversal or record decoding.
 */
export type PreparedMaintenanceCandidateSnapshot = Readonly<{
  [preparedMaintenanceCandidateSnapshotBrand]: true;
  candidateSegments: readonly CapturedCandidateSegment[];
}>;

export type PreparedMaintenanceCandidateSnapshotErrorCode =
  | "candidate_budget_exceeded"
  | "duplicate_candidate"
  | "frame_ordinal_budget_exceeded"
  | "invalid_candidate";

export class PreparedMaintenanceCandidateSnapshotError extends Error {
  readonly code: PreparedMaintenanceCandidateSnapshotErrorCode;

  constructor({ code, message }: {
    code: PreparedMaintenanceCandidateSnapshotErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "PreparedMaintenanceCandidateSnapshotError";
    this.code = code;
  }
}

function assertCandidate({ candidate }: { candidate: CapturedCandidateSegment }): void {
  if (
    !Number.isSafeInteger(candidate.frameCount)
    || candidate.frameCount < 1
    || candidate.frameCount > HIZOFS_V1_FORMAT_CONSTANTS.limits.framesPerSegment
    || candidate.frameOrdinalAuthority.frameCount !== candidate.frameCount
    || candidate.frameOrdinalAuthority.segmentIdentity !== segmentIdToLowercaseHex({ id: candidate.segmentId })
    || !Number.isSafeInteger(candidate.totalFrameBytes)
    || candidate.totalFrameBytes < 1
  ) {
    throw new PreparedMaintenanceCandidateSnapshotError({
      code: "invalid_candidate",
      message: "prepared maintenance candidate must have bounded positive frame and byte counts",
    });
  }
  switch (candidate.ownership) {
  case "abandoned_unsealed":
  case "footer_unusable":
  case "sealed": return;
  default: return candidate.ownership satisfies never;
  }
}

function detachedCandidate({ candidate }: {
  candidate: CapturedCandidateSegment;
}): CapturedCandidateSegment {
  return Object.freeze({
    ...candidate,
    frameOrdinalAuthority: cloneCandidateFrameOrdinalAuthority({ authority: candidate.frameOrdinalAuthority }),
    segmentId: Uint8Array.from(candidate.segmentId) as SegmentId,
  });
}

export function prepareMaintenanceCandidateSnapshot({ candidateSegments, policy }: {
  candidateSegments: readonly CapturedCandidateSegment[];
  policy: HizoFSMaintenancePolicy;
}): PreparedMaintenanceCandidateSnapshot {
  if (candidateSegments.length > policy.maxCandidateSegmentsPerBatch) {
    throw new PreparedMaintenanceCandidateSnapshotError({
      code: "candidate_budget_exceeded",
      message: "prepared maintenance candidates exceed the explicit batch bound",
    });
  }
  const candidates = new Map<string, CapturedCandidateSegment>();
  let frameOrdinalBytes = 0;
  for (const candidate of candidateSegments) {
    assertCandidate({ candidate });
    frameOrdinalBytes += candidate.frameOrdinalAuthority.byteLength;
    if (!Number.isSafeInteger(frameOrdinalBytes) || frameOrdinalBytes > policy.maxFrameOrdinalAuthorityBytesPerBatch) {
      throw new PreparedMaintenanceCandidateSnapshotError({
        code: "frame_ordinal_budget_exceeded",
        message: "prepared candidate frame ordinal authorities exceed the explicit memory budget",
      });
    }
    const identity = segmentIdToLowercaseHex({ id: candidate.segmentId });
    if (candidates.has(identity)) {
      throw new PreparedMaintenanceCandidateSnapshotError({
        code: "duplicate_candidate",
        message: "prepared maintenance candidates contain one Segment ID more than once",
      });
    }
    candidates.set(identity, detachedCandidate({ candidate }));
  }
  return Object.freeze({
    candidateSegments: Object.freeze([...candidates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, candidate]) => candidate)),
  }) as PreparedMaintenanceCandidateSnapshot;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
