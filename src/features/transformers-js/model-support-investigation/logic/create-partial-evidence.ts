import JSZip from "jszip";
import type {
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
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

function toolResultContinuationError({ run }: { run: ModelSupportInvestigationRun }): { name: string, message: string } | undefined {
  const observation = run.productionLane.observation?.toolResultContinuation;
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

function reasoningError({ run }: { run: ModelSupportInvestigationRun }): { name: string, message: string } | undefined {
  const reasoning = run.productionLane.observation?.reasoning;
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

function multimodalError({ run }: { run: ModelSupportInvestigationRun }): { name: string, message: string } | undefined {
  const multimodal = run.productionLane.observation?.multimodal;
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

function continuityError({ run }: { run: ModelSupportInvestigationRun }): { name: string, message: string } | undefined {
  const continuity = run.productionLane.observation?.continuity;
  if (continuity === undefined) return undefined;
  switch (continuity.status) {
  case "passed":
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
  return run.loadAttempts.flatMap((attempt) => {
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
  const loadingSummary = run.loadAttempts.length === 0
    ? "Model loading and generation stages marked not-run were not investigated by this build."
    : `${run.loadAttempts.length} real-model load ${run.loadAttempts.length === 1 ? "attempt was" : "attempts were"} recorded.`;
  const productionSummary = (() => {
    switch (run.productionLane.status) {
    case "passed":
      return `Production Lane passed with ${run.productionLane.observation?.route.strategy ?? "an unknown"} strategy.`;
    case "failed":
      return "Production Lane failed after Reference Lane evidence was preserved.";
    case "not-run":
      return "Production Lane was not run.";
    default: {
      const _ex: never = run.productionLane.status;
      throw new Error(`Unhandled Production Lane status: ${_ex}`);
    }
    }
  })();
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
    loadAttemptErrors: run.loadAttempts
      .filter(attempt => attempt.error !== undefined)
      .map(attempt => ({
        attemptId: attempt.attemptId,
        candidateId: attempt.candidateId,
        failureStage: attempt.failureStage,
        error: attempt.error,
      })),
    postAttemptCacheErrors: postAttemptCacheErrorRecords({ run }),
    toolProtocolProbeErrors: toolProtocolProbeErrorRecords({ run }),
    productionLaneError: run.productionLane.error,
    productionContinuityError: continuityError({ run }),
    productionToolResultContinuationError: toolResultContinuationError({ run }),
    productionReasoningError: reasoningError({ run }),
    productionMultimodalError: multimodalError({ run }),
    interruptionError: recovery?.interruption?.error,
  }, undefined, 2)}\n`);
  const investigationEvents = recovery?.events.map(event => ({
    eventKind: "investigation-event" as const,
    ...event,
  })) ?? [];
  const attemptEvents = run.loadAttempts.flatMap(attempt => attempt.events.map(event => ({
    eventKind: "load-attempt-event" as const,
    attemptId: attempt.attemptId,
    candidateId: attempt.candidateId,
    ...event,
  })));
  const allEvents = [...investigationEvents, ...attemptEvents];
  zip.file("events.jsonl", allEvents.map(event => JSON.stringify(event)).join("\n") + (allEvents.length > 0 ? "\n" : ""));
  if (run.runtimeAssets !== undefined) {
    zip.file("runtime-assets/preflight.json", `${JSON.stringify(run.runtimeAssets, undefined, 2)}\n`);
    zip.file("runtime-assets/environment.json", `${JSON.stringify(run.runtimeAssets.environment, undefined, 2)}\n`);
    zip.file("runtime-assets/backend-controls.json", `${JSON.stringify({
      wasm: run.runtimeAssets.control,
      webgpu: run.runtimeAssets.webGpuControl,
    }, undefined, 2)}\n`);
  }
  if (run.repository !== undefined) {
    zip.file("repository/repository.json", `${JSON.stringify(run.repository, undefined, 2)}\n`);
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
  switch (run.productionLane.status) {
  case "passed":
    if (run.productionLane.observation !== undefined) {
      zip.file(
        "production-lane/observation.json",
        `${JSON.stringify(run.productionLane.observation, undefined, 2)}
`,
      );
      if (run.productionLane.observation.continuity !== undefined) {
        zip.file(
          "production-lane/continuity.json",
          `${JSON.stringify(run.productionLane.observation.continuity, undefined, 2)}
`,
        );
      }
      zip.file(
        "production-lane/tool-result-continuation.json",
        `${JSON.stringify(run.productionLane.observation.toolResultContinuation, undefined, 2)}
`,
      );
      zip.file(
        "production-lane/reasoning.json",
        `${JSON.stringify(run.productionLane.observation.reasoning, undefined, 2)}
`,
      );
      zip.file(
        "production-lane/multimodal.json",
        `${JSON.stringify(run.productionLane.observation.multimodal, undefined, 2)}
`,
      );
    }
    break;
  case "failed":
    if (run.productionLane.error !== undefined) {
      zip.file(
        "production-lane/error.json",
        `${JSON.stringify(run.productionLane.error, undefined, 2)}
`,
      );
    }
    break;
  case "not-run":
    break;
  default: {
    const _ex: never = run.productionLane.status;
    throw new Error(`Unhandled Production Lane status: ${_ex}`);
  }
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
