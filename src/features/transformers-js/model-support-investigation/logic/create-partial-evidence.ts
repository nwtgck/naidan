import { setEvidenceFile, createEvidenceArchive, createEvidenceFilesReader, openEvidenceArchive } from './evidence-archive';
import { freshMetadataSummarySchema } from '@/features/transformers-js/model-support-investigation/fresh-metadata-worker/types';
import { investigationExecutionSummary } from './investigation-execution-summary';
import { renderInvestigationFeatureResults } from './investigation-feature-results';
import { PRODUCTION_PROVIDER_NATIVE_BATCH_BINARY_BYTES, PRODUCTION_PROVIDER_NATIVE_BATCH_JSON_CHARACTERS } from './investigation-provider-retention';
export { PRODUCTION_PROVIDER_NATIVE_BATCH_BINARY_BYTES, PRODUCTION_PROVIDER_NATIVE_BATCH_JSON_CHARACTERS } from './investigation-provider-retention';
import { createProductionProviderCaptureEvidence, PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH } from './production-provider-capture-evidence';
import { createProductionProviderInvestigationSummaryEvidence, PRODUCTION_PROVIDER_INVESTIGATION_SUMMARY_EVIDENCE_PATH, productionProviderInvestigationSummaryReferenceSchema } from './production-provider-investigation-summary';
import { verifyProductionProviderNativeEvidenceSidecar, measureProductionProviderNativeEvidenceSidecar, PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, PRODUCTION_PROVIDER_NATIVE_JSON_MAXIMUM_CHARACTERS, type ProductionProviderNativeEvidenceSidecar } from './production-provider-native-evidence';
import { addReplayMetadataToEvidenceFiles } from '@/features/transformers-js/model-support-investigation/logic/replay-metadata-export';
import { REPLAY_METADATA_BATCH_BYTES, type InvestigationReplayMetadataSidecar } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';
import { z } from "zod";
import type {
  ModelSupportInvestigationBatchEvidenceItem,
  ModelSupportInvestigationLoadAttemptError,
  ModelSupportInvestigationProgressObservation,
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationPartialObservation,
} from "@/features/transformers-js/types";
import {
  evaluateEvidenceReadiness,
  renderEvidenceReadinessMarkdown,
} from "@/features/transformers-js/model-support-investigation/logic/evaluate-evidence-readiness";
import { assessSupportBoundaries } from "@/features/transformers-js/model-support-investigation/logic/assess-support-boundaries";
import { verifyGeneratedEvidenceArchive, verifyGeneratedEvidenceFiles } from "@/features/transformers-js/model-support-investigation/logic/verify-evidence-archive";
import {
  assessEvidencePackage,
  renderEvidencePackageAssessmentMarkdown,
} from "@/features/transformers-js/model-support-investigation/logic/assess-evidence-package";
import { createDownloadVerificationEvidenceLaneFiles } from '@/features/transformers-js/download-verification/evidence/create-download-verification-evidence';
import { ordinaryProviderRuntimeCompletionSchema, providerLoadRuntimeCompletion } from './provider-load-runtime-completion';

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function safeFilePart({ value }: { value: string }): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "model";
}

function productionObservation({ run }: { run: ModelSupportInvestigationRun }):
  | TransformersJsProductionInvestigationObservation
  | TransformersJsProductionInvestigationPartialObservation
  | undefined {
  return run.productionLane.observation ?? run.productionLane.partialObservation;
}


function attemptEvidenceRecords({ run }: { run: ModelSupportInvestigationRun }) {
  return [
    ...run.loadAttempts.map(attempt => ({
      attemptId: attempt.attemptId,
      candidateId: attempt.candidateId,
      inputStrategyAttempts: attempt.inputStrategyAttempts,
      naturalGeneration: attempt.naturalGeneration,
      toolProtocolProbe: attempt.toolProtocolProbe,
    })),
    ...(run.activeLoadAttempt === undefined ? [] : [{
      attemptId: run.activeLoadAttempt.attemptId,
      candidateId: run.activeLoadAttempt.candidateId,
      inputStrategyAttempts: run.activeLoadAttempt.inputStrategyAttempts,
      naturalGeneration: run.activeLoadAttempt.naturalGeneration,
      toolProtocolProbe: run.activeLoadAttempt.toolProtocolProbe,
    }]),
  ];
}

function inputStrategyErrorRecords({ run }: { run: ModelSupportInvestigationRun }) {
  return attemptEvidenceRecords({ run }).flatMap(attempt => attempt.inputStrategyAttempts.flatMap((strategyAttempt) => {
    const status = strategyAttempt.status;
    switch (status) {
    case "passed":
      return [];
    case "failed":
      return [{
        attemptId: attempt.attemptId,
        candidateId: attempt.candidateId,
        strategy: strategyAttempt.strategy,
        failureStage: strategyAttempt.failureStage,
        error: strategyAttempt.error,
      }];
    default: {
      const _ex: never = status;
      return _ex;
    }
    }
  }));
}

function naturalGenerationErrorRecords({ run }: { run: ModelSupportInvestigationRun }) {
  return attemptEvidenceRecords({ run }).flatMap((attempt) => {
    const observation = attempt.naturalGeneration;
    if (observation === undefined) return [];
    switch (observation.status) {
    case "observed":
      return [];
    case "failed":
      return [{
        attemptId: attempt.attemptId,
        candidateId: attempt.candidateId,
        error: observation.error,
      }];
    default: {
      const _ex: never = observation;
      return _ex;
    }
    }
  });
}

function toolResultContinuationError({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationLoadAttemptError | undefined {
  const observation = productionObservation({ run })?.toolResultContinuation;
  if (observation === undefined) return undefined;
  switch (observation.status) {
  case "passed":
  case "not-run":
    return undefined;
  case "failed":
    return observation.error;
  default: {
    const _ex: never = observation;
    throw new Error(`Unhandled Production tool-result continuation status: ${String(_ex)}`);
  }
  }
}

function reasoningEffortErrorRecords({ run }: { run: ModelSupportInvestigationRun }): Array<{ effort: 'none' | 'high', error: ModelSupportInvestigationLoadAttemptError }> {
  const reasoning = productionObservation({ run })?.reasoning;
  if (reasoning === undefined || reasoning.status !== 'failed') return [];
  return reasoning.effortAttempts.flatMap((attempt) => {
    switch (attempt.status) {
    case 'passed':
      return [];
    case 'failed':
      return [{ effort: attempt.effort, error: attempt.error }];
    default: {
      const _ex: never = attempt;
      return _ex;
    }
    }
  });
}

function reasoningError({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationLoadAttemptError | undefined {
  const reasoning = productionObservation({ run })?.reasoning;
  if (reasoning === undefined) return undefined;
  switch (reasoning.status) {
  case "observed":
  case "unavailable":
    return undefined;
  case "failed":
    return reasoning.error;
  default: {
    const _ex: never = reasoning;
    throw new Error(`Unhandled Production reasoning status: ${String(_ex)}`);
  }
  }
}

function multimodalError({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationLoadAttemptError | undefined {
  const multimodal = productionObservation({ run })?.multimodal;
  if (multimodal === undefined) return undefined;
  switch (multimodal.status) {
  case 'observed':
  case 'unavailable':
    return undefined;
  case 'failed':
    return multimodal.error;
  default: {
    const _ex: never = multimodal;
    throw new Error(`Unhandled Production multimodal status: ${String(_ex)}`);
  }
  }
}

function firstTurnError({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationLoadAttemptError | undefined {
  const firstTurn = productionObservation({ run })?.firstTurn;
  if (firstTurn === undefined) return undefined;
  switch (firstTurn.status) {
  case "passed":
    return undefined;
  case "failed":
    return firstTurn.error;
  default: {
    const _ex: never = firstTurn;
    throw new Error(`Unhandled Production first-turn status: ${String(_ex)}`);
  }
  }
}

function persistenceRoundTripError({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationLoadAttemptError | undefined {
  const persistence = run.persistenceRoundTrip;
  if (persistence === undefined) return undefined;
  switch (persistence.status) {
  case 'observed':
    return undefined;
  case 'failed':
    return persistence.error;
  default: {
    const _ex: never = persistence;
    return _ex;
  }
  }
}

function continuityError({ run }: { run: ModelSupportInvestigationRun }): ModelSupportInvestigationLoadAttemptError | undefined {
  const continuity = productionObservation({ run })?.continuity;
  if (continuity === undefined) return undefined;
  switch (continuity.status) {
  case "passed":
  case "not-run":
    return undefined;
  case "failed":
    return continuity.error;
  default: {
    const _ex: never = continuity;
    throw new Error(`Unhandled continuity status: ${String(_ex)}`);
  }
  }
}

function postAttemptCacheErrorRecords({ run }: { run: ModelSupportInvestigationRun }) {
  return run.loadAttempts.flatMap((attempt) => {
    const observation = attempt.postAttemptCache;
    if (observation === undefined) return [];
    switch (observation.status) {
    case "observed":
      return [];
    case "failed":
      return [{
        attemptId: attempt.attemptId,
        candidateId: attempt.candidateId,
        error: observation.error,
      }];
    default: {
      const _ex: never = observation;
      throw new Error(`Unhandled post-attempt cache observation status: ${String(_ex)}`);
    }
    }
  });
}

function toolProtocolProbeErrorRecords({ run }: { run: ModelSupportInvestigationRun }) {
  return attemptEvidenceRecords({ run }).flatMap((attempt) => {
    const probe = attempt.toolProtocolProbe;
    if (probe === undefined) return [];
    switch (probe.status) {
    case "observed": {
      const records: Array<{ attemptId: string, candidateId: string, error: unknown }> = [];
      switch (probe.parserObservation.status) {
      case "failed":
        records.push({
          attemptId: attempt.attemptId,
          candidateId: attempt.candidateId,
          error: probe.parserObservation.error,
        });
        break;
      case "observed":
      case "unavailable":
        break;
      default: {
        const _ex: never = probe.parserObservation;
        throw new Error(`Unhandled tool parser observation status: ${String(_ex)}`);
      }
      }
      const roundTrip = probe.toolResultTemplateRoundTrip;
      if (roundTrip !== undefined) {
        switch (roundTrip.status) {
        case "failed":
          records.push({
            attemptId: attempt.attemptId,
            candidateId: attempt.candidateId,
            error: roundTrip.error,
          });
          break;
        case "observed":
        case "unavailable":
          break;
        default: {
          const _ex: never = roundTrip;
          throw new Error(`Unhandled tool-result roundtrip status: ${String(_ex)}`);
        }
        }
      }
      return records;
    }
    case "unavailable":
      return [];
    case "failed":
      return [{
        attemptId: attempt.attemptId,
        candidateId: attempt.candidateId,
        error: probe.error,
      }];
    default: {
      const _ex: never = probe;
      throw new Error(`Unhandled tool protocol probe status: ${String(_ex)}`);
    }
    }
  });
}

async function createPartialModelSupportEvidenceFiles({ run, recovery, replayMetadata, nativeEvidence, maximumNativeBinaryBytes, maximumNativeJsonCharacters }: {
  run: ModelSupportInvestigationRun,
  recovery: ModelSupportInvestigationRecovery | undefined,
  replayMetadata?: InvestigationReplayMetadataSidecar[],
  nativeEvidence: ProductionProviderNativeEvidenceSidecar | undefined,
  maximumNativeBinaryBytes: number,
  maximumNativeJsonCharacters: number,
}): Promise<{ files: Map<string, Blob>, fileName: string, nativeBinaryBytes: number, nativeJsonCharacters: number }> {
  const files = new Map<string, Blob>();
  const providerCapture = run.productionProviderCapture === undefined ? undefined : createProductionProviderCaptureEvidence({
    capture: run.productionProviderCapture, runId: run.runId, modelId: run.modelId,
  });
  if (providerCapture !== undefined) setEvidenceFile({ files, path: PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH, content: providerCapture.json });
  // Keep the bounded collection summary even when the Provider encoder refused
  // its larger snapshot. Its dedicated codec preserves known own-undefined fields.
  const providerSummary = run.productionProviderInvestigation === undefined ? undefined : createProductionProviderInvestigationSummaryEvidence({
    summary: run.productionProviderInvestigation, runId: run.runId, modelId: run.modelId,
  });
  const providerSummaryReference = providerSummary === undefined ? undefined : productionProviderInvestigationSummaryReferenceSchema.parse({
    format: 'production-provider-investigation-summary-reference-v1', path: PRODUCTION_PROVIDER_INVESTIGATION_SUMMARY_EVIDENCE_PATH,
  });
  if (providerSummary !== undefined) setEvidenceFile({ files, path: PRODUCTION_PROVIDER_INVESTIGATION_SUMMARY_EVIDENCE_PATH, content: providerSummary.json });
  const native = nativeEvidence === undefined ? undefined : await (async () => {
    if (run.productionProviderCapture === undefined) throw new Error('Native capture Evidence requires its Provider snapshot');
    // Recheck the current per-model input after earlier model awaits. Admission
    // of the original item array does not give later replacements more capacity.
    if (measureProductionProviderNativeEvidenceSidecar({ evidence: nativeEvidence }).jsonCharacters > maximumNativeJsonCharacters) {
      throw new Error('Native capture batch Evidence exceeds its retained data budget');
    }
    return verifyProductionProviderNativeEvidenceSidecar({ evidence: nativeEvidence, provider: run.productionProviderCapture, maximumBinaryBytes: maximumNativeBinaryBytes });
  })();
  if (native !== undefined) {
    setEvidenceFile({ files, path: native.path, content: native.json });
    for (const binary of native.binaries) setEvidenceFile({ files, path: binary.path, content: binary.blob });
  }
  switch (run.downloadEvidence?.runtimeCompletion?.source) {
  case 'ordinary-provider-load': {
    const actual = ordinaryProviderRuntimeCompletionSchema.parse(run.downloadEvidence.runtimeCompletion);
    const expected = ordinaryProviderRuntimeCompletionSchema.parse(providerLoadRuntimeCompletion({
      repositoryResolvedRevision: run.downloadEvidence.run.resolvedRevision, provider: run.productionProviderCapture,
      summary: run.productionProviderInvestigation, nativeJson: native?.json,
    }));
    if (run.downloadEvidence.mode !== 'runtime-complete' || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Provider Load receipt does not match its investigation Evidence owner');
    }
    break;
  }
  case 'reused-production-cache': case 'production-download-preparation': case 'cache-only-unavailable': case 'cache-reuse-failed': case undefined: break;
  default: { const exhaustive: never = run.downloadEvidence!.runtimeCompletion!.source; throw new Error('Unknown runtime completion source: ' + exhaustive); }
  }
  await addReplayMetadataToEvidenceFiles({ files, summary: run.replayMetadata, sidecars: replayMetadata });
  const freshMetadata = run.freshMetadata === undefined ? undefined : freshMetadataSummarySchema.parse(run.freshMetadata);
  if (freshMetadata !== undefined) {
    setEvidenceFile({ files, path: 'download-lane/fresh-metadata.json', content: `${JSON.stringify(freshMetadata, undefined, 2)}\n` });
  }
  const readiness = evaluateEvidenceReadiness({ run });
  const execution = investigationExecutionSummary({ run, recovery });
  const supportBoundaries = assessSupportBoundaries({ run });
  const hasProviderInvestigation = providerCapture !== undefined || providerSummary !== undefined;
  const loadingSummary = hasProviderInvestigation && run.loadAttempts.length === 0
    ? 'The separate Reference load comparison was not executed by this public Provider investigation. Its absence is not evidence that the ordinary Provider model was never loaded.'
    : run.activeLoadAttempt !== undefined
      ? `${run.loadAttempts.length} completed real-model load ${run.loadAttempts.length === 1 ? "attempt was" : "attempts were"} recorded; ${run.activeLoadAttempt.candidateId} is checkpointed while ${run.activeLoadAttempt.currentStage} is still running.`
      : run.loadAttempts.length === 0
        ? "No real-model load attempts were recorded. Consult the selected scope and step results to distinguish unselected stages from interrupted or failed stages."
        : `${run.loadAttempts.length} real-model load ${run.loadAttempts.length === 1 ? "attempt was" : "attempts were"} recorded.`;
  const productionSummary = (() => {
    if (hasProviderInvestigation) return 'Public Provider requests are recorded in the dedicated Provider evidence or its bounded summary. Request fulfillment, collection completion, and native recording coverage are separate observations; none alone certifies model correctness. The legacy direct Production comparison was not executed.';
    switch (run.productionLane.status) {
    case "passed": {
      const observation = run.productionLane.observation;
      if (observation === undefined) return "Production Lane completed without a serializable observation.";
      switch (observation.firstTurn.status) {
      case "passed":
        return `Production Lane generated successfully with ${observation.route.strategy} strategy.`;
      case "failed":
        return `Production Lane loaded and continued independent probes with ${observation.route.strategy} strategy after first-turn generation failed.`;
      default: {
        const _ex: never = observation.firstTurn;
        return _ex;
      }
      }
    }
    case "running": {
      const observation = productionObservation({ run });
      return observation === undefined
        ? "Production Lane is running; no structured probe checkpoint has been received yet."
        : "Production Lane is running; completed probe evidence from the latest structured checkpoint is included.";
    }
    case "failed": {
      const observation = productionObservation({ run });
      return observation === undefined
        ? "Production Lane failed after Reference Lane evidence was preserved."
        : "Production Lane failed after preserving completed Production probe evidence from the latest checkpoint.";
    }
    case "not-run":
      return "Production Lane was not run.";
    default: {
      const _ex: never = run.productionLane.status;
      throw new Error(`Unhandled Production Lane status: ${_ex}`);
    }
    }
  })();
  const formatLoadTelemetry = ({
    candidate,
    durationMs,
    progress,
  }: {
    candidate: string,
    durationMs: number | undefined,
    progress: ModelSupportInvestigationProgressObservation | undefined,
  }): string => {
    const duration = durationMs === undefined ? "duration=unavailable" : `duration=${Math.round(durationMs)}ms`;
    const callbackCounts = progress === undefined
      ? "progress=unavailable"
      : `raw-events=${progress.eventCount}, published-samples=${progress.publishedSampleCount}`;
    const cacheCounts = progress?.cacheMatchRequestCount === undefined
      ? "opfs=unavailable"
      : `opfs-matches=${progress.cacheMatchRequestCount}, hits=${progress.cacheHitCount ?? 0}, misses=${progress.cacheMissCount ?? 0}, alias-hits=${progress.cacheAliasHitCount ?? 0}, matched-bytes=${progress.cacheMatchedBytes ?? 0}, remote-fetch-attempts=${progress.remoteFetchAttemptCount ?? 0}`;
    return `${candidate} (${duration}; ${callbackCounts}; ${cacheCounts})`;
  };
  const modelLoadTelemetrySemantics = "Transformers.js download/progress callbacks measure Response body reads and do not prove network transfer; transport source is established by OPFS match and blocked remote-fetch observations.";
  const referenceLoadTelemetry = run.loadAttempts.length === 0
    ? "not-recorded"
    : run.loadAttempts.map(attempt => formatLoadTelemetry({
      candidate: attempt.candidateId,
      durationMs: attempt.modelLoadDurationMs,
      progress: attempt.modelLoadProgress,
    })).join("; ");
  const productionLoadTelemetry = (() => {
    const observation = productionObservation({ run });
    const attempts = observation?.loadAttempts ?? [];
    const completed = attempts.map(attempt => formatLoadTelemetry({
      candidate: `${attempt.candidate.device}-${attempt.candidate.dtype}`,
      durationMs: attempt.modelLoadDurationMs,
      progress: attempt.modelLoadProgress,
    }));
    const activeAttempt = run.productionLane.partialObservation?.activeLoadAttempt;
    const active = activeAttempt === undefined
      ? []
      : [`${formatLoadTelemetry({
        candidate: `${activeAttempt.candidate.device}-${activeAttempt.candidate.dtype}`,
        durationMs: activeAttempt.modelLoadDurationMs,
        progress: activeAttempt.modelLoadProgress,
      })} [running]`];
    const telemetry = [...completed, ...active];
    return telemetry.length === 0 ? "not-recorded" : telemetry.join("; ");
  })();
  const productionRuntimeLoadDurationMs = productionObservation({ run })?.runtimeLoadDurationMs;
  const productionRuntimePreparationDurationMs = productionObservation({ run })?.runtimePreparationDurationMs;
  const summary = `\
# Model Support Investigation Evidence

- Scope: ${run.scope}
- Execution: ${execution.state}
- Completed collection boundary result (not feature correctness): ${execution.result ?? 'not-recorded'}
- Latest boundary result (not execution completion): ${run.status}
- Fresh metadata preparation: ${freshMetadata?.status ?? 'not-recorded'}
- Fresh metadata preparation stage: ${freshMetadata?.preparationStage ?? 'not-recorded'}
- Fresh metadata failure category: ${freshMetadata?.failureCategory ?? 'not-recorded'}
- Fresh metadata observed transfer bytes: ${freshMetadata?.receivedBytes ?? 'not-recorded'}
- Model: ${run.modelId}
- Run ID: ${run.runId}
- External network policy: ${run.requestedConfiguration?.externalNetworkPolicy ?? "not-recorded"}
- Requested investigation scope: ${run.requestedConfiguration === undefined ? "not-recorded" : JSON.stringify(run.requestedConfiguration.scope)}
- Effective execution plan: ${run.executionPlan === undefined ? "not-recorded" : JSON.stringify(run.executionPlan)}
- Started: ${run.startedAt}
- Completed execution: ${execution.completedAt ?? 'not-recorded'}
- Evidence readiness (coverage, not execution status): ${readiness.overall}
- Recovery status: ${recovery?.status ?? "not-recorded"}
- Recovery journal: ${recovery === undefined
    ? "not-recorded"
    : `retained ${recovery.events.length} of ${recovery.totalEventCount} events; ${recovery.droppedEventCount} dropped by bounded telemetry policy`}
- Reference model-load telemetry: ${referenceLoadTelemetry}
- Model-load telemetry semantics: ${modelLoadTelemetrySemantics}
- Production model-load telemetry: ${productionLoadTelemetry}
- Production runtime-load total: ${productionRuntimeLoadDurationMs === undefined ? "not-recorded" : `${Math.round(productionRuntimeLoadDurationMs)}ms`}
- Production tokenizer/processor preparation: ${productionRuntimePreparationDurationMs === undefined ? "not-recorded" : `${Math.round(productionRuntimePreparationDurationMs)}ms`}

Evidence coverage and execution completion are independent. Unselected scopes are not pending work. Read execution.json for coordinator completion, and READINESS.md for the limits of the evidence. Legacy run.json status/completedAt describe the latest partial boundary. ${loadingSummary} ${productionSummary} Repository or cache artifacts are included only when their steps completed.

Fresh metadata preparation uses the ordinary Download metadata path with empty temporary memory. It does not certify a full model download or successful Load. Existing-cache acceptance is a separate result. HTTP observations distinguish runtime preparation from supplemental replay collection; received bytes describe fetch-visible bodies, not browser/OS prefetch traffic. See download-lane/fresh-metadata.json when present. Missing observations are not proof of a successful fresh download.

${renderInvestigationFeatureResults({ run })}

Production Provider capture: ${providerCapture === undefined ? 'not recorded' : PRODUCTION_PROVIDER_CAPTURE_EVIDENCE_PATH}. This fixed synthetic script records bounded public callbacks, not native invocation evidence or certified real-model success. A completed script or complete projection does not establish replay eligibility. Disposal observations describe an end request, not proof of physical termination.

Native generation capture: ${native === undefined ? 'not recorded' : `recorded; collection phase: ${native.summary.phase}; refused epochs: ${native.summary.refusedEpochCount}; ${native.path}`}. This is a bounded observation and does not certify Load success or complete replay. Provider settlement and native results remain independent observations; refusal or missing retrieval is not a successful capture.
`;
  setEvidenceFile({ files, path: "SUMMARY.md", content: summary });
  setEvidenceFile({ files, path: 'execution.json', content: `${JSON.stringify(execution, undefined, 2)}\n` });
  setEvidenceFile({ files, path: "READINESS.md", content: renderEvidenceReadinessMarkdown({ report: readiness }) });
  setEvidenceFile({ files, path: "readiness.json", content: `${JSON.stringify(readiness, undefined, 2)}\n` });
  setEvidenceFile({ files, path: "questions.json", content: `${JSON.stringify(readiness.domains.flatMap(domainReadiness => (
    domainReadiness.questions.map(question => ({ domainId: domainReadiness.domainId, ...question }))
  )), undefined, 2)}\n` });
  setEvidenceFile({ files, path: "support-boundaries.json", content: `${JSON.stringify(supportBoundaries, undefined, 2)}\n` });
  setEvidenceFile({ files, path: "run.json", content: `${JSON.stringify({ ...run, productionProviderCapture: providerCapture?.reference, productionProviderNativeCapture: native?.reference, productionProviderInvestigation: providerSummaryReference }, undefined, 2)}\n` });
  if (run.requestedConfiguration !== undefined || run.executionPlan !== undefined) {
    setEvidenceFile({ files, path: "execution-policy/policy.json", content: `${JSON.stringify({
      requestedConfiguration: run.requestedConfiguration,
      effectiveExecutionPlan: run.executionPlan,
    }, undefined, 2)}\n` });
  }
  if (recovery !== undefined) {
    setEvidenceFile({ files, path: "recovery/checkpoint.json", content: `${JSON.stringify(recovery, undefined, 2)}\n` });
  }
  setEvidenceFile({ files, path: "errors.json", content: `${JSON.stringify({
    runError: run.error,
    stepErrors: run.stepErrors,
    loadAttemptErrors: run.loadAttempts
      .filter(attempt => attempt.error !== undefined)
      .map(attempt => ({
        attemptId: attempt.attemptId,
        candidateId: attempt.candidateId,
        failureStage: attempt.failureStage,
        error: attempt.error,
      })),
    activeLoadAttemptError: run.activeLoadAttempt?.error === undefined
      ? undefined
      : {
        attemptId: run.activeLoadAttempt.attemptId,
        candidateId: run.activeLoadAttempt.candidateId,
        currentStage: run.activeLoadAttempt.currentStage,
        error: run.activeLoadAttempt.error,
      },
    inputStrategyErrors: inputStrategyErrorRecords({ run }),
    postAttemptCacheErrors: postAttemptCacheErrorRecords({ run }),
    naturalGenerationErrors: naturalGenerationErrorRecords({ run }),
    toolProtocolProbeErrors: toolProtocolProbeErrorRecords({ run }),
    productionLaneError: run.productionLane.error,
    productionFirstTurnError: firstTurnError({ run }),
    productionContinuityError: continuityError({ run }),
    persistenceRoundTripError: persistenceRoundTripError({ run }),
    productionToolResultContinuationError: toolResultContinuationError({ run }),
    productionReasoningError: reasoningError({ run }),
    productionReasoningEffortErrors: reasoningEffortErrorRecords({ run }),
    productionMultimodalError: multimodalError({ run }),
    interruptionError: recovery?.interruption?.error,
  }, undefined, 2)}\n` });
  const investigationEvents = recovery?.events.map(event => ({
    eventKind: "investigation-event" as const,
    ...event,
  })) ?? [];
  const attemptEvents = [
    ...run.loadAttempts.map(attempt => ({
      attemptId: attempt.attemptId,
      candidateId: attempt.candidateId,
      events: attempt.events,
    })),
    ...(run.activeLoadAttempt === undefined ? [] : [{
      attemptId: run.activeLoadAttempt.attemptId,
      candidateId: run.activeLoadAttempt.candidateId,
      events: run.activeLoadAttempt.events,
    }]),
  ].flatMap(attempt => attempt.events.map(event => ({
    eventKind: "load-attempt-event" as const,
    attemptId: attempt.attemptId,
    candidateId: attempt.candidateId,
    ...event,
  })));
  const allEvents = [...investigationEvents, ...attemptEvents];
  setEvidenceFile({ files, path: "events.jsonl", content: allEvents.map(event => JSON.stringify(event)).join("\n") + (allEvents.length > 0 ? "\n" : "") });
  if (run.runtimeAssets !== undefined) {
    setEvidenceFile({ files, path: "runtime-assets/preflight.json", content: `${JSON.stringify(run.runtimeAssets, undefined, 2)}\n` });
    if (run.runtimeAssets.assetIdentity !== undefined) {
      setEvidenceFile({ files, path: "runtime-assets/asset-identity.json", content: `${JSON.stringify(run.runtimeAssets.assetIdentity, undefined, 2)}\n` });
    }
    setEvidenceFile({ files, path: "runtime-assets/environment.json", content: `${JSON.stringify(run.runtimeAssets.environment, undefined, 2)}\n` });
    setEvidenceFile({ files, path: "runtime-assets/backend-controls.json", content: `${JSON.stringify({
      wasm: run.runtimeAssets.control,
      webgpu: run.runtimeAssets.webGpuControl,
    }, undefined, 2)}\n` });
  } else if (run.runtimeAssetsPartial !== undefined) {
    setEvidenceFile({ files, path: "runtime-assets/preflight-partial.json", content: `${JSON.stringify(run.runtimeAssetsPartial, undefined, 2)}\n` });
    if (run.runtimeAssetsPartial.assetIdentity !== undefined) {
      setEvidenceFile({ files, path: "runtime-assets/asset-identity.json", content: `${JSON.stringify(run.runtimeAssetsPartial.assetIdentity, undefined, 2)}\n` });
    }
    if (run.runtimeAssetsPartial.environment !== undefined) {
      setEvidenceFile({ files, path: "runtime-assets/environment.json", content: `${JSON.stringify(run.runtimeAssetsPartial.environment, undefined, 2)}\n` });
    }
    if (run.runtimeAssetsPartial.control !== undefined || run.runtimeAssetsPartial.webGpuControl !== undefined) {
      setEvidenceFile({ files, path: "runtime-assets/backend-controls.json", content: `${JSON.stringify({
        wasm: run.runtimeAssetsPartial.control,
        webgpu: run.runtimeAssetsPartial.webGpuControl,
      }, undefined, 2)}\n` });
    }
  }
  if (run.repository !== undefined) {
    setEvidenceFile({ files, path: "repository/repository.json", content: `${JSON.stringify(run.repository, undefined, 2)}\n` });
  }
  if (run.runtimeTarget !== undefined) {
    setEvidenceFile({ files, path: "runtime-target/target.json", content: `${JSON.stringify(run.runtimeTarget, undefined, 2)}\n` });
  }
  if (run.downloadEvidence !== undefined) {
    const { files: downloadFiles } = createDownloadVerificationEvidenceLaneFiles({ evidence: run.downloadEvidence });
    for (const [path, content] of Object.entries(downloadFiles)) {
      setEvidenceFile({ files, path, content });
    }
  }
  if (run.cache !== undefined) {
    setEvidenceFile({ files, path: "cache/inventory.json", content: `${JSON.stringify(run.cache, undefined, 2)}\n` });
    if (run.cache.provenance !== undefined) {
      setEvidenceFile({ files, path: "cache/provenance.json", content: `${JSON.stringify(run.cache.provenance, undefined, 2)}\n` });
    }
  }
  if (run.declarations !== undefined) {
    setEvidenceFile({ files, path: "model/declarations.json", content: `${JSON.stringify(run.declarations, undefined, 2)}\n` });
    setEvidenceFile({ files, path: "runtime-assets/class-capabilities.json", content: `${JSON.stringify(run.declarations.classCapabilities, undefined, 2)}\n` });
  }
  if (run.templateBehavior !== undefined) {
    setEvidenceFile({ files, path: "template-behavior/matrix.json", content: `${JSON.stringify(run.templateBehavior, undefined, 2)}
` });
  }
  if (run.modelFilePlan !== undefined) {
    setEvidenceFile({ files, path: "model-files/plans.json", content: `${JSON.stringify(run.modelFilePlan, undefined, 2)}
` });
  }
  {
    const observation = productionObservation({ run });
    if (observation !== undefined) {
      const isFullObservation = run.productionLane.observation !== undefined;
      setEvidenceFile({ files, path: isFullObservation ? "production-lane/observation.json" : "production-lane/partial-observation.json", content: `${JSON.stringify(observation, undefined, 2)}\n` });
      if ((observation.loadAttempts?.length ?? 0) > 0) {
        setEvidenceFile({ files, path: "production-lane/load-attempts.json", content: `${JSON.stringify(observation.loadAttempts, undefined, 2)}\n` });
      }
      const activeLoadAttempt = run.productionLane.partialObservation?.activeLoadAttempt;
      if (activeLoadAttempt !== undefined) {
        setEvidenceFile({ files, path: "production-lane/active-load-attempt.json", content: `${JSON.stringify(activeLoadAttempt, undefined, 2)}\n` });
      }
      if (observation.firstTurn !== undefined) {
        setEvidenceFile({ files, path: "production-lane/first-turn.json", content: `${JSON.stringify(observation.firstTurn, undefined, 2)}\n` });
      }
      if (observation.continuity !== undefined) {
        setEvidenceFile({ files, path: "production-lane/continuity.json", content: `${JSON.stringify(observation.continuity, undefined, 2)}\n` });
      }
      if (observation.toolResultContinuation !== undefined) {
        setEvidenceFile({ files, path: "production-lane/tool-result-continuation.json", content: `${JSON.stringify(observation.toolResultContinuation, undefined, 2)}\n` });
      }
      if (observation.reasoning !== undefined) {
        setEvidenceFile({ files, path: "production-lane/reasoning.json", content: `${JSON.stringify(observation.reasoning, undefined, 2)}\n` });
      }
      if (observation.multimodal !== undefined) {
        setEvidenceFile({ files, path: "production-lane/multimodal.json", content: `${JSON.stringify(observation.multimodal, undefined, 2)}\n` });
      }
    }
    if (run.productionLane.error !== undefined) {
      setEvidenceFile({ files, path: "production-lane/error.json", content: `${JSON.stringify(run.productionLane.error, undefined, 2)}\n` });
    }
  }
  if (run.persistenceRoundTrip !== undefined) {
    setEvidenceFile({ files, path: "continuity/persistence-roundtrip.json", content: `${JSON.stringify(run.persistenceRoundTrip, undefined, 2)}
` });
  }
  if (run.laneComparison !== undefined) {
    setEvidenceFile({ files, path: "lane-comparison/comparison.json", content: `${JSON.stringify(run.laneComparison, undefined, 2)}
` });
  }
  const toolProtocolProbes = run.loadAttempts
    .filter(attempt => attempt.toolProtocolProbe !== undefined)
    .map(attempt => ({
      attemptId: attempt.attemptId,
      candidateId: attempt.candidateId,
      probe: attempt.toolProtocolProbe,
    }));
  if (toolProtocolProbes.length > 0) {
    setEvidenceFile({ files, path: "protocol-probes/tool.json", content: `${JSON.stringify(toolProtocolProbes, undefined, 2)}
` });
  }
  if (run.activeLoadAttempt !== undefined) {
    setEvidenceFile({ files, path: "load-attempts/active.json", content: `${JSON.stringify(run.activeLoadAttempt, undefined, 2)}
` });
  }
  if (run.loadAttempts.length > 0) {
    setEvidenceFile({ files, path: "load-attempts/index.json", content: `${JSON.stringify(run.loadAttempts, undefined, 2)}
` });
    for (const attempt of run.loadAttempts) {
      setEvidenceFile({ files, path: `load-attempts/${safeFilePart({ value: attempt.attemptId })}.json`, content: `${JSON.stringify(attempt, undefined, 2)}
` });
    }
  }

  const packageFilePaths = [
    ...files.keys(),
    "PACKAGE.md",
    "package-assessment.json",
    "manifest.json",
  ];
  const packageAssessment = assessEvidencePackage({
    run,
    recovery,
    readiness,
    supportBoundaries,
    filePaths: packageFilePaths,
  });
  setEvidenceFile({ files, path: "SUMMARY.md", content: `${summary}
- Package self-assessment: ${packageAssessment.status}
` });
  setEvidenceFile({ files, path: "PACKAGE.md", content: renderEvidencePackageAssessmentMarkdown({ assessment: packageAssessment }) });
  setEvidenceFile({ files, path: "package-assessment.json", content: `${JSON.stringify(packageAssessment, undefined, 2)}
` });

  const manifestFiles = await createManifestFiles({ files });
  setEvidenceFile({ files, path: "manifest.json", content: `${JSON.stringify({
    schemaVersion: 1,
    runId: run.runId,
    generatedAt: run.completedAt ?? run.startedAt,
    files: manifestFiles,
  }, undefined, 2)}
` });

  return {
    files,
    fileName: `model-support-investigation-${safeFilePart({ value: run.modelId })}-${run.runId}.zip`,
    nativeBinaryBytes: native?.binaries.reduce((total, binary) => total + binary.byteLength, 0) ?? 0,
    nativeJsonCharacters: native?.json.length ?? 0,
  };
}

export async function createPartialModelSupportEvidence({ run, recovery, replayMetadata, nativeEvidence }: {
  run: ModelSupportInvestigationRun,
  recovery: ModelSupportInvestigationRecovery | undefined,
  replayMetadata?: InvestigationReplayMetadataSidecar[],
  nativeEvidence?: ProductionProviderNativeEvidenceSidecar,
}): Promise<{ blob: Blob, fileName: string }> {
  const { files, fileName } = await createPartialModelSupportEvidenceFiles({ run, recovery, replayMetadata, nativeEvidence, maximumNativeBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, maximumNativeJsonCharacters: PRODUCTION_PROVIDER_NATIVE_JSON_MAXIMUM_CHARACTERS });
  await verifyGeneratedEvidenceFiles({ archive: createEvidenceFilesReader({ files }) });
  const blob = await createEvidenceArchive({ files });
  await verifyGeneratedEvidenceArchive({ blob });
  return { blob, fileName };
}

function addEvidenceFiles({ source, destination, prefix }: {
  source: ReadonlyMap<string, Blob>,
  destination: Map<string, Blob>,
  prefix: string,
}): void {
  for (const [path, file] of [...source.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    setEvidenceFile({ files: destination, path: `${prefix}${path}`, content: file });
  }
}

async function createManifestFiles({ files }: { files: ReadonlyMap<string, Blob> }): Promise<Array<{
  path: string,
  byteLength: number,
  sha256: string,
}>> {
  const entries: Array<{ path: string, byteLength: number, sha256: string }> = [];
  // Own only one file body for hashing at a time, including native tensors.
  for (const [path, file] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (path === 'manifest.json') continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    entries.push({ path, byteLength: bytes.byteLength, sha256: await sha256Hex({ bytes }) });
  }
  return entries;
}

const batchEvidenceTargetSchema = z.object({
  index: z.number().int().positive(),
  target: z.string().min(1),
  status: z.enum(["pending", "running", "passed", "failed", "skipped", "interrupted"]),
  runId: z.string().min(1).optional(),
  error: z.string().optional(),
  evidencePath: z.string().min(1).optional(),
}).strict();

const batchEvidenceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: z.string().min(1),
  generatedAt: z.string().min(1),
  targetCount: z.number().int().positive(),
  packagedModelCount: z.number().int().nonnegative(),
  targets: z.array(batchEvidenceTargetSchema).min(1),
}).strict();

const batchEvidenceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: z.string().min(1),
  generatedAt: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict()),
}).strict();

const packagedRunIdentitySchema = z.object({
  modelId: z.string().min(1),
  runId: z.string().min(1),
}).passthrough();

// An aggregate tensor payload limit, not a bound on ZIP size, other metadata,
// or peak heap use (compression and verification may own additional copies).
// UTF-16 code units of native index JSON only, not UTF-8 bytes or peak heap use.

export async function createBatchModelSupportEvidence({
  batchId,
  items,
}: {
  batchId: string,
  items: readonly ModelSupportInvestigationBatchEvidenceItem[],
}): Promise<{ blob: Blob, fileName: string }> {
  if (batchId.length === 0) throw new Error("Model Support Investigation batch Evidence requires a batch ID");
  if (items.length === 0) throw new Error("Model Support Investigation batch Evidence requires at least one target");
  const replayBytes = items.reduce((total, item) => total + (item.replayMetadata ?? []).reduce((sum, sidecar) => sum + sidecar.blob.size, 0), 0);
  if (replayBytes > REPLAY_METADATA_BATCH_BYTES) throw new Error('Replay metadata batch export exceeds its byte budget');

  let nativeBinaryBytes = 0;
  let nativeJsonCharacters = 0;
  // Admit every retained sidecar before any model ZIP read or digest. Repeated
  // references count repeatedly because each model dossier has its own entries.
  for (const item of items) {
    if (item.nativeEvidence === undefined) continue;
    if (item.run === undefined) throw new Error('Native capture Evidence requires its investigation run');
    const measured = measureProductionProviderNativeEvidenceSidecar({ evidence: item.nativeEvidence });
    nativeBinaryBytes += measured.binaryBytes;
    nativeJsonCharacters += measured.jsonCharacters;
    if (nativeBinaryBytes > PRODUCTION_PROVIDER_NATIVE_BATCH_BINARY_BYTES || nativeJsonCharacters > PRODUCTION_PROVIDER_NATIVE_BATCH_JSON_CHARACTERS) {
      throw new Error('Native capture batch Evidence exceeds its retained data budget');
    }
  }

  const files = new Map<string, Blob>();
  let remainingNativeBinaryBytes = PRODUCTION_PROVIDER_NATIVE_BATCH_BINARY_BYTES;
  let remainingNativeJsonCharacters = PRODUCTION_PROVIDER_NATIVE_BATCH_JSON_CHARACTERS;
  const generatedAt = new Date().toISOString();
  const targets: Array<{
    index: number,
    target: string,
    status: ModelSupportInvestigationBatchEvidenceItem["status"],
    runId: string | undefined,
    error: string | undefined,
    evidencePath: string | undefined,
  }> = [];

  for (const [index, item] of items.entries()) {
    const directory = `models/${String(index + 1).padStart(3, "0")}-${safeFilePart({ value: item.target })}/`;
    if (item.nativeEvidence !== undefined && item.run === undefined) throw new Error('Native capture Evidence requires its investigation run');
    if (item.run !== undefined) {
      const { files: modelFiles, nativeBinaryBytes, nativeJsonCharacters } = await createPartialModelSupportEvidenceFiles({
        run: item.run,
        recovery: item.recovery,
        replayMetadata: item.replayMetadata,
        nativeEvidence: item.nativeEvidence,
        maximumNativeBinaryBytes: remainingNativeBinaryBytes,
        maximumNativeJsonCharacters: remainingNativeJsonCharacters,
      });
      remainingNativeBinaryBytes -= nativeBinaryBytes;
      remainingNativeJsonCharacters -= nativeJsonCharacters;
      // Verify each complete inner dossier before namespacing its entries. The
      // outer manifest alone cannot establish native binary/reference relations.
      await verifyGeneratedEvidenceFiles({ archive: createEvidenceFilesReader({ files: modelFiles }) });
      addEvidenceFiles({ source: modelFiles, destination: files, prefix: directory });
    }
    targets.push({
      index: index + 1,
      target: item.target,
      status: item.status,
      runId: item.run?.runId,
      error: item.error,
      evidencePath: item.run === undefined ? undefined : directory,
    });
  }

  setEvidenceFile({ files, path: "SUMMARY.md", content: `# Model Support Investigation batch Evidence\n\n- Batch ID: ${batchId}\n- Generated at: ${generatedAt}\n- Requested targets: ${items.length}\n- Packaged model dossiers: ${targets.filter(target => target.evidencePath !== undefined).length}\n\nEach requested target is indexed in batch.json. Targets with a captured run have a complete single-model Evidence package under models/.\n` });
  setEvidenceFile({ files, path: "batch.json", content: `${JSON.stringify({
    schemaVersion: 1,
    batchId,
    generatedAt,
    targetCount: items.length,
    packagedModelCount: targets.filter(target => target.evidencePath !== undefined).length,
    targets,
  }, undefined, 2)}\n` });

  const manifestFiles = await createManifestFiles({ files });
  setEvidenceFile({ files, path: "manifest.json", content: `${JSON.stringify({
    schemaVersion: 1,
    batchId,
    generatedAt,
    files: manifestFiles,
  }, undefined, 2)}\n` });

  const blob = await createEvidenceArchive({ files });
  const verification = await openEvidenceArchive({ blob });
  try {
    const batchFile = await verification.reader.read({ path: "batch.json" });
    if (batchFile === undefined) throw new Error("Batch Evidence archive is missing batch.json");
    const parsedBatch = batchEvidenceIndexSchema.parse(JSON.parse(await batchFile.text()) as unknown);
    const expectedPackagedModelCount = items.filter(item => item.run !== undefined).length;
    if (
      parsedBatch.batchId !== batchId
      || parsedBatch.targetCount !== items.length
      || parsedBatch.packagedModelCount !== expectedPackagedModelCount
      || parsedBatch.targets.length !== items.length
    ) {
      throw new Error("Batch Evidence archive target index is incomplete");
    }
    for (const [index, item] of items.entries()) {
      const indexed = parsedBatch.targets[index];
      if (
        indexed?.index !== index + 1
        || indexed.target !== item.target
        || indexed.status !== item.status
        || indexed.error !== item.error
      ) {
        throw new Error(`Batch Evidence target mismatch at index ${index + 1}`);
      }
      if (item.run !== undefined) {
        if (indexed.runId !== item.run.runId || typeof indexed.evidencePath !== "string") {
          throw new Error(`Batch Evidence is missing a dossier path for target: ${item.target}`);
        }
        const runFile = await verification.reader.read({ path: `${indexed.evidencePath}run.json` });
        if (runFile === undefined) throw new Error(`Batch Evidence is missing run.json for target: ${item.target}`);
        const packagedRun = packagedRunIdentitySchema.parse(JSON.parse(await runFile.text()) as unknown);
        if (packagedRun.modelId !== item.run.modelId || packagedRun.runId !== item.run.runId) {
          throw new Error(`Batch Evidence run identity mismatch for target: ${item.target}`);
        }
      } else if (indexed.runId !== undefined || indexed.evidencePath !== undefined) {
        throw new Error(`Batch Evidence unexpectedly packaged a dossier for target: ${item.target}`);
      }
    }

    const verificationManifestFile = await verification.reader.read({ path: "manifest.json" });
    if (verificationManifestFile === undefined) throw new Error("Batch Evidence archive is missing manifest.json");
    const verificationManifest = batchEvidenceManifestSchema.parse(JSON.parse(await verificationManifestFile.text()) as unknown);
    if (verificationManifest.batchId !== batchId) throw new Error("Batch Evidence archive manifest batch ID does not match");
    const archivePaths = verification.reader.paths
      .filter(path => path !== "manifest.json")
      .sort((left, right) => left.localeCompare(right));
    const manifestPaths = verificationManifest.files.map(entry => entry.path).sort((left, right) => left.localeCompare(right));
    if (manifestPaths.length !== archivePaths.length || manifestPaths.some((path, index) => path !== archivePaths[index])) {
      throw new Error("Batch Evidence archive manifest paths do not match archive files");
    }
    for (const entry of verificationManifest.files) {
      const file = await verification.reader.read({ path: entry.path });
      if (file === undefined) throw new Error(`Batch Evidence archive is missing manifest path: ${entry.path}`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== entry.byteLength || await sha256Hex({ bytes }) !== entry.sha256) {
        throw new Error(`Batch Evidence archive integrity mismatch: ${entry.path}`);
      }
    }

    return {
      blob,
      fileName: `model-support-investigation-batch-${safeFilePart({ value: batchId })}.zip`,
    };
  } finally {
    await verification.close();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
