import { releaseWorkerRemote, workerProxy, wrapWorkerRemote, type WorkerRemote } from "@/utils/worker-transport";
import { createProductionWorkerSession } from '@/features/transformers-js/worker/production-worker-session';
import { createFreshMetadataWorkerClient } from '@/features/transformers-js/model-support-investigation/fresh-metadata-worker/client-hosted';
import { freshMetadataRequestSchema, FRESH_METADATA_MAX_BYTES } from '@/features/transformers-js/model-support-investigation/fresh-metadata-worker/types';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationCheckpoint,
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationLoadAttemptStage,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
  ModelSupportInvestigationWorkerClient,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  TransformersJsModelLoadProgressObservation,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProductionInvestigationCandidateLoadAttempt,
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationPartialObservation,
  TransformersJsProductionInvestigationScenario,
} from "@/features/transformers-js/types";
import { runModelLoadInvestigation } from "@/features/transformers-js/model-support-investigation/logic/run-model-load-investigation";
import { completeDownloadVerificationRuntimeEvidence } from "@/features/transformers-js/download-verification/logic/complete-download-verification-runtime-evidence";
import { DEFAULT_CACHE_ACCEPTANCE_TIMEOUT_MS, withCacheAcceptanceDeadline } from '@/features/transformers-js/model-support-investigation/logic/cache-acceptance-deadline';
import { createModelLoadProgressTracker } from '@/features/transformers-js/model-support-investigation/logic/model-load-progress';
import { selectDownloadRuntimeCandidates } from "@/features/transformers-js/model-support-investigation/logic/select-download-runtime-candidates";
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
import { resolveInvestigationExecutionPlan } from "@/features/transformers-js/model-support-investigation/logic/investigation-config";
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
  session: ReturnType<typeof createProductionWorkerSession>,
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
}): { accepted: boolean; blocked: boolean; detail: string; errorDetail: string | undefined } {
  if (completion === undefined) {
    return {
      accepted: false,
      blocked: false,
      detail: 'Runtime cache acceptance evidence is missing',
      errorDetail: 'Runtime cache acceptance evidence is missing',
    };
  }
  switch (completion.status) {
  case 'accepted':
    return {
      accepted: true,
      blocked: false,
      detail: `Runtime cache accepted from ${completion.source} at ${completion.loaderRevisionOption ?? 'main'}${completion.selectedCandidate === undefined ? '' : ` using ${completion.selectedCandidate.device}/${completion.selectedCandidate.dtype}`}${runtimeRevisionIdentityDetail({ completion })}`,
      errorDetail: undefined,
    };
  case 'exhausted':
    switch (completion.source) {
    case 'cache-only-unavailable':
      return {
        accepted: false,
        blocked: true,
        detail: completion.error?.message ?? 'No complete local Production candidate is available; downstream runtime probes are blocked without downloading model artifacts',
        errorDetail: undefined,
      };
    case 'reused-production-cache':
    case 'production-download-preparation':
    case 'cache-reuse-failed':
      return {
        accepted: false,
        blocked: false,
        detail: 'Runtime cache acceptance ended with exhausted',
        errorDetail: completion.error?.message ?? 'Runtime cache acceptance status: exhausted',
      };
    default: {
      const _ex: never = completion.source;
      throw new Error(`Unhandled runtime completion source: ${_ex}`);
    }
    }
  case 'failed':
    return {
      accepted: false,
      blocked: false,
      detail: 'Runtime cache acceptance failed',
      errorDetail: completion.error?.message ?? 'Runtime cache acceptance status: failed',
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
  cacheAcceptanceTimeoutMs = DEFAULT_CACHE_ACCEPTANCE_TIMEOUT_MS,
}: {
  planningTimeoutMs?: number,
  candidateAttemptTimeoutMs?: number,
  productionLaneTimeoutMs?: number,
  cacheAcceptanceTimeoutMs?: number,
} = {}): ModelSupportInvestigationWorkerClient {
  const activeWorkers = new Set<Worker>();
  const activeProductionSessions = new Set<ProductionWorkerHandle['session']>();
  const activeMetadataClients = new Set<ReturnType<typeof createFreshMetadataWorkerClient>>();
  let disposed = false;
  let userInterruptionRequested = false;
  let activeInterrupt: (() => void) | undefined;
  let activeRuntimeAbortController: AbortController | undefined;

  const terminateAllWorkers = (): void => {
    for (const client of activeMetadataClients) client.dispose();
    activeMetadataClients.clear();
    for (const worker of activeWorkers) worker.terminate();
    activeWorkers.clear();
    for (const session of activeProductionSessions) session.dispose();
    activeProductionSessions.clear();
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        releaseWorkerRemote({ remote: handle.remote }),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    } catch {
      // The operation has already settled. A Comlink release failure is cleanup-only and
      // must not replace the investigation result; terminating the Worker is authoritative.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      terminateWorkerHandle({ handle });
    }
  };

  const createProductionWorkerHandle = (): ProductionWorkerHandle => {
    if (userInterruptionRequested) throw new ModelSupportInvestigationUserInterruptedError();
    if (disposed) throw new Error("Model Support Investigation client is disposed");
    // Production Lane intentionally uses the ordinary Production bootstrap so
    // both its offline network boundary and loader body remain identical.
    const worker = new Worker(new URL("../../worker/bootstrap.ts", import.meta.url), { type: "module" });
    const session = createProductionWorkerSession({ worker, startupTimeoutMs: undefined });
    activeProductionSessions.add(session);
    return { session };
  };

  const terminateProductionWorkerHandle = ({ handle }: { handle: ProductionWorkerHandle }): void => {
    handle.session.dispose();
    activeProductionSessions.delete(handle.session);
  };

  return {
    async runPartialInvestigation({ modelId, configuration, onEvent, onCheckpoint, replayMetadataBudgetBytes }) {
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
      const executionPlan = resolveInvestigationExecutionPlan({ scope: configuration.scope });
      const withExecutionPolicy = ({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationRun => ({
        ...run,
        requestedConfiguration: structuredClone(configuration),
        executionPlan: structuredClone(executionPlan),
      });
      let checkpoint: ModelSupportInvestigationCheckpoint = createInitialInvestigationCheckpoint({
        modelId,
        runId: crypto.randomUUID(),
        now,
      });
      checkpoint = { ...checkpoint, run: withExecutionPolicy({ run: checkpoint.run }) };
      let userInterruptionCheckpointPublished = false;
      let retainedReplayMetadata: ModelSupportInvestigationCheckpoint['replayMetadata'];
      let flushActiveProductionInterruptionEvidence: (() => void) | undefined;
      const publishCheckpoint = ({ force = false }: { force?: boolean } = {}): void => {
        if (userInterruptionRequested && !force) return;
        onCheckpoint({ checkpoint: { ...structuredClone(checkpoint), ...(retainedReplayMetadata === undefined ? {} : { replayMetadata: retainedReplayMetadata }) } });
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
        let freshMetadataAcquisition: 'not-started' | 'started' = 'not-started';
        let partialRun: ModelSupportInvestigationRun;
        try {
          const operation = planningHandle.remote.runPartialInvestigation(
            {
              modelId,
              externalNetworkPolicy: configuration.externalNetworkPolicy,
              executionPlan,
              replayMetadataBudgetBytes,
            },
            workerProxy({ value: ({ event }) => {
              if (!planningAcceptingCallbacks) return;
              planningStage = event.stepId;
              publishEvent({ event });
            } }),
            workerProxy({ value: ({ run, replayMetadata }) => {
              if (!planningAcceptingCallbacks) return;
              checkpoint = replaceInvestigationCheckpointRun({
                checkpoint,
                run: withExecutionPolicy({ run: fromPlanningWorkerRun({ run }) }),
                now,
              });
              if (replayMetadata !== undefined) retainedReplayMetadata = replayMetadata;
              publishCheckpoint();
            } }),
            workerProxy({ value: async ({ request: input }) => {
              if (!planningAcceptingCallbacks || disposed || userInterruptionRequested) throw new ModelSupportInvestigationUserInterruptedError();
              const request = freshMetadataRequestSchema.parse(input);
              if (configuration.externalNetworkPolicy !== 'allow' || !executionPlan.repositoryDownload
                || request.modelId !== normalizeTransformersJsProductionModelId({ modelId })
                || request.maximumBytes > (replayMetadataBudgetBytes ?? FRESH_METADATA_MAX_BYTES)) {
                throw new Error('Fresh metadata request exceeds the selected investigation authority');
              }
              // A failed acquisition must not mint another target-sized budget.
              // One disposable runtime owns this target's fresh attempt.
              switch (freshMetadataAcquisition) {
              case 'not-started': break;
              case 'started': throw new Error('Fresh metadata acquisition already started for this target');
              default: {
                const _ex: never = freshMetadataAcquisition;
                throw new Error(`Unknown fresh acquisition state: ${_ex}`);
              }
              }
              freshMetadataAcquisition = 'started';
              const client = createFreshMetadataWorkerClient();
              activeMetadataClients.add(client);
              const controller = new AbortController();
              activeRuntimeAbortController = controller;
              try {
                return await client.run({
                  ...request, repositoryFiles: request.repositoryFiles.map(({ path, size }) => ({ path, size })), signal: controller.signal,
                  onObservation: ({ summary }) => {
                    if (!planningAcceptingCallbacks || userInterruptionRequested) return;
                    checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: { ...checkpoint.run, freshMetadata: summary }, now });
                    const last = summary.requests.at(-1);
                    publishEvent({ event: { stepId: 'download-evidence', status: 'running',
                      detail: `Fresh metadata: ${summary.status}; ${last?.consumer ?? 'runtime-preparation'}; file=${last?.path ?? 'starting'}; response=${last?.httpStatus ?? 'pending'}; received=${summary.receivedBytes}/${summary.maximumBytes} bytes; preparation-stage=${summary.preparationStage ?? 'not-recorded'}; failure-category=${summary.failureCategory ?? 'not-recorded'}`,
                    } });
                  },
                });
              } finally {
                client.dispose();
                activeMetadataClients.delete(client);
                if (activeRuntimeAbortController === controller) activeRuntimeAbortController = undefined;
              }
            } }),
          );
          const planningRun = await awaitInterruptible({ operation: withPlanningTimeout({
            operation,
            timeoutMs: planningTimeoutMs,
            timeoutError: () => new PlanningTimeoutError({ stage: planningStage, timeoutMs: planningTimeoutMs }),
            onTimeout: () => {
              planningTimedOut = true;
              planningAcceptingCallbacks = false;
              for (const client of activeMetadataClients) client.dispose();
              activeMetadataClients.clear();
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
          partialRun = withExecutionPolicy({ run: fromPlanningWorkerRun({ run: planningRun }) });
          planningAcceptingCallbacks = false;
        } finally {
          planningAcceptingCallbacks = false;
          if (!planningTimedOut && !userInterruptionRequested) await releaseWorkerHandle({ handle: planningHandle });
        }
        checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
        publishCheckpoint();

        if (partialRun.downloadEvidence !== undefined && executionPlan.modelLoad) {
          const evidenceBeforeAcceptance = partialRun.downloadEvidence;
          const runtimeCandidateSelection = partialRun.modelFilePlan === undefined
            ? undefined
            : selectDownloadRuntimeCandidates({ modelFilePlan: partialRun.modelFilePlan });
          const runtimeAbortController = new AbortController();
          activeRuntimeAbortController = runtimeAbortController;
          let acceptingRuntimeProgress = true;
          let progressKey: string | undefined;
          let progressTracker: ReturnType<typeof createModelLoadProgressTracker> | undefined;
          const acceptanceDeadline = new Date(Date.now() + cacheAcceptanceTimeoutMs).toISOString();
          let acceptancePhase = 'cache-inventory';
          let progressDetail = '';
          const flushAcceptanceProgress = (): void => {
            const sample = progressTracker?.flush();
            if (sample !== undefined) publishEvent({ event: {
              stepId: 'download-evidence', status: 'running', detail: progressDetail, progress: sample,
            } });
          };
          flushActiveProductionInterruptionEvidence = flushAcceptanceProgress;
          publishEvent({
            event: {
              stepId: "download-evidence",
              status: "running",
              detail: "Checking the existing downloaded-model cache for one Production-accepted candidate; investigation will not download missing model artifacts",
            },
          });
          try {
            const completedEvidence = await awaitInterruptible({
              operation: withCacheAcceptanceDeadline({
                controller: runtimeAbortController,
                timeoutMs: cacheAcceptanceTimeoutMs,
                start: () => completeDownloadVerificationRuntimeEvidence({
                  evidence: evidenceBeforeAcceptance,
                  signal: runtimeAbortController.signal,
                  onProgress: ({ progress }) => {
                    if (!acceptingRuntimeProgress || runtimeAbortController.signal.aborted) return;
                    const candidateId = progress.candidate === undefined
                      ? 'candidate-selection'
                      : `${progress.candidate.device}-${progress.candidate.dtype}`;
                    const key = `${progress.revision ?? 'unselected'}:${candidateId}`;
                    if (key !== progressKey) {
                      flushAcceptanceProgress();
                      progressTracker = createModelLoadProgressTracker({ candidateId });
                      progressKey = key;
                    }
                    switch (progress.phase) {
                    case 'cache-inventory':
                    case 'revision-acceptance':
                    case 'candidate-acceptance':
                    case 'cache-after':
                      acceptancePhase = progress.phase;
                      break;
                    case 'runtime':
                      if (progress.info?.status.startsWith('cache-acceptance-')) acceptancePhase = progress.info.status;
                      break;
                    default: {
                      const exhaustive: never = progress.phase;
                      throw new Error(`Unhandled acceptance phase: ${exhaustive}`);
                    }
                    }
                    progressDetail = `Production cache acceptance: ${acceptancePhase}; revision=${progress.revision ?? 'unselected'}; candidate=${candidateId}; deadline=${acceptanceDeadline}`;
                    const sample = progressTracker?.observe({
                      info: progress.info ?? { status: progress.phase },
                      at: now(), nowMs: performance.now(),
                    });
                    if (sample === undefined) return;
                    publishEvent({ event: {
                      stepId: 'download-evidence', status: 'running',
                      detail: progressDetail,
                      progress: sample,
                    } });
                  },
                  allowLegacyMainReuse: !legacyMainHasBoundedMismatch({ provenance: partialRun.cache?.provenance }),
                  ...(runtimeCandidateSelection === undefined ? {} : {
                    reusableCandidateOrderByRevision: runtimeCandidateSelection.reusableCandidateOrderByRevision,
                  }),
                }),
              }),
            });
            partialRun = { ...partialRun, downloadEvidence: completedEvidence };
            const completion = completedEvidence.runtimeCompletion;
            if (completion !== undefined && completion.status === 'accepted' && partialRun.runtimeTarget !== undefined) {
              partialRun.runtimeTarget = {
                ...partialRun.runtimeTarget,
                loaderRevisionOption: completion.loaderRevisionOption,
              };
            }
            const outcome = runtimeCompletionOutcome({ completion });
            partialRun.steps = updateDownloadEvidenceCoordinatorStep({
              steps: partialRun.steps,
              status: outcome.accepted || outcome.blocked ? 'passed' : 'failed',
              detail: outcome.detail,
            });
            partialRun.currentOperation = outcome.detail;
            partialRun.completedAt = now();
            if (!outcome.accepted && !outcome.blocked) {
              partialRun.status = 'failed';
              const detail = String(outcome.errorDetail ?? 'Runtime cache acceptance failed without an error detail');
              const existingError: string | undefined = typeof partialRun.error === 'string' ? String(partialRun.error) : undefined;
              partialRun.error = existingError === undefined ? detail : `${existingError}; ${detail}`;
            }
            checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
            publishCheckpoint();
          } finally {
            flushAcceptanceProgress();
            if (flushActiveProductionInterruptionEvidence === flushAcceptanceProgress) flushActiveProductionInterruptionEvidence = undefined;
            acceptingRuntimeProgress = false;
            if (activeRuntimeAbortController === runtimeAbortController) activeRuntimeAbortController = undefined;
          }
        }

        if (partialRun.downloadEvidence !== undefined && !executionPlan.modelLoad) {
          partialRun.steps = updateDownloadEvidenceCoordinatorStep({
            steps: partialRun.steps,
            status: 'passed',
            detail: 'Probe-only Download Evidence collected; runtime cache acceptance was skipped because Model Load is not selected',
          });
          partialRun.currentOperation = 'Repository / Download investigation completed without Model Load';
          partialRun.completedAt = now();
          checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
          publishCheckpoint();
        }

        if (!executionPlan.modelLoad) {
          partialRun.steps = partialRun.steps.map(step => {
            if (step.id === 'loading-investigation' || step.id === 'lane-comparison') {
              return { ...step, status: 'skipped' as const, detail: 'Skipped because Model Load is not selected by investigation scope' };
            }
            return step;
          });
          partialRun.productionLane = { status: 'not-run', observation: undefined, partialObservation: undefined, error: undefined };
          partialRun.currentOperation = 'Selected investigation scope completed without Model Load';
          partialRun.completedAt = now();
          checkpoint = completeInvestigationCheckpoint({ checkpoint, run: partialRun, now });
          publishCheckpoint();
          return partialRun;
        }

        const runtimeCompletion: DownloadVerificationRuntimeCompletionEvidence | undefined = partialRun.downloadEvidence?.runtimeCompletion;
        const runtimeCompletionAccepted = runtimeCompletionOutcome({ completion: runtimeCompletion }).accepted;
        if (executionPlan.generation && runtimeCompletionAccepted && runtimeCompletion !== undefined && partialRun.runtimeTarget !== undefined) {
          const templateHandle = createWorkerHandle();
          let templateTimedOut = false;
          try {
            publishEvent({
              event: {
                stepId: 'template-behavior',
                status: 'running',
                detail: `Loading tokenizer cache-only from ${runtimeCompletion.loaderRevisionOption ?? 'main'} after runtime completion`,
              },
            });
            const templateBehavior = await withPlanningTimeout({
              // Keep interruption inside the deadline so a user stop/dispose
              // settles this wrapper and clears its timer immediately too.
              operation: awaitInterruptible({
                operation: templateHandle.remote.inspectDownloadedTemplateBehavior({
                  runtimeTarget: partialRun.runtimeTarget,
                }),
              }),
              timeoutMs: planningTimeoutMs,
              timeoutError: () => new PlanningTimeoutError({ stage: 'template-behavior', timeoutMs: planningTimeoutMs }),
              onTimeout: () => {
                templateTimedOut = true;
                terminateWorkerHandle({ handle: templateHandle });
              },
            });
            partialRun.templateBehavior = templateBehavior;
            const passed = templateBehavior.cases.filter(item => item.status === 'passed').length;
            const failed = templateBehavior.cases.length - passed;
            const tokenizerClass = String(templateBehavior.tokenizerClass);
            const detail = `${tokenizerClass}: ${passed} template cases rendered, ${failed} unsupported or failed, from the accepted runtime cache`;
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
            const existingError: string | undefined = typeof partialRun.error === 'string' ? String(partialRun.error) : undefined;
            const errorDetail = String(detail);
            partialRun.error = existingError === undefined ? errorDetail : `${existingError}; ${errorDetail}`;
            partialRun.currentOperation = detail;
            partialRun.completedAt = now();
            checkpoint = replaceInvestigationCheckpointRun({ checkpoint, run: partialRun, now });
            publishCheckpoint();
            // An unresponsive template Worker must end this target rather than
            // start more runtime work with stale template observations.
            if (templateTimedOut) throw error;
          } finally {
            if (!templateTimedOut && !userInterruptionRequested) await releaseWorkerHandle({ handle: templateHandle });
          }
        }

        const loadRun = await runModelLoadInvestigation({
          partialRun,
          runAttempt: async ({ candidate, loaderRevisionOption, onAttemptCheckpoint }) => {
            const { runtimeTarget, declarations, templateBehavior } = partialRun;
            if (runtimeTarget === undefined || declarations === undefined) {
              throw new Error("Candidate attempt prerequisites are unavailable");
            }
            const attemptRuntimeTarget = { ...runtimeTarget, loaderRevisionOption };
            const attemptHandle = createWorkerHandle();
            const attemptEvents: ModelSupportInvestigationLoadAttemptEvent[] = [];
            let lastStage: ModelSupportInvestigationLoadAttemptStage = "worker-start";
            let timedOut = false;
            let attemptAcceptingCallbacks = true;
            try {
              const operation = attemptHandle.remote.runCandidateAttempt(
                attemptRuntimeTarget,
                declarations,
                templateBehavior,
                candidate,
                { generation: executionPlan.generation, capabilityProbes: executionPlan.capabilityProbes },
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

        if (!executionPlan.generation) {
          loadRun.steps = loadRun.steps.map(step => {
            switch (step.id) {
            case 'lane-comparison':
              return { ...step, status: 'skipped' as const, detail: 'Skipped because Generation is not selected by investigation scope' };
            case 'runtime-assets':
            case 'repository-information':
            case 'download-evidence':
            case 'existing-model-data':
            case 'model-declarations':
            case 'template-behavior':
            case 'model-file-plan':
            case 'loading-investigation':
            case 'evidence-export':
              return step;
            default: {
              const _ex: never = step.id;
              return _ex;
            }
            }
          });
          loadRun.productionLane = { status: 'not-run', observation: undefined, partialObservation: undefined, error: undefined };
          loadRun.currentOperation = 'Model Load investigation completed; Generation was not selected';
          loadRun.completedAt = now();
          checkpoint = completeInvestigationCheckpoint({ checkpoint, run: loadRun, now });
          publishCheckpoint();
          return loadRun;
        }

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
                const operation = productionHandle.session.run({ operation: ({ remote }) => remote.runModelSupportInvestigationScenario(
                  candidateScenario,
                  workerProxy({ value: ({ event }) => {
                    if (!productionAcceptingCallbacks || !productionHandle.session.isActive()) return;
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
                    if (!productionAcceptingCallbacks || !productionHandle.session.isActive()) return;
                    latestCandidateObservation = structuredClone(observation);
                    onObservationCheckpoint({ observation: mergePartialObservation({ observation }) });
                  } }),
                ) });
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
              } catch (cause) {
                // The session rejects outstanding calls when terminated. Keep
                // the coordinator's deadline as the cause of that termination.
                const error = timedOut
                  ? new ProductionLaneTimeoutError({ stage: stageState.lastStage, timeoutMs: productionLaneTimeoutMs })
                  : cause;
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
                if (!timedOut && !userInterruptionRequested) terminateProductionWorkerHandle({ handle: productionHandle });
              }
            }

            throw lastCandidateError instanceof Error
              ? lastCandidateError
              : new Error("No Production Lane candidate succeeded");
          },
          onEvent: publishEvent,
          runContinuity: executionPlan.continuity,
          runCapabilityProbes: executionPlan.capabilityProbes,
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
      if (disposed) return;
      disposed = true;
      try {
        // Acceptance Workers are owned by the revision-acceptance client, not
        // either local Worker set. Reuse the interruption boundary to abort
        // that owner, freeze callbacks and settle the outstanding run as well.
        activeInterrupt?.();
      } finally {
        terminateAllWorkers();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
