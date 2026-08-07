import {
  sameWorkingGenerationIdentity,
  type WorkingGenerationAuthorityEpoch,
  type WorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";

export type SyncWaiterRegistryActivityState = "active" | "idle";

export type SyncWaiterRegistryErrorCode =
  | "authority_epoch_lost"
  | "sync_waiter_limit_reached"
  | "working_generation_changed";

export class SyncWaiterRegistryError extends Error {
  readonly code: SyncWaiterRegistryErrorCode;

  constructor({ code, message }: { code: SyncWaiterRegistryErrorCode; message: string }) {
    super(message);
    this.name = "SyncWaiterRegistryError";
    this.code = code;
  }
}

type VoidPromiseResolvers = ReturnType<typeof Promise.withResolvers<void>>;

type SyncWaiter = Readonly<{
  reject: VoidPromiseResolvers["reject"];
  resolve: VoidPromiseResolvers["resolve"];
  target: WorkingGenerationIdentity;
}>;

function assertSameAuthorityEpoch({
  authorityEpoch,
  identity,
  operation,
}: {
  authorityEpoch: WorkingGenerationAuthorityEpoch;
  identity: WorkingGenerationIdentity;
  operation: string;
}): void {
  if (identity.authorityEpoch !== authorityEpoch) {
    throw new SyncWaiterRegistryError({
      code: "authority_epoch_lost",
      message: `${operation} generation belongs to a stale runtime authority epoch`,
    });
  }
}

function targetSatisfiedByDurableGeneration({
  durable,
  target,
}: {
  durable: WorkingGenerationIdentity;
  target: WorkingGenerationIdentity;
}): boolean {
  if (durable.authorityEpoch !== target.authorityEpoch) {
    throw new SyncWaiterRegistryError({
      code: "authority_epoch_lost",
      message: "sync waiter target belongs to a stale runtime authority epoch",
    });
  }
  if (durable.generationNumber < target.generationNumber) return false;
  if (durable.generationNumber > target.generationNumber) return true;
  if (!sameWorkingGenerationIdentity({ left: durable, right: target })) {
    throw new SyncWaiterRegistryError({
      code: "working_generation_changed",
      message: "durable generation conflicts with the sync waiter target at the same generation number",
    });
  }
  return true;
}

/**
 * Bounds caller-held sync promises and resolves them only after an exact
 * runtime generation target is durable. The registry is runtime-only: its
 * generation numbers and authority epoch are never persisted or reconstructed
 * after process loss.
 */
export class SyncWaiterRegistry {
  readonly #authorityEpoch: WorkingGenerationAuthorityEpoch;
  #durable: WorkingGenerationIdentity;
  readonly #maximumWaiters: number;
  readonly #waiters = new Set<SyncWaiter>();

  constructor({ initialDurableGeneration, maximumWaiters }: {
    initialDurableGeneration: WorkingGenerationIdentity;
    maximumWaiters: number;
  }) {
    if (!Number.isSafeInteger(maximumWaiters) || maximumWaiters < 1) {
      throw new RangeError("maximum sync waiters must be a positive safe integer");
    }
    this.#authorityEpoch = initialDurableGeneration.authorityEpoch;
    this.#durable = initialDurableGeneration;
    this.#maximumWaiters = maximumWaiters;
  }

  activityState(): SyncWaiterRegistryActivityState {
    return this.#waiters.size === 0 ? "idle" : "active";
  }

  durableGeneration(): WorkingGenerationIdentity {
    return this.#durable;
  }

  waiterCount(): number {
    return this.#waiters.size;
  }

  waitFor({ target }: { target: WorkingGenerationIdentity }): Promise<void> {
    assertSameAuthorityEpoch({
      authorityEpoch: this.#authorityEpoch,
      identity: target,
      operation: "sync waiter target",
    });
    if (targetSatisfiedByDurableGeneration({ durable: this.#durable, target })) {
      return Promise.resolve();
    }
    if (this.#waiters.size >= this.#maximumWaiters) {
      throw new SyncWaiterRegistryError({
        code: "sync_waiter_limit_reached",
        message: "HizoFS runtime sync waiter limit reached",
      });
    }
    const { promise, reject, resolve } = Promise.withResolvers<void>();
    this.#waiters.add(Object.freeze({ reject, resolve, target }));
    return promise;
  }

  advanceDurableGeneration({ durable }: { durable: WorkingGenerationIdentity }): void {
    assertSameAuthorityEpoch({
      authorityEpoch: this.#authorityEpoch,
      identity: durable,
      operation: "durable",
    });
    if (durable.generationNumber < this.#durable.generationNumber) {
      throw new SyncWaiterRegistryError({
        code: "working_generation_changed",
        message: "durable generation cannot move backward",
      });
    }
    if (
      durable.generationNumber === this.#durable.generationNumber
      && !sameWorkingGenerationIdentity({ left: durable, right: this.#durable })
    ) {
      throw new SyncWaiterRegistryError({
        code: "working_generation_changed",
        message: "durable generation identity changed without advancing its generation number",
      });
    }
    this.#durable = durable;
    for (const waiter of this.#waiters) {
      let satisfied: boolean;
      try {
        satisfied = targetSatisfiedByDurableGeneration({ durable, target: waiter.target });
      } catch (cause: unknown) {
        this.#waiters.delete(waiter);
        waiter.reject(cause);
        continue;
      }
      if (!satisfied) continue;
      this.#waiters.delete(waiter);
      waiter.resolve();
    }
  }

  rejectAll({ cause }: { cause: unknown }): void {
    for (const waiter of this.#waiters) waiter.reject(cause);
    this.#waiters.clear();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
