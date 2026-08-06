import type {
  InodeNumber,
  InodeRevision,
  SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";
import {
  sameWorkingGenerationIdentity,
  type WorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";

export type CapturedWriterIdentity = Readonly<{
  baseWorkingGeneration: WorkingGenerationIdentity;
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  subvolumeId: SubvolumeId;
}>;

export type CurrentWriterPublicationState = Readonly<{
  workingGeneration: WorkingGenerationIdentity;
  inode: Readonly<{
    inodeNumber: InodeNumber;
    inodeRevision: InodeRevision;
    subvolumeId: SubvolumeId;
  }> | null;
  ordinaryDirectoryEntryReachability: number;
}>;

export type WriterPublicationConflictReason =
  | "working_generation_changed"
  | "inode_revision_changed"
  | "inode_unlinked_or_replaced"
  | "ordinary_reachability_invalid";

export type WriterPublicationEligibility =
  | Readonly<{ type: "eligible" }>
  | Readonly<{ reason: WriterPublicationConflictReason; type: "conflict" }>;

export function evaluateWriterPublicationEligibility({ captured, current }: {
  captured: CapturedWriterIdentity;
  current: CurrentWriterPublicationState;
}): WriterPublicationEligibility {
  if (!sameWorkingGenerationIdentity({
    left: current.workingGeneration,
    right: captured.baseWorkingGeneration,
  })) {
    return { reason: "working_generation_changed", type: "conflict" };
  }
  if (current.inode === null
    || current.inode.inodeNumber !== captured.inodeNumber
    || current.inode.subvolumeId !== captured.subvolumeId) {
    return { reason: "inode_unlinked_or_replaced", type: "conflict" };
  }
  if (current.inode.inodeRevision !== captured.inodeRevision) {
    return { reason: "inode_revision_changed", type: "conflict" };
  }
  if (current.ordinaryDirectoryEntryReachability !== 1) {
    return { reason: "ordinary_reachability_invalid", type: "conflict" };
  }
  return { type: "eligible" };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
