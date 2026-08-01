export type MaintenancePhase =
  | "capturing_roots"
  | "compacting"
  | "completed"
  | "marking"
  | "planning_sweep"
  | "publishing"
  | "sweeping"
  | "validating";

export type MaintenanceYieldReason =
  | "abort_requested"
  | "foreground_waiter"
  | "slice_byte_limit"
  | "slice_work_limit"
  | "soft_time_limit";

export type MaintenanceDiagnosticEventInput =
  | Readonly<{ copiedBytes: number; type: "compaction_progress" }>
  | Readonly<{ phase: MaintenancePhase; type: "phase_started" }>
  | Readonly<{ reason: MaintenanceYieldReason; type: "yielded" }>
  | Readonly<{ removedSegments: number; type: "sweep_progress" }>;

export type MaintenanceDiagnosticEvent = MaintenanceDiagnosticEventInput & Readonly<{
  sequence: number;
}>;

function nonNegativeSafeInteger({ name, value }: { name: string; value: number }): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function detachedEvent({ event, sequence }: {
  event: MaintenanceDiagnosticEventInput;
  sequence: number;
}): MaintenanceDiagnosticEvent {
  switch (event.type) {
  case "compaction_progress":
    return Object.freeze({
      copiedBytes: nonNegativeSafeInteger({ name: "copiedBytes", value: event.copiedBytes }),
      sequence,
      type: event.type,
    });
  case "phase_started":
    return Object.freeze({ phase: event.phase, sequence, type: event.type });
  case "sweep_progress":
    return Object.freeze({
      removedSegments: nonNegativeSafeInteger({ name: "removedSegments", value: event.removedSegments }),
      sequence,
      type: event.type,
    });
  case "yielded":
    return Object.freeze({ reason: event.reason, sequence, type: event.type });
  default: return event satisfies never;
  }
}

export class MaintenanceDiagnostics {
  #events: MaintenanceDiagnosticEvent[] = [];
  #maximumEvents: number;
  #nextSequence = 1;

  constructor({ maximumEvents }: { maximumEvents: number }) {
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1) {
      throw new RangeError("maintenance diagnostics require a positive safe event bound");
    }
    this.#maximumEvents = maximumEvents;
  }

  record({ event }: { event: MaintenanceDiagnosticEventInput }): void {
    if (!Number.isSafeInteger(this.#nextSequence)) {
      throw new RangeError("maintenance diagnostic sequence space is exhausted");
    }
    this.#events.push(detachedEvent({ event, sequence: this.#nextSequence }));
    this.#nextSequence += 1;
    if (this.#events.length > this.#maximumEvents) this.#events.shift();
  }

  snapshot(): readonly MaintenanceDiagnosticEvent[] {
    return Object.freeze(this.#events.map(event => Object.freeze({ ...event })));
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
