import { describe, expect, it } from "vitest";
import {
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import {
  SyncWaiterRegistry,
} from "@/00-storage/service/hizofs/runtime/sync-waiter-registry";
import { createTestingWorkingCandidateIdentities } from "@/00-storage/service/hizofs/runtime/testing/working-generation-identity-fixture";

function generations() {
  const { durable, working } = createTestingWorkingCandidateIdentities();
  const initial = createWorkingGenerationIdentity({
    authorityEpoch: working.authorityEpoch,
    commitReference: durable.commitReference,
    generationNumber: createWorkingGenerationNumber({ value: 0n }),
    mutationId: durable.mutationId,
  });
  const second = createSuccessorWorkingGenerationIdentity({
    commitReference: working.commitReference,
    mutationId: working.mutationId,
    previous: initial,
  });
  return { initial, second };
}

describe("SyncWaiterRegistry", () => {
  it("resolves an already durable exact generation without retaining a waiter", async () => {
    const { initial } = generations();
    const registry = new SyncWaiterRegistry({
      initialDurableGeneration: initial,
      maximumWaiters: 2,
    });

    await expect(registry.waitFor({ target: initial })).resolves.toBeUndefined();
    expect(registry.activityState()).toBe("idle");
    expect(registry.waiterCount()).toBe(0);
  });

  it("resolves only targets at or below the advanced durable generation", async () => {
    const { initial, second } = generations();
    const third = createSuccessorWorkingGenerationIdentity({
      commitReference: second.commitReference,
      mutationId: second.mutationId,
      previous: second,
    });
    const registry = new SyncWaiterRegistry({
      initialDurableGeneration: initial,
      maximumWaiters: 4,
    });
    let secondResolved = false;
    let thirdResolved = false;
    const secondWaiter = registry.waitFor({ target: second }).then(() => { secondResolved = true; });
    const thirdWaiter = registry.waitFor({ target: third }).then(() => { thirdResolved = true; });

    registry.advanceDurableGeneration({ durable: second });
    await secondWaiter;
    expect(secondResolved).toBe(true);
    expect(thirdResolved).toBe(false);
    expect(registry.waiterCount()).toBe(1);

    registry.advanceDurableGeneration({ durable: third });
    await thirdWaiter;
    expect(thirdResolved).toBe(true);
    expect(registry.activityState()).toBe("idle");
  });

  it("hard-bounds caller waiters", () => {
    const { initial, second } = generations();
    const registry = new SyncWaiterRegistry({
      initialDurableGeneration: initial,
      maximumWaiters: 1,
    });
    void registry.waitFor({ target: second });

    expect(() => registry.waitFor({ target: second })).toThrowError(expect.objectContaining({
      code: "sync_waiter_limit_reached",
    }));
  });

  it("rejects stale authority epochs before retaining a waiter", () => {
    const { initial } = generations();
    const stale = createWorkingGenerationIdentity({
      authorityEpoch: createWorkingGenerationAuthorityEpoch(),
      commitReference: initial.commitReference,
      generationNumber: createWorkingGenerationNumber({ value: 1n }),
      mutationId: initial.mutationId,
    });
    const registry = new SyncWaiterRegistry({
      initialDurableGeneration: initial,
      maximumWaiters: 2,
    });

    expect(() => registry.waitFor({ target: stale })).toThrowError(expect.objectContaining({
      code: "authority_epoch_lost",
    }));
    expect(registry.waiterCount()).toBe(0);
  });

  it("rejects same-number conflicting durable identities", () => {
    const { initial, second } = generations();
    const conflicting = createWorkingGenerationIdentity({
      authorityEpoch: initial.authorityEpoch,
      commitReference: second.commitReference,
      generationNumber: initial.generationNumber,
      mutationId: second.mutationId,
    });
    const registry = new SyncWaiterRegistry({
      initialDurableGeneration: initial,
      maximumWaiters: 2,
    });

    expect(() => registry.advanceDurableGeneration({ durable: conflicting })).toThrowError(
      expect.objectContaining({ code: "working_generation_changed" }),
    );
  });

  it("rejects all pending waiters without moving durable authority", async () => {
    const { initial, second } = generations();
    const registry = new SyncWaiterRegistry({
      initialDurableGeneration: initial,
      maximumWaiters: 2,
    });
    const cause = new Error("publication failed");
    const waiter = registry.waitFor({ target: second });

    registry.rejectAll({ cause });

    await expect(waiter).rejects.toBe(cause);
    expect(registry.durableGeneration()).toBe(initial);
    expect(registry.activityState()).toBe("idle");
  });

  it("rejects invalid waiter bounds", () => {
    const { initial } = generations();
    for (const maximumWaiters of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new SyncWaiterRegistry({
        initialDurableGeneration: initial,
        maximumWaiters,
      })).toThrowError(RangeError);
    }
  });
});
