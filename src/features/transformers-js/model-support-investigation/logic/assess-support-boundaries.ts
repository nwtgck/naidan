import type {
  ModelSupportInvestigationRun,
  ModelSupportInvestigationSupportBoundaryAssessment,
} from "@/features/transformers-js/model-support-investigation/types";

function runtimeIntegrityPassed({ run }: { run: ModelSupportInvestigationRun }): boolean {
  return run.runtimeAssets !== undefined
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.mjsOrigin
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.wasmOrigin
    && run.runtimeAssets.control.inputValue === run.runtimeAssets.control.outputValue;
}

export function assessSupportBoundaries({ run }: {
  run: ModelSupportInvestigationRun,
}): ModelSupportInvestigationSupportBoundaryAssessment[] {
  const assessments: ModelSupportInvestigationSupportBoundaryAssessment[] = [];

  if (run.runtimeAssets !== undefined && !runtimeIntegrityPassed({ run })) {
    assessments.push({
      assessmentId: "runtime-integrity-failed",
      boundary: "environment-runtime",
      basis: "exact-observation",
      summary: "The same-origin runtime or fixed ONNX control did not satisfy the runtime integrity gate.",
      evidencePaths: ["runtime-assets/preflight.json", "runtime-assets/backend-controls.json"],
      contradictoryEvidencePaths: [],
    });
  }

  if (run.declarations?.modelType !== undefined
    && run.declarations.classCapabilities.every(item => item.supports !== true)) {
    assessments.push({
      assessmentId: "public-auto-class-unsupported",
      boundary: "transformers-js-capability",
      basis: "exact-observation",
      summary: `No inspected public generative Auto class reported support for model type ${run.declarations.modelType}.`,
      evidencePaths: ["repository/declarations.json", "runtime-assets/class-capabilities.json"],
      contradictoryEvidencePaths: [],
    });
  }

  if (run.modelFilePlan !== undefined
    && run.modelFilePlan.candidates.length > 0
    && run.modelFilePlan.candidates.every(candidate => candidate.eligibility === "ineligible")
    && run.modelFilePlan.candidates.some(candidate => (
      candidate.missingRequiredFileCount > 0 || candidate.zeroByteRequiredFileCount > 0
    ))) {
    assessments.push({
      assessmentId: "required-repository-artifacts-unavailable",
      boundary: "repository-artifact",
      basis: "exact-observation",
      summary: "Every fixed quantized candidate is missing at least one required repository artifact or has a zero-byte required artifact.",
      evidencePaths: ["repository/repository.json", "model-files/plans.json"],
      contradictoryEvidencePaths: [],
    });
  }

  const passedReferenceAttempt = run.loadAttempts.find(attempt => attempt.status === "passed");
  const toolProtocolProbe = passedReferenceAttempt?.toolProtocolProbe;
  if (toolProtocolProbe !== undefined) {
    switch (toolProtocolProbe.status) {
    case "failed":
      assessments.push({
        assessmentId: "tool-protocol-probe-failed-after-reference-load",
        boundary: "unresolved",
        basis: "exact-observation",
        summary: "The fixed Reference candidate loaded and completed plain-text generation, but the bounded template-derived tool protocol probe failed. The available evidence does not isolate a narrower maintenance boundary.",
        evidencePaths: ["load-attempts/index.json", "protocol-probes/tool.json", "errors.json"],
        contradictoryEvidencePaths: [],
      });
      break;
    case "observed":
      if (!toolProtocolProbe.exactMatch) {
        assessments.push({
          assessmentId: "tool-protocol-forced-sequence-ended-early",
          boundary: "unresolved",
          basis: "exact-observation",
          summary: `The bounded template-derived tool protocol probe ended or diverged at token index ${toolProtocolProbe.firstMismatchIndex ?? "the length boundary"}. This may include normal generation stopping behavior, so no narrower root cause is asserted.`,
          evidencePaths: ["load-attempts/index.json", "protocol-probes/tool.json"],
          contradictoryEvidencePaths: [],
        });
      }
      if (toolProtocolProbe.exactMatch) {
        switch (toolProtocolProbe.parserObservation.status) {
        case "observed":
          if (!toolProtocolProbe.parserObservation.recognized) {
            assessments.push({
              assessmentId: "production-tool-parser-did-not-recognize-template-protocol",
              boundary: "naidan-production-adapter",
              basis: "differential-observation",
              summary: `The real model emitted the complete template-derived assistant tool-call sequence, but the existing ${toolProtocolProbe.parserObservation.strategy} production parser recognized no tool call.`,
              evidencePaths: ["load-attempts/index.json", "protocol-probes/tool.json"],
              contradictoryEvidencePaths: [],
            });
          }
          break;
        case "failed":
          assessments.push({
            assessmentId: "production-tool-parser-observation-failed",
            boundary: "unresolved",
            basis: "exact-observation",
            summary: `The real model emitted the complete template-derived assistant tool-call sequence, but production parser observation failed: ${toolProtocolProbe.parserObservation.error.message}`,
            evidencePaths: ["load-attempts/index.json", "protocol-probes/tool.json", "errors.json"],
            contradictoryEvidencePaths: [],
          });
          break;
        case "unavailable":
          break;
        default: {
          const exhaustive: never = toolProtocolProbe.parserObservation;
          throw new Error(`Unhandled tool parser observation status: ${String(exhaustive)}`);
        }
        }
      }
      break;
    case "unavailable":
      break;
    default: {
      const _ex: never = toolProtocolProbe;
      throw new Error(`Unhandled tool protocol probe status: ${String(_ex)}`);
    }
    }
  }
  if (passedReferenceAttempt !== undefined && run.productionLane.status === "failed") {
    assessments.push({
      assessmentId: "production-lane-failed-after-reference-success",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
      summary: "The fixed Reference candidate completed real-model generation, but the fresh Naidan Production Lane failed. The evidence isolates the divergence to the production routing or adapter boundary without asserting a narrower root cause.",
      evidencePaths: ["load-attempts/index.json", "production-lane/error.json"],
      contradictoryEvidencePaths: [],
    });
  }

  if (passedReferenceAttempt !== undefined
    && run.productionLane.status === "passed"
    && run.laneComparison !== undefined
    && !run.laneComparison.exactInputMatch) {
    assessments.push({
      assessmentId: "production-input-diverged-from-reference",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
      summary: `The Reference and Naidan Production lanes first diverged at input token index ${run.laneComparison.firstInputMismatchIndex ?? "after the shorter prefix"}.`,
      evidencePaths: ["load-attempts/index.json", "production-lane/observation.json", "lane-comparison/comparison.json"],
      contradictoryEvidencePaths: [],
    });
  }

  if (run.productionLane.status === "passed" && run.productionLane.observation !== undefined) {
    const continuity = run.productionLane.observation.continuity;
    if (continuity !== undefined) {
      switch (continuity.status) {
      case "failed":
        assessments.push({
          assessmentId: "production-continuity-failed-after-first-turn",
          boundary: "naidan-production-adapter",
          basis: "differential-observation",
          summary: "The first Naidan Production turn completed, but the deterministic second turn failed in the same fresh production Worker. The evidence does not assert a narrower root cause.",
          evidencePaths: ["production-lane/observation.json", "production-lane/continuity.json"],
          contradictoryEvidencePaths: [],
        });
        break;
      case "passed":
        switch (continuity.prefixComparison.mode) {
        case "full-input-prefix":
          if (continuity.prefixComparison.exactPrefixMatch === false) {
            assessments.push({
              assessmentId: "production-continuity-prefix-diverged",
              boundary: "naidan-production-adapter",
              basis: "differential-observation",
              summary: `The second Production input first diverged from the exact first-turn generated sequence at token index ${continuity.prefixComparison.firstMismatchIndex ?? "after the shorter prefix"}.`,
              evidencePaths: ["production-lane/continuity.json"],
              contradictoryEvidencePaths: [],
            });
          }
          break;
        case "cache-suffix":
        case "not-applicable-encoder-decoder":
          break;
        default: {
          const _ex: never = continuity.prefixComparison.mode;
          throw new Error(`Unhandled prefix comparison mode: ${_ex}`);
        }
        }
        break;
      default: {
        const _ex: never = continuity;
        throw new Error(`Unhandled continuity status: ${String(_ex)}`);
      }
      }
    }
  }

  if (run.productionLane.status === "passed" && run.productionLane.observation !== undefined) {
    const toolResultContinuation = run.productionLane.observation.toolResultContinuation;
    switch (toolResultContinuation.status) {
    case "passed":
      if (!toolResultContinuation.inputTokenExactMatch) {
        assessments.push({
          assessmentId: "production-tool-result-input-diverged-from-template-roundtrip",
          boundary: "naidan-production-adapter",
          basis: "differential-observation",
          summary: `The Production tool-result continuation input first diverged from the parser-to-template token sequence at index ${toolResultContinuation.firstInputMismatchIndex ?? "after the shorter sequence"}.`,
          evidencePaths: ["protocol-probes/tool.json", "production-lane/tool-result-continuation.json"],
          contradictoryEvidencePaths: [],
        });
      }
      break;
    case "failed":
      assessments.push({
        assessmentId: "production-tool-result-continuation-failed",
        boundary: "unresolved",
        basis: "exact-observation",
        summary: `The Reference parser and chat template produced a deterministic tool-result continuation, but the ${toolResultContinuation.strategy} Production turn failed: ${toolResultContinuation.error.message}. The available evidence does not distinguish Production input construction, strategy behavior, or model runtime failure.`,
        evidencePaths: ["protocol-probes/tool.json", "production-lane/tool-result-continuation.json", "errors.json"],
        contradictoryEvidencePaths: [],
      });
      break;
    case "not-run":
      break;
    default: {
      const _ex: never = toolResultContinuation;
      throw new Error(`Unhandled Production tool-result continuation status: ${String(_ex)}`);
    }
    }
  }

  if (runtimeIntegrityPassed({ run })
    && run.loadAttempts.length > 0
    && run.loadAttempts.every(attempt => attempt.loadedModel === undefined)) {
    assessments.push({
      assessmentId: "real-model-attempts-failed-after-runtime-control",
      boundary: "unresolved",
      basis: "differential-observation",
      summary: "The fixed runtime control passed, but every eligible real-model attempt failed. The available public evidence does not isolate a narrower maintenance boundary.",
      evidencePaths: ["runtime-assets/backend-controls.json", "load-attempts/index.json"],
      contradictoryEvidencePaths: [],
    });
  }

  return assessments;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
