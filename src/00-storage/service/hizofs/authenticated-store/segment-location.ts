import {
  assertSegmentPathBinding,
  segmentIdToRelativePath,
  type SegmentClass,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import {
  canonicalContainerPath,
  type CanonicalContainerPath,
} from "@/00-storage/service/hizofs/physical-store/paths";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";

export function authenticatedSegmentPath({ segmentClass, segmentId }: {
  segmentClass: SegmentClass;
  segmentId: SegmentId;
}): CanonicalContainerPath {
  const relativePath = segmentIdToRelativePath({ id: segmentId, segmentClass });
  assertSegmentPathBinding({ id: segmentId, relativePath, segmentClass });
  return canonicalContainerPath({ value: relativePath });
}

export async function segmentIdIsUsedAcrossClasses({ backend, segmentId }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  segmentId: SegmentId;
}): Promise<boolean> {
  // Segment ID is one global identity space. Reusing the same ID in the other
  // class would make the canonical class path ambiguous to later maintenance.
  return await backend.getFileSize({
    path: authenticatedSegmentPath({ segmentClass: "metadata", segmentId }),
  }) !== undefined || await backend.getFileSize({
    path: authenticatedSegmentPath({ segmentClass: "data", segmentId }),
  }) !== undefined;
}

export async function segmentIdIsUsedInOtherClass({ backend, segmentClass, segmentId }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  segmentClass: SegmentClass;
  segmentId: SegmentId;
}): Promise<boolean> {
  const otherClass: SegmentClass = (() => {
    switch (segmentClass) {
    case "metadata": return "data";
    case "data": return "metadata";
    default: return segmentClass satisfies never;
    }
  })();
  return await backend.getFileSize({
    path: authenticatedSegmentPath({ segmentClass: otherClass, segmentId }),
  }) !== undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
