import type {
  ModelSupportInvestigationRun,
  ModelSupportInvestigationSupportBoundaryAssessment,
} from "@/features/transformers-js/model-support-investigation/types";

function runtimeIntegrityPassed({ run }: { run: ModelSupportInvestigationRun }): boolean {
  return run.runtimeAssets !== undefined
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.mjsOrigin
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.wasmOrigin
    && run.runtimeAssets.control.status === "passed"
    && run.runtimeAssets.control.inputValue === run.runtimeAssets.control.outputValue;
}

const REQUIRED_RUNTIME_PREFLIGHT_STAGES = new Set([
  "origin-validation",
  "environment",
  "module-import",
  "wasm-fetch",
  "wasm-validation",
  "wasm-control",
] as const);

function runtimeIntegrityFailure({ run }: { run: ModelSupportInvestigationRun }): {
  evidencePath: string,
  boundary: ModelSupportInvestigationSupportBoundaryAssessment["boundary"],
  summary: string,
} | undefined {
  if (run.runtimeAssets !== undefined) {
    if (runtimeIntegrityPassed({ run })) return undefined;
    return {
      evidencePath: "runtime-assets/preflight.json",
      boundary: "environment-runtime",
      summary: "The fixed ONNX WASM control failed after the runtime assets were resolved and loaded.",
    };
  }
  if (run.runtimeAssetsPartial === undefined) return undefined;
  const failedStages = run.runtimeAssetsPartial.stageObservations
    .filter(observation => (
      observation.status === "failed"
        && REQUIRED_RUNTIME_PREFLIGHT_STAGES.has(observation.stage as typeof REQUIRED_RUNTIME_PREFLIGHT_STAGES extends Set<infer T> ? T : never)
    ))
    .map(observation => observation.stage);
  if (failedStages.length === 0) return undefined;

  const uniqueFailedStages = new Set(failedStages);
  if (uniqueFailedStages.size === 1 && uniqueFailedStages.has("origin-validation")) {
    return {
      evidencePath: "runtime-assets/preflight-partial.json",
      boundary: "naidan-production-adapter",
      summary: "The Hosted runtime asset URLs failed Naidan's same-origin configuration check.",
    };
  }
  if ([...uniqueFailedStages].every(stage => stage === "environment" || stage === "wasm-control")) {
    return {
      evidencePath: "runtime-assets/preflight-partial.json",
      boundary: "environment-runtime",
      summary: "Browser environment inspection or the fixed ONNX WASM backend control failed.",
    };
  }
  return {
    evidencePath: "runtime-assets/preflight-partial.json",
    boundary: "cross-boundary",
    summary: `Runtime preflight failed across a boundary that cannot be narrowed from this observation alone (${[...uniqueFailedStages].join(", ")}).`,
  };
}

export function assessSupportBoundaries({ run }: {
  run: ModelSupportInvestigationRun,
}): ModelSupportInvestigationSupportBoundaryAssessment[] {
  const assessments: ModelSupportInvestigationSupportBoundaryAssessment[] = [];
  const productionObservation = run.productionLane.observation ?? run.productionLane.partialObservation;
  const productionObservationPath = run.productionLane.observation === undefined
    ? "production-lane/partial-observation.json"
    : "production-lane/observation.json";

  const failedPrerequisiteSteps = ([
    { stepId: "repository-information", label: "repository information" },
    { stepId: "existing-model-data", label: "existing model data" },
    { stepId: "model-declarations", label: "model declarations" },
    { stepId: "template-behavior", label: "template/tokenizer behavior" },
    { stepId: "model-file-plan", label: "model file planning" },
  ] as const).filter(({ stepId }) => (run.stepErrors?.[stepId]?.length ?? 0) > 0);
  if (failedPrerequisiteSteps.length > 0) {
    assessments.push({
      assessmentId: "investigation-prerequisite-step-failed",
      boundary: "unresolved",
      basis: "exact-observation",
      summary: `Structured investigation errors were recorded for ${failedPrerequisiteSteps.map(({ label }) => label).join(", ")}. These failures are preserved without assigning them to a narrower model-support boundary.`,
      evidencePaths: ["errors.json"],
      contradictoryEvidencePaths: [],
    });
  }

  const runtimeFailure = runtimeIntegrityFailure({ run });
  if (runtimeFailure !== undefined) {
    assessments.push({
      assessmentId: "runtime-integrity-failed",
      boundary: runtimeFailure.boundary,
      basis: "exact-observation",
      summary: runtimeFailure.summary,
      evidencePaths: [
        runtimeFailure.evidencePath,
        ...((run.runtimeAssets?.assetIdentity ?? run.runtimeAssetsPartial?.assetIdentity) === undefined
          ? []
          : ["runtime-assets/asset-identity.json"]),
        ...(run.stepErrors?.["runtime-assets"]?.length ? ["errors.json"] : []),
        ...(run.runtimeAssets?.control !== undefined || run.runtimeAssetsPartial?.control !== undefined
          ? ["runtime-assets/backend-controls.json"]
          : []),
      ],
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
  const failedReferenceInputAttempt = run.loadAttempts.find(attempt => (
    attempt.loadedModel !== undefined
    && attempt.status !== "passed"
    && attempt.inputStrategyAttempts.length > 0
    && attempt.inputStrategyAttempts.every(strategyAttempt => strategyAttempt.status === "failed")
  ));
  if (failedReferenceInputAttempt !== undefined
    && productionObservation?.firstTurn?.status === "passed") {
    assessments.push({
      assessmentId: "reference-input-strategies-failed-production-succeeded",
      boundary: "unresolved",
      basis: "differential-observation",
      summary: `The ${failedReferenceInputAttempt.candidateId} model loaded in the Reference Lane, but all ${failedReferenceInputAttempt.inputStrategyAttempts.length} deterministic Reference input strategies failed while the same candidate completed the Naidan Production Lane. This contradicts a model-load/runtime failure and isolates the observed failure to the Reference probe/input-adapter path without asserting a model-specific support defect.`,
      evidencePaths: ["load-attempts/index.json"],
      contradictoryEvidencePaths: [productionObservationPath],
    });
  }

  if (passedReferenceAttempt !== undefined && run.productionLane.status === "failed") {
    assessments.push({
      assessmentId: "production-lane-failed-after-reference-success",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
      summary: "The fixed Reference candidate completed real-model generation, but the fresh Naidan Production Lane failed. The evidence isolates the divergence to the production routing or adapter boundary without asserting a narrower root cause.",
      evidencePaths: ["load-attempts/index.json", ...(productionObservation?.loadAttempts?.length ? ["production-lane/load-attempts.json"] : []), "production-lane/error.json"],
      contradictoryEvidencePaths: [],
    });
  }

  if (passedReferenceAttempt !== undefined
    && productionObservation?.firstTurn?.status === "failed") {
    assessments.push({
      assessmentId: "production-first-turn-failed-after-reference-success",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
      summary: `The fixed Reference candidate completed real-model generation, but the fresh Naidan Production first turn failed: ${productionObservation.firstTurn.error.message}. Independent Production probes continued where possible, so this assessment is limited to the first-turn production adapter path.`,
      evidencePaths: ["load-attempts/index.json", "production-lane/first-turn.json", productionObservationPath],
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

  if (run.persistenceRoundTrip !== undefined) {
    const persistence = run.persistenceRoundTrip;
    switch (persistence.status) {
    case 'observed':
      if (!persistence.exactModelVisibleMatch) {
        assessments.push({
          assessmentId: 'persistence-roundtrip-altered-model-visible-history',
          boundary: 'naidan-production-adapter',
          basis: 'exact-observation',
          summary: `Naidan's production persistence mapper/DTO/JSON roundtrip changed model-visible synthetic tool history at message index ${persistence.firstMismatchIndex ?? 'after the shorter transcript'}.`,
          evidencePaths: ['continuity/persistence-roundtrip.json'],
          contradictoryEvidencePaths: [],
        });
      }
      break;
    case 'failed':
      assessments.push({
        assessmentId: 'persistence-roundtrip-failed',
        boundary: 'cross-boundary',
        basis: 'exact-observation',
        summary: `The synthetic Naidan persistence mapper/DTO/JSON roundtrip failed: ${persistence.error.name}: ${persistence.error.message}. The observation does not narrow the failure beyond the serialization/runtime boundary.`,
        evidencePaths: ['continuity/persistence-roundtrip.json', 'errors.json'],
        contradictoryEvidencePaths: [],
      });
      break;
    default: {
      const _ex: never = persistence;
      throw new Error(`Unhandled persistence roundtrip status: ${String(_ex)}`);
    }
    }
  }

  if (productionObservation !== undefined) {
    const continuity = productionObservation.continuity;
    if (continuity !== undefined) {
      switch (continuity.status) {
      case "failed":
        assessments.push({
          assessmentId: "production-continuity-failed-after-first-turn",
          boundary: "naidan-production-adapter",
          basis: "differential-observation",
          summary: "The first Naidan Production turn completed, but the deterministic second turn failed in the same fresh production Worker. The evidence does not assert a narrower root cause.",
          evidencePaths: [productionObservationPath, "production-lane/continuity.json"],
          contradictoryEvidencePaths: [],
        });
        break;
      case "passed": {
        const cacheDecision = continuity.secondTurn.cacheDecision;
        const cacheDecisionContradictsHandoff = (() => {
          switch (cacheDecision.status) {
          case "reused":
            return !continuity.secondTurn.pastKeyValuesProvided;
          case "not-reused":
          case "not-applicable":
            return continuity.secondTurn.pastKeyValuesProvided;
          case "unavailable":
            return false;
          default: {
            const _ex: never = cacheDecision;
            return _ex;
          }
          }
        })();
        if (cacheDecisionContradictsHandoff) {
          assessments.push({
            assessmentId: "production-cache-decision-contradicts-model-handoff",
            boundary: "naidan-production-adapter",
            basis: "exact-observation",
            summary: `The Production strategy reported cache decision ${cacheDecision.status}, but model.generate ${continuity.secondTurn.pastKeyValuesProvided ? "received" : "did not receive"} past_key_values.`,
            evidencePaths: ["production-lane/continuity.json"],
            contradictoryEvidencePaths: [],
          });
        }
        switch (continuity.prefixComparison.mode) {
        case "full-input-prefix":
          if (continuity.prefixComparison.exactPrefixMatch === true
            && continuity.prefixComparison.comparisonInputSource === "reconstructed-full-conversation"
            && continuity.secondTurn.cacheDecision.status === "not-reused"
            && continuity.secondTurn.cacheDecision.reason === "qwen3_5-message-count-mismatch") {
            assessments.push({
              assessmentId: "production-exact-prefix-cache-reuse-blocked-by-message-count",
              boundary: "naidan-production-adapter",
              basis: "exact-observation",
              summary: "The reconstructed Qwen3.5 Production conversation preserved the exact prior model-token prefix, but the existing message-count gate rejected KV reuse and model.generate received no past_key_values.",
              evidencePaths: ["production-lane/continuity.json"],
              contradictoryEvidencePaths: [],
            });
          }
          if (continuity.prefixComparison.exactPrefixMatch === false) {
            const cacheDecision = continuity.secondTurn.cacheDecision;
            const mismatchContext = continuity.prefixComparison.firstMismatchContext;
            const contextSummary = mismatchContext === undefined
              ? ""
              : ` Decoded mismatch context: expected ${JSON.stringify(mismatchContext.expectedText)}, actual ${JSON.stringify(mismatchContext.actualText)}.`;
            const cacheWasReused = (() => {
              switch (cacheDecision.status) {
              case "reused":
                return true;
              case "not-reused":
              case "not-applicable":
              case "unavailable":
                return false;
              default: {
                const _ex: never = cacheDecision;
                return _ex;
              }
              }
            })();
            assessments.push({
              assessmentId: cacheWasReused
                ? "production-cache-reused-with-prefix-divergence"
                : "production-continuity-prefix-diverged",
              boundary: "naidan-production-adapter",
              basis: "differential-observation",
              summary: cacheWasReused
                ? `Naidan Production reused KV cache even though the reconstructed full conversation first diverged from the exact first-turn generated sequence at token index ${continuity.prefixComparison.firstMismatchIndex ?? "after the shorter prefix"}.${contextSummary}`
                : `The reconstructed second Production conversation first diverged from the exact first-turn generated sequence at token index ${continuity.prefixComparison.firstMismatchIndex ?? "after the shorter prefix"}.${contextSummary}`,
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
      }
      case "not-run":
        break;
      default: {
        const _ex: never = continuity;
        throw new Error(`Unhandled continuity status: ${String(_ex)}`);
      }
      }
    }
  }

  if (productionObservation?.toolResultContinuation !== undefined) {
    const toolResultContinuation = productionObservation.toolResultContinuation;
    switch (toolResultContinuation.status) {
    case "passed":
      if (!toolResultContinuation.inputTokenExactMatch) {
        assessments.push({
          assessmentId: "production-tool-result-input-diverged-from-template-roundtrip",
          boundary: "naidan-production-adapter",
          basis: "differential-observation",
          summary: `The Production tool-result continuation ${toolResultContinuation.comparisonInputSource ?? "actual-model-input"} input first diverged from the parser-to-template token sequence at index ${toolResultContinuation.firstInputMismatchIndex ?? "after the shorter sequence"}.`,
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
        summary: toolResultContinuation.strategy === undefined
          ? `The Reference parser and chat template produced a deterministic tool-result continuation, but Production failed before a tool-capable strategy was selected: ${toolResultContinuation.error.message}. The available evidence does not distinguish strategy selection from other Production adapter failures.`
          : `The Reference parser and chat template produced a deterministic tool-result continuation, but the ${toolResultContinuation.strategy} Production turn failed: ${toolResultContinuation.error.message}. The available evidence does not distinguish Production input construction, strategy behavior, or model runtime failure.`,
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
    && run.loadAttempts.every(attempt => attempt.loadedModel === undefined)
    && run.activeLoadAttempt?.loadedModel === undefined) {
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
