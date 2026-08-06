export type HizoFSPublicationModeRequest =
  | "automatic"
  | "immediate";

export type HizoFSPublicationModeApplied =
  | "immediate_publication_requested"
  | "immediate_publication_unqualified"
  | "lazy_publication_development"
  | "lazy_publication_strict";

export type HizoFSWritableDurabilityProfile =
  | "development-unverified"
  | "release-qualified";

export type HizoFSLazyPublicationRolloutGateId =
  | "accepted_only_success_timing"
  | "active_head_maintenance_clean_head"
  | "bounded_dirty_resources"
  | "fault_campaign"
  | "generation_target_sync"
  | "production_background_publication"
  | "provider_graceful_shutdown"
  | "single_runtime_write_authority"
  | "transition_and_credential_clean_head";

export type HizoFSLazyPublicationRolloutEvidence = Readonly<Record<
  HizoFSLazyPublicationRolloutGateId,
  boolean
>>;

export type HizoFSLazyPublicationRolloutGateReceipt = Readonly<{
  developmentActivationQualified: boolean;
  missingDevelopmentActivationGates: readonly HizoFSLazyPublicationRolloutGateId[];
  missingReleaseQualificationGates: readonly HizoFSLazyPublicationRolloutGateId[];
  releaseQualified: boolean;
}>;

const HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE_ORDER = Object.freeze([
  "accepted_only_success_timing",
  "production_background_publication",
  "generation_target_sync",
  "bounded_dirty_resources",
  "single_runtime_write_authority",
  "transition_and_credential_clean_head",
  "active_head_maintenance_clean_head",
  "provider_graceful_shutdown",
  "fault_campaign",
] as const satisfies readonly HizoFSLazyPublicationRolloutGateId[]);

const HIZOFS_LAZY_PUBLICATION_DEVELOPMENT_ACTIVATION_GATES = Object.freeze([
  "accepted_only_success_timing",
  "production_background_publication",
] as const satisfies readonly HizoFSLazyPublicationRolloutGateId[]);

export function evaluateLazyPublicationRolloutGate({ evidence }: {
  evidence: HizoFSLazyPublicationRolloutEvidence;
}): HizoFSLazyPublicationRolloutGateReceipt {
  const missingDevelopmentActivationGates = HIZOFS_LAZY_PUBLICATION_DEVELOPMENT_ACTIVATION_GATES
    .filter((gate) => !evidence[gate]);
  const missingReleaseQualificationGates = HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE_ORDER
    .filter((gate) => !evidence[gate]);
  return Object.freeze({
    developmentActivationQualified: missingDevelopmentActivationGates.length === 0,
    missingDevelopmentActivationGates: Object.freeze(missingDevelopmentActivationGates),
    missingReleaseQualificationGates: Object.freeze(missingReleaseQualificationGates),
    releaseQualified: missingReleaseQualificationGates.length === 0,
  });
}

/**
 * This receipt is owned by production source rather than a caller-supplied
 * option. Development-path activation is intentionally separated from release
 * qualification so the real mutation path can be exercised once its concrete
 * runtime prerequisites are green without pretending that release evidence is
 * complete.
 */
export const CURRENT_HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE = evaluateLazyPublicationRolloutGate({
  evidence: Object.freeze({
    accepted_only_success_timing: true,
    active_head_maintenance_clean_head: true,
    bounded_dirty_resources: true,
    fault_campaign: false,
    generation_target_sync: true,
    production_background_publication: true,
    provider_graceful_shutdown: true,
    single_runtime_write_authority: true,
    transition_and_credential_clean_head: true,
  }),
});

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


export function resolvePublicationModeApplied({
  lazyPublicationRollout,
  publicationModeRequest,
  writableProfile,
}: {
  lazyPublicationRollout: HizoFSLazyPublicationRolloutGateReceipt;
  publicationModeRequest: HizoFSPublicationModeRequest;
  writableProfile: HizoFSWritableDurabilityProfile;
}): HizoFSPublicationModeApplied {
  switch (publicationModeRequest) {
  case "immediate": return "immediate_publication_requested";
  case "automatic":
    if (!lazyPublicationRollout.developmentActivationQualified) {
      return "immediate_publication_unqualified";
    }
    if (writableProfile === "release-qualified" && lazyPublicationRollout.releaseQualified) {
      return "lazy_publication_strict";
    }
    return "lazy_publication_development";
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
