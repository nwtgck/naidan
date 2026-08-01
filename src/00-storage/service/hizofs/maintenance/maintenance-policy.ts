import { HIZOFS_V1_FORMAT_CONSTANTS } from "@/00-storage/service/hizofs/00-format";

const MAX_ORDINAL_BITSET_BYTES = Math.ceil(
  HIZOFS_V1_FORMAT_CONSTANTS.limits.framesPerSegment / 8,
);

export type MaintenancePolicyErrorCode =
  | "bitset_budget_exceeded"
  | "invalid_bound"
  | "remove_concurrency_exceeded";

export class MaintenancePolicyError extends Error {
  readonly code: MaintenancePolicyErrorCode;

  constructor({ code, message }: { code: MaintenancePolicyErrorCode; message: string }) {
    super(message);
    this.name = "MaintenancePolicyError";
    this.code = code;
  }
}

export type HizoFSMaintenancePolicy = Readonly<{
  enabled: boolean;
  maxBitsetBytesPerBatch: number;
  maxBytesReadPerCycle: number;
  maxCandidateSegmentsPerBatch: number;
  maxCapturedRoots: number;
  maxCompactionBytesPerSlice: number;
  maxCompletedMemoEntries: number;
  maxDecodedRecordsPerCycle: number;
  maxDecodedRecordsPerSlice: number;
  maxDiagnosticEvents: number;
  maxFollowedEdgesPerCycle: number;
  maxFrameOrdinalAuthorityBytesPerBatch: number;
  maxNewReferencesPerSlice: number;
  maxRelocationIndexPages: number;
  maxRemovalsPerSlice: number;
  maxRevisitsPerCycle: number;
  maxTraversalDepth: number;
  removeConcurrency: number;
  softSliceMilliseconds: number;
}>;

function positiveSafeInteger({ name, value }: { name: string; value: number }): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MaintenancePolicyError({
      code: "invalid_bound",
      message: `${name} must be a positive safe integer`,
    });
  }
  return value;
}

/**
 * Maintenance is disabled by default because reclaim is optional for
 * correctness. Enabling it never weakens the explicit memory/work bounds; an
 * uncertain cycle must retain bytes and abort without deletion.
 */
export function createMaintenancePolicy({
  enabled = false,
  maxBitsetBytesPerBatch = 64 * MAX_ORDINAL_BITSET_BYTES,
  maxBytesReadPerCycle = 1024 * 1024 * 1024,
  maxCandidateSegmentsPerBatch = 64,
  maxCapturedRoots = 4096,
  maxCompactionBytesPerSlice = 4 * 1024 * 1024,
  maxCompletedMemoEntries = 4096,
  maxDecodedRecordsPerCycle = 1_000_000,
  maxDecodedRecordsPerSlice = 256,
  maxDiagnosticEvents = 512,
  maxFollowedEdgesPerCycle = 4_000_000,
  maxFrameOrdinalAuthorityBytesPerBatch = 4 * 1024 * 1024,
  maxNewReferencesPerSlice = 1024,
  maxRelocationIndexPages = 4096,
  maxRemovalsPerSlice = 4,
  maxRevisitsPerCycle = 250_000,
  maxTraversalDepth = 4096,
  removeConcurrency = 1,
  softSliceMilliseconds = 8,
}: Partial<HizoFSMaintenancePolicy> = {}): HizoFSMaintenancePolicy {
  const policy = {
    enabled,
    maxBitsetBytesPerBatch: positiveSafeInteger({ name: "maxBitsetBytesPerBatch", value: maxBitsetBytesPerBatch }),
    maxBytesReadPerCycle: positiveSafeInteger({ name: "maxBytesReadPerCycle", value: maxBytesReadPerCycle }),
    maxCandidateSegmentsPerBatch: positiveSafeInteger({ name: "maxCandidateSegmentsPerBatch", value: maxCandidateSegmentsPerBatch }),
    maxCapturedRoots: positiveSafeInteger({ name: "maxCapturedRoots", value: maxCapturedRoots }),
    maxCompactionBytesPerSlice: positiveSafeInteger({ name: "maxCompactionBytesPerSlice", value: maxCompactionBytesPerSlice }),
    maxCompletedMemoEntries: positiveSafeInteger({ name: "maxCompletedMemoEntries", value: maxCompletedMemoEntries }),
    maxDecodedRecordsPerCycle: positiveSafeInteger({ name: "maxDecodedRecordsPerCycle", value: maxDecodedRecordsPerCycle }),
    maxDecodedRecordsPerSlice: positiveSafeInteger({ name: "maxDecodedRecordsPerSlice", value: maxDecodedRecordsPerSlice }),
    maxDiagnosticEvents: positiveSafeInteger({ name: "maxDiagnosticEvents", value: maxDiagnosticEvents }),
    maxFollowedEdgesPerCycle: positiveSafeInteger({ name: "maxFollowedEdgesPerCycle", value: maxFollowedEdgesPerCycle }),
    maxFrameOrdinalAuthorityBytesPerBatch: positiveSafeInteger({ name: "maxFrameOrdinalAuthorityBytesPerBatch", value: maxFrameOrdinalAuthorityBytesPerBatch }),
    maxNewReferencesPerSlice: positiveSafeInteger({ name: "maxNewReferencesPerSlice", value: maxNewReferencesPerSlice }),
    maxRelocationIndexPages: positiveSafeInteger({ name: "maxRelocationIndexPages", value: maxRelocationIndexPages }),
    maxRemovalsPerSlice: positiveSafeInteger({ name: "maxRemovalsPerSlice", value: maxRemovalsPerSlice }),
    maxRevisitsPerCycle: positiveSafeInteger({ name: "maxRevisitsPerCycle", value: maxRevisitsPerCycle }),
    maxTraversalDepth: positiveSafeInteger({ name: "maxTraversalDepth", value: maxTraversalDepth }),
    removeConcurrency: positiveSafeInteger({ name: "removeConcurrency", value: removeConcurrency }),
    softSliceMilliseconds: positiveSafeInteger({ name: "softSliceMilliseconds", value: softSliceMilliseconds }),
  };
  if (
    policy.maxCandidateSegmentsPerBatch
    > Math.floor(policy.maxBitsetBytesPerBatch / MAX_ORDINAL_BITSET_BYTES)
  ) {
    throw new MaintenancePolicyError({
      code: "bitset_budget_exceeded",
      message: "candidate batch worst-case ordinal bitsets exceed the explicit memory budget",
    });
  }
  if (policy.removeConcurrency > policy.maxRemovalsPerSlice) {
    throw new MaintenancePolicyError({
      code: "remove_concurrency_exceeded",
      message: "remove concurrency cannot exceed maximum removals per slice",
    });
  }
  return Object.freeze(policy);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  MAX_ORDINAL_BITSET_BYTES,
};
