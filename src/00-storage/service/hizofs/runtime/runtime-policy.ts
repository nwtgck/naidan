export type HizoFSPublicationModeRequest =
  | "automatic"
  | "immediate";

export type HizoFSPublicationModeApplied =
  | "immediate_publication"
  | "lazy_publication";

export type HizoFSWritableDurabilityProfile =
  | "development-unverified"
  | "release-qualified";


export type HizoFSLazyDurabilityPolicy = Readonly<{
  maximumAcceptedMutationsPerDirtyEpoch: number;
  maximumDirtyAgeMilliseconds: number;
  maximumDirtyMetadataBytes: number;
  maximumMutationAdmissionWaiters: number;
  maximumSyncWaiters: number;
  maximumUnpublishedPhysicalBytes: number;
  publicationModeRequest: HizoFSPublicationModeRequest;
}>;

export type HizoFSRuntimePolicy = Readonly<{
  lazyDurability: HizoFSLazyDurabilityPolicy;
  maxDirectoryIteratorEntries: number;
  maxHeldLockNames: number;
  maxMaintenanceRootRegistrations: number;
  maxReaderPins: number;
  maxSegmentReferences: number;
}>;

export const DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY: HizoFSLazyDurabilityPolicy = Object.freeze({
  maximumAcceptedMutationsPerDirtyEpoch: 512,
  maximumDirtyAgeMilliseconds: 2_000,
  maximumDirtyMetadataBytes: 32 * 1_024 * 1_024,
  maximumMutationAdmissionWaiters: 128,
  maximumSyncWaiters: 128,
  maximumUnpublishedPhysicalBytes: 64 * 1_024 * 1_024,
  publicationModeRequest: "automatic",
});

export type HizoFSRuntimePolicyErrorCode =
  | "invalid_publication_mode_request"
  | "invalid_runtime_limit";

export class HizoFSRuntimePolicyError extends Error {
  readonly code: HizoFSRuntimePolicyErrorCode;

  constructor({ code, message }: {
    code: HizoFSRuntimePolicyErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "HizoFSRuntimePolicyError";
    this.code = code;
  }
}

function validateLimit({ name, value }: { name: string; value: number }): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HizoFSRuntimePolicyError({
      code: "invalid_runtime_limit",
      message: `${name} must be a positive safe integer`,
    });
  }
}

function validatePublicationModeRequest({ value }: { value: HizoFSPublicationModeRequest }): void {
  switch (value) {
  case "automatic":
  case "immediate": return;
  default: throw new HizoFSRuntimePolicyError({
    code: "invalid_publication_mode_request",
    message: "publicationModeRequest must be automatic or immediate",
  });
  }
}


// Publication timing is independent of the backend's sync durability guarantee.
export function resolvePublicationModeApplied({
  publicationModeRequest,
}: {
  publicationModeRequest: HizoFSPublicationModeRequest;
}): HizoFSPublicationModeApplied {
  switch (publicationModeRequest) {
  case "immediate": return "immediate_publication";
  case "automatic": return "lazy_publication";
  default: return publicationModeRequest satisfies never;
  }
}

/**
 * Runtime tuning is deliberately explicit and never persisted. Validating all
 * bounds at composition time prevents a typo from silently disabling memory
 * limits in a later iterator, pin, Segment, lock, or lazy-publication path.
 */
export function createRuntimePolicy({
  lazyDurability,
  maxDirectoryIteratorEntries,
  maxHeldLockNames,
  maxMaintenanceRootRegistrations,
  maxReaderPins,
  maxSegmentReferences,
}: HizoFSRuntimePolicy): HizoFSRuntimePolicy {
  validateLimit({ name: "maxDirectoryIteratorEntries", value: maxDirectoryIteratorEntries });
  validateLimit({ name: "maxHeldLockNames", value: maxHeldLockNames });
  validateLimit({ name: "maxMaintenanceRootRegistrations", value: maxMaintenanceRootRegistrations });
  validateLimit({ name: "maxReaderPins", value: maxReaderPins });
  validateLimit({ name: "maxSegmentReferences", value: maxSegmentReferences });
  validateLimit({
    name: "lazyDurability.maximumAcceptedMutationsPerDirtyEpoch",
    value: lazyDurability.maximumAcceptedMutationsPerDirtyEpoch,
  });
  validateLimit({
    name: "lazyDurability.maximumDirtyAgeMilliseconds",
    value: lazyDurability.maximumDirtyAgeMilliseconds,
  });
  validateLimit({
    name: "lazyDurability.maximumDirtyMetadataBytes",
    value: lazyDurability.maximumDirtyMetadataBytes,
  });
  validateLimit({
    name: "lazyDurability.maximumMutationAdmissionWaiters",
    value: lazyDurability.maximumMutationAdmissionWaiters,
  });
  validateLimit({
    name: "lazyDurability.maximumSyncWaiters",
    value: lazyDurability.maximumSyncWaiters,
  });
  validateLimit({
    name: "lazyDurability.maximumUnpublishedPhysicalBytes",
    value: lazyDurability.maximumUnpublishedPhysicalBytes,
  });
  validatePublicationModeRequest({ value: lazyDurability.publicationModeRequest });
  return Object.freeze({
    lazyDurability: Object.freeze({ ...lazyDurability }),
    maxDirectoryIteratorEntries,
    maxHeldLockNames,
    maxMaintenanceRootRegistrations,
    maxReaderPins,
    maxSegmentReferences,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
