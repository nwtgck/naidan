import { releaseWorkerRemote, workerProxy, wrapWorkerRemote, type WorkerRemote } from "@/utils/worker-transport";
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationCheckpoint,
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationLoadAttemptStage,
  ModelSupportInvestigationWorkerClient,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  ITransformersJsWorker,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProductionInvestigationCandidateLoadAttempt,
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationPartialObservation,
  TransformersJsProductionInvestigationScenario,
} from "@/features/transformers-js/types";
import { runModelLoadInvestigation } from "@/features/transformers-js/model-support-investigation/logic/run-model-load-investigation";
import { runProductionLaneComparison } from "@/features/transformers-js/model-support-investigation/logic/run-production-lane-comparison";
import { fromPlanningWorkerRun } from "@/features/transformers-js/model-support-investigation/logic/planning-worker-run";
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
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";
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
  remote: WorkerRemote<IModelSupportInvestigationWorker>,
}

interface ProductionWorkerHandle {
  worker: Worker,
  remote: WorkerRemote<ITransformersJsWorker>,
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
      remote: wrapWorkerRemote<IModelSupportInvestigationWorker>({ endpoint: worker }),
    };
  };

  const terminateWorkerHandle = ({ handle }: { handle: InvestigationWorkerHandle }): void => {
    handle.worker.terminate();
    activeWorkers.delete(handle.worker);
  };

  const releaseWorkerHandle = async ({ handle }: { handle: InvestigationWorkerHandle }): Promise<void> => {
    try {
      await releaseWorkerRemote({ remote: handle.remote });
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
      remote: wrapWorkerRemote<ITransformersJsWorker>({ endpoint: worker }),
    };
  };

  const terminateProductionWorkerHandle = ({ handle }: { handle: ProductionWorkerHandle }): void => {
    handle.worker.terminate();
    activeProductionWorkers.delete(handle.worker);
  };

  const releaseProductionWorkerHandle = async ({ handle }: { handle: ProductionWorkerHandle }): Promise<void> => {
    try {
      await releaseWorkerRemote({ remote: handle.remote });
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
        let planningAcceptingCallbacks = true;
        let partialRun;
        try {
          const operation = planningHandle.remote.runPartialInvestigation(
            modelId,
            workerProxy({ value: ({ event }) => {
              if (!planningAcceptingCallbacks) return;
              planningStage = event.stepId;
              publishEvent({ event });
            } }),
            workerProxy({ value: ({ run }) => {
              if (!planningAcceptingCallbacks) return;
              checkpoint = replaceInvestigationCheckpointRun({
                checkpoint,
                run: fromPlanningWorkerRun({ run }),
                now,
              });
              publishCheckpoint();
            } }),
          );
          const planningRun = await withPlanningTimeout({
            operation,
            timeoutMs: planningTimeoutMs,
            timeoutError: () => new PlanningTimeoutError({ stage: planningStage, timeoutMs: planningTimeoutMs }),
            onTimeout: () => {
              planningTimedOut = true;
              planningAcceptingCallbacks = false;
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
          partialRun = fromPlanningWorkerRun({ run: planningRun });
          planningAcceptingCallbacks = false;
        } finally {
          planningAcceptingCallbacks = false;
          if (!planningTimedOut) await releaseWorkerHandle({ handle: planningHandle });
        }
        checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
        publishCheckpoint();

        const loadRun = await runModelLoadInvestigation({
          partialRun,
          runAttempt: async ({ candidate, onAttemptCheckpoint }) => {
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
            let attemptAcceptingCallbacks = true;
            try {
              const operation = attemptHandle.remote.runCandidateAttempt(
                repository,
                declarations,
                templateBehavior,
                cacheRevisionAliases,
                candidate,
                workerProxy({ value: ({ event }) => {
                  if (!attemptAcceptingCallbacks) return;
                  publishEvent({ event });
                } }),
                workerProxy({ value: ({ event }) => {
                  if (!attemptAcceptingCallbacks) return;
                  lastStage = event.stage;
                  attemptEvents.push(event);
                } }),
                workerProxy({ value: ({ attempt }) => {
                  if (!attemptAcceptingCallbacks) return;
                  onAttemptCheckpoint({ attempt });
                } }),
              );
              const result = await withCandidateAttemptTimeout({
                operation,
                timeoutMs: candidateAttemptTimeoutMs,
                timeoutError: () => new CandidateAttemptTimeoutError({
                  stage: lastStage,
                  events: [...attemptEvents],
                  timeoutMs: candidateAttemptTimeoutMs,
                }),
                onTimeout: () => {
                  timedOut = true;
                  attemptAcceptingCallbacks = false;
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
              attemptAcceptingCallbacks = false;
              return result;
            } finally {
              attemptAcceptingCallbacks = false;
              if (!timedOut) await releaseWorkerHandle({ handle: attemptHandle });
            }
          },
          onEvent: publishEvent,
          onRunUpdate: ({ run }) => {
            checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run, now });
            publishCheckpoint();
          },
          now,
          createAttemptId: () => crypto.randomUUID(),
        });
        checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: loadRun, now });
        publishCheckpoint();

        const completedRun = await runProductionLaneComparison({
          run: loadRun,
          runProductionScenario: async ({ scenario, onObservationCheckpoint }) => {
            if (disposed) throw new Error("Model Support Investigation client is disposed");
            const accumulatedLoadAttempts: TransformersJsProductionInvestigationCandidateLoadAttempt[] = [];
            let lastCandidateError: unknown;

            const sameCandidate = ({
              left,
              right,
            }: {
              left: TransformersJsProductionInvestigationCandidate,
              right: TransformersJsProductionInvestigationCandidate,
            }): boolean => left.device === right.device && left.dtype === right.dtype;

            const mergeLoadAttempts = ({
              candidateAttempts,
            }: {
              candidateAttempts: TransformersJsProductionInvestigationCandidateLoadAttempt[] | undefined,
            }): TransformersJsProductionInvestigationCandidateLoadAttempt[] => [
              ...accumulatedLoadAttempts,
              ...(candidateAttempts ?? []),
            ];

            const mergePartialObservation = ({
              observation,
            }: {
              observation: TransformersJsProductionInvestigationPartialObservation,
            }): TransformersJsProductionInvestigationPartialObservation => ({
              ...structuredClone(observation),
              loadAttempts: mergeLoadAttempts({ candidateAttempts: observation.loadAttempts }),
            });

            const mergeObservation = ({
              observation,
            }: {
              observation: TransformersJsProductionInvestigationObservation,
            }): TransformersJsProductionInvestigationObservation => ({
              ...structuredClone(observation),
              loadAttempts: mergeLoadAttempts({ candidateAttempts: observation.loadAttempts }),
            });

            for (const candidate of scenario.candidates) {
              const productionHandle = createProductionWorkerHandle();
              const stageState: { lastStage: ModelSupportInvestigationProductionLaneStage } = {
                lastStage: "worker-start",
              };
              let timedOut = false;
              let productionAcceptingCallbacks = true;
              let latestCandidateObservation: TransformersJsProductionInvestigationPartialObservation | undefined;
              const modelLoadProgress = createModelLoadProgressTracker({
                candidateId: `production-${candidate.device}-${candidate.dtype}`,
              });
              const candidateScenario: TransformersJsProductionInvestigationScenario = {
                ...scenario,
                candidates: [candidate],
              };
              try {
                const operation = productionHandle.remote.runModelSupportInvestigationScenario(
                  candidateScenario,
                  workerProxy({ value: ({ info }) => {
                    if (!productionAcceptingCallbacks) return;
                    stageState.lastStage = productionLaneStageFromStatus({ status: info.status, currentStage: stageState.lastStage });
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
                          detail: `Production Lane ${candidate.device}/${candidate.dtype} model-load`,
                          progress,
                        },
                      });
                      return;
                    }
                    publishEvent({
                      event: {
                        stepId: "lane-comparison",
                        status: "running",
                        detail: `Production Lane ${candidate.device}/${candidate.dtype} ${stageState.lastStage}`,
                      },
                    });
                  } }),
                  workerProxy({ value: ({ observation }) => {
                    if (!productionAcceptingCallbacks) return;
                    latestCandidateObservation = structuredClone(observation);
                    onObservationCheckpoint({ observation: mergePartialObservation({ observation }) });
                  } }),
                );
                const result = await withProductionLaneTimeout({
                  operation,
                  timeoutMs: productionLaneTimeoutMs,
                  timeoutError: () => new ProductionLaneTimeoutError({
                    stage: stageState.lastStage,
                    timeoutMs: productionLaneTimeoutMs,
                  }),
                  onTimeout: () => {
                    timedOut = true;
                    productionAcceptingCallbacks = false;
                    terminateProductionWorkerHandle({ handle: productionHandle });
                    publishEvent({
                      event: {
                        stepId: "lane-comparison",
                        status: "running",
                        detail: `Production Lane ${candidate.device}/${candidate.dtype} timed out at ${stageState.lastStage}`,
                      },
                    });
                  },
                });
                productionAcceptingCallbacks = false;
                return mergeObservation({ observation: result });
              } catch (error) {
                lastCandidateError = error;
                const candidateAttempts = latestCandidateObservation?.loadAttempts ?? [];
                const candidatePassedLoad = candidateAttempts.some(attempt =>
                  sameCandidate({ left: attempt.candidate, right: candidate }) && attempt.status === "passed"
                );
                const candidateFailedLoad = candidateAttempts.some(attempt =>
                  sameCandidate({ left: attempt.candidate, right: candidate }) && attempt.status === "failed"
                );
                if (candidatePassedLoad || (!candidateFailedLoad && stageState.lastStage !== "model-load")) {
                  throw error;
                }

                if (candidateFailedLoad) {
                  accumulatedLoadAttempts.push(...candidateAttempts);
                } else {
                  const timeoutAttempt: TransformersJsProductionInvestigationCandidateLoadAttempt = {
                    candidate: structuredClone(candidate),
                    status: "failed",
                    error: serializeInvestigationError({ error }),
                  };
                  accumulatedLoadAttempts.push(timeoutAttempt);
                  onObservationCheckpoint({
                    observation: {
                      modelId: scenario.modelId,
                      resolvedRevision: scenario.resolvedRevision,
                      candidate: undefined,
                      loadAttempts: structuredClone(accumulatedLoadAttempts),
                      route: undefined,
                      isEncoderDecoder: undefined,
                      firstTurn: undefined,
                      continuity: undefined,
                      toolResultContinuation: undefined,
                      reasoning: undefined,
                      multimodal: undefined,
                    },
                  });
                }
                publishEvent({
                  event: {
                    stepId: "lane-comparison",
                    status: "running",
                    detail: `Production Lane ${candidate.device}/${candidate.dtype} load failed; retrying the next candidate in a fresh Worker`,
                  },
                });
              } finally {
                productionAcceptingCallbacks = false;
                if (!timedOut) await releaseProductionWorkerHandle({ handle: productionHandle });
              }
            }

            throw lastCandidateError instanceof Error
              ? lastCandidateError
              : new Error("No Production Lane candidate succeeded");
          },
          onEvent: publishEvent,
          onRunUpdate: ({ run }) => {
            checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run, now });
            publishCheckpoint();
          },
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
