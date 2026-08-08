import { describe, expect, it } from "vitest";
import {
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import { createTestingWorkingCandidateIdentities } from "@/00-storage/service/hizofs/runtime/testing/working-generation-identity-fixture";
import { WorkingGenerationCoordinator } from "@/00-storage/service/hizofs/runtime/working-generation-coordinator";

function values() {
  const { durable, working } = createTestingWorkingCandidateIdentities();
  const initial = createWorkingGenerationIdentity({
    authorityEpoch: working.authorityEpoch,
    generationNumber: createWorkingGenerationNumber({ value: 0n }),
    mutationId: durable.mutationId,
  });
  const first = createSuccessorWorkingGenerationIdentity({
    mutationId: working.mutationId,
    previous: initial,
  });
  const second = createSuccessorWorkingGenerationIdentity({
    mutationId: first.mutationId,
    previous: first,
  });
  return { first, initial, second };
}

function coordinator({ initial = values().initial } = {}) {
  return new WorkingGenerationCoordinator({
    initialDurableGeneration: initial,
    policy: {
      ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maximumAcceptedMutationsPerDirtyEpoch: 2,
      maximumDirtyMetadataBytes: 20,
      maximumSyncWaiters: 2,
      maximumUnpublishedPhysicalBytes: 30,
    },
  });
}

describe("WorkingGenerationCoordinator", () => {
  it("captures the current working generation as a sync target", () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    expect(value.captureSyncTarget()).toEqual(initial);

    value.openMutationAdmission({ dirtyMetadataBytes: 7, unpublishedPhysicalBytes: 11 })
      .accept({ workingGeneration: first });

    expect(value.captureSyncTarget()).toEqual(first);
  });

  it("transfers exact measured resources before accepting a generation", () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    const admission = value.openMutationAdmission({
      dirtyMetadataBytes: 0,
      unpublishedPhysicalBytes: 0,
    });

    admission.replaceResourceReservation({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 11,
    });
    admission.accept({ workingGeneration: first });

    expect(value.snapshot().dirtyResources).toEqual({
      acceptedMutationCount: 1,
      dirtyMetadataBytes: 7,
      pendingAdmissionCount: 0,
      stagedCommitMaterializationHeadroomBytes: 0,
      unpublishedPhysicalBytes: 11,
    });
  });

  it("serializes mutation admission and rolls back failed preparation", () => {
    const value = coordinator();
    const admission = value.openMutationAdmission({
      dirtyMetadataBytes: 7,
      unpublishedPhysicalBytes: 11,
    });
    expect(() => value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "working_authority_busy" }));

    admission.rollback();

    expect(value.snapshot().dirtyResources).toEqual({
      acceptedMutationCount: 0,
      dirtyMetadataBytes: 0,
      pendingAdmissionCount: 0,
      stagedCommitMaterializationHeadroomBytes: 0,
      unpublishedPhysicalBytes: 0,
    });
  });

  it("accepts only the exact next authority-epoch generation", () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    const admission = value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    });
    expect(() => admission.accept({ workingGeneration: initial })).toThrowError(
      expect.objectContaining({ code: "working_generation_changed" }),
    );

    admission.accept({ workingGeneration: first });

    expect(value.snapshot().workingGeneration).toEqual(first);
  });

  it("resolves a waiter only after its target becomes durable", async () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    value.openMutationAdmission({ dirtyMetadataBytes: 7, unpublishedPhysicalBytes: 11 })
      .accept({ workingGeneration: first });
    const target = value.captureSyncTarget();
    let resolved = false;
    const waiter = value.waitForSyncTarget({ target }).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    value.openFlush().complete({ durableGeneration: first });
    await waiter;

    expect(resolved).toBe(true);
    expect(value.snapshot()).toEqual({
      dirtyResources: {
        acceptedMutationCount: 0,
        dirtyMetadataBytes: 0,
        pendingAdmissionCount: 0,
        stagedCommitMaterializationHeadroomBytes: 0,
        unpublishedPhysicalBytes: 0,
      },
      durableGeneration: first,
      flushState: "idle",
      managementBarrierActive: false,
      syncWaiterCount: 0,
      workingGeneration: first,
    });
  });

  it("rejects publication of an older candidate when a newer generation is working", () => {
    const { first, initial, second } = values();
    const value = coordinator({ initial });
    value.openMutationAdmission({ dirtyMetadataBytes: 1, unpublishedPhysicalBytes: 1 })
      .accept({ workingGeneration: first });
    value.openMutationAdmission({ dirtyMetadataBytes: 1, unpublishedPhysicalBytes: 1 })
      .accept({ workingGeneration: second });

    const flush = value.openFlush();
    expect(() => flush.complete({ durableGeneration: first }))
      .toThrowError(expect.objectContaining({ code: "durable_generation_not_current" }));
    flush.fail({ cause: new Error("selected candidate was stale") });
    expect(value.snapshot().durableGeneration.generationNumber).toBe(0n);
  });

  it("gates mutation acceptance during flush and permits an explicit stalled retry", async () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    value.openMutationAdmission({ dirtyMetadataBytes: 1, unpublishedPhysicalBytes: 1 })
      .accept({ workingGeneration: first });
    const waiter = value.waitForSyncTarget({ target: first });
    const firstFlush = value.openFlush();

    expect(firstFlush.target).toEqual(first);
    expect(value.snapshot().flushState).toBe("flushing");
    expect(() => value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "working_authority_busy" }));

    const cause = new Error("durable publication failed");
    firstFlush.fail({ cause });
    await expect(waiter).rejects.toBe(cause);
    expect(value.snapshot().flushState).toBe("stalled");
    expect(() => value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "durability_stalled" }));

    value.openFlush().complete({ durableGeneration: first });
    expect(value.snapshot().flushState).toBe("idle");
    expect(value.snapshot().durableGeneration).toEqual(first);
  });

  it("does not open a flush while mutation admission owns the authority", () => {
    const value = coordinator();
    const admission = value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    });

    expect(() => value.openFlush()).toThrowError(
      expect.objectContaining({ code: "working_authority_busy" }),
    );
    admission.rollback();
  });

  it("rejects all current sync waiters on a confirmed publication failure", async () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    value.openMutationAdmission({ dirtyMetadataBytes: 1, unpublishedPhysicalBytes: 1 })
      .accept({ workingGeneration: first });
    const waiter = value.waitForSyncTarget({ target: first });
    const cause = new Error("durable publication failed");

    value.openFlush().fail({ cause });

    await expect(waiter).rejects.toBe(cause);
    expect(value.snapshot().flushState).toBe("stalled");
    expect(value.snapshot().syncWaiterCount).toBe(0);
    expect(value.snapshot().workingGeneration).toEqual(first);
  });
  it("holds a clean-head management barrier across flush and authority switch work", () => {
    const { first, initial, second } = values();
    const value = coordinator({ initial });
    value.openMutationAdmission({ dirtyMetadataBytes: 1, unpublishedPhysicalBytes: 1 })
      .accept({ workingGeneration: first });

    const barrier = value.openManagementBarrier();
    expect(barrier.target).toEqual(first);
    expect(() => value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "management_barrier_active" }));
    expect(() => value.openFlush()).toThrowError(
      expect.objectContaining({ code: "management_barrier_active" }),
    );
    expect(() => barrier.close()).toThrowError(
      expect.objectContaining({ code: "management_head_not_clean" }),
    );

    barrier.openFlush().complete({ durableGeneration: first });
    expect(() => value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "management_barrier_active" }));

    barrier.close();
    value.openMutationAdmission({ dirtyMetadataBytes: 1, unpublishedPhysicalBytes: 1 })
      .accept({ workingGeneration: second });
    expect(value.snapshot().workingGeneration).toEqual(second);
  });

  it("retains the management barrier across a failed flush retry", () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    value.openMutationAdmission({ dirtyMetadataBytes: 1, unpublishedPhysicalBytes: 1 })
      .accept({ workingGeneration: first });
    const barrier = value.openManagementBarrier();

    barrier.openFlush().fail({ cause: new Error("publication failed") });
    expect(() => barrier.close()).toThrowError(
      expect.objectContaining({ code: "management_head_not_clean" }),
    );
    expect(() => value.openMutationAdmission({
      dirtyMetadataBytes: 1,
      unpublishedPhysicalBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "management_barrier_active" }));

    barrier.openFlush().complete({ durableGeneration: first });
    barrier.close();
    expect(value.snapshot().flushState).toBe("idle");
  });

  it("permits only one management barrier owner", () => {
    const value = coordinator();
    const barrier = value.openManagementBarrier();

    expect(() => value.openManagementBarrier()).toThrowError(
      expect.objectContaining({ code: "working_authority_busy" }),
    );

    barrier.close();
  });

  it("retains one staged Commit headroom across working-generation replacements", () => {
    const { first, initial, second } = values();
    const value = coordinator({ initial });
    const firstAdmission = value.openMutationAdmission({ dirtyMetadataBytes: 3, unpublishedPhysicalBytes: 4 });
    firstAdmission.reserveStagedCommitMaterializationHeadroom({ bytes: 5 });
    firstAdmission.accept({ workingGeneration: first });
    const secondAdmission = value.openMutationAdmission({ dirtyMetadataBytes: 2, unpublishedPhysicalBytes: 3 });
    secondAdmission.reserveStagedCommitMaterializationHeadroom({ bytes: 5 });
    secondAdmission.accept({ workingGeneration: second });

    expect(value.snapshot().dirtyResources).toMatchObject({
      acceptedMutationCount: 2,
      dirtyMetadataBytes: 10,
      stagedCommitMaterializationHeadroomBytes: 5,
      unpublishedPhysicalBytes: 12,
    });
  });

  it("accounts materialization attempt risk through the flush capability", () => {
    const { first, initial } = values();
    const value = coordinator({ initial });
    const admission = value.openMutationAdmission({ dirtyMetadataBytes: 3, unpublishedPhysicalBytes: 4 });
    admission.reserveStagedCommitMaterializationHeadroom({ bytes: 5 });
    admission.accept({ workingGeneration: first });

    const flush = value.openFlush();
    const attempt = flush.beginStagedCommitMaterializationAttempt({ frameBytes: 5 });
    expect(value.snapshot().dirtyResources).toMatchObject({
      dirtyMetadataBytes: 13,
      stagedCommitMaterializationHeadroomBytes: 5,
      unpublishedPhysicalBytes: 14,
    });
    attempt.completeReusableCandidate();
    expect(value.snapshot().dirtyResources).toMatchObject({
      dirtyMetadataBytes: 8,
      stagedCommitMaterializationHeadroomBytes: 0,
      unpublishedPhysicalBytes: 9,
    });
    flush.complete({ durableGeneration: first });
    expect(value.snapshot().dirtyResources).toMatchObject({
      dirtyMetadataBytes: 0,
      stagedCommitMaterializationHeadroomBytes: 0,
      unpublishedPhysicalBytes: 0,
    });
  });

});
