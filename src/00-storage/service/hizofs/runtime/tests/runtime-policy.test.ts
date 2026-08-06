import { describe, expect, it } from "vitest";
import { CURRENT_HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE, DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY, createRuntimePolicy, evaluateLazyPublicationRolloutGate, resolvePublicationModeApplied } from "@/00-storage/service/hizofs/runtime/runtime-policy";

describe("HizoFS runtime policy", () => {
  it("freezes explicit non-persisted memory and enumeration bounds", () => {
    const policy = createRuntimePolicy({
      lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maxDirectoryIteratorEntries: 64,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    });
    expect(policy).toEqual({
      lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maxDirectoryIteratorEntries: 64,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.lazyDurability)).toBe(true);
  });

  it("freezes the conservative lazy-durability defaults", () => {
    expect(DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY).toEqual({
      maximumAcceptedMutationsPerDirtyEpoch: 512,
      maximumDirtyAgeMilliseconds: 2_000,
      maximumDirtyMetadataBytes: 32 * 1_024 * 1_024,
      maximumMutationAdmissionWaiters: 128,
      maximumSyncWaiters: 128,
      maximumUnpublishedPhysicalBytes: 64 * 1_024 * 1_024,
      publicationModeRequest: "automatic",
    });
    expect(Object.isFrozen(DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY)).toBe(true);
  });

  it("rejects zero, negative, fractional, and unsafe bounds", () => {
    const baseline = {
      lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maxDirectoryIteratorEntries: 64,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    };
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createRuntimePolicy({ ...baseline, maxHeldLockNames: invalid }))
        .toThrowError(expect.objectContaining({ code: "invalid_runtime_limit" }));
      expect(() => createRuntimePolicy({
        ...baseline,
        lazyDurability: {
          ...baseline.lazyDurability,
          maximumSyncWaiters: invalid,
        },
      })).toThrowError(expect.objectContaining({ code: "invalid_runtime_limit" }));
    }
  });

  it("separates development activation blockers from release qualification gates", () => {
    expect(CURRENT_HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE).toEqual({
      developmentActivationQualified: true,
      missingDevelopmentActivationGates: [],
      missingReleaseQualificationGates: [
        "fault_campaign",
      ],
      releaseQualified: false,
    });
  });

  it("can activate the development path before release qualification", () => {
    const developmentQualified = evaluateLazyPublicationRolloutGate({
      evidence: {
        accepted_only_success_timing: true,
        active_head_maintenance_clean_head: false,
        bounded_dirty_resources: true,
        fault_campaign: false,
        generation_target_sync: true,
        production_background_publication: true,
        provider_graceful_shutdown: true,
        single_runtime_write_authority: true,
        transition_and_credential_clean_head: true,
      },
    });
    const releaseQualified = evaluateLazyPublicationRolloutGate({
      evidence: {
        accepted_only_success_timing: true,
        active_head_maintenance_clean_head: true,
        bounded_dirty_resources: true,
        fault_campaign: true,
        generation_target_sync: true,
        production_background_publication: true,
        provider_graceful_shutdown: true,
        single_runtime_write_authority: true,
        transition_and_credential_clean_head: true,
      },
    });
    expect(resolvePublicationModeApplied({
      lazyPublicationRollout: CURRENT_HIZOFS_LAZY_PUBLICATION_ROLLOUT_GATE,
      publicationModeRequest: "automatic",
      writableProfile: "development-unverified",
    })).toBe("lazy_publication_development");
    expect(resolvePublicationModeApplied({
      lazyPublicationRollout: developmentQualified,
      publicationModeRequest: "automatic",
      writableProfile: "development-unverified",
    })).toBe("lazy_publication_development");
    expect(resolvePublicationModeApplied({
      lazyPublicationRollout: developmentQualified,
      publicationModeRequest: "automatic",
      writableProfile: "release-qualified",
    })).toBe("lazy_publication_development");
    expect(resolvePublicationModeApplied({
      lazyPublicationRollout: releaseQualified,
      publicationModeRequest: "automatic",
      writableProfile: "release-qualified",
    })).toBe("lazy_publication_strict");
    expect(resolvePublicationModeApplied({
      lazyPublicationRollout: releaseQualified,
      publicationModeRequest: "immediate",
      writableProfile: "release-qualified",
    })).toBe("immediate_publication_requested");
  });

  it("rejects an unknown publication mode at the runtime boundary", () => {
    expect(() => createRuntimePolicy({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        publicationModeRequest: "unknown" as "automatic",
      },
      maxDirectoryIteratorEntries: 64,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    })).toThrowError(expect.objectContaining({ code: "invalid_publication_mode_request" }));
  });
});
