import { describe, expect, it } from "vitest";
import { DirtyResourceBudget } from "@/00-storage/service/hizofs/runtime/dirty-resource-budget";
import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY } from "@/00-storage/service/hizofs/runtime/runtime-policy";

function budget({ maximumAcceptedMutationsPerDirtyEpoch = 2, maximumDirtyMetadataBytes = 20, maximumUnpublishedPhysicalBytes = 30 } = {}) {
  return new DirtyResourceBudget({
    policy: {
      ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maximumAcceptedMutationsPerDirtyEpoch,
      maximumDirtyMetadataBytes,
      maximumUnpublishedPhysicalBytes,
    },
  });
}

describe("DirtyResourceBudget", () => {
  it("atomically transfers a reservation into accepted dirty resources", () => {
    const value = budget();
    const admission = value.reserveAdmission({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 11,
    });
    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 0,
      dirtyMetadataBytes: 7,
      pendingAdmissionCount: 1,
      unpublishedPhysicalBytes: 11,
    });

    admission.commitAccepted();

    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 1,
      dirtyMetadataBytes: 7,
      pendingAdmissionCount: 0,
      unpublishedPhysicalBytes: 11,
    });
  });

  it("atomically replaces a provisional reservation with exact measured resources", () => {
    const value = budget();
    const admission = value.reserveAdmission({
      dirtyMetadataBytes: 0,
      unpublishedPhysicalBytes: 0,
    });

    admission.replaceReservation({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 11,
    });

    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 0,
      dirtyMetadataBytes: 7,
      pendingAdmissionCount: 1,
      unpublishedPhysicalBytes: 11,
    });
    admission.commitAccepted();
    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 1,
      dirtyMetadataBytes: 7,
      pendingAdmissionCount: 0,
      unpublishedPhysicalBytes: 11,
    });
  });

  it("keeps the provisional reservation intact when exact measured resources exceed a limit", () => {
    const value = budget({ maximumDirtyMetadataBytes: 6 });
    const admission = value.reserveAdmission({
      dirtyMetadataBytes: 0,
      unpublishedPhysicalBytes: 0,
    });

    expect(() => admission.replaceReservation({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "dirty_metadata_byte_limit_reached" }));
    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 0,
      dirtyMetadataBytes: 0,
      pendingAdmissionCount: 1,
      unpublishedPhysicalBytes: 0,
    });

    admission.rollback();
    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 0,
      dirtyMetadataBytes: 0,
      pendingAdmissionCount: 0,
      unpublishedPhysicalBytes: 0,
    });
  });

  it("rolls back all reserved resources when candidate acceptance fails", () => {
    const value = budget();
    const admission = value.reserveAdmission({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 11,
    });

    admission.rollback();

    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 0,
      dirtyMetadataBytes: 0,
      pendingAdmissionCount: 0,
      unpublishedPhysicalBytes: 0,
    });
  });

  it("counts pending admissions against every hard limit", () => {
    const value = budget({
      maximumAcceptedMutationsPerDirtyEpoch: 1,
      maximumDirtyMetadataBytes: 7,
      maximumUnpublishedPhysicalBytes: 11,
    });
    void value.reserveAdmission({ dirtyMetadataBytes: 7, unpublishedPhysicalBytes: 11 });

    expect(() => value.reserveAdmission({ dirtyMetadataBytes: 0, unpublishedPhysicalBytes: 0 }))
      .toThrowError(expect.objectContaining({ code: "dirty_mutation_limit_reached" }));
  });

  it("reports the exact exhausted byte budget", () => {
    expect(() => budget({ maximumDirtyMetadataBytes: 6 }).reserveAdmission({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "dirty_metadata_byte_limit_reached" }));
    expect(() => budget({ maximumUnpublishedPhysicalBytes: 10 }).reserveAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 11,
    })).toThrowError(expect.objectContaining({ code: "unpublished_physical_byte_limit_reached" }));
  });

  it("rejects invalid and overflowing resource deltas", () => {
    const value = budget({ maximumDirtyMetadataBytes: Number.MAX_SAFE_INTEGER });
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => value.reserveAdmission({
        dirtyMetadataBytes: invalid,
        unpublishedPhysicalBytes: 0,
      })).toThrowError(expect.objectContaining({ code: "invalid_resource_delta" }));
    }
    const first = value.reserveAdmission({
      dirtyMetadataBytes: Number.MAX_SAFE_INTEGER,
      unpublishedPhysicalBytes: 0,
    });
    first.commitAccepted();
    expect(() => value.reserveAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 0,
    })).toThrowError(expect.objectContaining({ code: "invalid_resource_delta" }));
  });

  it("resets only after all admissions settle", () => {
    const value = budget();
    const admission = value.reserveAdmission({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 11,
    });
    expect(() => value.resetAfterDurablePublication()).toThrowError(expect.objectContaining({
      code: "publication_with_active_admission",
    }));
    admission.commitAccepted();

    value.resetAfterDurablePublication();

    expect(value.snapshot()).toEqual({
      acceptedMutationCount: 0,
      dirtyMetadataBytes: 0,
      pendingAdmissionCount: 0,
      unpublishedPhysicalBytes: 0,
    });
  });

  it("does not permit a reservation receipt to settle twice", () => {
    const value = budget();
    const admission = value.reserveAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    });
    admission.commitAccepted();

    expect(() => admission.rollback()).toThrowError(expect.objectContaining({ code: "admission_closed" }));
  });
});
