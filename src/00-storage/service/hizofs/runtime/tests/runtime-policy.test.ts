import { describe, expect, it } from "vitest";
import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY, createRuntimePolicy, resolvePublicationModeApplied } from "@/00-storage/service/hizofs/runtime/runtime-policy";

describe("HizoFS runtime policy", () => {
  it("freezes explicit non-persisted resource bounds", () => {
    const policy = createRuntimePolicy({
      lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    });
    expect(policy).toEqual({
      lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
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

  it("selects lazy publication by default and preserves explicit immediate publication", () => {
    expect(resolvePublicationModeApplied({
      publicationModeRequest: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY.publicationModeRequest,
    })).toBe("lazy_publication");
    expect(resolvePublicationModeApplied({
      publicationModeRequest: "immediate",
    })).toBe("immediate_publication");
  });

  it("rejects an unknown publication mode at the runtime boundary", () => {
    expect(() => createRuntimePolicy({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        publicationModeRequest: "unknown" as "automatic",
      },
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    })).toThrowError(expect.objectContaining({ code: "invalid_publication_mode_request" }));
  });
});
