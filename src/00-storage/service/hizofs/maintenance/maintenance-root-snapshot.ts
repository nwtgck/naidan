import { segmentIdToLowercaseHex } from "@/00-storage/service/hizofs/00-format";
import type { CapturedCandidateSegment } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import {
  cloneCandidateFrameOrdinalAuthority,
  sameCandidateFrameOrdinalAuthority,
} from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import {
  cloneMaintenanceTraversalItem,
  maintenanceTraversalItemIdentity,
  maintenanceTraversalReferenceIdentity,
  type MaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

export type MaintenanceRootSnapshot = Readonly<{
  candidateSegments: readonly CapturedCandidateSegment[];
  maintenanceRootEpoch: number;
  roots: readonly MaintenanceTraversalItem[];
}>;

export type MaintenanceRootValidationFailure =
  | "candidate_changed"
  | "candidate_missing"
  | "root_epoch_changed"
  | "root_set_changed";

export type MaintenanceRootValidationResult =
  | Readonly<{ valid: true }>
  | Readonly<{ reason: MaintenanceRootValidationFailure; valid: false }>;

export type MaintenanceRootSnapshotErrorCode =
  | "conflicting_root_role"
  | "duplicate_candidate"
  | "invalid_epoch";

export class MaintenanceRootSnapshotError extends Error {
  readonly code: MaintenanceRootSnapshotErrorCode;

  constructor({ code, message }: { code: MaintenanceRootSnapshotErrorCode; message: string }) {
    super(message);
    this.name = "MaintenanceRootSnapshotError";
    this.code = code;
  }
}

function cloneCandidate({ candidate }: { candidate: CapturedCandidateSegment }): CapturedCandidateSegment {
  return Object.freeze({
    ...candidate,
    frameOrdinalAuthority: cloneCandidateFrameOrdinalAuthority({ authority: candidate.frameOrdinalAuthority }),
    segmentId: Uint8Array.from(candidate.segmentId) as typeof candidate.segmentId,
  });
}

function candidateIdentity({ candidate }: { candidate: CapturedCandidateSegment }): string {
  return segmentIdToLowercaseHex({ id: candidate.segmentId });
}

export function createMaintenanceRootSnapshot({ candidateSegments, maintenanceRootEpoch, roots }: {
  candidateSegments: readonly CapturedCandidateSegment[];
  maintenanceRootEpoch: number;
  roots: readonly MaintenanceTraversalItem[];
}): MaintenanceRootSnapshot {
  if (!Number.isSafeInteger(maintenanceRootEpoch) || maintenanceRootEpoch < 0) {
    throw new MaintenanceRootSnapshotError({
      code: "invalid_epoch",
      message: "maintenance root epoch must be a non-negative safe integer",
    });
  }
  const uniqueRoots = new Map<string, MaintenanceTraversalItem>();
  const rolesByReference = new Map<string, MaintenanceTraversalItem["pageRole"]>();
  for (const item of roots) {
    const referenceIdentity = maintenanceTraversalReferenceIdentity({ item });
    const existingRole = rolesByReference.get(referenceIdentity);
    if (existingRole !== undefined && existingRole !== item.pageRole) {
      throw new MaintenanceRootSnapshotError({
        code: "conflicting_root_role",
        message: "maintenance root snapshot assigns conflicting page roles to one reference",
      });
    }
    rolesByReference.set(referenceIdentity, item.pageRole);
    uniqueRoots.set(maintenanceTraversalItemIdentity({ item }), cloneMaintenanceTraversalItem({ item }));
  }
  const candidates = new Map<string, CapturedCandidateSegment>();
  for (const candidate of candidateSegments) {
    const identity = candidateIdentity({ candidate });
    if (candidates.has(identity)) {
      throw new MaintenanceRootSnapshotError({
        code: "duplicate_candidate",
        message: "maintenance root snapshot contains one candidate segment more than once",
      });
    }
    candidates.set(identity, cloneCandidate({ candidate }));
  }
  return Object.freeze({
    candidateSegments: Object.freeze([...candidates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, candidate]) => candidate)),
    maintenanceRootEpoch,
    roots: Object.freeze([...uniqueRoots.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => item)),
  });
}

export function validateMaintenanceRootSnapshot({ captured, current }: {
  captured: MaintenanceRootSnapshot;
  current: MaintenanceRootSnapshot;
}): MaintenanceRootValidationResult {
  if (captured.maintenanceRootEpoch !== current.maintenanceRootEpoch) {
    return Object.freeze({ reason: "root_epoch_changed", valid: false });
  }
  const capturedRoots = captured.roots.map(item => maintenanceTraversalItemIdentity({ item }));
  const currentRoots = current.roots.map(item => maintenanceTraversalItemIdentity({ item }));
  if (capturedRoots.length !== currentRoots.length
    || capturedRoots.some((identity, index) => identity !== currentRoots[index])) {
    return Object.freeze({ reason: "root_set_changed", valid: false });
  }
  const currentCandidates = new Map(current.candidateSegments.map(candidate => [candidateIdentity({ candidate }), candidate]));
  for (const candidate of captured.candidateSegments) {
    const currentCandidate = currentCandidates.get(candidateIdentity({ candidate }));
    if (currentCandidate === undefined) return Object.freeze({ reason: "candidate_missing", valid: false });
    if (candidate.ownership !== currentCandidate.ownership
      || candidate.frameCount !== currentCandidate.frameCount
      || candidate.totalFrameBytes !== currentCandidate.totalFrameBytes
      || !sameCandidateFrameOrdinalAuthority({
        left: candidate.frameOrdinalAuthority,
        right: currentCandidate.frameOrdinalAuthority,
      })) {
      return Object.freeze({ reason: "candidate_changed", valid: false });
    }
  }
  return Object.freeze({ valid: true });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
