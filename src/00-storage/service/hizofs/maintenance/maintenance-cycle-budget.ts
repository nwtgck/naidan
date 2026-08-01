import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

export type MaintenanceCycleBudgetErrorCode =
  | "budget_exceeded"
  | "counter_overflow"
  | "invalid_delta";

export class MaintenanceCycleBudgetError extends Error {
  readonly code: MaintenanceCycleBudgetErrorCode;
  readonly counter: keyof MaintenanceCycleBudgetSnapshot;

  constructor({ code, counter, message }: {
    code: MaintenanceCycleBudgetErrorCode;
    counter: keyof MaintenanceCycleBudgetSnapshot;
    message: string;
  }) {
    super(message);
    this.name = "MaintenanceCycleBudgetError";
    this.code = code;
    this.counter = counter;
  }
}

export type MaintenanceCycleBudgetSnapshot = Readonly<{
  bytesRead: number;
  decodedRecords: number;
  followedEdges: number;
  revisitEncounters: number;
}>;

type CounterName = keyof MaintenanceCycleBudgetSnapshot;

function checkedDelta({ counter, value }: { counter: CounterName; value: number }): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MaintenanceCycleBudgetError({
      code: "invalid_delta",
      counter,
      message: `${counter} delta must be a non-negative safe integer`,
    });
  }
  return value;
}

export class MaintenanceCycleBudget {
  #limits: Readonly<Record<CounterName, number>>;
  #values: Record<CounterName, number> = {
    bytesRead: 0,
    decodedRecords: 0,
    followedEdges: 0,
    revisitEncounters: 0,
  };

  constructor({ policy }: { policy: HizoFSMaintenancePolicy }) {
    this.#limits = Object.freeze({
      bytesRead: policy.maxBytesReadPerCycle,
      decodedRecords: policy.maxDecodedRecordsPerCycle,
      followedEdges: policy.maxFollowedEdgesPerCycle,
      revisitEncounters: policy.maxRevisitsPerCycle,
    });
  }

  #consume({ counter, delta }: { counter: CounterName; delta: number }): void {
    const checked = checkedDelta({ counter, value: delta });
    const current = this.#values[counter];
    const next = current + checked;
    if (!Number.isSafeInteger(next)) {
      throw new MaintenanceCycleBudgetError({
        code: "counter_overflow",
        counter,
        message: `${counter} counter overflowed before maintenance could fail closed`,
      });
    }
    if (next > this.#limits[counter]) {
      throw new MaintenanceCycleBudgetError({
        code: "budget_exceeded",
        counter,
        message: `${counter} exceeded the explicit cycle hard budget`,
      });
    }
    this.#values[counter] = next;
  }

  consumeDecodedRecord({ bytesRead }: { bytesRead: number }): void {
    checkedDelta({ counter: "bytesRead", value: bytesRead });
    this.#consume({ counter: "decodedRecords", delta: 1 });
    this.#consume({ counter: "bytesRead", delta: bytesRead });
  }

  consumeFollowedEdge(): void {
    this.#consume({ counter: "followedEdges", delta: 1 });
  }

  consumeRevisitEncounter(): void {
    this.#consume({ counter: "revisitEncounters", delta: 1 });
  }

  snapshot(): MaintenanceCycleBudgetSnapshot {
    return Object.freeze({ ...this.#values });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
