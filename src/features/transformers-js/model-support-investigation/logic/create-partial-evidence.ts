import JSZip from "jszip";
import type {
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
import { verifyGeneratedEvidenceArchive } from "@/features/transformers-js/model-support-investigation/logic/verify-evidence-archive";
import {
  assessEvidencePackage,
  renderEvidencePackageAssessmentMarkdown,
} from "@/features/transformers-js/model-support-investigation/logic/assess-evidence-package";
import { createDownloadVerificationEvidenceLaneFiles } from '@/features/transformers-js/download-verification/evidence/create-download-verification-evidence';

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

export async function createPartialModelSupportEvidence({ run, recovery }: {
  run: ModelSupportInvestigationRun,
  recovery: ModelSupportInvestigationRecovery | undefined,
}): Promise<{ blob: Blob, fileName: string }> {
  const zip = new JSZip();
  const readiness = evaluateEvidenceReadiness({ run });
  const supportBoundaries = assessSupportBoundaries({ run });
  const loadingSummary = run.activeLoadAttempt !== undefined
    ? `${run.loadAttempts.length} completed real-model load ${run.loadAttempts.length === 1 ? "attempt was" : "attempts were"} recorded; ${run.activeLoadAttempt.candidateId} is checkpointed while ${run.activeLoadAttempt.currentStage} is still running.`
    : run.loadAttempts.length === 0
      ? "Model loading and generation stages marked not-run were not investigated by this build."
      : `${run.loadAttempts.length} real-model load ${run.loadAttempts.length === 1 ? "attempt was" : "attempts were"} recorded.`;
  const productionSummary = (() => {
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
- Status: ${run.status}
- Model: ${run.modelId}
- Run ID: ${run.runId}
- Started: ${run.startedAt}
- Completed: ${run.completedAt}
- Evidence readiness: ${readiness.overall}
- Recovery status: ${recovery?.status ?? "not-recorded"}
- Recovery journal: ${recovery === undefined
    ? "not-recorded"
    : `retained ${recovery.events.length} of ${recovery.totalEventCount} events; ${recovery.droppedEventCount} dropped by bounded telemetry policy`}
- Reference model-load telemetry: ${referenceLoadTelemetry}
- Model-load telemetry semantics: ${modelLoadTelemetrySemantics}
- Production model-load telemetry: ${productionLoadTelemetry}
- Production runtime-load total: ${productionRuntimeLoadDurationMs === undefined ? "not-recorded" : `${Math.round(productionRuntimeLoadDurationMs)}ms`}
- Production tokenizer/processor preparation: ${productionRuntimePreparationDurationMs === undefined ? "not-recorded" : `${Math.round(productionRuntimePreparationDurationMs)}ms`}

This is a partial evidence package. ${loadingSummary} ${productionSummary} Repository or cache artifacts are included only when their steps completed.
`;
  zip.file("SUMMARY.md", summary);
  zip.file("READINESS.md", renderEvidenceReadinessMarkdown({ report: readiness }));
  zip.file("readiness.json", `${JSON.stringify(readiness, undefined, 2)}\n`);
  zip.file("questions.json", `${JSON.stringify(readiness.domains.flatMap(domainReadiness => (
    domainReadiness.questions.map(question => ({ domainId: domainReadiness.domainId, ...question }))
  )), undefined, 2)}\n`);
  zip.file("support-boundaries.json", `${JSON.stringify(supportBoundaries, undefined, 2)}\n`);
  zip.file("run.json", `${JSON.stringify(run, undefined, 2)}\n`);
  if (recovery !== undefined) {
    zip.file("recovery/checkpoint.json", `${JSON.stringify(recovery, undefined, 2)}\n`);
  }
  zip.file("errors.json", `${JSON.stringify({
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
  }, undefined, 2)}\n`);
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
  zip.file("events.jsonl", allEvents.map(event => JSON.stringify(event)).join("\n") + (allEvents.length > 0 ? "\n" : ""));
  if (run.runtimeAssets !== undefined) {
    zip.file("runtime-assets/preflight.json", `${JSON.stringify(run.runtimeAssets, undefined, 2)}\n`);
    if (run.runtimeAssets.assetIdentity !== undefined) {
      zip.file("runtime-assets/asset-identity.json", `${JSON.stringify(run.runtimeAssets.assetIdentity, undefined, 2)}\n`);
    }
    zip.file("runtime-assets/environment.json", `${JSON.stringify(run.runtimeAssets.environment, undefined, 2)}\n`);
    zip.file("runtime-assets/backend-controls.json", `${JSON.stringify({
      wasm: run.runtimeAssets.control,
      webgpu: run.runtimeAssets.webGpuControl,
    }, undefined, 2)}\n`);
  } else if (run.runtimeAssetsPartial !== undefined) {
    zip.file("runtime-assets/preflight-partial.json", `${JSON.stringify(run.runtimeAssetsPartial, undefined, 2)}\n`);
    if (run.runtimeAssetsPartial.assetIdentity !== undefined) {
      zip.file("runtime-assets/asset-identity.json", `${JSON.stringify(run.runtimeAssetsPartial.assetIdentity, undefined, 2)}\n`);
    }
    if (run.runtimeAssetsPartial.environment !== undefined) {
      zip.file("runtime-assets/environment.json", `${JSON.stringify(run.runtimeAssetsPartial.environment, undefined, 2)}\n`);
    }
    if (run.runtimeAssetsPartial.control !== undefined || run.runtimeAssetsPartial.webGpuControl !== undefined) {
      zip.file("runtime-assets/backend-controls.json", `${JSON.stringify({
        wasm: run.runtimeAssetsPartial.control,
        webgpu: run.runtimeAssetsPartial.webGpuControl,
      }, undefined, 2)}\n`);
    }
  }
  if (run.repository !== undefined) {
    zip.file("repository/repository.json", `${JSON.stringify(run.repository, undefined, 2)}\n`);
  }
  if (run.downloadEvidence !== undefined) {
    const { files } = createDownloadVerificationEvidenceLaneFiles({ evidence: run.downloadEvidence });
    for (const [path, content] of Object.entries(files)) {
      zip.file(path, content);
    }
  }
  if (run.cache !== undefined) {
    zip.file("cache/inventory.json", `${JSON.stringify(run.cache, undefined, 2)}\n`);
    if (run.cache.provenance !== undefined) {
      zip.file("cache/provenance.json", `${JSON.stringify(run.cache.provenance, undefined, 2)}\n`);
    }
  }
  if (run.declarations !== undefined) {
    zip.file("repository/declarations.json", `${JSON.stringify(run.declarations, undefined, 2)}\n`);
    zip.file(
      "runtime-assets/class-capabilities.json",
      `${JSON.stringify(run.declarations.classCapabilities, undefined, 2)}\n`,
    );
  }
  if (run.templateBehavior !== undefined) {
    zip.file(
      "template-behavior/matrix.json",
      `${JSON.stringify(run.templateBehavior, undefined, 2)}
`,
    );
  }
  if (run.modelFilePlan !== undefined) {
    zip.file(
      "model-files/plans.json",
      `${JSON.stringify(run.modelFilePlan, undefined, 2)}
`,
    );
  }
  {
    const observation = productionObservation({ run });
    if (observation !== undefined) {
      const isFullObservation = run.productionLane.observation !== undefined;
      zip.file(
        isFullObservation ? "production-lane/observation.json" : "production-lane/partial-observation.json",
        `${JSON.stringify(observation, undefined, 2)}\n`,
      );
      if ((observation.loadAttempts?.length ?? 0) > 0) {
        zip.file("production-lane/load-attempts.json", `${JSON.stringify(observation.loadAttempts, undefined, 2)}\n`);
      }
      const activeLoadAttempt = run.productionLane.partialObservation?.activeLoadAttempt;
      if (activeLoadAttempt !== undefined) {
        zip.file(
          "production-lane/active-load-attempt.json",
          `${JSON.stringify(activeLoadAttempt, undefined, 2)}\n`,
        );
      }
      if (observation.firstTurn !== undefined) {
        zip.file("production-lane/first-turn.json", `${JSON.stringify(observation.firstTurn, undefined, 2)}\n`);
      }
      if (observation.continuity !== undefined) {
        zip.file("production-lane/continuity.json", `${JSON.stringify(observation.continuity, undefined, 2)}\n`);
      }
      if (observation.toolResultContinuation !== undefined) {
        zip.file("production-lane/tool-result-continuation.json", `${JSON.stringify(observation.toolResultContinuation, undefined, 2)}\n`);
      }
      if (observation.reasoning !== undefined) {
        zip.file("production-lane/reasoning.json", `${JSON.stringify(observation.reasoning, undefined, 2)}\n`);
      }
      if (observation.multimodal !== undefined) {
        zip.file("production-lane/multimodal.json", `${JSON.stringify(observation.multimodal, undefined, 2)}\n`);
      }
    }
    if (run.productionLane.error !== undefined) {
      zip.file("production-lane/error.json", `${JSON.stringify(run.productionLane.error, undefined, 2)}\n`);
    }
  }
  if (run.persistenceRoundTrip !== undefined) {
    zip.file(
      "continuity/persistence-roundtrip.json",
      `${JSON.stringify(run.persistenceRoundTrip, undefined, 2)}
`,
    );
  }
  if (run.laneComparison !== undefined) {
    zip.file(
      "lane-comparison/comparison.json",
      `${JSON.stringify(run.laneComparison, undefined, 2)}
`,
    );
  }
  const toolProtocolProbes = run.loadAttempts
    .filter(attempt => attempt.toolProtocolProbe !== undefined)
    .map(attempt => ({
      attemptId: attempt.attemptId,
      candidateId: attempt.candidateId,
      probe: attempt.toolProtocolProbe,
    }));
  if (toolProtocolProbes.length > 0) {
    zip.file(
      "protocol-probes/tool.json",
      `${JSON.stringify(toolProtocolProbes, undefined, 2)}
`,
    );
  }
  if (run.activeLoadAttempt !== undefined) {
    zip.file("load-attempts/active.json", `${JSON.stringify(run.activeLoadAttempt, undefined, 2)}
`);
  }
  if (run.loadAttempts.length > 0) {
    zip.file("load-attempts/index.json", `${JSON.stringify(run.loadAttempts, undefined, 2)}
`);
    for (const attempt of run.loadAttempts) {
      zip.file(
        `load-attempts/${safeFilePart({ value: attempt.attemptId })}.json`,
        `${JSON.stringify(attempt, undefined, 2)}
`,
      );
    }
  }

  const packageFilePaths = [
    ...Object.entries(zip.files)
      .filter(([, file]) => !file.dir)
      .map(([path]) => path),
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
  zip.file("SUMMARY.md", `${summary}
- Package self-assessment: ${packageAssessment.status}
`);
  zip.file("PACKAGE.md", renderEvidencePackageAssessmentMarkdown({ assessment: packageAssessment }));
  zip.file("package-assessment.json", `${JSON.stringify(packageAssessment, undefined, 2)}
`);

  const manifestFiles = await Promise.all(Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(async ([path, file]) => {
      const bytes = await file.async("uint8array");
      return { path, byteLength: bytes.byteLength, sha256: await sha256Hex({ bytes }) };
    }));
  zip.file("manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    runId: run.runId,
    generatedAt: run.completedAt ?? run.startedAt,
    files: manifestFiles,
  }, undefined, 2)}
`);

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  await verifyGeneratedEvidenceArchive({ blob });
  return {
    blob,
    fileName: `model-support-investigation-${safeFilePart({ value: run.modelId })}-${run.runId}.zip`,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
