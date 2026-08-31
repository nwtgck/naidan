import type {
  ModelSupportInvestigationCheckpoint,
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationRecordedEvent,
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
} from "@/features/transformers-js/model-support-investigation/types";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";

const MAXIMUM_RETAINED_EVENTS = 512;

const LATER_STEPS: ModelSupportInvestigationStep[] = [
  { id: "repository-information", status: "not-run", detail: undefined },
  { id: "existing-model-data", status: "not-run", detail: undefined },
  { id: "model-declarations", status: "not-run", detail: undefined },
  { id: "template-behavior", status: "not-run", detail: undefined },
  { id: "model-file-plan", status: "not-run", detail: undefined },
  { id: "loading-investigation", status: "not-run", detail: undefined },
  { id: "lane-comparison", status: "not-run", detail: undefined },
  { id: "evidence-export", status: "not-run", detail: undefined },
];

function cloneRun({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationRun {
  return structuredClone(run);
}

function nextRecovery({
  recovery,
  status,
  checkpointedAt,
}: {
  recovery: ModelSupportInvestigationRecovery,
  status: ModelSupportInvestigationRecovery["status"],
  checkpointedAt: string,
}): ModelSupportInvestigationRecovery {
  return {
    ...recovery,
    status,
    checkpointSequence: recovery.checkpointSequence + 1,
    checkpointedAt,
  };
}

function retainRecordedEvent({
  events,
  event,
}: {
  events: ModelSupportInvestigationRecordedEvent[],
  event: ModelSupportInvestigationRecordedEvent,
}): {
  events: ModelSupportInvestigationRecordedEvent[],
  dropped: boolean,
} {
  if (events.length < MAXIMUM_RETAINED_EVENTS) {
    return { events: [...events, event], dropped: false };
  }

  // Preserve semantic stage boundaries preferentially. Progress samples are
  // diagnostic telemetry and may be discarded once the bounded recovery
  // journal is full; their cumulative counters remain in the retained latest
  // sample. If semantic events themselves exceed the hard bound, drop the
  // oldest event rather than allowing recovery checkpoints to grow forever.
  const oldestProgressIndex = events.findIndex(item => item.progress !== undefined);
  const dropIndex = oldestProgressIndex >= 0 ? oldestProgressIndex : 0;
  return {
    events: [
      ...events.slice(0, dropIndex),
      ...events.slice(dropIndex + 1),
      event,
    ],
    dropped: true,
  };
}

export function createInitialInvestigationCheckpoint({
  modelId,
  runId,
  now,
}: {
  modelId: string,
  runId: string,
  now: () => string,
}): ModelSupportInvestigationCheckpoint {
  const at = now();
  return {
    run: {
      schemaVersion: 1,
      runId,
      modelId,
      scope: "partial-runtime-preflight",
      startedAt: at,
      completedAt: at,
      status: "failed",
      currentOperation: "Investigation Worker has not reported its first completed boundary",
      steps: [
        { id: "runtime-assets", status: "running", detail: "Starting Runtime Integrity Preflight" },
        ...LATER_STEPS,
      ],
      runtimeAssets: undefined,
      repository: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
      laneComparison: undefined,
      error: "Investigation has not completed",
    },
    recovery: {
      schemaVersion: 1,
      status: "running",
      checkpointSequence: 0,
      checkpointedAt: at,
      totalEventCount: 0,
      droppedEventCount: 0,
      lastEvent: undefined,
      events: [],
      interruption: undefined,
    },
  };
}

export function recordInvestigationEvent({
  checkpoint,
  event,
  now,
}: {
  checkpoint: ModelSupportInvestigationCheckpoint,
  event: ModelSupportInvestigationEvent,
  now: () => string,
}): ModelSupportInvestigationCheckpoint {
  const at = now();
  const sequence = checkpoint.recovery.totalEventCount + 1;
  const recordedEvent = { ...event, sequence, at };
  const retained = retainRecordedEvent({ events: checkpoint.recovery.events, event: recordedEvent });
  // This is a hot path during model load. Do not deep-clone the entire run for
  // telemetry: only the top-level fields and changed step need a new object.
  // Full run cloning remains at actual Worker checkpoint boundaries.
  const run: ModelSupportInvestigationRun = {
    ...checkpoint.run,
    completedAt: at,
    currentOperation: event.detail,
    steps: checkpoint.run.steps.map(step => (
      step.id === event.stepId
        ? { ...step, status: event.status, detail: event.detail }
        : step
    )),
  };
  return {
    run,
    recovery: {
      ...nextRecovery({ recovery: checkpoint.recovery, status: "running", checkpointedAt: at }),
      totalEventCount: sequence,
      droppedEventCount: checkpoint.recovery.droppedEventCount + (retained.dropped ? 1 : 0),
      lastEvent: recordedEvent,
      events: retained.events,
      interruption: undefined,
    },
  };
}

export function replaceInvestigationCheckpointRun({
  checkpoint,
  run,
  now,
}: {
  checkpoint: ModelSupportInvestigationCheckpoint,
  run: ModelSupportInvestigationRun,
  now: () => string,
}): ModelSupportInvestigationCheckpoint {
  const at = now();
  return {
    run: cloneRun({ run }),
    recovery: nextRecovery({ recovery: checkpoint.recovery, status: "running", checkpointedAt: at }),
  };
}

export function completeInvestigationCheckpoint({
  checkpoint,
  run,
  now,
}: {
  checkpoint: ModelSupportInvestigationCheckpoint,
  run: ModelSupportInvestigationRun,
  now: () => string,
}): ModelSupportInvestigationCheckpoint {
  const at = now();
  return {
    run: cloneRun({ run }),
    recovery: nextRecovery({ recovery: checkpoint.recovery, status: "completed", checkpointedAt: at }),
  };
}

export function interruptInvestigationCheckpoint({
  checkpoint,
  error,
  now,
}: {
  checkpoint: ModelSupportInvestigationCheckpoint,
  error: unknown,
  now: () => string,
}): ModelSupportInvestigationCheckpoint {
  const at = now();
  const serialized = serializeInvestigationError({ error });
  const run = cloneRun({ run: checkpoint.run });
  const boundary = checkpoint.recovery.lastEvent === undefined
    ? "before the first reported boundary"
    : `after ${checkpoint.recovery.lastEvent.stepId}: ${checkpoint.recovery.lastEvent.detail}`;
  run.completedAt = at;
  run.status = "failed";
  run.currentOperation = `Investigation interrupted ${boundary}`;
  run.error = run.error === undefined
    ? `Investigation interrupted: ${serialized.message}`
    : `${run.error}; Investigation interrupted: ${serialized.message}`;
  run.steps = run.steps.map(step => {
    switch (step.status) {
    case "running":
      return { ...step, status: "failed", detail: `Interrupted: ${serialized.message}` };
    case "not-run":
    case "passed":
    case "failed":
    case "blocked":
      return step;
    default: {
      const _ex: never = step.status;
      throw new Error(`Unhandled investigation step status: ${_ex}`);
    }
    }
  });
  return {
    run,
    recovery: {
      ...nextRecovery({ recovery: checkpoint.recovery, status: "interrupted", checkpointedAt: at }),
      interruption: {
        at,
        lastEventSequence: checkpoint.recovery.lastEvent?.sequence,
        error: serialized,
      },
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  MAXIMUM_RETAINED_EVENTS,
};
