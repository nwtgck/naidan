import {
  sameWorkingGenerationIdentity,
  type WorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import {
  DirtyResourceBudget,
  type DirtyResourceAdmission,
  type DirtyResourceBudgetSnapshot,
} from "@/00-storage/service/hizofs/runtime/dirty-resource-budget";
import type { HizoFSLazyDurabilityPolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import { SyncWaiterRegistry } from "@/00-storage/service/hizofs/runtime/sync-waiter-registry";

export type WorkingGenerationCoordinatorErrorCode =
  | "admission_closed"
  | "durability_stalled"
  | "durable_generation_not_current"
  | "flush_closed"
  | "management_barrier_active"
  | "management_barrier_closed"
  | "management_head_not_clean"
  | "working_authority_busy"
  | "working_generation_changed";

export class WorkingGenerationCoordinatorError extends Error {
  readonly code: WorkingGenerationCoordinatorErrorCode;

  constructor({ code, message }: { code: WorkingGenerationCoordinatorErrorCode; message: string }) {
    super(message);
    this.name = "WorkingGenerationCoordinatorError";
    this.code = code;
  }
}

export type WorkingGenerationMutationAdmission = Readonly<{
  accept: ({ workingGeneration }: { workingGeneration: WorkingGenerationIdentity }) => void;
  replaceResourceReservation: ({ dirtyMetadataBytes, unpublishedPhysicalBytes }: {
    dirtyMetadataBytes: number;
    unpublishedPhysicalBytes: number;
  }) => void;
  rollback: () => void;
}>;

export type WorkingGenerationFlushState = "flushing" | "idle" | "stalled";

export type WorkingGenerationFlush = Readonly<{
  complete: ({ durableGeneration }: { durableGeneration: WorkingGenerationIdentity }) => void;
  fail: ({ cause }: { cause: unknown }) => void;
  target: WorkingGenerationIdentity;
}>;

/**
 * Holds mutation admission closed after a durable-head flush so a management
 * authority switch cannot race with a new accepted generation. A standalone
 * sync is insufficient because another session could mutate after sync returns.
 */
export type WorkingGenerationManagementBarrier = Readonly<{
  close: () => void;
  openFlush: () => WorkingGenerationFlush;
  target: WorkingGenerationIdentity;
}>;

export type WorkingGenerationCoordinatorSnapshot = Readonly<{
  dirtyResources: DirtyResourceBudgetSnapshot;
  durableGeneration: WorkingGenerationIdentity;
  flushState: WorkingGenerationFlushState;
  managementBarrierActive: boolean;
  syncWaiterCount: number;
  workingGeneration: WorkingGenerationIdentity;
}>;

/**
 * Owns the runtime-only accepted and durable generation identities. The
 * initial protocol permits one mutation admission at a time and publishes
 * only the exact latest working generation, avoiding an older same-sequence
 * candidate becoming durable while a newer candidate remains dirty.
 */
export class WorkingGenerationCoordinator {
  readonly #dirtyResources: DirtyResourceBudget;
  #durabilityStalled = false;
  #durableGeneration: WorkingGenerationIdentity;
  #flushActive = false;
  #managementBarrierActive = false;
  #mutationAdmissionActive = false;
  readonly #syncWaiters: SyncWaiterRegistry;
  #workingGeneration: WorkingGenerationIdentity;

  constructor({ initialDurableGeneration, policy }: {
    initialDurableGeneration: WorkingGenerationIdentity;
    policy: HizoFSLazyDurabilityPolicy;
  }) {
    this.#dirtyResources = new DirtyResourceBudget({ policy });
    this.#durableGeneration = initialDurableGeneration;
    this.#syncWaiters = new SyncWaiterRegistry({
      initialDurableGeneration,
      maximumWaiters: policy.maximumSyncWaiters,
    });
    this.#workingGeneration = initialDurableGeneration;
  }

  captureSyncTarget(): WorkingGenerationIdentity {
    return this.#workingGeneration;
  }

  openMutationAdmission({ dirtyMetadataBytes, unpublishedPhysicalBytes }: {
    dirtyMetadataBytes: number;
    unpublishedPhysicalBytes: number;
  }): WorkingGenerationMutationAdmission {
    if (this.#managementBarrierActive) {
      throw new WorkingGenerationCoordinatorError({
        code: "management_barrier_active",
        message: "working generation mutation admission is blocked by a management clean-head barrier",
      });
    }
    if (this.#durabilityStalled) {
      throw new WorkingGenerationCoordinatorError({
        code: "durability_stalled",
        message: "working generation durability is stalled until an explicit flush retry succeeds",
      });
    }
    if (this.#flushActive || this.#mutationAdmissionActive) {
      throw new WorkingGenerationCoordinatorError({
        code: "working_authority_busy",
        message: "working generation authority is already owned by mutation admission or flush",
      });
    }
    const resources = this.#dirtyResources.reserveAdmission({
      dirtyMetadataBytes,
      unpublishedPhysicalBytes,
    });
    this.#mutationAdmissionActive = true;
    let active = true;
    const requireActive = (): DirtyResourceAdmission => {
      if (!active) {
        throw new WorkingGenerationCoordinatorError({
          code: "admission_closed",
          message: "working generation mutation admission is already closed",
        });
      }
      return resources;
    };
    const close = (): DirtyResourceAdmission => {
      const retainedResources = requireActive();
      active = false;
      this.#mutationAdmissionActive = false;
      return retainedResources;
    };
    return Object.freeze({
      accept: ({ workingGeneration }) => {
        requireActive();
        if (
          workingGeneration.authorityEpoch !== this.#workingGeneration.authorityEpoch
          || workingGeneration.generationNumber !== this.#workingGeneration.generationNumber + 1n
        ) {
          throw new WorkingGenerationCoordinatorError({
            code: "working_generation_changed",
            message: "accepted working generation is not the exact next runtime generation",
          });
        }
        close().commitAccepted();
        this.#workingGeneration = workingGeneration;
      },
      replaceResourceReservation: ({ dirtyMetadataBytes, unpublishedPhysicalBytes }) => {
        requireActive().replaceReservation({ dirtyMetadataBytes, unpublishedPhysicalBytes });
      },
      rollback: () => close().rollback(),
    });
  }

  waitForSyncTarget({ target }: { target: WorkingGenerationIdentity }): Promise<void> {
    return this.#syncWaiters.waitFor({ target });
  }

  #advanceDurableToCurrentWorkingGeneration({ durableGeneration }: {
    durableGeneration: WorkingGenerationIdentity;
  }): void {
    if (!sameWorkingGenerationIdentity({
      left: durableGeneration,
      right: this.#workingGeneration,
    })) {
      throw new WorkingGenerationCoordinatorError({
        code: "durable_generation_not_current",
        message: "initial lazy-publication protocol may publish only the exact current working generation",
      });
    }
    this.#syncWaiters.advanceDurableGeneration({ durable: durableGeneration });
    this.#durableGeneration = durableGeneration;
    this.#dirtyResources.resetAfterDurablePublication();
  }

  #openFlush({ managementBarrierOwned }: { managementBarrierOwned: boolean }): WorkingGenerationFlush {
    if (this.#managementBarrierActive !== managementBarrierOwned) {
      throw new WorkingGenerationCoordinatorError({
        code: "management_barrier_active",
        message: managementBarrierOwned
          ? "management clean-head barrier no longer owns the working generation authority"
          : "working generation flush is blocked by a management clean-head barrier",
      });
    }
    if (this.#flushActive || this.#mutationAdmissionActive) {
      throw new WorkingGenerationCoordinatorError({
        code: "working_authority_busy",
        message: "working generation authority is already owned by mutation admission or flush",
      });
    }
    this.#flushActive = true;
    let active = true;
    const requireActive = (): void => {
      if (!active) {
        throw new WorkingGenerationCoordinatorError({
          code: "flush_closed",
          message: "working generation flush capability is already closed",
        });
      }
    };
    const close = (): void => {
      requireActive();
      active = false;
      this.#flushActive = false;
    };
    const target = this.#workingGeneration;
    return Object.freeze({
      complete: ({ durableGeneration }) => {
        requireActive();
        this.#advanceDurableToCurrentWorkingGeneration({ durableGeneration });
        close();
        this.#durabilityStalled = false;
      },
      fail: ({ cause }) => {
        close();
        this.#durabilityStalled = true;
        this.#syncWaiters.rejectAll({ cause });
      },
      target,
    });
  }

  confirmCurrentWorkingGenerationDurable(): void {
    if (!this.#durabilityStalled) {
      throw new WorkingGenerationCoordinatorError({
        code: "durable_generation_not_current",
        message: "working generation is not awaiting external durable-authority resolution",
      });
    }
    if (this.#flushActive || this.#managementBarrierActive || this.#mutationAdmissionActive) {
      throw new WorkingGenerationCoordinatorError({
        code: "working_authority_busy",
        message: "working generation authority is busy during external durable-authority resolution",
      });
    }
    this.#advanceDurableToCurrentWorkingGeneration({ durableGeneration: this.#workingGeneration });
    this.#durabilityStalled = false;
  }

  openFlush(): WorkingGenerationFlush {
    return this.#openFlush({ managementBarrierOwned: false });
  }

  openManagementBarrier(): WorkingGenerationManagementBarrier {
    if (this.#managementBarrierActive || this.#flushActive || this.#mutationAdmissionActive) {
      throw new WorkingGenerationCoordinatorError({
        code: "working_authority_busy",
        message: "working generation authority is already owned by mutation, flush, or management",
      });
    }
    this.#managementBarrierActive = true;
    let active = true;
    const requireActive = (): void => {
      if (!active) {
        throw new WorkingGenerationCoordinatorError({
          code: "management_barrier_closed",
          message: "management clean-head barrier is already closed",
        });
      }
    };
    const target = this.#workingGeneration;
    return Object.freeze({
      close: () => {
        requireActive();
        if (this.#flushActive) {
          throw new WorkingGenerationCoordinatorError({
            code: "working_authority_busy",
            message: "management clean-head barrier cannot close during flush",
          });
        }
        if (this.#durabilityStalled || !sameWorkingGenerationIdentity({
          left: this.#durableGeneration,
          right: this.#workingGeneration,
        })) {
          throw new WorkingGenerationCoordinatorError({
            code: "management_head_not_clean",
            message: "management clean-head barrier cannot close before the working generation is durable",
          });
        }
        active = false;
        this.#managementBarrierActive = false;
      },
      openFlush: () => {
        requireActive();
        return this.#openFlush({ managementBarrierOwned: true });
      },
      target,
    });
  }

  snapshot(): WorkingGenerationCoordinatorSnapshot {
    return Object.freeze({
      dirtyResources: this.#dirtyResources.snapshot(),
      durableGeneration: this.#durableGeneration,
      flushState: this.#flushActive ? "flushing" : this.#durabilityStalled ? "stalled" : "idle",
      managementBarrierActive: this.#managementBarrierActive,
      syncWaiterCount: this.#syncWaiters.waiterCount(),
      workingGeneration: this.#workingGeneration,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
