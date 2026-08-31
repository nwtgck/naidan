import type {
  ModelSupportInvestigationEvidenceDomainReadiness,
  ModelSupportInvestigationEvidenceReadinessReport,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationToolParserObservation,
  ModelSupportInvestigationToolResultTemplateRoundTrip,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  TransformersJsProductionInvestigationActiveCandidateLoadAttempt,
  TransformersJsProductionInvestigationReasoningEffortObservation,
  TransformersJsProductionInvestigationToolResultContinuationObservation,
} from "@/features/transformers-js/types";

function activeProductionLoadAttemptSummary({
  attempt,
}: {
  attempt: TransformersJsProductionInvestigationActiveCandidateLoadAttempt,
}): string {
  return `${attempt.candidate.device}/${attempt.candidate.dtype}=running`;
}

function questionStatus({
  status,
}: {
  status: ModelSupportInvestigationEvidenceDomainReadiness["status"],
}): ModelSupportInvestigationEvidenceDomainReadiness["questions"][number]["status"] {
  switch (status) {
  case "implementation-ready":
  case "partial":
  case "insufficient":
    return "answered";
  case "not-observed":
    return "unobserved";
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled evidence readiness status: ${_ex}`);
  }
  }
}


function reasoningEffortSummary({ attempt }: {
  attempt: TransformersJsProductionInvestigationReasoningEffortObservation,
}): string {
  switch (attempt.status) {
  case 'passed':
    return `${attempt.effort}=passed(${attempt.inputTokenCount} input tokens)`;
  case 'failed':
    return `${attempt.effort}=failed(${attempt.error.name}: ${attempt.error.message})`;
  default: {
    const _ex: never = attempt;
    return _ex;
  }
  }
}

function domain({
  domainId,
  status,
  summary,
  questionId,
  answer,
  evidencePaths,
}: Omit<ModelSupportInvestigationEvidenceDomainReadiness, "questions"> & {
  questionId: string,
  answer: string,
  evidencePaths: string[],
}): ModelSupportInvestigationEvidenceDomainReadiness {
  return {
    domainId,
    status,
    summary,
    questions: [{
      questionId,
      status: questionStatus({ status }),
      answer,
      evidencePaths,
    }],
  };
}

function toolParserReadinessSummary({ observation }: {
  observation: ModelSupportInvestigationToolParserObservation,
}): string {
  switch (observation.status) {
  case "observed":
    return observation.recognized
      ? `The existing ${observation.strategy} production parser recognized ${observation.toolCalls.length} tool call(s).`
      : `The existing ${observation.strategy} production parser was executed but recognized no tool call.`;
  case "unavailable":
    return `Production parser observation was unavailable: ${observation.reason}`;
  case "failed":
    return `Production parser observation failed: ${observation.error.message}`;
  default: {
    const exhaustive: never = observation;
    return exhaustive;
  }
  }
}

function toolParserReadinessAnswer({ observation }: {
  observation: ModelSupportInvestigationToolParserObservation,
}): string {
  switch (observation.status) {
  case "observed":
    return `${observation.strategy} / ${observation.parserKind}; recognized=${String(observation.recognized)}; toolCalls=${observation.toolCalls.length}`;
  case "unavailable":
    return `${observation.strategy}: unavailable (${observation.reason})`;
  case "failed":
    return `${observation.strategy ?? 'strategy-unresolved'}: ${observation.error.name}: ${observation.error.message}`;
  default: {
    const exhaustive: never = observation;
    return exhaustive;
  }
  }
}

function toolResultRoundTripSummary({ observation }: {
  observation: ModelSupportInvestigationToolResultTemplateRoundTrip | undefined,
}): string {
  if (observation === undefined) return "Parser-to-template tool-result roundtrip was not run.";
  switch (observation.status) {
  case "observed":
    return `The recognized tool call and fixed tool result were re-rendered into ${observation.inputTokenIds.length} continuation token(s).`;
  case "unavailable":
    return `Parser-to-template tool-result roundtrip was unavailable: ${observation.reason}`;
  case "failed":
    return `Parser-to-template tool-result roundtrip failed: ${observation.error.message}`;
  default: {
    const exhaustive: never = observation;
    return exhaustive;
  }
  }
}

function toolResultRoundTripAnswer({ observation }: {
  observation: ModelSupportInvestigationToolResultTemplateRoundTrip | undefined,
}): string {
  if (observation === undefined) return "not run";
  switch (observation.status) {
  case "observed":
    return `rendered ${observation.inputTokenIds.length} continuation tokens from ${observation.parserStrategy} parser output`;
  case "unavailable":
    return `unavailable (${observation.reason})`;
  case "failed":
    return `${observation.error.name}: ${observation.error.message}`;
  default: {
    const exhaustive: never = observation;
    return exhaustive;
  }
  }
}

function productionToolResultContinuationSummary({ observation }: {
  observation: TransformersJsProductionInvestigationToolResultContinuationObservation | undefined,
}): string {
  if (observation === undefined) return "Production tool-result continuation was not observed.";
  switch (observation.status) {
  case "passed": {
    const cacheDecision = observation.turn.cacheDecision ?? {
      status: "unavailable" as const,
      reason: "not observed",
    };
    const cacheProvided = observation.turn.pastKeyValuesProvided === true;
    const comparisonInputSource = observation.comparisonInputSource ?? "actual-model-input";
    const cacheSummary = `cache=${cacheDecision.status} (${cacheDecision.reason}); past_key_values=${cacheProvided ? 'provided' : 'not provided'}`;
    return observation.inputTokenExactMatch
      ? `The ${observation.strategy} Production strategy used the exact ${observation.expectedInputTokenIds.length}-token parser-to-template continuation input via ${comparisonInputSource} and generated ${observation.turn.generatedTokenIds.length} token(s); ${cacheSummary}. Tool-loop termination and actual cross-turn tool KV reuse remain unobserved.`
      : `The ${observation.strategy} Production strategy generated ${observation.turn.generatedTokenIds.length} token(s), but its ${comparisonInputSource} continuation input first differed from the parser-to-template tokens at index ${observation.firstInputMismatchIndex ?? "the length boundary"}; ${cacheSummary}. Tool-loop termination and actual cross-turn tool KV reuse remain unobserved.`;
  }
  case "failed":
    return observation.strategy === undefined
      ? `Production tool-result continuation failed before a strategy was selected: ${observation.error.message}`
      : `Production tool-result continuation failed in the ${observation.strategy} strategy: ${observation.error.message}`;
  case "not-run":
    return `Production tool-result continuation was not run: ${observation.reason}`;
  default: {
    const _ex: never = observation;
    return _ex;
  }
  }
}

function productionToolResultContinuationAnswer({ observation }: {
  observation: TransformersJsProductionInvestigationToolResultContinuationObservation | undefined,
}): string {
  if (observation === undefined) return "not observed";
  switch (observation.status) {
  case "passed": {
    const cacheDecision = observation.turn.cacheDecision ?? {
      status: "unavailable" as const,
      reason: "not observed",
    };
    const comparisonInputSource = observation.comparisonInputSource ?? "actual-model-input";
    return `${observation.strategy}; generated=${observation.turn.generatedTokenIds.length}; comparison=${comparisonInputSource}; inputExact=${String(observation.inputTokenExactMatch)}; firstMismatch=${observation.firstInputMismatchIndex ?? "none"}; cache=${cacheDecision.status} (${cacheDecision.reason}); past_key_values=${observation.turn.pastKeyValuesProvided === true ? 'provided' : 'not provided'}`;
  }
  case "failed":
    return `${observation.strategy ?? 'strategy-unresolved'}: ${observation.error.name}: ${observation.error.message}`;
  case "not-run":
    return `not run (${observation.reason})`;
  default: {
    const _ex: never = observation;
    return _ex;
  }
  }
}

export function evaluateEvidenceReadiness({ run }: {
  run: ModelSupportInvestigationRun,
}): ModelSupportInvestigationEvidenceReadinessReport {
  const productionPartialObservation = run.productionLane.partialObservation;
  const productionObservation = run.productionLane.observation ?? productionPartialObservation;
  const productionObservationPath = run.productionLane.observation !== undefined
    ? "production-lane/observation.json"
    : run.productionLane.partialObservation !== undefined
      ? "production-lane/partial-observation.json"
      : undefined;
  const runtimeEvidencePath = run.runtimeAssets !== undefined
    ? "runtime-assets/preflight.json"
    : run.runtimeAssetsPartial !== undefined
      ? "runtime-assets/preflight-partial.json"
      : undefined;
  const runtimeAssetIdentity = run.runtimeAssets?.assetIdentity ?? run.runtimeAssetsPartial?.assetIdentity;
  const runtimeAssetIdentityPath = runtimeAssetIdentity === undefined ? undefined : "runtime-assets/asset-identity.json";
  const runtimeAssetIdentityVerified = runtimeAssetIdentity !== undefined
    && runtimeAssetIdentity.observedManifestBuildId === runtimeAssetIdentity.manifestBuildId
    && runtimeAssetIdentity.mjs.observedByteLength === runtimeAssetIdentity.mjs.expectedByteLength
    && runtimeAssetIdentity.mjs.observedSha256 === runtimeAssetIdentity.mjs.expectedSha256
    && runtimeAssetIdentity.wasm.observedByteLength === runtimeAssetIdentity.wasm.expectedByteLength
    && runtimeAssetIdentity.wasm.observedSha256 === runtimeAssetIdentity.wasm.expectedSha256
    && runtimeAssetIdentity.wasm.observedPhysicalByteLength === runtimeAssetIdentity.wasm.expectedPhysicalByteLength
    && runtimeAssetIdentity.wasm.observedPhysicalSha256 === runtimeAssetIdentity.wasm.expectedPhysicalSha256;
  const runtimeReady = run.runtimeAssets !== undefined
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.mjsOrigin
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.wasmOrigin
    && runtimeAssetIdentityVerified
    && run.runtimeAssets.control.status === "passed"
    && run.runtimeAssets.control.inputValue === run.runtimeAssets.control.outputValue;
  const runtimeThreadingSummary = (() => {
    const threading = (run.runtimeAssets ?? run.runtimeAssetsPartial)?.threading;
    if (threading === undefined) return "Wasm thread configuration was not observed";
    return `Wasm threads requested=${threading.requestedThreads ?? "unknown"}, effective=${threading.effectiveThreads ?? "unknown"} (${threading.effectiveThreadsBasis}); proxy=${threading.proxy ?? "unknown"}; pthread lifecycle=${threading.childWorkerLifecycle}`;
  })();
  const stepErrorCount = ({ stepId }: { stepId: keyof NonNullable<ModelSupportInvestigationRun["stepErrors"]> }): number => (
    run.stepErrors?.[stepId]?.length ?? 0
  );
  const runtimeStepErrorCount = stepErrorCount({ stepId: "runtime-assets" });
  const repositoryStepErrorCount = stepErrorCount({ stepId: "repository-information" });
  const cacheStepErrorCount = stepErrorCount({ stepId: "existing-model-data" });
  const declarationsStepErrorCount = stepErrorCount({ stepId: "model-declarations" });
  const templateStepErrorCount = stepErrorCount({ stepId: "template-behavior" });
  const modelFilePlanStepErrorCount = stepErrorCount({ stepId: "model-file-plan" });
  const revisionReady = run.repository !== undefined && /^[0-9a-f]{40}$/i.test(run.repository.resolvedRevision);
  const supportedClassCount = run.declarations?.classCapabilities.filter(item => item.supports === true).length ?? 0;
  const generationTemplate = run.templateBehavior?.cases.find(item => (
    item.caseId === "user-generation" && item.status === "passed" && (item.inputIds?.length ?? 0) > 0
  ));
  const generationInputIds = generationTemplate?.inputIds;
  const toolTemplateProvenance = run.templateBehavior?.toolTemplateProvenance;
  const toolTemplateObserved = toolTemplateProvenance?.status === 'observed';
  const eligibleCandidates = run.modelFilePlan?.candidates.filter(item => item.eligibility === "eligible") ?? [];
  const completedLoadedAttempt = run.loadAttempts.find(item => item.loadedModel !== undefined);
  const loadedAttempt = completedLoadedAttempt ?? (run.activeLoadAttempt?.loadedModel === undefined ? undefined : run.activeLoadAttempt);
  const loadedAttemptEvidencePath = completedLoadedAttempt === undefined ? "load-attempts/active.json" : "load-attempts/index.json";
  const passedAttempt = run.loadAttempts.find(item => item.status === "passed");
  const postAttemptCache = [...run.loadAttempts]
    .reverse()
    .find(attempt => attempt.postAttemptCache !== undefined)
    ?.postAttemptCache;
  const postAttemptInventory = (() => {
    if (postAttemptCache === undefined) return undefined;
    switch (postAttemptCache.status) {
    case "observed":
      return postAttemptCache.inventory;
    case "failed":
      return undefined;
    default: {
      const _ex: never = postAttemptCache;
      throw new Error(`Unhandled post-attempt cache observation status: ${String(_ex)}`);
    }
    }
  })();
  const cacheObserved = run.cache !== undefined || postAttemptInventory !== undefined;
  const cacheProvenance = run.cache?.provenance;
  const cacheProvenanceSummary = (() => {
    if (cacheProvenance === undefined) return "bounded cache sampling was not run";
    const transportObserved = cacheProvenance.files.filter(file => file.transport?.status === "observed").length;
    const transportFallback = cacheProvenance.files.filter(file => file.transport?.status === "fallback-metadata").length;
    const transportUnobserved = cacheProvenance.files.filter(file => file.transport === undefined).length;
    const transportSummary = `lightweight transport observed=${transportObserved}, metadata-fallback=${transportFallback}, legacy/unobserved=${transportUnobserved}`;
    switch (cacheProvenance.status) {
    case "bounded-samples-matched":
      return `bounded samples matched against the resolved revision for ${cacheProvenance.files.length} cache files; whole-file provenance was not independently verified; ${transportSummary}`;
    case "mismatched":
      return `bounded sample mismatch detected in ${cacheProvenance.files.filter(file => file.status === "mismatched").length} cache files; ${transportSummary}`;
    case "partial":
      return `bounded cache sampling was incomplete; ${transportSummary}`;
    case "not-observed":
      return "no resolved- or requested-revision cache file was eligible for bounded sampling";
    default: {
      const _ex: never = cacheProvenance.status;
      return _ex;
    }
    }
  })();
  const cacheReadinessStatus = (() => {
    if (!cacheObserved) return cacheStepErrorCount > 0 ? "insufficient" as const : "not-observed" as const;
    if (cacheStepErrorCount > 0) return "insufficient" as const;
    if (cacheProvenance === undefined) return "partial" as const;
    switch (cacheProvenance.status) {
    case "mismatched":
      return "insufficient" as const;
    case "bounded-samples-matched":
    case "partial":
    case "not-observed":
      return "partial" as const;
    default: {
      const _ex: never = cacheProvenance.status;
      return _ex;
    }
    }
  })();
  const cacheAnswer = (() => {
    const before = run.cache === undefined
      ? "Initial inventory was not observed"
      : `Initial inventory: files=${run.cache.fileCount}, complete markers=${run.cache.completionMarkerCount}`;
    switch (postAttemptCache?.status) {
    case "observed": {
      const coverage = postAttemptCache.requiredFileCoverage;
      return `${before}; post-attempt inventory: files=${postAttemptCache.inventory.fileCount}, complete markers=${postAttemptCache.inventory.completionMarkerCount}, incomplete=${postAttemptCache.inventory.incompleteFileCount}; candidate required files: expected=${coverage.expectedPaths.length}, complete=${coverage.completePaths.length}, size-mismatch=${coverage.sizeMismatchPaths.length}, incomplete=${coverage.incompletePaths.length}, missing=${coverage.missingPaths.length}; ${cacheProvenanceSummary}`;
    }
    case "failed":
      return `${before}; post-attempt inventory failed: ${postAttemptCache.error.message}; ${cacheProvenanceSummary}`;
    case undefined:
      return `${before}; post-attempt inventory was not observed; ${cacheProvenanceSummary}`;
    default: {
      const _ex: never = postAttemptCache;
      return _ex;
    }
    }
  })();
  const toolProtocolProbe = passedAttempt?.toolProtocolProbe;
  const productionToolResultContinuation = productionObservation?.toolResultContinuation;
  const productionReasoning = productionObservation?.reasoning;
  const runtimeGenerationReady = passedAttempt !== undefined
    && passedAttempt.loadedModel !== undefined
    && passedAttempt.inputTensors.length > 0
    && passedAttempt.generatedTokenIds.length > 0;
  const sessionFileCorrelations = loadedAttempt?.loadedModel?.sessionFileCorrelations ?? [];
  const exactSessionFileCorrelationCount = sessionFileCorrelations.filter(item => item.status === "exact").length;
  const unresolvedSessionFileCorrelationCount = sessionFileCorrelations.length - exactSessionFileCorrelationCount;
  const sessionFilesReady = loadedAttempt !== undefined
    && sessionFileCorrelations.length > 0
    && unresolvedSessionFileCorrelationCount === 0;
  const naturalReady = runtimeGenerationReady && passedAttempt.naturalGeneration?.status === "observed";
  const productionFirstTurn = productionObservation?.firstTurn;
  const productionPlainTextTokenCount = (() => {
    if (productionFirstTurn === undefined) return 0;
    switch (productionFirstTurn.status) {
    case "passed":
      return productionFirstTurn.turn.generatedTokenIds.length;
    case "failed":
      return 0;
    default: {
      const _ex: never = productionFirstTurn;
      return _ex;
    }
    }
  })();
  const productionPlainTextReady = productionPlainTextTokenCount > 0;
  const productionLoadAttemptsEvidencePaths = [
    ...((productionObservation?.loadAttempts?.length ?? 0) > 0 ? ["production-lane/load-attempts.json"] : []),
    ...(productionPartialObservation?.activeLoadAttempt === undefined ? [] : ["production-lane/active-load-attempt.json"]),
  ];
  const productionReadiness = (() => {
    switch (run.productionLane.status) {
    case "passed": {
      const observation = run.productionLane.observation;
      const comparison = run.laneComparison;
      if (observation === undefined) {
        return {
          status: "partial" as const,
          summary: "The Naidan Production Lane completed without a serializable observation.",
          answer: "Production evidence incomplete",
          evidencePaths: [],
        };
      }
      switch (observation.firstTurn.status) {
      case "failed":
        return {
          status: "partial" as const,
          summary: "Production routing and model loading were observed, but the first Production generation failed; independent Production probes continued where possible.",
          answer: `${observation.route.autoClass} / ${observation.route.processor} / ${observation.route.strategy}; first turn failed: ${observation.firstTurn.error.name}: ${observation.firstTurn.error.message}`,
          evidencePaths: ["production-lane/observation.json", "production-lane/first-turn.json", ...productionLoadAttemptsEvidencePaths],
        };
      case "passed":
        break;
      default: {
        const _ex: never = observation.firstTurn;
        return _ex;
      }
      }
      if (comparison === undefined) {
        return {
          status: "partial" as const,
          summary: "The Naidan Production Lane generated successfully, but a passed Reference generation comparison was unavailable.",
          answer: `${observation.route.autoClass} / ${observation.route.processor} / ${observation.route.strategy}; Production generation observed without Reference comparison`,
          evidencePaths: ["production-lane/observation.json", "production-lane/first-turn.json", ...productionLoadAttemptsEvidencePaths],
        };
      }
      const inputComparison = comparison.exactInputMatch
        ? "match exactly"
        : `first differ at ${comparison.firstInputMismatchIndex ?? "the shorter-prefix boundary"}`;
      return {
        status: "implementation-ready" as const,
        summary: "Naidan Production routing and the first Reference/Production input-token difference were observed.",
        answer: `${observation.route.autoClass} / ${observation.route.processor} / ${observation.route.strategy}; input tokens ${inputComparison}`,
        evidencePaths: ["production-lane/observation.json", "production-lane/first-turn.json", "lane-comparison/comparison.json", ...productionLoadAttemptsEvidencePaths],
      };
    }
    case "running": {
      if (productionObservation === undefined) {
        return {
          status: "not-observed" as const,
          summary: "The Naidan Production Lane is running, but no structured Production checkpoint has been received yet.",
          answer: "Running; structured checkpoint pending",
          evidencePaths: [],
        };
      }
      const route = productionObservation.route;
      if (route === undefined) {
        const attempts = productionObservation.loadAttempts ?? [];
        const activeAttempt = productionPartialObservation?.activeLoadAttempt;
        const attemptSummaryParts = [
          ...attempts.map(attempt => `${attempt.candidate.device}/${attempt.candidate.dtype}=${attempt.status}`),
          ...(activeAttempt === undefined
            ? []
            : [activeProductionLoadAttemptSummary({ attempt: activeAttempt })]),
        ];
        const attemptSummary = attemptSummaryParts.length === 0
          ? "candidate load route pending"
          : attemptSummaryParts.join("; ");
        return {
          status: "partial" as const,
          summary: "The Naidan Production Lane is still loading a model; completed attempts and any active candidate telemetry from the latest structured checkpoint were preserved.",
          answer: attemptSummary,
          evidencePaths: ["production-lane/partial-observation.json", ...productionLoadAttemptsEvidencePaths],
        };
      }
      return {
        status: "partial" as const,
        summary: "The Naidan Production Lane is still running; model routing and completed Production probes from the latest structured checkpoint were preserved.",
        answer: `${route.autoClass} / ${route.processor} / ${route.strategy}; checkpointed while running`,
        evidencePaths: ["production-lane/partial-observation.json", ...productionLoadAttemptsEvidencePaths],
      };
    }
    case "failed":
      return {
        status: "partial" as const,
        summary: productionObservation === undefined
          ? "Reference evidence was preserved, but the Naidan Production Lane failed."
          : "The Naidan Production Lane failed after preserving completed Production probes from the latest structured checkpoint.",
        answer: run.productionLane.error?.message ?? "Production Lane failed",
        evidencePaths: productionObservation === undefined
          ? ["production-lane/error.json"]
          : ["production-lane/partial-observation.json", "production-lane/error.json", ...productionLoadAttemptsEvidencePaths],
      };
    case "not-run":
      return {
        status: "not-observed" as const,
        summary: "Naidan Production routing was not observed.",
        answer: "Unobserved",
        evidencePaths: [],
      };
    default: {
      const _ex: never = run.productionLane.status;
      throw new Error(`Unhandled Production Lane status: ${_ex}`);
    }
    }
  })();

  const continuityReadiness = (() => {
    if (productionObservation === undefined) {
      return {
        status: "not-observed" as const,
        summary: "Two-turn Production continuity and KV cache behavior were not observed.",
        answer: "Unobserved",
        evidencePaths: [] as string[],
      };
    }
    const continuity = productionObservation.continuity;
    if (continuity === undefined) {
      return {
        status: "not-observed" as const,
        summary: "The Production observation predates two-turn continuity evidence.",
        answer: "Unobserved",
        evidencePaths: [] as string[],
      };
    }
    switch (continuity.status) {
    case "passed": {
      const prefix = continuity.prefixComparison;
      const cacheDecision = continuity.secondTurn.cacheDecision;
      const pastKeyValuesProvided = continuity.secondTurn.pastKeyValuesProvided;
      const cacheDecisionConsistent = (() => {
        switch (cacheDecision.status) {
        case "reused":
          return pastKeyValuesProvided;
        case "not-reused":
        case "not-applicable":
          return !pastKeyValuesProvided;
        case "unavailable":
          return true;
        default: {
          const _ex: never = cacheDecision;
          return _ex;
        }
        }
      })();
      const cacheAnswer = `${cacheDecision.status}: ${cacheDecision.reason}; model.generate past_key_values ${pastKeyValuesProvided ? "provided" : "not provided"}`;
      const prefixAnswer = (() => {
        switch (prefix.mode) {
        case "full-input-prefix": {
          const source = (() => {
            switch (prefix.comparisonInputSource) {
            case "reconstructed-full-conversation":
              return "reconstructed full conversation";
            case "actual-model-input":
              return "actual model input";
            case "not-applicable":
              return "an unavailable comparison input";
            default: {
              const _ex: never = prefix.comparisonInputSource;
              return _ex;
            }
            }
          })();
          if (prefix.exactPrefixMatch) return `${source} preserved the exact prior model-token prefix`;
          const context = prefix.firstMismatchContext;
          return context === undefined
            ? `${source} first differed at ${prefix.firstMismatchIndex ?? "the shorter-prefix boundary"}`
            : `${source} first differed at ${prefix.firstMismatchIndex}; expected ${JSON.stringify(context.expectedText)}, actual ${JSON.stringify(context.actualText)}`;
        }
        case "cache-suffix":
          return "second input was a cache suffix and a reconstructed full conversation input was unavailable, so exact full-prefix equality could not be established";
        case "not-applicable-encoder-decoder":
          return "encoder-decoder prefix comparison was not applicable";
        default: {
          const _ex: never = prefix.mode;
          throw new Error(`Unhandled prefix comparison mode: ${_ex}`);
        }
        }
      })();
      const hasImplementationReadyPrefixEvidence = (() => {
        switch (prefix.mode) {
        case "full-input-prefix":
          switch (prefix.comparisonInputSource) {
          case "reconstructed-full-conversation":
            return true;
          case "actual-model-input":
          case "not-applicable":
            return false;
          default: {
            const _ex: never = prefix.comparisonInputSource;
            return _ex;
          }
          }
        case "cache-suffix":
        case "not-applicable-encoder-decoder":
          return false;
        default: {
          const _ex: never = prefix.mode;
          return _ex;
        }
        }
      })();
      const persistence = run.persistenceRoundTrip;
      const persistenceAssessment = (() => {
        if (persistence === undefined) {
          return {
            status: 'unobserved' as const,
            answer: 'Naidan persistence mapper/DTO/JSON roundtrip was not observed',
            evidencePaths: [] as string[],
          };
        }
        switch (persistence.status) {
        case 'failed':
          return {
            status: 'failed' as const,
            answer: `Naidan persistence mapper/DTO/JSON roundtrip failed: ${persistence.error.name}: ${persistence.error.message}`,
            evidencePaths: ['continuity/persistence-roundtrip.json', 'errors.json'],
          };
        case 'observed': {
          if (!persistence.exactModelVisibleMatch) {
            return {
              status: 'mismatched' as const,
              answer: `Naidan persistence mapper/DTO/JSON roundtrip changed model-visible synthetic history at message index ${persistence.firstMismatchIndex ?? 'after the shorter transcript'}`,
              evidencePaths: ['continuity/persistence-roundtrip.json'],
            };
          }
          switch (persistence.modelVisibleProjectionMethod) {
          case undefined:
            return {
              status: 'matched-serialization-only' as const,
              answer: `Naidan persistence mapper/DTO/JSON roundtrip preserved ${persistence.originalMessages.length} synthetic messages exactly, but the Evidence predates the shared Production history projection; physical storage-provider I/O was not exercised`,
              evidencePaths: ['continuity/persistence-roundtrip.json'],
            };
          case 'build-chat-generation-messages-v1':
            return {
              status: 'matched-production-projection' as const,
              answer: `Naidan persistence mapper/DTO/JSON roundtrip preserved ${persistence.originalMessages.length} model-visible synthetic messages exactly through the same Production history projection used for LM requests; physical storage-provider I/O was not exercised`,
              evidencePaths: ['continuity/persistence-roundtrip.json'],
            };
          default: {
            const _ex: never = persistence.modelVisibleProjectionMethod;
            return _ex;
          }
          }
        }
        default: {
          const _ex: never = persistence;
          return _ex;
        }
        }
      })();
      const cacheDecisionObserved = (() => {
        switch (cacheDecision.status) {
        case "reused":
        case "not-reused":
        case "not-applicable":
          return true;
        case "unavailable":
          return false;
        default: {
          const _ex: never = cacheDecision;
          return _ex;
        }
        }
      })();
      const status = (() => {
        if (!cacheDecisionConsistent) return "insufficient" as const;
        switch (persistenceAssessment.status) {
        case 'failed':
        case 'mismatched':
          return "insufficient" as const;
        case 'matched-production-projection':
          return hasImplementationReadyPrefixEvidence && cacheDecisionObserved
            ? "implementation-ready" as const
            : "partial" as const;
        case 'matched-serialization-only':
        case 'unobserved':
          return "partial" as const;
        default: {
          const _ex: never = persistenceAssessment;
          return _ex;
        }
        }
      })();
      const summary = (() => {
        if (!cacheDecisionConsistent) {
          return "The Production cache decision and the actual past_key_values handoff contradict each other, so continuity evidence is internally inconsistent.";
        }
        switch (persistenceAssessment.status) {
        case 'failed':
          return "The synthetic Naidan persistence serialization roundtrip failed, so continuity evidence is incomplete.";
        case 'mismatched':
          return "Naidan persistence serialization changed model-visible synthetic history, so the continuity path is not safe for exact KV-prefix reuse.";
        case 'matched-production-projection':
          switch (status) {
          case 'implementation-ready':
            return "The deterministic Production continuation recorded cache handoff and exact reconstructed token-prefix evidence, and the persistence roundtrip preserved synthetic tool history through the same Production history projection used for LM requests.";
          case 'partial':
            return "The persistence roundtrip matched through the Production history projection, but the exact reconstructed prefix or cache decision is not fully observed.";
          case 'insufficient':
            return "The persistence and Production history projection matched, but continuity evidence remains internally inconsistent.";
          default: {
            const _ex: never = status;
            return _ex;
          }
          }
        case 'matched-serialization-only':
          return "The persistence serialization roundtrip matched, but the Evidence does not prove that the restored history passed through the same Production LM-message projection, so continuity readiness remains partial.";
        case 'unobserved':
          return "A deterministic Production continuation recorded partial cache/token-prefix evidence, but the persistence serialization contract was not observed.";
        default: {
          const _ex: never = persistenceAssessment;
          return _ex;
        }
        }
      })();
      return {
        status,
        summary,
        answer: `${cacheAnswer}; ${prefixAnswer}; ${persistenceAssessment.answer}`,
        evidencePaths: ["production-lane/continuity.json", ...persistenceAssessment.evidencePaths],
      };
    }
    case "failed":
      return {
        status: "partial" as const,
        summary: "The first Production turn passed, but deterministic second-turn continuity failed.",
        answer: `${continuity.error.name}: ${continuity.error.message}`,
        evidencePaths: ["production-lane/continuity.json"],
      };
    case "not-run":
      return {
        status: "not-observed" as const,
        summary: "Two-turn Production continuity could not run because its prerequisite first turn did not complete.",
        answer: continuity.reason,
        evidencePaths: ["production-lane/continuity.json"],
      };
    default: {
      const _ex: never = continuity;
      throw new Error(`Unhandled continuity status: ${String(_ex)}`);
    }
    }
  })();

  const domains: ModelSupportInvestigationEvidenceDomainReadiness[] = [
    domain({
      domainId: "runtime-assets",
      status: runtimeReady
        ? "implementation-ready"
        : runtimeEvidencePath === undefined
          ? "not-observed"
          : "insufficient",
      summary: runtimeReady
        ? "Same-origin runtime manifest, MJS/WASM fingerprints, and the fixed ONNX control passed."
        : runtimeEvidencePath === undefined
          ? "Runtime integrity evidence was not observed."
          : "Runtime integrity evidence is partial, fingerprint-incomplete, or contains a failed required stage.",
      questionId: "runtime-assets-same-origin-and-control",
      answer: runtimeReady
        ? `Verified build ${runtimeAssetIdentity!.manifestBuildId}; MJS/WASM hashes matched the compiled manifest; ${runtimeThreadingSummary}`
        : runtimeEvidencePath === undefined
          ? "Unobserved"
          : runtimeAssetIdentity === undefined
            ? "Runtime asset identity was not observed"
            : `Not verified; build=${runtimeAssetIdentity.manifestBuildId}; observedBuild=${runtimeAssetIdentity.observedManifestBuildId ?? "unobserved"}`,
      evidencePaths: [
        ...(runtimeEvidencePath === undefined ? [] : [runtimeEvidencePath]),
        ...(runtimeAssetIdentityPath === undefined ? [] : [runtimeAssetIdentityPath]),
        ...(runtimeStepErrorCount > 0 ? ["errors.json"] : []),
      ],
    }),
    domain({
      domainId: "repository",
      status: revisionReady
        ? "implementation-ready"
        : repositoryStepErrorCount > 0
          ? "insufficient"
          : run.repository === undefined
            ? "not-observed"
            : "insufficient",
      summary: revisionReady
        ? "The repository is frozen to an exact 40-character commit SHA."
        : repositoryStepErrorCount > 0
          ? `Repository inspection failed with ${repositoryStepErrorCount} structured error(s).`
          : "An exact repository revision was not verified.",
      questionId: "exact-model-revision",
      answer: run.repository?.resolvedRevision
        ?? (repositoryStepErrorCount > 0 ? "Inspection failed; see structured step errors" : "Unobserved"),
      evidencePaths: run.repository === undefined
        ? (repositoryStepErrorCount > 0 ? ["errors.json"] : [])
        : ["repository/repository.json", ...(repositoryStepErrorCount > 0 ? ["errors.json"] : [])],
    }),
    domain({
      domainId: "cache",
      status: cacheReadinessStatus,
      summary: cacheStepErrorCount > 0
        ? `OPFS/cache inspection recorded ${cacheStepErrorCount} structured error(s); ${cacheProvenanceSummary}.`
        : cacheObserved
          ? `OPFS inventory was observed; ${cacheProvenanceSummary}.`
          : "OPFS cache inventory was not observed.",
      questionId: "cache-revision-provenance",
      answer: cacheAnswer,
      evidencePaths: [
        ...(run.cache === undefined ? [] : ["cache/inventory.json"]),
        ...(cacheProvenance === undefined ? [] : ["cache/provenance.json"]),
        ...(postAttemptCache === undefined ? [] : ["load-attempts/index.json"]),
        ...(cacheStepErrorCount > 0 ? ["errors.json"] : []),
      ],
    }),
    domain({
      domainId: "model-declarations",
      status: run.declarations === undefined
        ? declarationsStepErrorCount > 0 ? "insufficient" : "not-observed"
        : run.declarations.modelType !== undefined && supportedClassCount > 0 && run.declarations.fileFailures.length === 0
          ? "implementation-ready"
          : "partial",
      summary: run.declarations === undefined
        ? declarationsStepErrorCount > 0
          ? `Model declaration inspection failed with ${declarationsStepErrorCount} structured error(s).`
          : "Model declarations were not observed."
        : run.declarations.fileFailures.length === 0
          ? `${supportedClassCount} public generative Auto classes were observed as supported.`
          : `${supportedClassCount} public generative Auto classes were observed as supported; ${run.declarations.fileFailures.length} optional declaration files failed and remain unresolved.`,
      questionId: "model-type-and-public-class",
      answer: run.declarations?.modelType
        ?? (declarationsStepErrorCount > 0 ? "Inspection failed; see structured step errors" : "Unobserved"),
      evidencePaths: run.declarations === undefined
        ? (declarationsStepErrorCount > 0 ? ["errors.json"] : [])
        : ["repository/declarations.json", "runtime-assets/class-capabilities.json", ...(declarationsStepErrorCount > 0 ? ["errors.json"] : [])],
    }),
    domain({
      domainId: "template-tokenizer",
      status: run.templateBehavior === undefined
        ? templateStepErrorCount > 0 ? "insufficient" : "not-observed"
        : generationInputIds === undefined ? "partial" : "implementation-ready",
      summary: run.templateBehavior === undefined && templateStepErrorCount > 0
        ? `Tokenizer/template inspection failed with ${templateStepErrorCount} structured error(s).`
        : generationInputIds === undefined ? "A deterministic generation prompt token sequence was not verified." : `The user-generation case produced ${generationInputIds.length} input tokens.`,
      questionId: "reference-generation-input-ids",
      answer: generationInputIds === undefined
        ? templateStepErrorCount > 0 ? "Inspection failed; see structured step errors" : "Unobserved"
        : `${generationInputIds.length} tokens`,
      evidencePaths: run.templateBehavior === undefined
        ? templateStepErrorCount > 0 ? ["errors.json"] : []
        : ["template-behavior/matrix.json"],
    }),
    domain({
      domainId: "model-file-plan",
      status: run.modelFilePlan === undefined
        ? modelFilePlanStepErrorCount > 0 ? "insufficient" : "not-observed"
        : eligibleCandidates.length > 0 ? "implementation-ready" : "partial",
      summary: run.modelFilePlan === undefined
        ? modelFilePlanStepErrorCount > 0
          ? `Model file planning failed with ${modelFilePlanStepErrorCount} structured error(s).`
          : "ModelRegistry plans were not observed."
        : `${eligibleCandidates.length} fixed quantized candidates are eligible.`,
      questionId: "eligible-quantized-candidates",
      answer: run.modelFilePlan === undefined && modelFilePlanStepErrorCount > 0
        ? "Inspection failed; see structured step errors"
        : eligibleCandidates.map(item => item.candidateId).join(", ") || "None",
      evidencePaths: run.modelFilePlan === undefined
        ? (modelFilePlanStepErrorCount > 0 ? ["errors.json"] : [])
        : ["model-files/plans.json", ...(modelFilePlanStepErrorCount > 0 ? ["errors.json"] : [])],
    }),
    domain({
      domainId: "runtime-load",
      status: sessionFilesReady ? "implementation-ready" : loadedAttempt !== undefined ? "partial" : run.loadAttempts.length > 0 ? "partial" : "not-observed",
      summary: sessionFilesReady
        ? "A fixed candidate loaded successfully, and every observed Session was exactly correlated to a unique core ONNX basename."
        : loadedAttempt !== undefined
          ? `A fixed candidate loaded successfully, but ${unresolvedSessionFileCorrelationCount} of ${sessionFileCorrelations.length} Session-to-file correlations remain unresolved; generation may still be unavailable.`
          : "No successful real-model load was observed.",
      questionId: "real-model-load-and-session-files",
      answer: loadedAttempt === undefined
        ? "Unobserved"
        : `${loadedAttempt.candidateId}; model loaded; exact session files=${exactSessionFileCorrelationCount}; unresolved=${unresolvedSessionFileCorrelationCount}`,
      evidencePaths: loadedAttempt === undefined ? [] : [loadedAttemptEvidencePath],
    }),
    domain({
      domainId: "plain-text",
      status: naturalReady
        ? "implementation-ready"
        : runtimeGenerationReady || productionPlainTextReady
          ? "partial"
          : "not-observed",
      summary: naturalReady
        ? "A bounded, non-forced greedy Reference output baseline was observed."
        : productionPlainTextReady
          ? `The Naidan Production Lane generated ${productionPlainTextTokenCount} token(s), but the bounded Reference natural baseline was not observed.`
          : "A bounded natural output baseline was not observed.",
      questionId: "bounded-natural-output",
      answer: (() => {
        const naturalGeneration = passedAttempt?.naturalGeneration;
        if (naturalGeneration !== undefined) {
          switch (naturalGeneration.status) {
          case "observed":
            return `${naturalGeneration.generatedTokenIds.length} Reference tokens`;
          case "failed":
            return `Reference natural baseline failed: ${naturalGeneration.error.name}: ${naturalGeneration.error.message}`;
          default: {
            const _ex: never = naturalGeneration;
            return _ex;
          }
          }
        }
        return productionPlainTextReady
          ? `${productionPlainTextTokenCount} Production tokens; Reference baseline unobserved`
          : "Unobserved";
      })(),
      evidencePaths: naturalReady
        ? ["load-attempts/index.json"]
        : productionPlainTextReady && productionObservationPath !== undefined
          ? [productionObservationPath]
          : runtimeGenerationReady
            ? ["load-attempts/index.json"]
            : [],
    }),
    domain({
      domainId: "production-routing",
      status: productionReadiness.status,
      summary: productionReadiness.summary,
      questionId: "production-route-and-reference-token-diff",
      answer: productionReadiness.answer,
      evidencePaths: productionReadiness.evidencePaths,
    }),
    domain({
      domainId: "continuity-kv-cache",
      status: continuityReadiness.status,
      summary: continuityReadiness.summary,
      questionId: "continuity-kv-cache-behavior",
      answer: continuityReadiness.answer,
      evidencePaths: continuityReadiness.evidencePaths,
    }),
    domain({
      domainId: 'tools',
      status: (() => {
        if (toolTemplateObserved) return 'partial';
        if (toolProtocolProbe === undefined) return 'not-observed';
        switch (toolProtocolProbe.status) {
        case 'observed':
        case 'failed':
          return 'partial';
        case 'unavailable':
          return 'not-observed';
        default: {
          const _ex: never = toolProtocolProbe;
          return _ex;
        }
        }
      })(),
      summary: (() => {
        if (toolProtocolProbe === undefined) {
          return toolTemplateObserved
            ? 'The tokenizer rendered deterministic tool protocol provenance, but a real forced generation probe and parser behavior were not observed.'
            : 'A deterministic assistant tool-call and tool-result continuation template was not observed.';
        }
        switch (toolProtocolProbe.status) {
        case 'observed':
          return toolProtocolProbe.exactMatch
            ? `The real model generation loop exactly emitted the bounded template-derived tool protocol sequence under a logits processor. ${toolParserReadinessSummary({ observation: toolProtocolProbe.parserObservation })} ${toolResultRoundTripSummary({ observation: toolProtocolProbe.toolResultTemplateRoundTrip })} ${productionToolResultContinuationSummary({ observation: productionToolResultContinuation })}`
            : `The real model generation loop executed the bounded template-derived tool protocol probe but ended or diverged before the complete sequence. ${toolParserReadinessSummary({ observation: toolProtocolProbe.parserObservation })} ${toolResultRoundTripSummary({ observation: toolProtocolProbe.toolResultTemplateRoundTrip })} ${productionToolResultContinuationSummary({ observation: productionToolResultContinuation })}`;
        case 'unavailable':
          return `The tool protocol probe was not executed: ${toolProtocolProbe.reason}`;
        case 'failed':
          return `The tool protocol probe failed without invalidating the successful model load: ${toolProtocolProbe.error.message}`;
        default: {
          const _ex: never = toolProtocolProbe;
          return _ex;
        }
        }
      })(),
      questionId: 'tool-protocol-forced-generation',
      answer: (() => {
        if (toolProtocolProbe === undefined) {
          if (!toolTemplateObserved) return 'Unobserved';
          return toolTemplateProvenance.generationPromptPrefixMatch
            ? `${toolTemplateProvenance.assistantToolCallSuffixTokenIds?.length ?? 0} template-derived assistant tool-call suffix tokens; real generation not run`
            : `template token sequences first differ at ${toolTemplateProvenance.firstMismatchIndex ?? 'the length boundary'}`;
        }
        switch (toolProtocolProbe.status) {
        case 'observed':
          return toolProtocolProbe.exactMatch
            ? `${toolProtocolProbe.generatedTokenIds.length} of ${toolProtocolProbe.forcedTokenIds.length} forced tokens matched exactly; ${toolParserReadinessAnswer({ observation: toolProtocolProbe.parserObservation })}; ${toolResultRoundTripAnswer({ observation: toolProtocolProbe.toolResultTemplateRoundTrip })}; ${productionToolResultContinuationAnswer({ observation: productionToolResultContinuation })}`
            : `first mismatch or early termination at ${toolProtocolProbe.firstMismatchIndex ?? 'the length boundary'}; ${toolParserReadinessAnswer({ observation: toolProtocolProbe.parserObservation })}; ${toolResultRoundTripAnswer({ observation: toolProtocolProbe.toolResultTemplateRoundTrip })}; ${productionToolResultContinuationAnswer({ observation: productionToolResultContinuation })}`;
        case 'unavailable':
          return toolProtocolProbe.reason;
        case 'failed':
          return `${toolProtocolProbe.error.name}: ${toolProtocolProbe.error.message}`;
        default: {
          const _ex: never = toolProtocolProbe;
          return _ex;
        }
        }
      })(),
      evidencePaths: [
        ...(toolTemplateObserved ? ['template-behavior/matrix.json'] : []),
        ...(toolProtocolProbe === undefined ? [] : ['protocol-probes/tool.json', 'load-attempts/index.json']),
        ...(productionToolResultContinuation === undefined ? [] : ['production-lane/tool-result-continuation.json']),
      ],
    }),
    domain({
      domainId: 'reasoning',
      status: (() => {
        if (productionReasoning === undefined) return 'not-observed';
        switch (productionReasoning.status) {
        case 'observed':
        case 'failed':
          return 'partial';
        case 'unavailable':
          return 'not-observed';
        default: {
          const _ex: never = productionReasoning;
          return _ex;
        }
        }
      })(),
      summary: (() => {
        if (productionReasoning === undefined) return 'A Production reasoning effort differential was not observed.';
        switch (productionReasoning.status) {
        case 'observed':
          return productionReasoning.inputTokenExactMatch
            ? 'The existing Qwen3.5 Production strategy ran with reasoning efforts none and high, but both modes produced identical input token IDs.'
            : `The existing Qwen3.5 Production strategy ran with reasoning efforts none and high and first changed the input token IDs at index ${productionReasoning.firstInputMismatchIndex ?? 'the length boundary'}.`;
        case 'failed': {
          const attemptSummary = productionReasoning.effortAttempts
            .map(attempt => reasoningEffortSummary({ attempt }))
            .join('; ');
          return `The Qwen3.5 Production reasoning differential was incomplete, but both reasoning efforts were attempted independently: ${attemptSummary}`;
        }
        case 'unavailable':
          return `Production reasoning observation was unavailable: ${productionReasoning.reason}`;
        default: {
          const _ex: never = productionReasoning;
          return _ex;
        }
        }
      })(),
      questionId: 'production-reasoning-effort-differential',
      answer: (() => {
        if (productionReasoning === undefined) return 'Unobserved';
        switch (productionReasoning.status) {
        case 'observed':
          return `qwen3_5; none tokens=${productionReasoning.disabledTurn.inputTokenIds.length}; high tokens=${productionReasoning.enabledTurn.inputTokenIds.length}; inputExact=${String(productionReasoning.inputTokenExactMatch)}; firstMismatch=${productionReasoning.firstInputMismatchIndex ?? 'none'}`;
        case 'failed':
          return productionReasoning.effortAttempts
            .map(attempt => reasoningEffortSummary({ attempt }))
            .join('; ');
        case 'unavailable':
          return productionReasoning.reason;
        default: {
          const _ex: never = productionReasoning;
          return _ex;
        }
        }
      })(),
      evidencePaths: productionReasoning === undefined ? [] : ['production-lane/reasoning.json'],
    }),
    domain({
      domainId: 'multimodal',
      status: (() => {
        const multimodal = productionObservation?.multimodal;
        if (multimodal === undefined) return 'not-observed';
        switch (multimodal.status) {
        case 'observed':
        case 'failed':
          return 'partial';
        case 'unavailable':
          return 'not-observed';
        default: {
          const _ex: never = multimodal;
          return _ex;
        }
        }
      })(),
      summary: (() => {
        const multimodal = productionObservation?.multimodal;
        if (multimodal === undefined) return 'A fixed synthetic multimodal Production probe was not observed.';
        switch (multimodal.status) {
        case 'observed':
          return `The existing Gemma 4 Production strategy processed fixed ${multimodal.fixture.width}x${multimodal.fixture.height} ${multimodal.fixture.mimeType} fixture ${multimodal.fixture.fixtureId} and generated ${multimodal.turn.generatedTokenIds.length} token(s). Output quality was not evaluated.`;
        case 'failed':
          return `The fixed Gemma 4 multimodal Production probe failed: ${multimodal.error.message}`;
        case 'unavailable':
          return `Production multimodal observation was unavailable for ${multimodal.strategy}: ${multimodal.reason}`;
        default: {
          const _ex: never = multimodal;
          return _ex;
        }
        }
      })(),
      questionId: 'multimodal-behavior',
      answer: (() => {
        const multimodal = productionObservation?.multimodal;
        if (multimodal === undefined) return 'Unobserved';
        switch (multimodal.status) {
        case 'observed':
          return `${multimodal.strategy}; fixture=${multimodal.fixture.fixtureId}; sha256=${multimodal.fixture.sha256}; inputKeys=${multimodal.turn.inputKeys.join(',')}; inputTensors=${multimodal.turn.inputTensors.map(tensor => `${tensor.name}:${tensor.dtype ?? 'unknown'}[${tensor.dims.join('x')}]`).join(',')}; generatedTokens=${multimodal.turn.generatedTokenIds.length}`;
        case 'failed':
          return `${multimodal.strategy}: ${multimodal.error.name}: ${multimodal.error.message}`;
        case 'unavailable':
          return `${multimodal.strategy}: unavailable (${multimodal.reason})`;
        default: {
          const _ex: never = multimodal;
          return _ex;
        }
        }
      })(),
      evidencePaths: productionObservation?.multimodal === undefined ? [] : ['production-lane/multimodal.json'],
    }),
  ];

  const coreInsufficient = domains.some(item => (
    ["runtime-assets", "repository"].includes(item.domainId) && item.status !== "implementation-ready"
  ));
  return {
    schemaVersion: 1,
    overall: coreInsufficient ? "insufficient" : "partial",
    domains,
  };
}

export function renderEvidenceReadinessMarkdown({
  report,
}: {
  report: ModelSupportInvestigationEvidenceReadinessReport,
}): string {
  const lines = [
    "# Evidence Readiness",
    "",
    `- Overall: ${report.overall}`,
    "",
  ];
  for (const domainReadiness of report.domains) {
    lines.push(`## ${domainReadiness.domainId}`, "", `- Status: ${domainReadiness.status}`, `- Summary: ${domainReadiness.summary}`, "");
    for (const question of domainReadiness.questions) {
      lines.push(`- ${question.questionId}: ${question.status} — ${question.answer}`);
      if (question.evidencePaths.length > 0) lines.push(`  - Evidence: ${question.evidencePaths.join(", ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
