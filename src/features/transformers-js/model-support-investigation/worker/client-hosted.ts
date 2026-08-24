import * as Comlink from "comlink";
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationCheckpoint,
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationLoadAttemptStage,
  ModelSupportInvestigationWorkerClient,
} from "@/features/transformers-js/model-support-investigation/types";
import type { ITransformersJsWorker } from "@/features/transformers-js/types";
import { runModelLoadInvestigation } from "@/features/transformers-js/model-support-investigation/logic/run-model-load-investigation";
import { runProductionLaneComparison } from "@/features/transformers-js/model-support-investigation/logic/run-production-lane-comparison";
import {
  CandidateAttemptTimeoutError,
  DEFAULT_CANDIDATE_ATTEMPT_TIMEOUT_MS,
  withCandidateAttemptTimeout,
} from "@/features/transformers-js/model-support-investigation/logic/candidate-attempt-timeout";
import {
  DEFAULT_PRODUCTION_LANE_TIMEOUT_MS,
  type ModelSupportInvestigationProductionLaneStage,
  ProductionLaneTimeoutError,
  withProductionLaneTimeout,
} from "@/features/transformers-js/model-support-investigation/logic/production-lane-timeout";
import { createModelLoadProgressTracker } from "@/features/transformers-js/model-support-investigation/logic/model-load-progress";
import { createCacheRevisionAliases } from "@/features/transformers-js/model-support-investigation/logic/create-cache-revision-aliases";
import {
  DEFAULT_PLANNING_TIMEOUT_MS,
  type ModelSupportInvestigationPlanningStage,
  PlanningTimeoutError,
  withPlanningTimeout,
} from "@/features/transformers-js/model-support-investigation/logic/planning-timeout";
import {
  completeInvestigationCheckpoint,
  createInitialInvestigationCheckpoint,
  interruptInvestigationCheckpoint,
  recordInvestigationEvent,
  replaceInvestigationCheckpointRun,
} from "@/features/transformers-js/model-support-investigation/logic/investigation-recovery";

interface InvestigationWorkerHandle {
  worker: Worker,
  remote: Comlink.Remote<IModelSupportInvestigationWorker>,
}

interface ProductionWorkerHandle {
  worker: Worker,
  remote: Comlink.Remote<ITransformersJsWorker>,
}

function productionLaneStageFromStatus({
  status,
  currentStage,
}: {
  status: string,
  currentStage: ModelSupportInvestigationProductionLaneStage,
}): ModelSupportInvestigationProductionLaneStage {
  switch (status) {
  case "model-support-production-model-load":
    return "model-load";
  case "model-support-production-first-turn":
    return "first-turn";
  case "model-support-production-continuity":
    return "continuity";
  case "model-support-production-tool-result-continuation":
    return "tool-result-continuation";
  case "model-support-production-reasoning-differential":
    return "reasoning-differential";
  case "model-support-production-multimodal":
    return "multimodal";
  case "model-support-production-complete":
    return "complete";
  default:
    return currentStage;
  }
}

export function createModelSupportInvestigationWorkerClient({
  planningTimeoutMs = DEFAULT_PLANNING_TIMEOUT_MS,
  candidateAttemptTimeoutMs = DEFAULT_CANDIDATE_ATTEMPT_TIMEOUT_MS,
  productionLaneTimeoutMs = DEFAULT_PRODUCTION_LANE_TIMEOUT_MS,
}: {
  planningTimeoutMs?: number,
  candidateAttemptTimeoutMs?: number,
  productionLaneTimeoutMs?: number,
} = {}): ModelSupportInvestigationWorkerClient {
  const activeWorkers = new Set<Worker>();
  const activeProductionWorkers = new Set<Worker>();
  let disposed = false;

  const createWorkerHandle = (): InvestigationWorkerHandle => {
    if (disposed) throw new Error("Model Support Investigation client is disposed");
    const worker = new Worker(new URL("./entry.ts", import.meta.url), { type: "module" });
    activeWorkers.add(worker);
    return {
      worker,
      remote: Comlink.wrap<IModelSupportInvestigationWorker>(worker),
    };
  };

  const terminateWorkerHandle = ({ handle }: { handle: InvestigationWorkerHandle }): void => {
    handle.worker.terminate();
    activeWorkers.delete(handle.worker);
  };

  const releaseWorkerHandle = async ({ handle }: { handle: InvestigationWorkerHandle }): Promise<void> => {
    try {
      await handle.remote[Comlink.releaseProxy]();
    } finally {
      terminateWorkerHandle({ handle });
    }
  };

  const createProductionWorkerHandle = (): ProductionWorkerHandle => {
    if (disposed) throw new Error("Model Support Investigation client is disposed");
    // Production Lane intentionally runs the real Production worker entry so the
    // observed loader body remains identical to ordinary model loading.
    const worker = new Worker(new URL("../../worker/entry.ts", import.meta.url), { type: "module" });
    activeProductionWorkers.add(worker);
    return {
      worker,
      remote: Comlink.wrap<ITransformersJsWorker>(worker),
    };
  };

  const terminateProductionWorkerHandle = ({ handle }: { handle: ProductionWorkerHandle }): void => {
    handle.worker.terminate();
    activeProductionWorkers.delete(handle.worker);
  };

  const releaseProductionWorkerHandle = async ({ handle }: { handle: ProductionWorkerHandle }): Promise<void> => {
    try {
      await handle.remote[Comlink.releaseProxy]();
    } finally {
      terminateProductionWorkerHandle({ handle });
    }
  };

  return {
    async runPartialInvestigation({ modelId, onEvent, onCheckpoint }) {
      const now = (): string => new Date().toISOString();
      let checkpoint: ModelSupportInvestigationCheckpoint = createInitialInvestigationCheckpoint({
        modelId,
        runId: crypto.randomUUID(),
        now,
      });
      const publishCheckpoint = (): void => {
        onCheckpoint({ checkpoint: structuredClone(checkpoint) });
      };
      const publishEvent = ({ event }: Parameters<typeof onEvent>[0]): void => {
        checkpoint = recordInvestigationEvent({ checkpoint, event, now });
        onEvent({ event });
        publishCheckpoint();
      };
      publishCheckpoint();

      try {
        const planningHandle = createWorkerHandle();
        let planningStage: ModelSupportInvestigationPlanningStage = "worker-start";
        let planningTimedOut = false;
        let partialRun;
        try {
          const operation = planningHandle.remote.runPartialInvestigation(
            modelId,
            Comlink.proxy(({ event }) => {
              planningStage = event.stepId;
              publishEvent({ event });
            }),
          );
          partialRun = await withPlanningTimeout({
            operation,
            timeoutMs: planningTimeoutMs,
            timeoutError: () => new PlanningTimeoutError({ stage: planningStage, timeoutMs: planningTimeoutMs }),
            onTimeout: () => {
              planningTimedOut = true;
              terminateWorkerHandle({ handle: planningHandle });
              publishEvent({
                event: {
                  stepId: (() => {
                    switch (planningStage) {
                    case "worker-start":
                      return "runtime-assets";
                    case "runtime-assets":
                    case "repository-information":
                    case "existing-model-data":
                    case "model-declarations":
                    case "template-behavior":
                    case "model-file-plan":
                    case "loading-investigation":
                    case "lane-comparison":
                    case "evidence-export":
                      return planningStage;
                    default: {
                      const _ex: never = planningStage;
                      throw new Error(`Unhandled planning stage: ${_ex}`);
                    }
                    }
                  })(),
                  status: "failed",
                  detail: `Investigation planning timed out at ${planningStage}`,
                },
              });
            },
          });
        } finally {
          if (!planningTimedOut) await releaseWorkerHandle({ handle: planningHandle });
        }
        checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
        publishCheckpoint();

        const loadRun = await runModelLoadInvestigation({
          partialRun,
          runAttempt: async ({ candidate }) => {
            const { repository, declarations, templateBehavior } = partialRun;
            if (repository === undefined || declarations === undefined) {
              throw new Error("Candidate attempt prerequisites are unavailable");
            }
            const cacheRevisionAliases = createCacheRevisionAliases({
              repository,
              provenance: partialRun.cache?.provenance,
            });
            const attemptHandle = createWorkerHandle();
            const attemptEvents: ModelSupportInvestigationLoadAttemptEvent[] = [];
            let lastStage: ModelSupportInvestigationLoadAttemptStage = "worker-start";
            let timedOut = false;
            try {
              const operation = attemptHandle.remote.runCandidateAttempt(
                repository,
                declarations,
                templateBehavior,
                cacheRevisionAliases,
                candidate,
                Comlink.proxy(publishEvent),
                Comlink.proxy(({ event }) => {
                  lastStage = event.stage;
                  attemptEvents.push(event);
                }),
              );
              return await withCandidateAttemptTimeout({
                operation,
                timeoutMs: candidateAttemptTimeoutMs,
                timeoutError: () => new CandidateAttemptTimeoutError({
                  stage: lastStage,
                  events: [...attemptEvents],
                  timeoutMs: candidateAttemptTimeoutMs,
                }),
                onTimeout: () => {
                  timedOut = true;
                  terminateWorkerHandle({ handle: attemptHandle });
                  publishEvent({
                    event: {
                      stepId: "loading-investigation",
                      status: "running",
                      detail: `${candidate.candidateId}: timed out at ${lastStage}; starting the next eligible candidate`,
                    },
                  });
                },
              });
            } finally {
              if (!timedOut) await releaseWorkerHandle({ handle: attemptHandle });
            }
          },
          onEvent: publishEvent,
          now,
          createAttemptId: () => crypto.randomUUID(),
        });
        checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: loadRun, now });
        publishCheckpoint();

        const completedRun = await runProductionLaneComparison({
          run: loadRun,
          runProductionScenario: async ({ scenario }) => {
            if (disposed) throw new Error("Model Support Investigation client is disposed");
            const productionHandle = createProductionWorkerHandle();
            let lastStage: ModelSupportInvestigationProductionLaneStage = "worker-start";
            let timedOut = false;
            const modelLoadProgress = createModelLoadProgressTracker({
              candidateId: `production-${scenario.candidate.device}-${scenario.candidate.dtype}`,
            });
            try {
              const operation = productionHandle.remote.runModelSupportInvestigationScenario(
                scenario,
                Comlink.proxy(({ info }) => {
                  lastStage = productionLaneStageFromStatus({ status: info.status, currentStage: lastStage });
                  if (info.status === "progress" || info.status === "progress_total" || info.status === "initiate" || info.status === "download" || info.status === "done" || info.status === "ready") {
                    const progress = modelLoadProgress.observe({
                      info,
                      at: now(),
                      nowMs: performance.now(),
                    });
                    if (progress === undefined) return;
                    publishEvent({
                      event: {
                        stepId: "lane-comparison",
                        status: "running",
                        detail: "Production Lane model-load",
                        progress,
                      },
                    });
                    return;
                  }
                  publishEvent({
                    event: {
                      stepId: "lane-comparison",
                      status: "running",
                      detail: `Production Lane ${lastStage}`,
                    },
                  });
                }),
              );
              return await withProductionLaneTimeout({
                operation,
                timeoutMs: productionLaneTimeoutMs,
                timeoutError: () => new ProductionLaneTimeoutError({
                  stage: lastStage,
                  timeoutMs: productionLaneTimeoutMs,
                }),
                onTimeout: () => {
                  timedOut = true;
                  terminateProductionWorkerHandle({ handle: productionHandle });
                  publishEvent({
                    event: {
                      stepId: "lane-comparison",
                      status: "running",
                      detail: `Production Lane timed out at ${lastStage}`,
                    },
                  });
                },
              });
            } finally {
              if (!timedOut) await releaseProductionWorkerHandle({ handle: productionHandle });
            }
          },
          onEvent: publishEvent,
          now,
        });
        checkpoint = completeInvestigationCheckpoint({ checkpoint, run: completedRun, now });
        publishCheckpoint();
        return completedRun;
      } catch (error) {
        checkpoint = interruptInvestigationCheckpoint({ checkpoint, error, now });
        publishCheckpoint();
        throw error;
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const worker of activeWorkers) worker.terminate();
      activeWorkers.clear();
      for (const worker of activeProductionWorkers) worker.terminate();
      activeProductionWorkers.clear();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
