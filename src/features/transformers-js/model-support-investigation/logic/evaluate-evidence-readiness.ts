import type {
  ModelSupportInvestigationEvidenceDomainReadiness,
  ModelSupportInvestigationEvidenceReadinessReport,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationToolParserObservation,
  ModelSupportInvestigationToolResultTemplateRoundTrip,
} from "@/features/transformers-js/model-support-investigation/types";
import type { TransformersJsProductionInvestigationToolResultContinuationObservation } from "@/features/transformers-js/types";

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
    return `${observation.strategy}: ${observation.error.name}: ${observation.error.message}`;
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
  case "passed":
    return observation.inputTokenExactMatch
      ? `The ${observation.strategy} Production strategy used the exact ${observation.expectedInputTokenIds.length}-token parser-to-template continuation input and generated ${observation.turn.generatedTokenIds.length} token(s). Tool-loop termination remains unobserved.`
      : `The ${observation.strategy} Production strategy generated ${observation.turn.generatedTokenIds.length} token(s), but its continuation input first differed from the parser-to-template tokens at index ${observation.firstInputMismatchIndex ?? "the length boundary"}. Tool-loop termination remains unobserved.`;
  case "failed":
    return `Production tool-result continuation failed in the ${observation.strategy} strategy: ${observation.error.message}`;
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
  case "passed":
    return `${observation.strategy}; generated=${observation.turn.generatedTokenIds.length}; inputExact=${String(observation.inputTokenExactMatch)}; firstMismatch=${observation.firstInputMismatchIndex ?? "none"}`;
  case "failed":
    return `${observation.strategy}: ${observation.error.name}: ${observation.error.message}`;
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
  const runtimeReady = run.runtimeAssets !== undefined
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.mjsOrigin
    && run.runtimeAssets.applicationOrigin === run.runtimeAssets.wasmOrigin
    && run.runtimeAssets.control.inputValue === run.runtimeAssets.control.outputValue;
  const revisionReady = run.repository !== undefined && /^[0-9a-f]{40}$/i.test(run.repository.resolvedRevision);
  const supportedClassCount = run.declarations?.classCapabilities.filter(item => item.supports === true).length ?? 0;
  const generationTemplate = run.templateBehavior?.cases.find(item => (
    item.caseId === "user-generation" && item.status === "passed" && (item.inputIds?.length ?? 0) > 0
  ));
  const generationInputIds = generationTemplate?.inputIds;
  const toolTemplateProvenance = run.templateBehavior?.toolTemplateProvenance;
  const toolTemplateObserved = toolTemplateProvenance?.status === 'observed';
  const eligibleCandidates = run.modelFilePlan?.candidates.filter(item => item.eligibility === "eligible") ?? [];
  const loadedAttempt = run.loadAttempts.find(item => item.loadedModel !== undefined);
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
    switch (cacheProvenance.status) {
    case "bounded-samples-matched":
      return `bounded samples matched against the resolved revision for ${cacheProvenance.files.length} cache files; whole-file provenance was not independently verified`;
    case "mismatched":
      return `bounded sample mismatch detected in ${cacheProvenance.files.filter(file => file.status === "mismatched").length} cache files`;
    case "partial":
      return "bounded cache sampling was incomplete";
    case "not-observed":
      return "no resolved- or requested-revision cache file was eligible for bounded sampling";
    default: {
      const _ex: never = cacheProvenance.status;
      return _ex;
    }
    }
  })();
  const cacheReadinessStatus = (() => {
    if (!cacheObserved) return "not-observed" as const;
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
      return `${before}; post-attempt inventory: files=${postAttemptCache.inventory.fileCount}, complete markers=${postAttemptCache.inventory.completionMarkerCount}, incomplete=${postAttemptCache.inventory.incompleteFileCount}; candidate required files: expected=${coverage.expectedPaths.length}, complete=${coverage.completePaths.length}, incomplete=${coverage.incompletePaths.length}, missing=${coverage.missingPaths.length}; ${cacheProvenanceSummary}`;
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
  const productionToolResultContinuation = run.productionLane.observation?.toolResultContinuation;
  const productionReasoning = run.productionLane.observation?.reasoning;
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
  const naturalReady = runtimeGenerationReady && passedAttempt.naturalGeneration !== undefined;
  const productionReadiness = (() => {
    switch (run.productionLane.status) {
    case "passed": {
      const observation = run.productionLane.observation;
      const comparison = run.laneComparison;
      if (observation === undefined || comparison === undefined) {
        return {
          status: "partial" as const,
          summary: "The Naidan Production Lane passed, but its routing or Reference comparison evidence is incomplete.",
          answer: "Production evidence incomplete",
          evidencePaths: observation === undefined ? [] : ["production-lane/observation.json"],
        };
      }
      const inputComparison = comparison.exactInputMatch
        ? "match exactly"
        : `first differ at ${comparison.firstInputMismatchIndex ?? "the shorter-prefix boundary"}`;
      return {
        status: "implementation-ready" as const,
        summary: "Naidan Production routing and the first Reference/Production input-token difference were observed.",
        answer: `${observation.route.autoClass} / ${observation.route.processor} / ${observation.route.strategy}; input tokens ${inputComparison}`,
        evidencePaths: ["production-lane/observation.json", "lane-comparison/comparison.json"],
      };
    }
    case "failed":
      return {
        status: "partial" as const,
        summary: "Reference evidence was preserved, but the Naidan Production Lane failed.",
        answer: run.productionLane.error?.message ?? "Production Lane failed",
        evidencePaths: ["production-lane/error.json"],
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
    if (run.productionLane.status !== "passed" || run.productionLane.observation === undefined) {
      return {
        status: "not-observed" as const,
        summary: "Two-turn Production continuity and KV cache behavior were not observed.",
        answer: "Unobserved",
        evidencePaths: [] as string[],
      };
    }
    const continuity = run.productionLane.observation.continuity;
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
      const cacheAnswer = continuity.secondTurn.pastKeyValuesProvided ? "cache provided" : "cache not provided";
      const prefixAnswer = (() => {
        switch (prefix.mode) {
        case "full-input-prefix":
          return prefix.exactPrefixMatch
            ? "full input prefix matched"
            : `full input prefix first differed at ${prefix.firstMismatchIndex ?? "the shorter-prefix boundary"}`;
        case "cache-suffix":
          return "second input was a cache suffix; full-prefix equality was not inferred";
        case "not-applicable-encoder-decoder":
          return "encoder-decoder prefix comparison was not applicable";
        default: {
          const _ex: never = prefix.mode;
          throw new Error(`Unhandled prefix comparison mode: ${_ex}`);
        }
        }
      })();
      return {
        status: "partial" as const,
        summary: "A deterministic second Production turn was observed with shallow KV structure metadata and an evidence-bounded prefix interpretation.",
        answer: `${cacheAnswer}; ${prefixAnswer}`,
        evidencePaths: ["production-lane/continuity.json"],
      };
    }
    case "failed":
      return {
        status: "partial" as const,
        summary: "The first Production turn passed, but deterministic second-turn continuity failed.",
        answer: `${continuity.error.name}: ${continuity.error.message}`,
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
      status: runtimeReady ? "implementation-ready" : run.runtimeAssets === undefined ? "not-observed" : "insufficient",
      summary: runtimeReady ? "Same-origin runtime assets and the fixed ONNX control passed." : "Runtime integrity evidence is unavailable or failed.",
      questionId: "runtime-assets-same-origin-and-control",
      answer: runtimeReady ? "Verified" : "Not verified",
      evidencePaths: run.runtimeAssets === undefined ? [] : ["runtime-assets/preflight.json"],
    }),
    domain({
      domainId: "repository",
      status: revisionReady ? "implementation-ready" : run.repository === undefined ? "not-observed" : "insufficient",
      summary: revisionReady ? "The repository is frozen to an exact 40-character commit SHA." : "An exact repository revision was not verified.",
      questionId: "exact-model-revision",
      answer: run.repository?.resolvedRevision ?? "Unobserved",
      evidencePaths: run.repository === undefined ? [] : ["repository/repository.json"],
    }),
    domain({
      domainId: "cache",
      status: cacheReadinessStatus,
      summary: cacheObserved
        ? `OPFS inventory was observed; ${cacheProvenanceSummary}.`
        : "OPFS cache inventory was not observed.",
      questionId: "cache-revision-provenance",
      answer: cacheAnswer,
      evidencePaths: [
        ...(run.cache === undefined ? [] : ["cache/inventory.json"]),
        ...(cacheProvenance === undefined ? [] : ["cache/provenance.json"]),
        ...(postAttemptCache === undefined ? [] : ["load-attempts/index.json"]),
      ],
    }),
    domain({
      domainId: "model-declarations",
      status: run.declarations === undefined ? "not-observed" : run.declarations.modelType !== undefined && supportedClassCount > 0 ? "implementation-ready" : "partial",
      summary: run.declarations === undefined ? "Model declarations were not observed." : `${supportedClassCount} public generative Auto classes were observed as supported.`,
      questionId: "model-type-and-public-class",
      answer: run.declarations?.modelType ?? "Unobserved",
      evidencePaths: run.declarations === undefined ? [] : ["repository/declarations.json", "runtime-assets/class-capabilities.json"],
    }),
    domain({
      domainId: "template-tokenizer",
      status: run.templateBehavior === undefined ? "not-observed" : generationInputIds === undefined ? "partial" : "implementation-ready",
      summary: generationInputIds === undefined ? "A deterministic generation prompt token sequence was not verified." : `The user-generation case produced ${generationInputIds.length} input tokens.`,
      questionId: "reference-generation-input-ids",
      answer: generationInputIds === undefined ? "Unobserved" : `${generationInputIds.length} tokens`,
      evidencePaths: run.templateBehavior === undefined ? [] : ["template-behavior/matrix.json"],
    }),
    domain({
      domainId: "model-file-plan",
      status: run.modelFilePlan === undefined ? "not-observed" : eligibleCandidates.length > 0 ? "implementation-ready" : "partial",
      summary: run.modelFilePlan === undefined ? "ModelRegistry plans were not observed." : `${eligibleCandidates.length} fixed quantized candidates are eligible.`,
      questionId: "eligible-quantized-candidates",
      answer: eligibleCandidates.map(item => item.candidateId).join(", ") || "None",
      evidencePaths: run.modelFilePlan === undefined ? [] : ["model-files/plans.json"],
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
      evidencePaths: loadedAttempt === undefined ? [] : ["load-attempts/index.json"],
    }),
    domain({
      domainId: "plain-text",
      status: naturalReady ? "implementation-ready" : runtimeGenerationReady ? "partial" : "not-observed",
      summary: naturalReady ? "A bounded, non-forced greedy output baseline was observed." : "A bounded natural output baseline was not observed.",
      questionId: "bounded-natural-output",
      answer: passedAttempt?.naturalGeneration === undefined ? "Unobserved" : `${passedAttempt.naturalGeneration.generatedTokenIds.length} tokens`,
      evidencePaths: passedAttempt === undefined ? [] : ["load-attempts/index.json"],
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
        case 'failed':
          return `The Qwen3.5 Production reasoning differential failed while running effort ${productionReasoning.failedEffort}: ${productionReasoning.error.message}`;
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
          return `${productionReasoning.failedEffort}: ${productionReasoning.error.name}: ${productionReasoning.error.message}`;
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
        const multimodal = run.productionLane.observation?.multimodal;
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
        const multimodal = run.productionLane.observation?.multimodal;
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
        const multimodal = run.productionLane.observation?.multimodal;
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
      evidencePaths: run.productionLane.observation?.multimodal === undefined ? [] : ['production-lane/multimodal.json'],
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
