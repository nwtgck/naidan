<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, toRaw } from "vue";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleIcon,
  CircleSlash2Icon,
  CopyIcon,
  DownloadIcon,
  Loader2Icon,
  PlayIcon,
  SearchCheckIcon,
  SquareIcon,
  XIcon,
} from "lucide-vue-next";
import { ensureStrings, lazyStrings } from "@/strings";
import type {
  ModelSupportInvestigationBatchEvidenceItem,
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationProgressObservation,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
  ModelSupportInvestigationStepId,
} from "@/features/transformers-js/model-support-investigation/types";
import { createModelSupportInvestigationWorkerClient } from "@/features/transformers-js/model-support-investigation/worker/client-hosted";
import { createModelSupportInvestigationEvidenceWorkerClient } from "@/features/transformers-js/model-support-investigation/evidence-worker/client-hosted";
import {
  canonicalInvestigationTargetList,
  configurationForPreset,
  createDefaultInvestigationConfiguration,
  deriveInvestigationPreset,
  normalizeInvestigationTarget,
  parseInvestigationTargets,
  resolveEffectiveScope,
  type ModelSupportInvestigationConfiguration,
  type ModelSupportInvestigationExternalNetworkPolicy,
  type ModelSupportInvestigationPreset,
  type ModelSupportInvestigationScopeId,
} from "@/features/transformers-js/model-support-investigation/logic/investigation-config";
import { runInvestigationTargetsSequentially, type ModelSupportInvestigationTargetExecution } from "@/features/transformers-js/model-support-investigation/logic/run-investigation-targets-sequentially";
import { evaluateEvidenceReadiness } from "@/features/transformers-js/model-support-investigation/logic/evaluate-evidence-readiness";
import { assessSupportBoundaries } from "@/features/transformers-js/model-support-investigation/logic/assess-support-boundaries";
import type { TransformersJsProductionInvestigationActiveCandidateLoadAttempt } from "@/features/transformers-js/types";

const props = defineProps<{
  modelId: string,
}>();

const emit = defineEmits<{
  (event: "close"): void,
}>();

const modalContent = ref<HTMLElement | undefined>(undefined);
const normalizedSeededTarget = normalizeInvestigationTarget({ input: props.modelId });
const committedTargets = ref<string[]>(normalizedSeededTarget === undefined ? [] : [normalizedSeededTarget]);
const targetDraft = ref(normalizedSeededTarget === undefined ? props.modelId.trim() : '');
const targetDraftParseResult = computed(() => parseInvestigationTargets({ text: targetDraft.value }));
const targetParseResult = computed(() => {
  const targets = [...committedTargets.value];
  const seen = new Set(targets);
  for (const target of targetDraftParseResult.value.targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  return { targets, errors: targetDraftParseResult.value.errors };
});
const investigationConfiguration = ref(createDefaultInvestigationConfiguration());
const investigationPreset = computed(() => deriveInvestigationPreset({ configuration: investigationConfiguration.value }));
const effectiveScope = computed(() => resolveEffectiveScope({ scope: investigationConfiguration.value.scope }));
const hasRequestedScope = computed(() => Object.values(investigationConfiguration.value.scope).some(value => value === 'selected'));
const investigationScopeIds: readonly ModelSupportInvestigationScopeId[] = [
  'repository-download',
  'model-load',
  'generation',
  'continuity',
  'capability-probes',
];
const targetExecutions = shallowRef<ModelSupportInvestigationTargetExecution[]>([]);
const currentRunningTarget = computed(() => targetExecutions.value.find(execution => execution.status === 'running')?.target);
const canSkipCurrentTarget = computed(() => {
  const currentTarget = currentRunningTarget.value;
  if (currentTarget === undefined) return false;
  const currentIndex = targetExecutions.value.findIndex(execution => execution.target === currentTarget);
  if (currentIndex < 0) return false;
  return targetExecutions.value.slice(currentIndex + 1).some(execution => execution.status === 'pending');
});
const selectedTarget = ref<string | undefined>(undefined);
const run = shallowRef<ModelSupportInvestigationRun | undefined>(undefined);
const recovery = ref<ModelSupportInvestigationRecovery | undefined>(undefined);
const recoveryByTarget = new Map<string, ModelSupportInvestigationRecovery | undefined>();
const runByTarget = new Map<string, ModelSupportInvestigationRun>();
const started = ref(false);
const running = ref(false);
const stopping = ref(false);
const skippingCurrentTarget = ref(false);
const evidenceExporting = ref(false);
const batchRunId = ref<string | undefined>(undefined);
const currentOperation = ref<string | undefined>(undefined);
const latestProgress = ref<ModelSupportInvestigationProgressObservation | undefined>(undefined);
const progressClockMs = ref(Date.now());
let progressClock: ReturnType<typeof setInterval> | undefined;
const displayedCurrentOperation = computed(() => (
  currentOperation.value
  ?? (started.value
    ? lazyStrings.ModelSupportInvestigationModal__checking_same_origin_runtime_assets()
    : lazyStrings.ModelSupportInvestigationModal__ready_to_start())
));

function formatModelLoadCacheDiagnostic({ progress }: {
  progress: ModelSupportInvestigationProgressObservation,
}): string | undefined {
  if (progress.cacheMatchRequestCount === undefined && progress.remoteFetchAttemptCount === undefined) return undefined;
  return `cache=${progress.cacheHitCount ?? 0} hit/${progress.cacheMissCount ?? 0} miss/${progress.cacheAliasHitCount ?? 0} alias · opfs-matched-bytes=${progress.cacheMatchedBytes ?? 0} · remote-fetch-attempts=${progress.remoteFetchAttemptCount ?? 0}`;
}

const displayedProgressDiagnostic = computed(() => {
  const progress = latestProgress.value;
  if (progress === undefined) return undefined;
  const activitySeconds = Math.max(0, Math.floor((progressClockMs.value - Date.parse(progress.lastActivityAt)) / 1000));
  const forwardSeconds = progress.lastForwardProgressAt === undefined
    ? "never"
    : `${Math.max(0, Math.floor((progressClockMs.value - Date.parse(progress.lastForwardProgressAt)) / 1000))}s`;
  const aggregate = progress.aggregateLoaded === undefined
    ? "unknown"
    : `${progress.aggregateLoaded}/${progress.aggregateTotal ?? "?"}${progress.aggregateProgress === undefined ? "" : ` (${progress.aggregateProgress.toFixed(1)}%)`}`;
  const file = progress.currentFile === undefined
    ? "unknown"
    : `${progress.currentFile} ${progress.fileLoaded ?? "?"}/${progress.fileTotal ?? "?"}${progress.fileProgress === undefined ? "" : ` (${progress.fileProgress.toFixed(1)}%)`}`;
  const cacheDiagnostic = formatModelLoadCacheDiagnostic({ progress });
  return `candidate=${progress.candidateId} · source-policy=${progress.artifactSource} · transformers-status=${progress.sourceStatus} · response-read=${aggregate} · file=${file} · events=${progress.eventCount} (progress_total=${progress.progressTotalEventCount}, progress=${progress.progressEventCount}, published=${progress.publishedSampleCount})${cacheDiagnostic === undefined ? "" : ` · ${cacheDiagnostic}`} · forward=${progress.forwardProgressCount} · repeated-no-forward=${progress.repeatedWithoutForwardProgressCount} · last-activity=${activitySeconds}s · last-forward=${forwardSeconds}`;
});
const repositorySummary = computed(() => {
  const repository = run.value?.repository;
  if (repository === undefined) return undefined;
  return lazyStrings.ModelSupportInvestigationModal__repository_summary({
    fileCount: repository.fileCount,
    pipelineTag: repository.pipelineTag,
  });
});
const supportedAutoClasses = computed(() => (
  run.value?.declarations?.classCapabilities
    .filter(entry => entry.supports === true)
    .map(entry => entry.autoClass) ?? []
));
const declarationSummary = computed(() => {
  const declarations = run.value?.declarations;
  if (declarations === undefined) return undefined;
  return lazyStrings.ModelSupportInvestigationModal__declaration_files_summary({
    fileCount: declarations.files.length,
    revision: declarations.resolvedRevision,
  });
});
const templateBehaviorSummary = computed(() => {
  const behavior = run.value?.templateBehavior;
  if (behavior === undefined) return undefined;
  const passedCount = behavior.cases.filter(item => item.status === "passed").length;
  return lazyStrings.ModelSupportInvestigationModal__template_behavior_summary({
    tokenizerClass: behavior.tokenizerClass,
    passedCount,
    failedCount: behavior.cases.length - passedCount,
  });
});
const toolTemplateProvenanceSummary = computed(() => {
  const provenance = run.value?.templateBehavior?.toolTemplateProvenance;
  if (provenance === undefined) return undefined;
  switch (provenance.status) {
  case "unavailable":
    return lazyStrings.ModelSupportInvestigationModal__tool_template_provenance_summary({
      mode: "unavailable",
      suffixTokenCount: undefined,
      firstMismatchIndex: undefined,
      reason: provenance.reason,
    });
  case "observed":
    return lazyStrings.ModelSupportInvestigationModal__tool_template_provenance_summary({
      mode: provenance.generationPromptPrefixMatch ? "prefix" : "difference",
      suffixTokenCount: provenance.assistantToolCallSuffixTokenIds?.length,
      firstMismatchIndex: provenance.firstMismatchIndex,
      reason: undefined,
    });
  default: {
    const _ex: never = provenance;
    return _ex;
  }
  }
});
function toolParserSummaryArguments({ observation }: {
  observation: Extract<ModelSupportInvestigationLoadAttempt["toolProtocolProbe"], { status: "observed" }>["parserObservation"],
}): {
  parserMode: "recognized" | "unrecognized" | "unavailable" | "failed",
  parserStrategy: string,
  parserToolCallCount: number | undefined,
  parserReason: string | undefined,
} {
  switch (observation.status) {
  case "observed":
    return {
      parserMode: observation.recognized ? "recognized" : "unrecognized",
      parserStrategy: observation.strategy,
      parserToolCallCount: observation.toolCalls.length,
      parserReason: undefined,
    };
  case "unavailable":
    return {
      parserMode: "unavailable",
      parserStrategy: observation.strategy,
      parserToolCallCount: undefined,
      parserReason: observation.reason,
    };
  case "failed":
    return {
      parserMode: "failed",
      parserStrategy: observation.strategy,
      parserToolCallCount: undefined,
      parserReason: `${observation.error.name}: ${observation.error.message}`,
    };
  default: {
    const exhaustive: never = observation;
    return exhaustive;
  }
  }
}

function toolResultRoundTripSummaryArguments({ observation }: {
  observation: Extract<ModelSupportInvestigationLoadAttempt["toolProtocolProbe"], { status: "observed" }>["toolResultTemplateRoundTrip"],
}): {
  roundTripMode: "observed" | "unavailable" | "failed" | "not-run",
  roundTripTokenCount: number | undefined,
  roundTripReason: string | undefined,
} {
  if (observation === undefined) {
    return { roundTripMode: "not-run", roundTripTokenCount: undefined, roundTripReason: undefined };
  }
  switch (observation.status) {
  case "observed":
    return { roundTripMode: "observed", roundTripTokenCount: observation.inputTokenIds.length, roundTripReason: undefined };
  case "unavailable":
    return { roundTripMode: "unavailable", roundTripTokenCount: undefined, roundTripReason: observation.reason };
  case "failed":
    return { roundTripMode: "failed", roundTripTokenCount: undefined, roundTripReason: `${observation.error.name}: ${observation.error.message}` };
  default: {
    const exhaustive: never = observation;
    return exhaustive;
  }
  }
}

function toolProtocolProbeSummary({ attempt }: {
  attempt: ModelSupportInvestigationLoadAttempt,
}): string | undefined {
  const probe = attempt.toolProtocolProbe;
  if (probe === undefined) return undefined;
  switch (probe.status) {
  case "observed": {
    const parserArguments = toolParserSummaryArguments({ observation: probe.parserObservation });
    const roundTripArguments = toolResultRoundTripSummaryArguments({ observation: probe.toolResultTemplateRoundTrip });
    return lazyStrings.ModelSupportInvestigationModal__tool_protocol_probe_summary({
      mode: probe.exactMatch ? "observed-exact" : "observed-incomplete",
      forcedTokenCount: probe.forcedTokenIds.length,
      generatedTokenCount: probe.generatedTokenIds.length,
      firstMismatchIndex: probe.firstMismatchIndex,
      reason: undefined,
      parserMode: parserArguments.parserMode,
      parserStrategy: parserArguments.parserStrategy,
      parserToolCallCount: parserArguments.parserToolCallCount,
      parserReason: parserArguments.parserReason,
      roundTripMode: roundTripArguments.roundTripMode,
      roundTripTokenCount: roundTripArguments.roundTripTokenCount,
      roundTripReason: roundTripArguments.roundTripReason,
    });
  }
  case "unavailable":
    return lazyStrings.ModelSupportInvestigationModal__tool_protocol_probe_summary({
      mode: "unavailable",
      forcedTokenCount: undefined,
      generatedTokenCount: undefined,
      firstMismatchIndex: undefined,
      reason: probe.reason,
      parserMode: "not-run",
      parserStrategy: undefined,
      parserToolCallCount: undefined,
      parserReason: undefined,
      roundTripMode: "not-run",
      roundTripTokenCount: undefined,
      roundTripReason: undefined,
    });
  case "failed":
    return lazyStrings.ModelSupportInvestigationModal__tool_protocol_probe_summary({
      mode: "failed",
      forcedTokenCount: probe.forcedTokenIds.length,
      generatedTokenCount: undefined,
      firstMismatchIndex: undefined,
      reason: `${probe.error.name}: ${probe.error.message}`,
      parserMode: "not-run",
      parserStrategy: undefined,
      parserToolCallCount: undefined,
      parserReason: undefined,
      roundTripMode: "not-run",
      roundTripTokenCount: undefined,
      roundTripReason: undefined,
    });
  default: {
    const _ex: never = probe;
    return _ex;
  }
  }
}

const modelFilePlanSummary = computed(() => {
  const plan = run.value?.modelFilePlan;
  if (plan === undefined) return undefined;
  return lazyStrings.ModelSupportInvestigationModal__model_file_plan_summary({
    eligibleCount: plan.candidates.filter(candidate => candidate.eligibility === "eligible").length,
    candidateCount: plan.candidates.length,
    registryFailureCount: plan.candidates.filter(candidate => candidate.registryStatus === "failed").length,
  });
});
const productionLaneRouteSummary = computed(() => {
  const observation = run.value?.productionLane.observation ?? run.value?.productionLane.partialObservation;
  const route = observation?.route;
  if (route === undefined) return undefined;
  return lazyStrings.ModelSupportInvestigationModal__lane_route_summary({
    autoClass: route.autoClass,
    processor: route.processor,
    strategy: route.strategy,
    modelType: route.modelType,
  });
});
function formatActiveProductionLoadAttempt({
  attempt,
}: {
  attempt: TransformersJsProductionInvestigationActiveCandidateLoadAttempt,
}): string {
  const progress = attempt.modelLoadProgress;
  const progressSummary = progress === undefined
    ? ""
    : ` (raw-events=${progress.eventCount}, published-samples=${progress.publishedSampleCount}${formatModelLoadCacheDiagnostic({ progress }) === undefined ? "" : `, ${formatModelLoadCacheDiagnostic({ progress })}`})`;
  return `${attempt.candidate.device}/${attempt.candidate.dtype}: running${progressSummary}`;
}

const productionLoadAttemptsSummary = computed(() => {
  const productionLane = run.value?.productionLane;
  const observation = productionLane?.observation ?? productionLane?.partialObservation;
  const attempts = observation?.loadAttempts ?? [];
  const activeAttempt = productionLane?.partialObservation?.activeLoadAttempt;
  const summaries = [
    ...attempts.map(attempt => `${attempt.candidate.device}/${attempt.candidate.dtype}: ${attempt.status}${attempt.error === undefined ? '' : ` (${attempt.error.name}: ${attempt.error.message})`}`),
    ...(activeAttempt === undefined
      ? []
      : [formatActiveProductionLoadAttempt({ attempt: activeAttempt })]),
  ];
  return summaries.length === 0 ? undefined : summaries.join(' → ');
});
const productionLaneComparisonSummary = computed(() => {
  const currentRun = run.value;
  if (currentRun === undefined) return undefined;
  if (currentRun.productionLane.status === "failed" && currentRun.productionLane.error !== undefined) {
    return lazyStrings.ModelSupportInvestigationModal__lane_failed({
      message: currentRun.productionLane.error.message,
    });
  }
  const comparison = currentRun.laneComparison;
  if (comparison === undefined) return undefined;
  return comparison.exactInputMatch
    ? lazyStrings.ModelSupportInvestigationModal__lane_input_match({
      tokenCount: comparison.referenceInputTokenIds.length,
    })
    : lazyStrings.ModelSupportInvestigationModal__lane_input_mismatch({
      mismatchIndex: comparison.firstInputMismatchIndex,
    });
});
const persistenceRoundTripSummary = computed(() => {
  const persistence = run.value?.persistenceRoundTrip;
  if (persistence === undefined) return undefined;
  switch (persistence.status) {
  case 'observed':
    return lazyStrings.ModelSupportInvestigationModal__persistence_roundtrip_summary({
      status: persistence.status,
      exactModelVisibleMatch: persistence.exactModelVisibleMatch,
      serializedByteLength: persistence.serializedByteLength,
      firstMismatchIndex: persistence.firstMismatchIndex,
      errorName: undefined,
      errorMessage: undefined,
    });
  case 'failed':
    return lazyStrings.ModelSupportInvestigationModal__persistence_roundtrip_summary({
      status: persistence.status,
      exactModelVisibleMatch: undefined,
      serializedByteLength: undefined,
      firstMismatchIndex: undefined,
      errorName: persistence.error.name,
      errorMessage: persistence.error.message,
    });
  default: {
    const _ex: never = persistence;
    return _ex;
  }
  }
});
const productionContinuitySummary = computed(() => {
  const continuity = (run.value?.productionLane.observation ?? run.value?.productionLane.partialObservation)?.continuity;
  if (continuity === undefined) return undefined;
  switch (continuity.status) {
  case "failed":
    return lazyStrings.ModelSupportInvestigationModal__lane_continuity_failed({
      name: continuity.error.name,
      message: continuity.error.message,
    });
  case "not-run":
    return undefined;
  case "passed": {
    const prefix = continuity.prefixComparison;
    return lazyStrings.ModelSupportInvestigationModal__lane_continuity_summary({
      cacheProvided: continuity.secondTurn.pastKeyValuesProvided,
      cacheDecisionStatus: continuity.secondTurn.cacheDecision.status,
      cacheDecisionReason: continuity.secondTurn.cacheDecision.reason,
      mode: prefix.mode,
      comparisonInputSource: prefix.comparisonInputSource,
      exactPrefixMatch: prefix.exactPrefixMatch,
      firstMismatchIndex: prefix.firstMismatchIndex,
      secondInputTokenCount: prefix.secondInputTokenIds.length,
      mismatchExpectedText: prefix.firstMismatchContext?.expectedText,
      mismatchActualText: prefix.firstMismatchContext?.actualText,
    });
  }
  default: {
    const _ex: never = continuity;
    return _ex;
  }
  }
});
const productionToolResultContinuationSummary = computed(() => {
  const observation = (run.value?.productionLane.observation ?? run.value?.productionLane.partialObservation)?.toolResultContinuation;
  if (observation === undefined) return undefined;
  switch (observation.status) {
  case "not-run":
    return undefined;
  case "failed":
    return lazyStrings.ModelSupportInvestigationModal__tool_result_production_continuation_failed({
      strategy: observation.strategy ?? "strategy-unresolved",
      name: observation.error.name,
      message: observation.error.message,
    });
  case "passed":
    return lazyStrings.ModelSupportInvestigationModal__tool_result_production_continuation_passed({
      strategy: observation.strategy,
      generatedTokenCount: observation.turn.generatedTokenIds.length,
      comparisonInputSource: observation.comparisonInputSource ?? 'actual-model-input',
      inputMatch: observation.inputTokenExactMatch ? "matched" : "mismatched",
      firstMismatchIndex: observation.firstInputMismatchIndex,
      cacheDecisionStatus: observation.turn.cacheDecision?.status ?? 'unavailable',
      cacheDecisionReason: observation.turn.cacheDecision?.reason ?? 'not observed',
      cacheProvided: observation.turn.pastKeyValuesProvided === true,
    });
  default: {
    const _ex: never = observation;
    return _ex;
  }
  }
});
const productionMultimodalSummary = computed(() => {
  const observation = (run.value?.productionLane.observation ?? run.value?.productionLane.partialObservation)?.multimodal;
  if (observation === undefined) return undefined;
  switch (observation.status) {
  case "observed":
    return lazyStrings.ModelSupportInvestigationModal__multimodal_observed({
      strategy: observation.strategy,
      fixtureId: observation.fixture.fixtureId,
      width: observation.fixture.width,
      height: observation.fixture.height,
      mimeType: observation.fixture.mimeType,
      inputTensorCount: observation.turn.inputTensors.length,
      generatedTokenCount: observation.turn.generatedTokenIds.length,
    });
  case "failed":
    return lazyStrings.ModelSupportInvestigationModal__multimodal_failed({
      strategy: observation.strategy,
      name: observation.error.name,
      message: observation.error.message,
    });
  case "unavailable":
    return lazyStrings.ModelSupportInvestigationModal__multimodal_unavailable({
      strategy: observation.strategy,
      reason: observation.reason,
    });
  default: {
    const _ex: never = observation;
    return _ex;
  }
  }
});
const productionReasoningSummary = computed(() => {
  const observation = (run.value?.productionLane.observation ?? run.value?.productionLane.partialObservation)?.reasoning;
  if (observation === undefined) return undefined;
  switch (observation.status) {
  case "observed":
    return lazyStrings.ModelSupportInvestigationModal__reasoning_differential_observed({
      strategy: observation.strategy,
      disabledTokenCount: observation.disabledTurn.inputTokenIds.length,
      enabledTokenCount: observation.enabledTurn.inputTokenIds.length,
      inputMatch: observation.inputTokenExactMatch ? "matched" : "mismatched",
      firstMismatchIndex: observation.firstInputMismatchIndex,
    });
  case "failed":
    return lazyStrings.ModelSupportInvestigationModal__reasoning_differential_failed({
      effort: observation.failedEffort,
      name: observation.error.name,
      message: observation.error.message,
    });
  case "unavailable":
    return lazyStrings.ModelSupportInvestigationModal__reasoning_differential_unavailable({
      reason: observation.reason,
    });
  default: {
    const _ex: never = observation;
    return _ex;
  }
  }
});
const evidenceReadiness = computed(() => run.value === undefined
  ? undefined
  : evaluateEvidenceReadiness({ run: run.value }));
const evidenceReadinessSummary = computed(() => {
  const report = evidenceReadiness.value;
  if (report === undefined) return undefined;
  return lazyStrings.ModelSupportInvestigationModal__evidence_readiness_summary({
    implementationReadyCount: report.domains.filter(item => item.status === "implementation-ready").length,
    partialCount: report.domains.filter(item => item.status === "partial").length,
    insufficientCount: report.domains.filter(item => item.status === "insufficient").length,
    notObservedCount: report.domains.filter(item => item.status === "not-observed").length,
  });
});
const supportBoundaryAssessments = computed(() => run.value === undefined
  ? []
  : assessSupportBoundaries({ run: run.value }));
const supportBoundarySummary = computed(() => lazyStrings.ModelSupportInvestigationModal__support_boundary_summary({
  count: supportBoundaryAssessments.value.length,
  boundaries: [...new Set(supportBoundaryAssessments.value.map(item => item.boundary))].join(", "),
}));
const runtimeAssetsView = computed(() => run.value?.runtimeAssets ?? run.value?.runtimeAssetsPartial);
const runtimeEnvironmentSummary = computed(() => {
  const environment = runtimeAssetsView.value?.environment;
  if (environment === undefined) return undefined;
  const adapter = environment.webGpu.adapterInfo.description
    ?? environment.webGpu.adapterInfo.device
    ?? environment.webGpu.adapterInfo.architecture
    ?? environment.webGpu.adapterInfo.vendor;
  const threading = runtimeAssetsView.value?.threading;
  return lazyStrings.ModelSupportInvestigationModal__runtime_environment_summary({
    webGpuAvailability: environment.webGpu.availability,
    crossOriginIsolated: environment.crossOriginIsolated,
    hardwareConcurrency: environment.hardwareConcurrency,
    adapter,
    requestedThreads: threading?.requestedThreads,
    effectiveThreads: threading?.effectiveThreads,
    proxy: threading?.proxy,
    pthreadLifecycle: threading?.childWorkerLifecycle,
  });
});
const cacheSummary = computed(() => {
  const cache = run.value?.cache;
  if (cache === undefined) return undefined;
  return lazyStrings.ModelSupportInvestigationModal__opfs_inventory_summary({
    fileCount: cache.fileCount,
    totalBytes: cache.totalBytes,
    incompleteFileCount: cache.incompleteFileCount,
    orphanCompletionMarkerCount: cache.orphanCompletionMarkerCount,
    zeroByteFileCount: cache.zeroByteFileCount,
  });
});
function initialInvestigationSteps(): ModelSupportInvestigationStep[] {
  return [
    { id: "runtime-assets", status: "not-run", detail: undefined },
    { id: "repository-information", status: "not-run", detail: undefined },
    { id: "download-evidence", status: "not-run", detail: undefined },
    { id: "existing-model-data", status: "not-run", detail: undefined },
    { id: "model-declarations", status: "not-run", detail: undefined },
    { id: "template-behavior", status: "not-run", detail: undefined },
    { id: "model-file-plan", status: "not-run", detail: undefined },
    { id: "loading-investigation", status: "not-run", detail: undefined },
    { id: "lane-comparison", status: "not-run", detail: undefined },
    { id: "evidence-export", status: "not-run", detail: undefined },
  ];
}

const steps = ref<ModelSupportInvestigationStep[]>(initialInvestigationSteps());
let activeClient: ReturnType<typeof createModelSupportInvestigationWorkerClient> | undefined;
let interruptionRequested = false;
let skipRequestedTarget: string | undefined;

const findingDetails = computed(() => steps.value
  .filter(step => step.detail !== undefined)
  .map(step => ({ id: step.id, detail: step.detail! })));

function updateStep({ event }: { event: ModelSupportInvestigationEvent }): void {
  currentOperation.value = event.detail;
  if (event.progress !== undefined) latestProgress.value = event.progress;
  steps.value = steps.value.map(step => step.id === event.stepId
    ? { ...step, status: event.status, detail: event.detail }
    : step);
}

function withEvidenceExportStep({
  sourceRun,
  status,
  detail,
}: {
  sourceRun: ModelSupportInvestigationRun,
  status: "running" | "passed" | "failed",
  detail: string,
}): ModelSupportInvestigationRun {
  return {
    ...sourceRun,
    currentOperation: detail,
    steps: sourceRun.steps.map(step => {
      switch (step.id) {
      case "evidence-export":
        return { ...step, status, detail };
      case "runtime-assets":
      case "repository-information":
      case "download-evidence":
      case "existing-model-data":
      case "model-declarations":
      case "template-behavior":
      case "model-file-plan":
      case "loading-investigation":
      case "lane-comparison":
        return step;
      default: {
        const _ex: never = step.id;
        return _ex;
      }
      }
    }),
  };
}

async function evidenceExportDetail({
  status,
  error,
}: {
  status: "running" | "passed" | "failed",
  error?: string,
}): Promise<string> {
  const exportLabel = await ensureStrings.ModelSupportInvestigationModal__evidence_export();
  const statusLabel = await (() => {
    switch (status) {
    case "running":
      return ensureStrings.ModelSupportInvestigationModal__running();
    case "passed":
      return ensureStrings.ModelSupportInvestigationModal__passed();
    case "failed":
      return ensureStrings.ModelSupportInvestigationModal__failed();
    default: {
      const _ex: never = status;
      return _ex;
    }
    }
  })();
  return error === undefined
    ? `${exportLabel}: ${statusLabel}`
    : `${exportLabel}: ${statusLabel}: ${error}`;
}

function stepLabel({ stepId }: { stepId: ModelSupportInvestigationStepId }): string | undefined {
  switch (stepId) {
  case "runtime-assets":
    return lazyStrings.ModelSupportInvestigationModal__runtime_assets();
  case "repository-information":
    return lazyStrings.ModelSupportInvestigationModal__repository_information();
  case "download-evidence":
    return lazyStrings.ModelSupportInvestigationModal__download_verification();
  case "existing-model-data":
    return lazyStrings.ModelSupportInvestigationModal__existing_model_data();
  case "model-declarations":
    return lazyStrings.ModelSupportInvestigationModal__model_declarations();
  case "template-behavior":
    return lazyStrings.ModelSupportInvestigationModal__template_behavior();
  case "model-file-plan":
    return lazyStrings.ModelSupportInvestigationModal__model_file_plan();
  case "loading-investigation":
    return lazyStrings.ModelSupportInvestigationModal__loading_investigation();
  case "lane-comparison":
    return lazyStrings.ModelSupportInvestigationModal__lane_comparison();
  case "evidence-export":
    return lazyStrings.ModelSupportInvestigationModal__evidence_export();
  default: {
    const _ex: never = stepId;
    return _ex;
  }
  }
}

function candidateEligibilityLabel({ candidate }: {
  candidate: ModelSupportInvestigationCandidateFilePlan,
}): string | undefined {
  switch (candidate.eligibility) {
  case "eligible":
    return lazyStrings.ModelSupportInvestigationModal__candidate_eligible();
  case "ineligible":
    return lazyStrings.ModelSupportInvestigationModal__candidate_ineligible();
  case "registry-failed":
    return lazyStrings.ModelSupportInvestigationModal__candidate_registry_failed();
  default: {
    const _ex: never = candidate.eligibility;
    return _ex;
  }
  }
}

function candidatePlanSummary({ candidate }: {
  candidate: ModelSupportInvestigationCandidateFilePlan,
}): string | undefined {
  const status = candidateEligibilityLabel({ candidate });
  if (status === undefined) return undefined;
  return lazyStrings.ModelSupportInvestigationModal__candidate_plan_summary({
    candidateId: candidate.candidateId,
    status,
    requiredFileCount: candidate.requiredFileCount,
    missingRequiredFileCount: candidate.missingRequiredFileCount + candidate.zeroByteRequiredFileCount,
    cacheCompleteCount: candidate.cacheCompleteMarkerRequiredFileCount,
  });
}

function statusLabel({ status }: { status: ModelSupportInvestigationStep["status"] }): string | undefined {
  switch (status) {
  case "running":
    return lazyStrings.ModelSupportInvestigationModal__running();
  case "passed":
    return lazyStrings.ModelSupportInvestigationModal__passed();
  case "failed":
    return lazyStrings.ModelSupportInvestigationModal__failed();
  case "not-run":
    return lazyStrings.ModelSupportInvestigationModal__not_run();
  case "blocked":
    return lazyStrings.ModelSupportInvestigationModal__blocked();
  case "skipped":
    return lazyStrings.ModelSupportInvestigationModal__skipped();
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
}

function getFocusableElements(): HTMLElement[] {
  const root = modalContent.value;
  if (root === undefined) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(
    "button:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])",
  )).filter(element => element.offsetParent !== null);
}

function close(): void {
  if (running.value) return;
  emit("close");
}

function handleKeydown({ event }: { event: KeyboardEvent }): void {
  if (event.key === "Escape") {
    close();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = getFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    modalContent.value?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modalContent.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function disposeClientBestEffort({ client }: {
  client: ReturnType<typeof createModelSupportInvestigationWorkerClient>,
}): Promise<void> {
  try {
    await client.dispose();
  } catch {
    // Worker cleanup is advisory after a run has settled. A dispose failure must not
    // replace an already-observed investigation result or surface as an unhandled rejection.
  }
}

async function interruptClientBestEffort({ client }: {
  client: ReturnType<typeof createModelSupportInvestigationWorkerClient> | undefined,
}): Promise<boolean> {
  if (client === undefined) return false;
  try {
    await client.interrupt();
    return true;
  } catch {
    // Interrupt is a cleanup/control request. Transport failure must not surface as an
    // unhandled rejection or replace already-observed investigation Evidence.
    return false;
  }
}

async function disposeActiveClient(): Promise<void> {
  const client = activeClient;
  if (client === undefined) return;
  activeClient = undefined;
  await disposeClientBestEffort({ client });
}

async function stopInvestigation(): Promise<void> {
  if (!running.value || stopping.value) return;
  stopping.value = true;
  interruptionRequested = true;
  skipRequestedTarget = undefined;
  skippingCurrentTarget.value = false;
  try {
    await interruptClientBestEffort({ client: activeClient });
  } finally {
    stopping.value = false;
  }
}

async function skipCurrentTarget(): Promise<void> {
  if (!running.value || stopping.value || skippingCurrentTarget.value || !canSkipCurrentTarget.value) return;
  const target = currentRunningTarget.value;
  const client = activeClient;
  if (target === undefined || client === undefined) return;

  skipRequestedTarget = target;
  skippingCurrentTarget.value = true;
  const interruptionAccepted = await interruptClientBestEffort({ client });
  if (!interruptionAccepted && skipRequestedTarget === target) {
    skipRequestedTarget = undefined;
    skippingCurrentTarget.value = false;
  }
}

function applyRunPresentation({
  target,
  sourceRun,
  sourceRecovery,
}: {
  target: string,
  sourceRun: ModelSupportInvestigationRun,
  sourceRecovery: ModelSupportInvestigationRecovery | undefined,
}): void {
  selectedTarget.value = target;
  run.value = sourceRun;
  recovery.value = sourceRecovery;
  recoveryByTarget.set(target, sourceRecovery);
  runByTarget.set(target, structuredClone(sourceRun));
  steps.value = sourceRun.steps;
  currentOperation.value = sourceRun.currentOperation;
  const progress = sourceRecovery?.lastEvent?.progress;
  if (progress !== undefined) latestProgress.value = progress;
}

async function runSingleTarget({ target, configuration }: {
  target: string,
  configuration: ModelSupportInvestigationConfiguration,
}): Promise<ModelSupportInvestigationRun> {
  const client = createModelSupportInvestigationWorkerClient();
  activeClient = client;
  selectedTarget.value = target;
  run.value = undefined;
  recovery.value = undefined;
  steps.value = initialInvestigationSteps();
  currentOperation.value = lazyStrings.ModelSupportInvestigationModal__checking_same_origin_runtime_assets();
  latestProgress.value = undefined;
  try {
    const completedRun = await client.runPartialInvestigation({
      modelId: target,
      configuration: structuredClone(configuration),
      onEvent: ({ event }) => updateStep({ event }),
      onCheckpoint: ({ checkpoint }) => {
        applyRunPresentation({
          target,
          sourceRun: checkpoint.run,
          sourceRecovery: checkpoint.recovery,
        });
      },
    });
    applyRunPresentation({
      target,
      sourceRun: completedRun,
      sourceRecovery: recoveryByTarget.get(target),
    });
    return completedRun;
  } finally {
    if (activeClient === client) activeClient = undefined;
    await disposeClientBestEffort({ client });
    if (skipRequestedTarget === target) skippingCurrentTarget.value = false;
  }
}

function selectTargetExecution({ executionIndex }: { executionIndex: number }): void {
  const execution = targetExecutions.value[executionIndex];
  if (running.value || execution?.run === undefined) return;
  applyRunPresentation({
    target: execution.target,
    sourceRun: execution.run,
    sourceRecovery: recoveryByTarget.get(execution.target),
  });
}

function appendCommittedTargets({ targets }: { targets: readonly string[] }): void {
  const seen = new Set(committedTargets.value);
  const next = [...committedTargets.value];
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    next.push(target);
  }
  committedTargets.value = next;
}

function commitTargetDraft(): boolean {
  if (targetDraft.value.trim().length === 0) return true;
  const parsed = targetDraftParseResult.value;
  if (parsed.errors.length > 0) return false;
  appendCommittedTargets({ targets: parsed.targets });
  targetDraft.value = '';
  return true;
}

function handleTargetDraftPaste({ event }: { event: ClipboardEvent }): void {
  const pasted = event.clipboardData?.getData('text') ?? '';
  if (pasted.length === 0) return;
  const combined = targetDraft.value.trim().length === 0
    ? pasted
    : `${targetDraft.value}\n${pasted}`;
  const parsed = parseInvestigationTargets({ text: combined });
  event.preventDefault();
  if (parsed.errors.length > 0) {
    targetDraft.value = combined;
    return;
  }
  appendCommittedTargets({ targets: parsed.targets });
  targetDraft.value = '';
}

function handleTargetDraftKeydown({ event }: { event: KeyboardEvent }): void {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  commitTargetDraft();
}

function removeCommittedTarget({ targetIndex }: { targetIndex: number }): void {
  if (running.value) return;
  committedTargets.value = committedTargets.value.filter((_target, index) => index !== targetIndex);
}

function copyModelList(): void {
  if (targetParseResult.value.errors.length > 0) return;
  const value = canonicalInvestigationTargetList({ targets: targetParseResult.value.targets });
  if (value.length === 0) return;
  try {
    void Promise.resolve(navigator.clipboard.writeText(value)).catch(() => {
      // Clipboard permission and platform failures are non-semantic UI failures. Do not
      // surface them as an unhandled event-handler rejection or affect investigation state.
    });
  } catch {
    // Some hosts or test doubles can fail synchronously despite the Clipboard API Promise contract.
  }
}

function presetLabel({ preset }: { preset: ModelSupportInvestigationPreset }): string | undefined {
  switch (preset) {
  case 'full':
    return lazyStrings.ModelSupportInvestigationModal__full_investigation();
  case 'offline':
    return lazyStrings.ModelSupportInvestigationModal__offline();
  case 'download-focused':
    return lazyStrings.ModelSupportInvestigationModal__download_focused();
  case 'custom':
    return lazyStrings.ModelSupportInvestigationModal__custom();
  default: {
    const _ex: never = preset;
    return _ex;
  }
  }
}

function scopeLabel({ scopeId }: { scopeId: ModelSupportInvestigationScopeId }): string | undefined {
  switch (scopeId) {
  case 'repository-download':
    return lazyStrings.ModelSupportInvestigationModal__repository_and_download();
  case 'model-load':
    return lazyStrings.ModelSupportInvestigationModal__model_load();
  case 'generation':
    return lazyStrings.ModelSupportInvestigationModal__generation();
  case 'continuity':
    return lazyStrings.ModelSupportInvestigationModal__continuity_and_kv_cache();
  case 'capability-probes':
    return lazyStrings.ModelSupportInvestigationModal__capability_probes();
  default: {
    const _ex: never = scopeId;
    return _ex;
  }
  }
}

function applyPreset({ preset }: { preset: Exclude<ModelSupportInvestigationPreset, 'custom'> }): void {
  if (running.value) return;
  investigationConfiguration.value = configurationForPreset({ preset });
}

function toggleScope({ scopeId }: { scopeId: ModelSupportInvestigationScopeId }): void {
  if (running.value) return;
  const configuration = structuredClone(toRaw(investigationConfiguration.value));
  switch (configuration.scope[scopeId]) {
  case 'selected':
    configuration.scope[scopeId] = 'not-selected';
    break;
  case 'not-selected':
    configuration.scope[scopeId] = 'selected';
    break;
  default: {
    const _ex: never = configuration.scope[scopeId];
    return _ex;
  }
  }
  investigationConfiguration.value = configuration;
}

function setExternalNetworkPolicy({ policy }: {
  policy: ModelSupportInvestigationExternalNetworkPolicy,
}): void {
  if (running.value) return;
  const configuration = structuredClone(toRaw(investigationConfiguration.value));
  configuration.externalNetworkPolicy = policy;
  investigationConfiguration.value = configuration;
}

async function startInvestigation(): Promise<void> {
  if (running.value || !hasRequestedScope.value || !commitTargetDraft()) return;
  if (committedTargets.value.length === 0) return;

  const targets = [...committedTargets.value];
  const configuration = structuredClone(toRaw(investigationConfiguration.value));

  started.value = true;
  batchRunId.value = crypto.randomUUID();
  running.value = true;
  stopping.value = false;
  skippingCurrentTarget.value = false;
  interruptionRequested = false;
  skipRequestedTarget = undefined;
  targetExecutions.value = [];
  recoveryByTarget.clear();
  runByTarget.clear();
  run.value = undefined;
  recovery.value = undefined;
  steps.value = initialInvestigationSteps();
  currentOperation.value = undefined;
  latestProgress.value = undefined;


  try {
    const executions = await runInvestigationTargetsSequentially({
      targets,
      runTarget: async ({ target }) => await runSingleTarget({ target, configuration }),
      onUpdate: ({ executions: nextExecutions }) => {
        targetExecutions.value = [...nextExecutions];
      },
      shouldInterrupt: () => interruptionRequested,
      takeSkipRequest: ({ target }) => {
        if (skipRequestedTarget !== target) return false;
        skipRequestedTarget = undefined;
        return true;
      },
      recoverRunAfterError: ({ target }) => runByTarget.get(target),
    });
    targetExecutions.value = executions;
    if (run.value === undefined) {
      const lastCompleted = [...executions].reverse().find(execution => execution.run !== undefined);
      if (lastCompleted?.run !== undefined) {
        const executionIndex = executions.indexOf(lastCompleted);
        if (executionIndex >= 0) selectTargetExecution({ executionIndex });
      }
    }
  } finally {
    running.value = false;
    stopping.value = false;
    skippingCurrentTarget.value = false;
    skipRequestedTarget = undefined;
    await disposeActiveClient();
  }
}

function snapshotEvidenceState<T extends object>({ value }: { value: T }): T {
  // Vue refs expose deeply reactive proxies. Structured-clone the underlying plain DTO,
  // never the reactive wrapper itself, so Evidence export remains safe while the live run continues.
  return structuredClone(toRaw(value));
}

function updateEvidenceExportPresentation({
  status,
  detail,
}: {
  status: "passed" | "failed",
  detail: string,
}): void {
  steps.value = steps.value.map(step => {
    switch (step.id) {
    case "evidence-export":
      return { ...step, status, detail };
    case "runtime-assets":
    case "repository-information":
    case "download-evidence":
    case "existing-model-data":
    case "model-declarations":
    case "template-behavior":
    case "model-file-plan":
    case "loading-investigation":
    case "lane-comparison":
      return step;
    default: {
      const _ex: never = step.id;
      return _ex;
    }
    }
  });
}

async function downloadPartialEvidence(): Promise<void> {
  if (evidenceExporting.value) return;
  const sourceRun = run.value;
  const executions = targetExecutions.value;
  if (sourceRun === undefined && executions.length === 0) return;
  evidenceExporting.value = true;
  try {
    const passedDetail = await evidenceExportDetail({ status: "passed" });
    const evidenceClient = createModelSupportInvestigationEvidenceWorkerClient();
    const { blob, fileName } = await (async () => {
      try {
        if (sourceRun !== undefined && executions.length <= 1) {
          const runSnapshot = snapshotEvidenceState({ value: sourceRun });
          const recoverySnapshot = recovery.value === undefined
            ? undefined
            : snapshotEvidenceState({ value: recovery.value });
          const exportedRun = withEvidenceExportStep({
            sourceRun: runSnapshot,
            status: "passed",
            detail: passedDetail,
          });
          return await evidenceClient.createPartialEvidence({
            run: exportedRun,
            recovery: recoverySnapshot,
          });
        }

        const items: ModelSupportInvestigationBatchEvidenceItem[] = executions.map(execution => {
          const capturedRun = execution.run ?? runByTarget.get(execution.target);
          const packagedRun = capturedRun === undefined
            ? undefined
            : withEvidenceExportStep({
              sourceRun: snapshotEvidenceState({ value: capturedRun }),
              status: "passed",
              detail: passedDetail,
            });
          const capturedRecovery = recoveryByTarget.get(execution.target);
          return {
            target: execution.target,
            status: execution.status,
            run: packagedRun,
            recovery: capturedRecovery === undefined
              ? undefined
              : snapshotEvidenceState({ value: capturedRecovery }),
            error: execution.error,
          };
        });
        return await evidenceClient.createBatchEvidence({
          batchId: batchRunId.value ?? crypto.randomUUID(),
          items,
        });
      } finally {
        try {
          await evidenceClient.dispose();
        } catch {
          // Evidence has already been created successfully. Worker cleanup failure must not
          // replace that semantic result or prevent the browser download from starting.
        }
      }
    })();
    updateEvidenceExportPresentation({ status: "passed", detail: passedDetail });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedDetail = await evidenceExportDetail({ status: "failed", error: errorMessage });
    updateEvidenceExportPresentation({ status: "failed", detail: failedDetail });
    console.error("[model-support-investigation] Evidence export failed", error);
  } finally {
    evidenceExporting.value = false;
  }
}

onMounted(async () => {
  progressClock = setInterval(() => {
    progressClockMs.value = Date.now();
  }, 1000);
  await nextTick();
  modalContent.value?.focus();
});

onUnmounted(() => {
  if (progressClock !== undefined) clearInterval(progressClock);
  interruptionRequested = true;
  skipRequestedTarget = undefined;
  skippingCurrentTarget.value = false;
  const client = activeClient;
  void (async () => {
    await interruptClientBestEffort({ client });
    if (activeClient === client) await disposeActiveClient();
  })();
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div
    tw-class="fixed inset-0 z-[120] bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
    role="presentation"
  >
    <div
      ref="modalContent"
      class="modal-content-zoom"
      tw-class="w-full max-w-5xl max-h-[90vh] bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col outline-none"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      data-testid="model-support-investigation-modal"
      @keydown="handleKeydown({ event: $event })"
    >
      <header tw-class="px-6 py-5 bg-gray-50 dark:bg-gray-800/70 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-4">
        <div tw-class="min-w-0">
          <div tw-class="flex items-center gap-2 text-purple-600 dark:text-purple-400 mb-1">
            <SearchCheckIcon tw-class="w-5 h-5" aria-hidden="true" />
            <h2 tw-class="text-lg font-bold text-gray-900 dark:text-white">
              {{ lazyStrings.ModelSupportInvestigationModal__model_support_investigation() }}
            </h2>
          </div>
          <p v-if="selectedTarget" tw-class="text-xs text-gray-500 dark:text-gray-400 truncate">{{ selectedTarget }}</p>
          <p tw-class="text-[10px] text-amber-600 dark:text-amber-400 mt-1 font-semibold uppercase tracking-wide">
            {{ lazyStrings.ModelSupportInvestigationModal__this_is_partial_evidence() }}
          </p>
          <p tw-class="text-[10px] text-gray-500 dark:text-gray-400 mt-1 max-w-3xl">
            {{ lazyStrings.ModelSupportInvestigationModal__environment_evidence_disclosure() }}
          </p>
        </div>
        <button
          type="button"
          :disabled="running"
          tw-class="p-2 rounded-xl text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          :title="lazyStrings.ModelSupportInvestigationModal__close()"
          data-testid="model-support-investigation-close"
          @click="close"
        >
          <XIcon tw-class="w-5 h-5" />
        </button>
      </header>

      <nav
        tw-class="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 grid grid-cols-2 gap-2"
        data-testid="model-support-stage-indicator"
      >
        <div
          tw-class="rounded-lg px-3 py-2 text-center text-[10px] font-bold"
          :class="!started ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300' : 'text-gray-400'"
          data-testid="model-support-stage-setup"
          :data-state="started ? 'completed' : 'active'"
        >
          1 · {{ lazyStrings.ModelSupportInvestigationModal__setup() }}
        </div>
        <div
          tw-class="rounded-lg px-3 py-2 text-center text-[10px] font-bold"
          :class="started ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300' : 'text-gray-400'"
          data-testid="model-support-stage-running-results"
          :data-state="started ? 'active' : 'upcoming'"
        >
          2 · {{ lazyStrings.ModelSupportInvestigationModal__running_and_results() }}
        </div>
      </nav>

      <section
        v-if="!started"
        tw-class="px-6 py-5 bg-white dark:bg-gray-900 space-y-4 min-h-0 flex-1 overflow-y-auto"
        data-testid="model-support-investigation-setup"
      >
        <div tw-class="flex items-center justify-between gap-3">
          <div>
            <p tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">
              {{ lazyStrings.ModelSupportInvestigationModal__targets() }}
            </p>
            <p tw-class="text-[10px] text-gray-500 dark:text-gray-400">
              {{ lazyStrings.ModelSupportInvestigationModal__one_model_per_line() }}
            </p>
          </div>
          <button
            type="button"
            :disabled="targetParseResult.targets.length === 0 || targetParseResult.errors.length > 0"
            tw-class="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-[10px] font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            data-testid="model-support-copy-targets"
            @click="copyModelList"
          >
            <CopyIcon tw-class="w-3.5 h-3.5" />
            {{ lazyStrings.ModelSupportInvestigationModal__copy_model_list() }}
          </button>
        </div>
        <div
          v-if="committedTargets.length > 0"
          tw-class="space-y-1.5"
          data-testid="model-support-target-list"
        >
          <div
            v-for="(target, targetIndex) in committedTargets"
            :key="target"
            tw-class="flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2"
            :data-testid="`model-support-target-row-${target}`"
          >
            <code tw-class="min-w-0 flex-1 text-xs text-gray-800 dark:text-gray-100 break-all">{{ target }}</code>
            <button
              type="button"
              tw-class="shrink-0 p-1 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
              :data-testid="`model-support-target-remove-${target}`"
              @click="removeCommittedTarget({ targetIndex })"
            >
              <XIcon tw-class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <textarea
          v-model="targetDraft"
          rows="2"
          tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 font-mono text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-4 focus:ring-purple-500/10 focus:border-purple-300 dark:focus:border-purple-700 resize-y"
          data-testid="model-support-targets-input"
          :placeholder="lazyStrings.ModelSupportInvestigationModal__add_models_placeholder()"
          @paste="handleTargetDraftPaste({ event: $event })"
          @keydown="handleTargetDraftKeydown({ event: $event })"
        />
        <div
          v-if="targetParseResult.errors.length > 0"
          tw-class="space-y-1 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/60 dark:bg-red-950/20 px-3 py-2"
          data-testid="model-support-target-errors"
        >
          <p
            v-for="error in targetParseResult.errors"
            :key="`${error.lineNumber}:${error.input}`"
            tw-class="text-[10px] text-red-600 dark:text-red-300"
          >
            {{ lazyStrings.ModelSupportInvestigationModal__invalid_model_line({ lineNumber: error.lineNumber }) }}
          </p>
        </div>
        <div
          tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/70 px-3 py-3 space-y-2"
          data-testid="model-support-presets"
        >
          <div tw-class="flex items-center justify-between gap-3">
            <p tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">
              {{ lazyStrings.ModelSupportInvestigationModal__presets() }}
            </p>
            <span tw-class="text-[9px] font-bold uppercase tracking-wider text-gray-400">
              {{ presetLabel({ preset: investigationPreset }) }}
            </span>
          </div>
          <div tw-class="flex flex-wrap gap-1.5">
            <button
              v-for="preset in (['full', 'offline', 'download-focused'] as const)"
              :key="preset"
              type="button"
              :disabled="running"
              :aria-pressed="investigationPreset === preset"
              :tw-class="investigationPreset === preset
                ? 'px-3 py-1.5 rounded-lg text-[10px] font-bold bg-purple-600 text-white disabled:opacity-50'
                : 'px-3 py-1.5 rounded-lg text-[10px] font-bold border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50'"
              :data-testid="`model-support-preset-${preset}`"
              @click="applyPreset({ preset })"
            >
              {{ presetLabel({ preset }) }}
            </button>
            <span
              :tw-class="investigationPreset === 'custom'
                ? 'px-3 py-1.5 rounded-lg text-[10px] font-bold bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                : 'px-3 py-1.5 rounded-lg text-[10px] font-bold text-gray-400 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'"
              data-testid="model-support-preset-custom"
              :data-active="investigationPreset === 'custom' ? 'true' : 'false'"
            >
              {{ presetLabel({ preset: 'custom' }) }}
            </span>
          </div>
        </div>

        <div
          tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/70 px-3 py-3 space-y-2"
          data-testid="model-support-investigation-scope"
        >
          <div tw-class="flex items-center justify-between gap-3">
            <p tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">
              {{ lazyStrings.ModelSupportInvestigationModal__investigation_scope() }}
            </p>
            <span tw-class="text-[9px] font-bold uppercase tracking-wider text-gray-400">
              {{ lazyStrings.ModelSupportInvestigationModal__execution_policy() }}
            </span>
          </div>
          <div tw-class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <button
              v-for="scopeId in investigationScopeIds"
              :key="scopeId"
              type="button"
              :disabled="running || effectiveScope[scopeId] === 'required'"
              :aria-pressed="effectiveScope[scopeId] !== 'not-selected'"
              :data-state="effectiveScope[scopeId]"
              :data-testid="`model-support-scope-${scopeId}`"
              :tw-class="effectiveScope[scopeId] === 'selected'
                ? 'min-w-0 flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 disabled:opacity-70'
                : effectiveScope[scopeId] === 'required'
                  ? 'min-w-0 flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 disabled:opacity-80'
                  : 'min-w-0 flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50'"
              @click="toggleScope({ scopeId })"
            >
              <span tw-class="text-[10px] font-bold truncate">{{ scopeLabel({ scopeId }) }}</span>
              <span
                v-if="effectiveScope[scopeId] === 'required'"
                tw-class="shrink-0 text-[8px] font-bold uppercase tracking-wide"
              >
                {{ lazyStrings.ModelSupportInvestigationModal__required_by_selected_scope() }}
              </span>
            </button>
          </div>
        </div>

        <div
          tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/70 px-3 py-3 space-y-2"
          data-testid="model-support-external-network-policy"
        >
          <div tw-class="flex items-center justify-between gap-3">
            <div tw-class="min-w-0">
              <p tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">
                {{ lazyStrings.ModelSupportInvestigationModal__external_network_access() }}
              </p>
              <p tw-class="text-[10px] text-gray-500 dark:text-gray-400">
                {{ lazyStrings.ModelSupportInvestigationModal__full_model_download_is_disabled_during_investigation() }}
              </p>
            </div>
            <div tw-class="flex shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 bg-white dark:bg-gray-900">
              <button
                type="button"
                :disabled="running"
                :aria-pressed="investigationConfiguration.externalNetworkPolicy === 'allow'"
                :tw-class="investigationConfiguration.externalNetworkPolicy === 'allow'
                  ? 'px-3 py-1.5 rounded-md text-[10px] font-bold bg-purple-600 text-white disabled:opacity-50'
                  : 'px-3 py-1.5 rounded-md text-[10px] font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50'"
                data-testid="model-support-network-allow"
                @click="setExternalNetworkPolicy({ policy: 'allow' })"
              >
                {{ lazyStrings.ModelSupportInvestigationModal__allow() }}
              </button>
              <button
                type="button"
                :disabled="running"
                :aria-pressed="investigationConfiguration.externalNetworkPolicy === 'deny'"
                :tw-class="investigationConfiguration.externalNetworkPolicy === 'deny'
                  ? 'px-3 py-1.5 rounded-md text-[10px] font-bold bg-purple-600 text-white disabled:opacity-50'
                  : 'px-3 py-1.5 rounded-md text-[10px] font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50'"
                data-testid="model-support-network-deny"
                @click="setExternalNetworkPolicy({ policy: 'deny' })"
              >
                {{ lazyStrings.ModelSupportInvestigationModal__deny() }}
              </button>
            </div>
          </div>
        </div>
        <div tw-class="space-y-3" data-testid="model-support-investigation-start-summary">
          <div tw-class="flex items-center justify-between gap-3">
            <h3 tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.ModelSupportInvestigationModal__execution_policy() }}</h3>
            <span tw-class="text-[9px] font-bold uppercase tracking-wider text-gray-400">{{ presetLabel({ preset: investigationPreset }) }}</span>
          </div>
          <div tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/70 p-3 space-y-2">
            <div tw-class="flex items-center justify-between gap-3 text-[10px]">
              <span tw-class="font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__external_network_access() }}</span>
              <span tw-class="font-bold text-gray-700 dark:text-gray-200">
                {{ investigationConfiguration.externalNetworkPolicy === 'allow' ? lazyStrings.ModelSupportInvestigationModal__allow() : lazyStrings.ModelSupportInvestigationModal__deny() }}
              </span>
            </div>
            <div tw-class="space-y-1">
              <div
                v-for="scopeId in investigationScopeIds"
                :key="scopeId"
                tw-class="flex items-center justify-between gap-3 rounded-lg bg-white dark:bg-gray-900 px-3 py-2"
                :data-testid="`model-support-start-scope-${scopeId}`"
                :data-state="effectiveScope[scopeId]"
              >
                <span tw-class="text-[10px] font-bold text-gray-700 dark:text-gray-200">{{ scopeLabel({ scopeId }) }}</span>
                <span v-if="effectiveScope[scopeId] === 'required'" tw-class="text-[8px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  {{ lazyStrings.ModelSupportInvestigationModal__required_by_selected_scope() }}
                </span>
                <CheckCircle2Icon v-else-if="effectiveScope[scopeId] === 'selected'" tw-class="w-3.5 h-3.5 text-green-500" />
                <CircleSlash2Icon v-else tw-class="w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
              </div>
            </div>
          </div>
          <p tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__models_are_investigated_sequentially() }}</p>
          <p tw-class="text-[10px] text-amber-600 dark:text-amber-400">{{ lazyStrings.ModelSupportInvestigationModal__full_model_download_is_disabled_during_investigation() }}</p>
        </div>
      </section>

      <div
        v-else
        tw-class="min-h-0 flex-1 overflow-y-auto p-5 space-y-5"
        data-testid="model-support-investigation-running-results"
      >
        <section tw-class="space-y-4">
          <div
            v-if="targetExecutions.length > 0"
            tw-class="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 p-2 space-y-1"
            data-testid="model-support-target-executions"
          >
            <button
              v-for="(execution, executionIndex) in targetExecutions"
              :key="execution.target"
              type="button"
              :disabled="running || execution.run === undefined"
              tw-class="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-default disabled:hover:bg-transparent transition-colors"
              :data-testid="`model-support-target-${execution.target}`"
              :data-status="execution.status"
              @click="selectTargetExecution({ executionIndex })"
            >
              <Loader2Icon v-if="execution.status === 'running'" tw-class="w-3.5 h-3.5 animate-spin text-purple-500" />
              <CheckCircle2Icon v-else-if="execution.status === 'passed'" tw-class="w-3.5 h-3.5 text-green-500" />
              <AlertCircleIcon v-else-if="execution.status === 'failed' || execution.status === 'interrupted'" tw-class="w-3.5 h-3.5 text-red-500" />
              <CircleSlash2Icon v-else-if="execution.status === 'skipped'" tw-class="w-3.5 h-3.5 text-gray-400" />
              <CircleIcon v-else tw-class="w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
              <span tw-class="font-mono text-[10px] text-gray-700 dark:text-gray-200 truncate">{{ execution.target }}</span>
            </button>
          </div>
          <div tw-class="space-y-2">
            <div
              v-for="step in steps"
              :key="step.id"
              tw-class="flex items-start gap-3 p-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-800/40"
              :data-testid="`model-support-step-${step.id}`"
            >
              <Loader2Icon v-if="step.status === 'running'" tw-class="w-4 h-4 mt-0.5 text-purple-500 animate-spin shrink-0" />
              <CheckCircle2Icon v-else-if="step.status === 'passed'" tw-class="w-4 h-4 mt-0.5 text-green-500 shrink-0" />
              <AlertCircleIcon v-else-if="step.status === 'failed'" tw-class="w-4 h-4 mt-0.5 text-red-500 shrink-0" />
              <CircleSlash2Icon v-else-if="step.status === 'blocked'" tw-class="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
              <CircleSlash2Icon v-else-if="step.status === 'skipped'" tw-class="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
              <CircleIcon v-else tw-class="w-4 h-4 mt-0.5 text-gray-300 dark:text-gray-600 shrink-0" />
              <div tw-class="min-w-0 flex-1">
                <div tw-class="flex items-center justify-between gap-2">
                  <span tw-class="text-xs font-bold text-gray-800 dark:text-gray-200">{{ stepLabel({ stepId: step.id }) }}</span>
                  <span tw-class="text-[9px] font-bold uppercase tracking-wider text-gray-400">{{ statusLabel({ status: step.status }) }}</span>
                </div>
                <p v-if="step.detail" tw-class="text-[10px] text-gray-500 dark:text-gray-400 mt-1 break-words">{{ step.detail }}</p>
              </div>
            </div>
          </div>
        </section>

        <section tw-class="space-y-5">
          <div>
            <h3 tw-class="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
              {{ lazyStrings.ModelSupportInvestigationModal__current_operation() }}
            </h3>
            <div tw-class="rounded-xl border border-purple-100 dark:border-purple-900/50 bg-purple-50/70 dark:bg-purple-900/20 p-4 flex items-start gap-3">
              <CircleIcon v-if="!started" tw-class="w-4 h-4 mt-0.5 text-gray-300 dark:text-gray-600 shrink-0" />
              <Loader2Icon v-else-if="running" tw-class="w-4 h-4 mt-0.5 text-purple-500 animate-spin shrink-0" />
              <CheckCircle2Icon v-else-if="run?.status === 'passed'" tw-class="w-4 h-4 mt-0.5 text-green-500 shrink-0" />
              <AlertCircleIcon v-else tw-class="w-4 h-4 mt-0.5 text-red-500 shrink-0" />
              <div tw-class="min-w-0">
                <code tw-class="text-xs text-gray-700 dark:text-gray-200 break-all" data-testid="model-support-current-operation">{{ displayedCurrentOperation }}</code>
                <code
                  v-if="displayedProgressDiagnostic"
                  tw-class="block mt-2 text-[10px] text-gray-500 dark:text-gray-400 break-all"
                  data-testid="model-support-live-progress"
                >{{ displayedProgressDiagnostic }}</code>
              </div>
            </div>
          </div>

          <div>
            <h3 tw-class="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
              {{ lazyStrings.ModelSupportInvestigationModal__findings() }}
            </h3>
            <div v-if="findingDetails.length > 0" tw-class="space-y-2">
              <div
                v-for="finding in findingDetails"
                :key="finding.id"
                tw-class="rounded-xl border border-gray-100 dark:border-gray-800 p-3 bg-white dark:bg-gray-900"
              >
                <p tw-class="text-[10px] font-bold text-gray-500 dark:text-gray-400 mb-1">{{ stepLabel({ stepId: finding.id }) }}</p>
                <code tw-class="text-[10px] text-gray-700 dark:text-gray-200 break-all">{{ finding.detail }}</code>
              </div>
            </div>
          </div>

          <div v-if="runtimeAssetsView" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <dl tw-class="text-[10px] divide-y divide-gray-100 dark:divide-gray-800">
              <div tw-class="grid grid-cols-[100px_minmax(0,1fr)] gap-3 p-3">
                <dt tw-class="font-bold text-gray-400 uppercase">{{ lazyStrings.ModelSupportInvestigationModal__runtime_variant() }}</dt>
                <dd tw-class="font-mono text-gray-700 dark:text-gray-200">{{ runtimeAssetsView.variant }}</dd>
              </div>
              <div tw-class="grid grid-cols-[100px_minmax(0,1fr)] gap-3 p-3">
                <dt tw-class="font-bold text-gray-400 uppercase">{{ lazyStrings.ModelSupportInvestigationModal__runtime_mjs() }}</dt>
                <dd tw-class="font-mono text-gray-700 dark:text-gray-200 break-all">{{ runtimeAssetsView.mjsUrl }}</dd>
              </div>
              <div tw-class="grid grid-cols-[100px_minmax(0,1fr)] gap-3 p-3">
                <dt tw-class="font-bold text-gray-400 uppercase">{{ lazyStrings.ModelSupportInvestigationModal__runtime_wasm() }}</dt>
                <dd tw-class="font-mono text-gray-700 dark:text-gray-200 break-all">{{ runtimeAssetsView.wasmUrl }}</dd>
              </div>
              <div tw-class="grid grid-cols-[100px_minmax(0,1fr)] gap-3 p-3">
                <dt tw-class="font-bold text-gray-400 uppercase">{{ lazyStrings.ModelSupportInvestigationModal__runtime_bytes() }}</dt>
                <dd tw-class="font-mono text-gray-700 dark:text-gray-200">{{ runtimeAssetsView.wasmByteLength ?? lazyStrings.ModelSupportInvestigationModal__runtime_no_output() }}</dd>
              </div>
              <div tw-class="grid grid-cols-[100px_minmax(0,1fr)] gap-3 p-3" data-testid="model-support-runtime-environment">
                <dt tw-class="font-bold text-gray-400 uppercase">{{ lazyStrings.ModelSupportInvestigationModal__runtime_environment() }}</dt>
                <dd tw-class="font-mono text-gray-700 dark:text-gray-200 break-all">{{ runtimeEnvironmentSummary }}</dd>
              </div>
              <div v-if="runtimeAssetsView.control" tw-class="grid grid-cols-[100px_minmax(0,1fr)] gap-3 p-3" data-testid="model-support-wasm-control">
                <dt tw-class="font-bold text-gray-400 uppercase">{{ lazyStrings.ModelSupportInvestigationModal__runtime_control() }}</dt>
                <dd tw-class="font-mono text-gray-700 dark:text-gray-200 break-all">
                  {{ runtimeAssetsView.control?.status }} · {{ runtimeAssetsView.control?.outputValue ?? runtimeAssetsView.control?.error ?? lazyStrings.ModelSupportInvestigationModal__runtime_no_output() }}
                </dd>
              </div>
              <div v-if="runtimeAssetsView.webGpuControl" tw-class="grid grid-cols-[100px_minmax(0,1fr)] gap-3 p-3" data-testid="model-support-webgpu-control">
                <dt tw-class="font-bold text-gray-400 uppercase">{{ lazyStrings.ModelSupportInvestigationModal__runtime_control_webgpu() }}</dt>
                <dd tw-class="font-mono text-gray-700 dark:text-gray-200 break-all">
                  {{ runtimeAssetsView.webGpuControl?.status }} · {{ runtimeAssetsView.webGpuControl?.outputValue ?? runtimeAssetsView.webGpuControl?.error ?? lazyStrings.ModelSupportInvestigationModal__runtime_no_output() }}
                </dd>
              </div>
            </dl>
          </div>

          <div v-if="run?.repository" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-1">
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__repository() }}</p>
            <p tw-class="font-mono text-[10px] text-gray-700 dark:text-gray-200 break-all">{{ run.repository.normalizedModelId }}@{{ run.repository.resolvedRevision }}</p>
            <p tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ repositorySummary }}</p>
          </div>

          <div v-if="run?.declarations" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__model_declarations() }}</p>
            <p tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ declarationSummary }}</p>
            <dl tw-class="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[10px]">
              <dt tw-class="font-bold text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__model_type() }}</dt>
              <dd tw-class="font-mono text-gray-700 dark:text-gray-200 break-all">{{ run.declarations.modelType ?? lazyStrings.ModelSupportInvestigationModal__missing_model_type() }}</dd>
              <dt tw-class="font-bold text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__supported_auto_classes() }}</dt>
              <dd tw-class="font-mono text-gray-700 dark:text-gray-200 break-all">
                {{ supportedAutoClasses.length > 0 ? supportedAutoClasses.join(', ') : lazyStrings.ModelSupportInvestigationModal__no_supported_auto_classes() }}
              </dd>
            </dl>
          </div>

          <div v-if="run?.templateBehavior" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-1">
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__template_behavior() }}</p>
            <p tw-class="text-xs text-gray-700 dark:text-gray-200">{{ templateBehaviorSummary }}</p>
            <p v-if="toolTemplateProvenanceSummary" tw-class="text-[10px] text-gray-500 dark:text-gray-400" data-testid="model-support-tool-template-provenance">{{ toolTemplateProvenanceSummary }}</p>
          </div>

          <div v-if="run?.modelFilePlan" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__model_file_plan() }}</p>
            <p tw-class="text-xs text-gray-700 dark:text-gray-200">{{ modelFilePlanSummary }}</p>
            <div tw-class="space-y-1">
              <p
                v-for="candidate in run.modelFilePlan.candidates"
                :key="candidate.candidateId"
                tw-class="font-mono text-[10px] text-gray-600 dark:text-gray-300 break-all"
                :data-testid="`model-support-candidate-${candidate.candidateId}`"
              >
                {{ candidatePlanSummary({ candidate }) }}
              </p>
            </div>
          </div>

          <div v-if="run && run.loadAttempts.length > 0" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__loading_investigation() }}</p>
            <div tw-class="space-y-2">
              <div
                v-for="attempt in run.loadAttempts"
                :key="attempt.attemptId"
                tw-class="rounded-lg border border-gray-100 dark:border-gray-800 p-2 space-y-1"
                :data-testid="`model-support-load-attempt-${attempt.candidateId}`"
              >
                <p tw-class="font-mono text-[10px] text-gray-700 dark:text-gray-200 break-all">
                  {{ attempt.candidateId }} · {{ statusLabel({ status: attempt.status }) }} · {{ attempt.autoClass ?? 'no-generative-auto-class' }}
                </p>
                <p tw-class="font-mono text-[10px] text-gray-500 dark:text-gray-400 break-all">
                  {{ attempt.failureStage ?? 'minimum-generation' }} · minimum={{ attempt.generatedTokenIds.join(',') || 'none' }} · natural={{ attempt.naturalGeneration?.status === 'observed' ? attempt.naturalGeneration.generatedTokenIds.length : (attempt.naturalGeneration?.status ?? 'not-run') }} · {{ attempt.naturalGeneration?.status === 'observed' ? attempt.naturalGeneration.termination : (attempt.naturalGeneration?.status ?? 'not-run') }}
                </p>
                <p
                  v-if="toolProtocolProbeSummary({ attempt })"
                  tw-class="text-[10px] text-gray-500 dark:text-gray-400 break-all"
                  :data-testid="`model-support-tool-protocol-probe-${attempt.candidateId}`"
                >
                  {{ toolProtocolProbeSummary({ attempt }) }}
                </p>
                <p v-if="attempt.error" tw-class="font-mono text-[10px] text-red-600 dark:text-red-400 break-all">
                  {{ attempt.error.name }}: {{ attempt.error.message }}
                </p>
              </div>
            </div>
          </div>

          <div
            v-if="persistenceRoundTripSummary"
            tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3"
            data-testid="model-support-persistence-roundtrip"
          >
            <p tw-class="text-xs text-gray-600 dark:text-gray-300 break-all">{{ persistenceRoundTripSummary }}</p>
          </div>

          <div
            v-if="run && run.productionLane.status !== 'not-run'"
            tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-1"
            data-testid="model-support-lane-comparison"
          >
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__lane_comparison() }}</p>
            <p v-if="productionLaneRouteSummary" tw-class="font-mono text-[10px] text-gray-700 dark:text-gray-200 break-all">{{ productionLaneRouteSummary }}</p>
            <p v-if="productionLoadAttemptsSummary" tw-class="font-mono text-[10px] text-gray-600 dark:text-gray-300 break-all" data-testid="model-support-production-load-attempts">{{ productionLoadAttemptsSummary }}</p>
            <p v-if="productionLaneComparisonSummary" tw-class="text-xs text-gray-600 dark:text-gray-300 break-all">{{ productionLaneComparisonSummary }}</p>
            <p v-if="productionContinuitySummary" tw-class="text-xs text-gray-600 dark:text-gray-300 break-all" data-testid="model-support-production-continuity">{{ productionContinuitySummary }}</p>
            <p v-if="productionToolResultContinuationSummary" tw-class="text-xs text-gray-600 dark:text-gray-300 break-all" data-testid="model-support-production-tool-result-continuation">{{ productionToolResultContinuationSummary }}</p>
            <p v-if="productionReasoningSummary" tw-class="text-xs text-gray-600 dark:text-gray-300 break-all" data-testid="model-support-production-reasoning">{{ productionReasoningSummary }}</p>
            <p v-if="productionMultimodalSummary" tw-class="text-xs text-gray-600 dark:text-gray-300 break-all" data-testid="model-support-production-multimodal">{{ productionMultimodalSummary }}</p>
          </div>

          <div v-if="evidenceReadiness" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-1" data-testid="model-support-evidence-readiness">
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__evidence_readiness() }}</p>
            <p tw-class="text-xs text-gray-700 dark:text-gray-200">{{ evidenceReadinessSummary }}</p>
          </div>

          <div v-if="supportBoundaryAssessments.length > 0" tw-class="rounded-xl border border-amber-200 dark:border-amber-800 p-3 space-y-1" data-testid="model-support-boundary-assessment">
            <p tw-class="text-[10px] font-bold uppercase text-amber-600 dark:text-amber-400">{{ lazyStrings.ModelSupportInvestigationModal__support_boundary() }}</p>
            <p tw-class="text-xs text-gray-700 dark:text-gray-200">{{ supportBoundarySummary }}</p>
          </div>

          <div v-if="run?.cache" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-1">
            <p tw-class="text-[10px] font-bold uppercase text-gray-400">{{ lazyStrings.ModelSupportInvestigationModal__opfs_inventory() }}</p>
            <p tw-class="font-mono text-[10px] text-gray-700 dark:text-gray-200 break-all">{{ run.cache.rootPath }}</p>
            <p tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ cacheSummary }}</p>
            <p tw-class="text-[10px] text-amber-600 dark:text-amber-400">{{ lazyStrings.ModelSupportInvestigationModal__cache_revision_unknown() }}</p>
          </div>
        </section>
      </div>

      <footer tw-class="px-6 py-4 bg-gray-50 dark:bg-gray-800/70 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-3">
        <button
          v-if="!started"
          type="button"
          :disabled="targetParseResult.targets.length === 0 || targetParseResult.errors.length > 0 || !hasRequestedScope"
          tw-class="px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold flex items-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="model-support-investigation-start"
          @click="startInvestigation"
        >
          <PlayIcon tw-class="w-4 h-4" />
          {{ lazyStrings.ModelSupportInvestigationModal__start_investigation() }}
        </button>
        <button
          v-if="running && canSkipCurrentTarget"
          type="button"
          :disabled="stopping || skippingCurrentTarget"
          tw-class="px-4 py-2.5 rounded-xl border border-amber-200 dark:border-amber-800 text-xs font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          data-testid="model-support-investigation-skip-current"
          @click="skipCurrentTarget"
        >
          <Loader2Icon v-if="skippingCurrentTarget" tw-class="w-4 h-4 animate-spin" />
          <CircleSlash2Icon v-else tw-class="w-4 h-4" />
          {{ lazyStrings.ModelSupportInvestigationModal__stop_this_model_and_continue() }}
        </button>
        <button
          v-if="running"
          type="button"
          :disabled="stopping"
          tw-class="px-4 py-2.5 rounded-xl border border-red-200 dark:border-red-800 text-xs font-bold text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          data-testid="model-support-investigation-stop"
          @click="stopInvestigation"
        >
          <Loader2Icon v-if="stopping" tw-class="w-4 h-4 animate-spin" />
          <SquareIcon v-else tw-class="w-4 h-4" />
          {{ lazyStrings.ModelSupportInvestigationModal__stop_investigation() }}
        </button>
        <button
          v-if="started"
          type="button"
          :disabled="(run === undefined && targetExecutions.length === 0) || evidenceExporting"
          tw-class="px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold flex items-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="model-support-investigation-download"
          @click="downloadPartialEvidence"
        >
          <Loader2Icon v-if="evidenceExporting" tw-class="w-4 h-4 animate-spin" />
          <DownloadIcon v-else tw-class="w-4 h-4" />
          {{ lazyStrings.ModelSupportInvestigationModal__download_partial_evidence() }}
        </button>
        <button
          type="button"
          :disabled="running"
          tw-class="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          @click="close"
        >
          {{ lazyStrings.ModelSupportInvestigationModal__close() }}
        </button>
      </footer>
    </div>
  </div>
</template>
