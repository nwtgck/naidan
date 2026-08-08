import type { HomeRecordReference, PhysicalRecordReference } from "@/00-storage/service/hizofs/00-format";
import type { PreparedMaintenanceCandidateSnapshot } from "@/00-storage/service/hizofs/maintenance/prepared-maintenance-candidate-snapshot";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  createLogicalMaintenanceTraversalItem,
  createPhysicalRelocationMaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";
import {
  createMaintenanceRootSnapshot,
  type MaintenanceRootSnapshot,
} from "@/00-storage/service/hizofs/maintenance/maintenance-root-snapshot";

export type CompleteMaintenanceRootSets = Readonly<{
  activeCommitRoots: readonly HomeRecordReference[];
  fallbackCommitRoots: readonly HomeRecordReference[];
  inspectorPinnedRoots: readonly HomeRecordReference[];
  readerPinnedRoots: readonly HomeRecordReference[];
  relocationIndexRoots: readonly PhysicalRecordReference[];
  unknownFeatureRoots: readonly HomeRecordReference[];
  writerDependencyRoots: readonly HomeRecordReference[];
  writerWorkingPageRoots: readonly HomeRecordReference[];
}>;

export type MaintenanceRootCategoryCounts = Readonly<{
  activeCommit: number;
  fallbackCommit: number;
  inspectorPinned: number;
  readerPinned: number;
  relocationIndex: number;
  unknownFeature: number;
  writerDependency: number;
  writerWorkingPage: number;
}>;

export type CompleteMaintenanceRootCapture = Readonly<{
  counts: MaintenanceRootCategoryCounts;
  snapshot: MaintenanceRootSnapshot;
}>;

export type MaintenanceRootCaptureErrorCode =
  | "candidate_budget_exceeded"
  | "captured_root_budget_exceeded"
  | "missing_active_authority";

export class MaintenanceRootCaptureError extends Error {
  readonly code: MaintenanceRootCaptureErrorCode;

  constructor({ code, message }: { code: MaintenanceRootCaptureErrorCode; message: string }) {
    super(message);
    this.name = "MaintenanceRootCaptureError";
    this.code = code;
  }
}

function rootCount({ rootSets }: { rootSets: CompleteMaintenanceRootSets }): number {
  return rootSets.activeCommitRoots.length
    + rootSets.fallbackCommitRoots.length
    + rootSets.inspectorPinnedRoots.length
    + rootSets.readerPinnedRoots.length
    + rootSets.relocationIndexRoots.length
    + rootSets.unknownFeatureRoots.length
    + rootSets.writerDependencyRoots.length
    + rootSets.writerWorkingPageRoots.length;
}

function logicalItems({ references }: { references: readonly HomeRecordReference[] }) {
  return references.map(reference => createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference }));
}

function logicalRootPageItems({ references }: { references: readonly HomeRecordReference[] }) {
  return references.map(reference => createLogicalMaintenanceTraversalItem({ pageRole: "root", reference }));
}

export function captureCompleteMaintenanceRoots({
  candidateSnapshot,
  maintenanceRootEpoch,
  policy,
  rootSets,
}: {
  candidateSnapshot: PreparedMaintenanceCandidateSnapshot;
  maintenanceRootEpoch: number;
  policy: HizoFSMaintenancePolicy;
  rootSets: CompleteMaintenanceRootSets;
}): CompleteMaintenanceRootCapture {
  if (candidateSnapshot.candidateSegments.length > policy.maxCandidateSegmentsPerBatch) {
    throw new MaintenanceRootCaptureError({
      code: "candidate_budget_exceeded",
      message: "maintenance root capture candidate snapshot exceeds the active policy bound",
    });
  }
  if (rootSets.activeCommitRoots.length < 1) {
    throw new MaintenanceRootCaptureError({
      code: "missing_active_authority",
      message: "maintenance root capture requires at least one active Commit authority root",
    });
  }
  const total = rootCount({ rootSets });
  if (!Number.isSafeInteger(total) || total > policy.maxCapturedRoots) {
    throw new MaintenanceRootCaptureError({
      code: "captured_root_budget_exceeded",
      message: "maintenance root capture exceeds the explicit total root bound",
    });
  }
  const counts: MaintenanceRootCategoryCounts = Object.freeze({
    activeCommit: rootSets.activeCommitRoots.length,
    fallbackCommit: rootSets.fallbackCommitRoots.length,
    inspectorPinned: rootSets.inspectorPinnedRoots.length,
    readerPinned: rootSets.readerPinnedRoots.length,
    relocationIndex: rootSets.relocationIndexRoots.length,
    unknownFeature: rootSets.unknownFeatureRoots.length,
    writerDependency: rootSets.writerDependencyRoots.length,
    writerWorkingPage: rootSets.writerWorkingPageRoots.length,
  });
  return Object.freeze({
    counts,
    snapshot: createMaintenanceRootSnapshot({
      candidateSegments: candidateSnapshot.candidateSegments,
      maintenanceRootEpoch,
      roots: [
        ...logicalItems({ references: rootSets.activeCommitRoots }),
        ...logicalItems({ references: rootSets.fallbackCommitRoots }),
        ...logicalItems({ references: rootSets.readerPinnedRoots }),
        ...logicalItems({ references: rootSets.inspectorPinnedRoots }),
        ...logicalItems({ references: rootSets.writerDependencyRoots }),
        ...logicalRootPageItems({ references: rootSets.writerWorkingPageRoots }),
        ...logicalItems({ references: rootSets.unknownFeatureRoots }),
        ...rootSets.relocationIndexRoots.map(reference => createPhysicalRelocationMaintenanceTraversalItem({
          pageRole: "root",
          reference,
        })),
      ],
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
