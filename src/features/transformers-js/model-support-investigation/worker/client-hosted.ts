import { releaseWorkerRemote, workerProxy, wrapWorkerRemote, type WorkerRemote } from "@/utils/worker-transport";
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationCheckpoint,
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationLoadAttemptStage,
  ModelSupportInvestigationStep,
  ModelSupportInvestigationWorkerClient,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  ITransformersJsWorker,
  TransformersJsModelLoadProgressObservation,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProductionInvestigationCandidateLoadAttempt,
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationPartialObservation,
  TransformersJsProductionInvestigationScenario,
} from "@/features/transformers-js/types";
import { runModelLoadInvestigation } from "@/features/transformers-js/model-support-investigation/logic/run-model-load-investigation";
import { completeDownloadVerificationRuntimeEvidence } from "@/features/transformers-js/download-verification/logic/complete-download-verification-runtime-evidence";
import type { DownloadVerificationRuntimeCompletionEvidence } from "@/features/transformers-js/download-verification/evidence/types";
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
import {
  isModelSupportInvestigationUserInterruptedError,
  ModelSupportInvestigationUserInterruptedError,
} from "@/features/transformers-js/model-support-investigation/logic/investigation-interruption";

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
  case "model-support-production-runtime-preparation":
    return "runtime-preparation";
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

function isProductionModelLoadStage({
  stage,
}: {
  stage: ModelSupportInvestigationProductionLaneStage,
}): boolean {
  switch (stage) {
  case "model-load":
    return true;
  case "worker-start":
  case "runtime-preparation":
  case "first-turn":
  case "continuity":
  case "tool-result-continuation":
  case "reasoning-differential":
  case "multimodal":
  case "complete":
    return false;
  default: {
    const _ex: never = stage;
    return _ex;
  }
  }
}

function productionLoadProgressDetail({
  stage,
  candidate,
}: {
  stage: ModelSupportInvestigationProductionLaneStage,
  candidate: TransformersJsProductionInvestigationCandidate,
}): string {
  switch (stage) {
  case "runtime-preparation":
    return `Production Lane ${candidate.device}/${candidate.dtype} runtime-preparation`;
  case "worker-start":
  case "model-load":
    return `Production Lane ${candidate.device}/${candidate.dtype} model-load`;
  case "first-turn":
  case "continuity":
  case "tool-result-continuation":
  case "reasoning-differential":
  case "multimodal":
  case "complete":
    return `Production Lane ${candidate.device}/${candidate.dtype} ${stage} (late model-load progress)`;
  default: {
    const _ex: never = stage;
    return _ex;
  }
  }
}

function updateDownloadEvidenceCoordinatorStep({
  steps,
  status,
  detail,
}: {
  steps: ModelSupportInvestigationStep[],
  status: ModelSupportInvestigationStep['status'],
  detail: string,
}): ModelSupportInvestigationStep[] {
  return steps.map(step => {
    switch (step.id) {
    case 'download-evidence':
      return { ...step, status, detail };
    case 'runtime-assets':
    case 'repository-information':
    case 'existing-model-data':
    case 'model-declarations':
    case 'template-behavior':
    case 'model-file-plan':
    case 'loading-investigation':
    case 'lane-comparison':
    case 'evidence-export':
      return step;
    default: {
      const _ex: never = step.id;
      return _ex;
    }
    }
  });
}

function updateTemplateBehaviorCoordinatorStep({
  steps,
  status,
  detail,
}: {
  steps: ModelSupportInvestigationStep[],
  status: ModelSupportInvestigationStep['status'],
  detail: string,
}): ModelSupportInvestigationStep[] {
  return steps.map(step => {
    switch (step.id) {
    case 'template-behavior':
      return { ...step, status, detail };
    case 'runtime-assets':
    case 'repository-information':
    case 'download-evidence':
    case 'existing-model-data':
    case 'model-declarations':
    case 'model-file-plan':
    case 'loading-investigation':
    case 'lane-comparison':
    case 'evidence-export':
      return step;
    default: {
      const _ex: never = step.id;
      return _ex;
    }
    }
  });
}

function legacyMainHasBoundedMismatch({ provenance }: {
  provenance: { files: Array<{ cacheRevision: string; status: string }> } | undefined,
}): boolean {
  return provenance?.files.some(file => (
    file.cacheRevision === 'main' && file.status === 'mismatched'
  )) ?? false;
}

function runtimeRevisionIdentityDetail({ completion }: {
  completion: DownloadVerificationRuntimeCompletionEvidence,
}): string {
  const exact = completion.cacheRevision === completion.repositoryResolvedRevision
    && completion.loaderRevisionOption === completion.repositoryResolvedRevision;
  return exact ? '' : '; exact frozen-revision identity remains unverified';
}

function runtimeCompletionOutcome({ completion }: {
  completion: DownloadVerificationRuntimeCompletionEvidence | undefined,
}): { accepted: boolean; detail: string; errorDetail: string | undefined } {
  if (completion === undefined) {
    return { accepted: false, detail: 'Runtime cache completion evidence is missing', errorDetail: 'Runtime completion evidence is missing' };
  }
  switch (completion.status) {
  case 'accepted':
    return {
      accepted: true,
      detail: `Runtime cache accepted from ${completion.source} at ${completion.loaderRevisionOption ?? 'main'}${completion.selectedCandidate === undefined ? '' : ` using ${completion.selectedCandidate.device}/${completion.selectedCandidate.dtype}`}${runtimeRevisionIdentityDetail({ completion })}`,
      errorDetail: undefined,
    };
  case 'failed':
  case 'exhausted':
    return {
      accepted: false,
      detail: `Runtime cache completion ended with ${completion.status}`,
      errorDetail: completion.error?.message ?? `Runtime completion status: ${completion.status}`,
    };
  default: {
    const _ex: never = completion.status;
    throw new Error(`Unhandled runtime completion status: ${_ex}`);
  }
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
  let userInterruptionRequested = false;
  let activeInterrupt: (() => void) | undefined;
  let activeRuntimeAbortController: AbortController | undefined;

  const terminateAllWorkers = (): void => {
    for (const worker of activeWorkers) worker.terminate();
    activeWorkers.clear();
    for (const worker of activeProductionWorkers) worker.terminate();
    activeProductionWorkers.clear();
  };

  const createWorkerHandle = (): InvestigationWorkerHandle => {
    if (userInterruptionRequested) throw new ModelSupportInvestigationUserInterruptedError();
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
    if (userInterruptionRequested) throw new ModelSupportInvestigationUserInterruptedError();
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
      const userInterruptionError = new ModelSupportInvestigationUserInterruptedError();
      const interruption = Promise.withResolvers<never>();
      const awaitInterruptible = async <T>({
        operation,
      }: {
        operation: Promise<T>,
      }): Promise<T> => (
        await Promise.race([operation, interruption.promise])
      );
      let checkpoint: ModelSupportInvestigationCheckpoint = createInitialInvestigationCheckpoint({
        modelId,
        runId: crypto.randomUUID(),
        now,
      });
      let userInterruptionCheckpointPublished = false;
      let flushActiveProductionInterruptionEvidence: (() => void) | undefined;
      const publishCheckpoint = ({ force = false }: { force?: boolean } = {}): void => {
        if (userInterruptionRequested && !force) return;
        onCheckpoint({ checkpoint: structuredClone(checkpoint) });
      };
      const publishEvent = ({ event }: Parameters<typeof onEvent>[0]): void => {
        if (userInterruptionRequested) return;
        checkpoint = recordInvestigationEvent({ checkpoint, event, now });
        onEvent({ event });
        publishCheckpoint();
      };
      activeInterrupt = () => {
        if (userInterruptionRequested) return;
        flushActiveProductionInterruptionEvidence?.();
        activeRuntimeAbortController?.abort(userInterruptionError);
        userInterruptionRequested = true;
        terminateAllWorkers();
        checkpoint = interruptInvestigationCheckpoint({ checkpoint, error: userInterruptionError, now });
        userInterruptionCheckpointPublished = true;
        publishCheckpoint({ force: true });
        interruption.reject(userInterruptionError);
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
          const planningRun = await awaitInterruptible({ operation: withPlanningTimeout({
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
                    case "download-evidence":
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
          }) });
          partialRun = fromPlanningWorkerRun({ run: planningRun });
          planningAcceptingCallbacks = false;
        } finally {
          planningAcceptingCallbacks = false;
          if (!planningTimedOut && !userInterruptionRequested) await releaseWorkerHandle({ handle: planningHandle });
        }
        checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
        publishCheckpoint();

        if (partialRun.downloadEvidence !== undefined) {
          const runtimeAbortController = new AbortController();
          activeRuntimeAbortController = runtimeAbortController;
          publishEvent({
            event: {
              stepId: "download-evidence",
              status: "running",
              detail: "Preparing or reusing one Production-accepted runtime cache for downstream investigation lanes",
            },
          });
          try {
            const completedEvidence = await awaitInterruptible({
              operation: completeDownloadVerificationRuntimeEvidence({
                evidence: partialRun.downloadEvidence,
                signal: runtimeAbortController.signal,
                allowLegacyMainReuse: !legacyMainHasBoundedMismatch({ provenance: partialRun.cache?.provenance }),
              }),
            });
            partialRun = { ...partialRun, downloadEvidence: completedEvidence };
            const completion = completedEvidence.runtimeCompletion;
            const outcome = runtimeCompletionOutcome({ completion });
            partialRun.steps = updateDownloadEvidenceCoordinatorStep({
              steps: partialRun.steps,
              status: outcome.accepted ? 'passed' : 'failed',
              detail: outcome.detail,
            });
            partialRun.currentOperation = outcome.detail;
            partialRun.completedAt = now();
            if (!outcome.accepted) {
              partialRun.status = 'failed';
              const detail = outcome.errorDetail ?? 'Runtime completion failed without an error detail';
              partialRun.error = partialRun.error === undefined ? detail : `${partialRun.error}; ${detail}`;
            }
            checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
            publishCheckpoint();
          } finally {
            if (activeRuntimeAbortController === runtimeAbortController) activeRuntimeAbortController = undefined;
          }
        }

        const runtimeCompletion = partialRun.downloadEvidence?.runtimeCompletion;
        const runtimeCompletionAccepted = runtimeCompletionOutcome({ completion: runtimeCompletion }).accepted;
        if (runtimeCompletionAccepted && runtimeCompletion !== undefined && partialRun.repository !== undefined) {
          const templateHandle = createWorkerHandle();
          try {
            publishEvent({
              event: {
                stepId: 'template-behavior',
                status: 'running',
                detail: `Loading tokenizer cache-only from ${runtimeCompletion.loaderRevisionOption ?? 'main'} after runtime completion`,
              },
            });
            partialRun.templateBehavior = await awaitInterruptible({
              operation: templateHandle.remote.inspectDownloadedTemplateBehavior({
                repository: partialRun.repository,
                loaderRevisionOption: runtimeCompletion.loaderRevisionOption,
              }),
            });
            const passed = partialRun.templateBehavior.cases.filter(item => item.status === 'passed').length;
            const failed = partialRun.templateBehavior.cases.length - passed;
            const detail = `${partialRun.templateBehavior.tokenizerClass}: ${passed} template cases rendered, ${failed} unsupported or failed, from the accepted runtime cache`;
            partialRun.steps = updateTemplateBehaviorCoordinatorStep({
              steps: partialRun.steps,
              status: 'passed',
              detail,
            });
            partialRun.currentOperation = detail;
            partialRun.completedAt = now();
            checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
            publishCheckpoint();
          } catch (error) {
            if (userInterruptionRequested || isModelSupportInvestigationUserInterruptedError({ error })) throw userInterruptionError;
            const serialized = serializeInvestigationError({ error });
            const detail = `Template behavior failed after runtime completion: ${serialized.message}`;
            partialRun.steps = updateTemplateBehaviorCoordinatorStep({
              steps: partialRun.steps,
              status: 'failed',
              detail,
            });
            partialRun.status = 'failed';
            partialRun.error = partialRun.error === undefined ? detail : `${partialRun.error}; ${detail}`;
            partialRun.currentOperation = detail;
            partialRun.completedAt = now();
            checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
            publishCheckpoint();
          } finally {
            if (!userInterruptionRequested) await releaseWorkerHandle({ handle: templateHandle });
          }
        }

        const loadRun = await runModelLoadInvestigation({
          partialRun,
          runAttempt: async ({ candidate, loaderRevisionOption, onAttemptCheckpoint }) => {
            const { repository, declarations, templateBehavior } = partialRun;
            if (repository === undefined || declarations === undefined) {
              throw new Error("Candidate attempt prerequisites are unavailable");
            }
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
                loaderRevisionOption,
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
              const result = await awaitInterruptible({ operation: withCandidateAttemptTimeout({
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
              }) });
              attemptAcceptingCallbacks = false;
              return result;
            } finally {
              attemptAcceptingCallbacks = false;
              if (!timedOut && !userInterruptionRequested) await releaseWorkerHandle({ handle: attemptHandle });
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
              let latestCandidateLoadProgress: TransformersJsModelLoadProgressObservation | undefined;
              const candidateScenario: TransformersJsProductionInvestigationScenario = {
                ...scenario,
                candidates: [candidate],
              };
              const interruptedCandidateObservation = (): TransformersJsProductionInvestigationPartialObservation => {
                const observation = latestCandidateObservation === undefined
                  ? {
                    modelId: scenario.modelId,
                    resolvedRevision: scenario.resolvedRevision,
                    loaderRevisionOption: scenario.loadRevision ?? null,
                    runtimeLoadDurationMs: undefined,
                    candidate: undefined,
                    loadAttempts: structuredClone(accumulatedLoadAttempts),
                    activeLoadAttempt: undefined,
                    route: undefined,
                    isEncoderDecoder: undefined,
                    firstTurn: undefined,
                    continuity: undefined,
                    toolResultContinuation: undefined,
                    reasoning: undefined,
                    multimodal: undefined,
                  } satisfies TransformersJsProductionInvestigationPartialObservation
                  : mergePartialObservation({ observation: latestCandidateObservation });
                if (!isProductionModelLoadStage({ stage: stageState.lastStage })) return observation;
                const existingActiveAttempt = observation.activeLoadAttempt;
                observation.activeLoadAttempt = {
                  candidate: structuredClone(candidate),
                  status: "running",
                  modelLoadDurationMs: existingActiveAttempt?.modelLoadDurationMs,
                  modelLoadProgress: latestCandidateLoadProgress === undefined
                    ? existingActiveAttempt?.modelLoadProgress
                    : structuredClone(latestCandidateLoadProgress),
                };
                return observation;
              };
              flushActiveProductionInterruptionEvidence = () => {
                onObservationCheckpoint({ observation: interruptedCandidateObservation() });
              };
              try {
                const operation = productionHandle.remote.runModelSupportInvestigationScenario(
                  candidateScenario,
                  workerProxy({ value: ({ event }) => {
                    if (!productionAcceptingCallbacks) return;
                    switch (event.kind) {
                    case "model-load":
                      latestCandidateLoadProgress = structuredClone(event.progress);
                      publishEvent({
                        event: {
                          stepId: "lane-comparison",
                          status: "running",
                          detail: productionLoadProgressDetail({
                            stage: stageState.lastStage,
                            candidate,
                          }),
                          progress: event.progress,
                        },
                      });
                      return;
                    case "stage":
                      stageState.lastStage = productionLaneStageFromStatus({
                        status: event.status,
                        currentStage: stageState.lastStage,
                      });
                      publishEvent({
                        event: {
                          stepId: "lane-comparison",
                          status: "running",
                          detail: `Production Lane ${candidate.device}/${candidate.dtype} ${stageState.lastStage}`,
                        },
                      });
                      return;
                    default: {
                      const _ex: never = event;
                      return _ex;
                    }
                    }
                  } }),
                  workerProxy({ value: ({ observation }) => {
                    if (!productionAcceptingCallbacks) return;
                    latestCandidateObservation = structuredClone(observation);
                    onObservationCheckpoint({ observation: mergePartialObservation({ observation }) });
                  } }),
                );
                const result = await awaitInterruptible({ operation: withProductionLaneTimeout({
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
                }) });
                productionAcceptingCallbacks = false;
                return mergeObservation({ observation: result });
              } catch (error) {
                if (userInterruptionRequested || isModelSupportInvestigationUserInterruptedError({ error })) {
                  throw userInterruptionError;
                }
                lastCandidateError = error;
                const candidateAttempts = latestCandidateObservation?.loadAttempts ?? [];
                const candidatePassedLoad = candidateAttempts.some(attempt =>
                  sameCandidate({ left: attempt.candidate, right: candidate }) && attempt.status === "passed"
                );
                const candidateFailedLoad = candidateAttempts.some(attempt =>
                  sameCandidate({ left: attempt.candidate, right: candidate }) && attempt.status === "failed"
                );
                if (candidatePassedLoad || (!candidateFailedLoad && !isProductionModelLoadStage({ stage: stageState.lastStage }))) {
                  throw error;
                }

                if (candidateFailedLoad) {
                  accumulatedLoadAttempts.push(...candidateAttempts);
                } else {
                  const timeoutAttempt: TransformersJsProductionInvestigationCandidateLoadAttempt = {
                    candidate: structuredClone(candidate),
                    status: "failed",
                    modelLoadDurationMs: undefined,
                    modelLoadProgress: latestCandidateLoadProgress === undefined
                      ? undefined
                      : structuredClone(latestCandidateLoadProgress),
                    error: serializeInvestigationError({ error }),
                  };
                  accumulatedLoadAttempts.push(timeoutAttempt);
                  onObservationCheckpoint({
                    observation: {
                      modelId: scenario.modelId,
                      resolvedRevision: scenario.resolvedRevision,
                      loaderRevisionOption: scenario.loadRevision ?? null,
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
                flushActiveProductionInterruptionEvidence = undefined;
                if (!timedOut && !userInterruptionRequested) await releaseProductionWorkerHandle({ handle: productionHandle });
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
        const interruptedByUser = userInterruptionRequested
          || isModelSupportInvestigationUserInterruptedError({ error });
        if (!userInterruptionCheckpointPublished) {
          checkpoint = interruptInvestigationCheckpoint({
            checkpoint,
            error: interruptedByUser ? userInterruptionError : error,
            now,
          });
          publishCheckpoint({ force: true });
        }
        throw interruptedByUser ? userInterruptionError : error;
      } finally {
        activeRuntimeAbortController = undefined;
        activeInterrupt = undefined;
      }
    },
    async interrupt(): Promise<void> {
      activeInterrupt?.();
    },
    async dispose(): Promise<void> {
      disposed = true;
      terminateAllWorkers();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
