import { describe, expect, it } from "vitest";
import type { ModelSupportInvestigationRun } from "@/features/transformers-js/model-support-investigation/types";
import { assessSupportBoundaries } from "./assess-support-boundaries";

function baseRun(): ModelSupportInvestigationRun {
  return {
    schemaVersion: 1, runId: "run", modelId: "org/model", scope: "partial-runtime-preflight",
    startedAt: "2026-08-06T00:00:00.000Z", completedAt: "2026-08-06T00:00:01.000Z",
    status: "passed", currentOperation: "done", steps: [], runtimeAssets: undefined,
    repository: undefined, cache: undefined, declarations: undefined, templateBehavior: undefined,
    modelFilePlan: undefined, loadAttempts: [],
    productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
    laneComparison: undefined, error: undefined,
  };
}

describe("assessSupportBoundaries", () => {
  it("classifies missing public Auto class support without guessing a runtime root cause", () => {
    const run = baseRun();
    run.declarations = {
      normalizedModelId: "org/model", resolvedRevision: "a".repeat(40), files: [],
      fileFailures: [],
      config: { model_type: "new-model" }, modelType: "new-model", architectures: [],
      autoMap: undefined, transformersJsConfig: undefined,
      classCapabilities: [{ autoClass: "AutoModelForCausalLM", supports: false, notEvaluatedReason: undefined }],
    };
    expect(assessSupportBoundaries({ run })).toEqual([expect.objectContaining({
      boundary: "transformers-js-capability", basis: "exact-observation",
    })]);
  });

  it("classifies missing required repository files", () => {
    const run = baseRun();
    run.modelFilePlan = {
      normalizedModelId: "org/model", resolvedRevision: "a".repeat(40), modelType: "model",
      registrySource: "ModelRegistry.get_model_files", cacheRevisionProvenance: "not-observed",
      cacheRevisionProvenanceReason: "not observed", candidates: [{
        candidateId: "wasm-q4", device: "wasm", dtype: "q4", registryStatus: "planned", registryError: undefined,
        registryReturnedFileCount: 1, duplicatePaths: [], files: [], requiredFileCount: 1, optionalFileCount: 0,
        missingRequiredFileCount: 1, zeroByteRequiredFileCount: 0, missingOptionalFileCount: 0,
        cacheObservedRequiredFileCount: 0, cacheCompleteMarkerRequiredFileCount: 0, eligibility: "ineligible",
        ineligibleReasons: ["missing required file"],
      }],
    };
    expect(assessSupportBoundaries({ run })[0]).toEqual(expect.objectContaining({ boundary: "repository-artifact" }));
  });

  it("keeps real-model failures unresolved after the runtime control passes", () => {
    const run = baseRun();
    run.runtimeAssets = {
      variant: "asyncify", baseUrl: "https://naidan.example/", mjsUrl: "https://naidan.example/ort.mjs",
      wasmUrl: "https://naidan.example/ort.wasm", wasmByteLength: 4, mjsOrigin: "https://naidan.example",
      wasmOrigin: "https://naidan.example", applicationOrigin: "https://naidan.example",
      environment: { userAgent: "Browser", vendor: "Vendor", hardwareConcurrency: 8, deviceMemoryGiB: undefined, crossOriginIsolated: true, webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined } },
      control: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "wasm", status: "passed", inputName: "x", outputName: "y", inputValue: 7, outputValue: 7, error: undefined },
      webGpuControl: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "webgpu", status: "not-available", inputName: "x", outputName: "y", inputValue: 7, outputValue: undefined, error: undefined },
    };
    run.loadAttempts = [{
      attemptId: "attempt", candidateId: "wasm-q4", device: "wasm", dtype: "q4", autoClass: "AutoModelForCausalLM",
      resolvedRevision: "a".repeat(40), startedAt: run.startedAt, completedAt: run.completedAt!, status: "failed",
      inputStrategyAttempts: [],
      selectedInputStrategy: undefined,
      failureStage: "model-load", events: [], inputTokenCount: undefined, inputTokenIds: [], inputTensors: [], loadedModel: undefined,
      generatedTokenIds: [], generatedText: undefined, naturalGeneration: undefined, toolProtocolProbe: undefined, modelType: undefined,
      error: { name: "Error", message: "failed", stack: undefined },
    }];
    expect(assessSupportBoundaries({ run })[0]).toEqual(expect.objectContaining({
      boundary: "unresolved", basis: "differential-observation",
    }));
  });

  it("does not classify an input-build failure as a real-model load failure when the model loaded", () => {
    const run = baseRun();
    run.runtimeAssets = {
      variant: "asyncify", baseUrl: "https://naidan.example/", mjsUrl: "https://naidan.example/ort.mjs",
      wasmUrl: "https://naidan.example/ort.wasm", wasmByteLength: 4, mjsOrigin: "https://naidan.example",
      wasmOrigin: "https://naidan.example", applicationOrigin: "https://naidan.example",
      environment: { userAgent: "Browser", vendor: "Vendor", hardwareConcurrency: 8, deviceMemoryGiB: undefined, crossOriginIsolated: true, webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined } },
      control: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "wasm", status: "passed", inputName: "x", outputName: "y", inputValue: 7, outputValue: 7, error: undefined },
      webGpuControl: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "webgpu", status: "not-available", inputName: "x", outputName: "y", inputValue: 7, outputValue: undefined, error: undefined },
    };
    run.loadAttempts = [{
      attemptId: "attempt", candidateId: "wasm-q4", device: "wasm", dtype: "q4", autoClass: "AutoModelForCausalLM",
      resolvedRevision: "a".repeat(40), startedAt: run.startedAt, completedAt: run.completedAt!, status: "failed",
      inputStrategyAttempts: [],
      selectedInputStrategy: undefined,
      failureStage: "input-build", events: [], inputTokenCount: 0, inputTokenIds: [], inputTensors: [],
      loadedModel: {
        modelType: "model",
        isEncoderDecoder: false,
        sessions: [],
        sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: undefined,
          eosTokenId: undefined,
          padTokenId: undefined,
          decoderStartTokenId: undefined,
        },
      },
      generatedTokenIds: [], generatedText: undefined, naturalGeneration: undefined, toolProtocolProbe: undefined, modelType: "model",
      error: { name: "TemplateInputUnavailableError", message: "input unavailable", stack: undefined },
    }];

    expect(assessSupportBoundaries({ run }).some(item => item.assessmentId === "real-model-attempts-failed-after-runtime-control")).toBe(false);
  });


  it("attributes Reference input-strategy exhaustion to the probe path when Production succeeds", () => {
    const run = baseRun();
    run.loadAttempts = [{
      attemptId: "reference", candidateId: "webgpu-q4f16", device: "webgpu", dtype: "q4f16",
      autoClass: "AutoModelForCausalLM", resolvedRevision: "a".repeat(40),
      startedAt: run.startedAt, completedAt: run.completedAt!, status: "failed", failureStage: "first-generation",
      events: [],
      inputStrategyAttempts: [{
        strategy: "chat-template-tensor-dict", status: "failed", failureStage: "first-generation",
        inputTokenIds: [1, 2], inputTensors: [],
        error: { name: "TypeError", message: "adapter failed", stack: undefined },
      }, {
        strategy: "observed-token-ids-transformers-tensor", status: "failed", failureStage: "first-generation",
        inputTokenIds: [1, 2], inputTensors: [],
        error: { name: "TypeError", message: "fallback failed", stack: undefined },
      }],
      selectedInputStrategy: undefined, inputTokenCount: undefined, inputTokenIds: [], inputTensors: [],
      loadedModel: {
        modelType: "llama", isEncoderDecoder: false, sessions: [], sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: { maxNewTokens: 1, doSample: false, bosTokenId: undefined, eosTokenId: undefined, padTokenId: undefined, decoderStartTokenId: undefined },
      },
      generatedTokenIds: [], generatedText: undefined, naturalGeneration: undefined, toolProtocolProbe: undefined,
      modelType: "llama", error: { name: "ReferenceInputStrategiesExhaustedError", message: "all failed", stack: undefined },
    }];
    run.productionLane = {
      status: "passed",
      observation: {
        firstTurn: { status: "passed", turn: { generatedTokenIds: [9] } },
        toolResultContinuation: { status: "not-run", reason: "not available" },
      } as never,
      error: undefined,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "reference-input-strategies-failed-production-succeeded",
      boundary: "unresolved",
      basis: "differential-observation",
      contradictoryEvidencePaths: ["production-lane/observation.json"],
    }));
  });

  it("keeps prerequisite inspection failures unresolved instead of guessing their support boundary", () => {
    const run = baseRun();
    run.stepErrors = {
      "repository-information": [{
        name: "SyntaxError",
        message: "Unexpected token '<' while parsing repository metadata",
        stack: "SyntaxError: Unexpected token '<'",
        thrownType: "SyntaxError",
      }],
      "template-behavior": [{
        name: "TypeError",
        message: "template inspection failed",
        stack: "TypeError: template inspection failed",
        thrownType: "TypeError",
      }],
    };

    expect(assessSupportBoundaries({ run })).toContainEqual({
      assessmentId: "investigation-prerequisite-step-failed",
      boundary: "unresolved",
      basis: "exact-observation",
      summary: expect.stringContaining("repository information, template/tokenizer behavior"),
      evidencePaths: ["errors.json"],
      contradictoryEvidencePaths: [],
    });
  });

  it("attributes same-origin runtime configuration failure to the Naidan adapter boundary", () => {
    const run = baseRun();
    run.runtimeAssetsPartial = {
      variant: "asyncify",
      baseUrl: "https://cdn.example/",
      mjsUrl: "https://cdn.example/ort.mjs",
      wasmUrl: "https://cdn.example/ort.wasm",
      physicalWasmUrl: "https://cdn.example/ort.wasm.gz",
      applicationOrigin: "https://naidan.example",
      mjsOrigin: "https://cdn.example",
      wasmOrigin: "https://cdn.example",
      physicalWasmOrigin: "https://cdn.example",
      environment: undefined,
      wasmByteLength: undefined,
      control: undefined,
      webGpuControl: undefined,
      currentStage: undefined,
      stageObservations: [{
        stage: "origin-validation",
        status: "failed",
        detail: "runtime assets are cross-origin",
        error: "runtime assets are cross-origin",
      }],
    };
    run.stepErrors = {
      "runtime-assets": [{
        name: "Error",
        message: "runtime assets are cross-origin",
        stack: undefined,
      }],
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "runtime-integrity-failed",
      boundary: "naidan-production-adapter",
      evidencePaths: ["runtime-assets/preflight-partial.json", "errors.json"],
    }));
  });

  it("keeps runtime module loading failures cross-boundary when one observation cannot identify the owner", () => {
    const run = baseRun();
    run.runtimeAssetsPartial = {
      variant: "asyncify",
      baseUrl: "https://naidan.example/transformers/",
      mjsUrl: "https://naidan.example/transformers/ort.mjs",
      wasmUrl: "https://naidan.example/transformers/ort.wasm",
      physicalWasmUrl: "https://naidan.example/transformers/ort.wasm.gz",
      applicationOrigin: "https://naidan.example",
      mjsOrigin: "https://naidan.example",
      wasmOrigin: "https://naidan.example",
      physicalWasmOrigin: "https://naidan.example",
      environment: undefined,
      wasmByteLength: undefined,
      control: undefined,
      webGpuControl: undefined,
      currentStage: undefined,
      stageObservations: [{
        stage: "origin-validation",
        status: "passed",
        detail: "same-origin",
      }, {
        stage: "module-import",
        status: "failed",
        detail: "module import failed",
        error: "module import failed",
      }],
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "runtime-integrity-failed",
      boundary: "cross-boundary",
    }));
  });

  it("does not manufacture an assessment when no boundary evidence exists", () => {
    expect(assessSupportBoundaries({ run: baseRun() })).toEqual([]);
  });
  it("classifies an exact template-derived sequence rejected by the production parser at the Naidan adapter boundary", () => {
    const run = baseRun();
    run.loadAttempts = [{
      attemptId: "reference", candidateId: "webgpu-q4", device: "webgpu", dtype: "q4",
      autoClass: "AutoModelForCausalLM", resolvedRevision: "a".repeat(40),
      startedAt: run.startedAt, completedAt: run.completedAt!, status: "passed", failureStage: undefined,
      inputStrategyAttempts: [],
      selectedInputStrategy: undefined,
      events: [], inputTokenCount: 2, inputTokenIds: [1, 2], inputTensors: [], loadedModel: undefined,
      generatedTokenIds: [3], generatedText: "reference", naturalGeneration: undefined,
      toolProtocolProbe: {
        status: "observed", forced: true, source: "chat-template-render",
        generationCaseId: "tools-generation", assistantToolCallCaseId: "assistant-tool-call-history",
        toolResultContinuationCaseId: "tool-result-continuation", inputTokenIds: [1, 2],
        forcedTokenIds: [3], generatedTokenIds: [3], generatedText: "tool", exactMatch: true,
        firstMismatchIndex: undefined, termination: "complete-forced-sequence",
        parserObservation: {
          status: "observed", strategy: "standard", parserKind: "standard-tool-call-stream-parser",
          inputMode: "production-text-streamer-reconstruction", inputChunks: ["tool"], visibleText: "tool",
          callBoundaryCount: undefined, toolCalls: [], recognized: false,
        },
      },
      modelType: "model", error: undefined,
    }];

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-tool-parser-did-not-recognize-template-protocol",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
    }));
  });

  it("classifies a Production failure after Reference success at the Naidan adapter boundary", () => {
    const run = baseRun();
    run.loadAttempts = [{
      attemptId: "reference", candidateId: "webgpu-q4", device: "webgpu", dtype: "q4",
      autoClass: "AutoModelForCausalLM", resolvedRevision: "a".repeat(40),
      startedAt: run.startedAt, completedAt: run.completedAt!, status: "passed", failureStage: undefined,
      inputStrategyAttempts: [],
      selectedInputStrategy: undefined,
      events: [], inputTokenCount: 2, inputTokenIds: [1, 2], inputTensors: [], loadedModel: undefined,
      generatedTokenIds: [3], generatedText: "reference", naturalGeneration: undefined, toolProtocolProbe: undefined,
      modelType: "model", error: undefined,
    }];
    run.productionLane = {
      status: "failed",
      observation: undefined,
      error: { name: "Error", message: "production failed", stack: undefined },
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-lane-failed-after-reference-success",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
    }));
  });

  it("isolates a Production first-turn failure after Reference success without discarding later probes", () => {
    const run = baseRun();
    run.loadAttempts = [{
      attemptId: "reference", candidateId: "webgpu-q4", device: "webgpu", dtype: "q4",
      autoClass: "AutoModelForCausalLM", resolvedRevision: "a".repeat(40),
      startedAt: run.startedAt, completedAt: run.completedAt!, status: "passed", failureStage: undefined,
      inputStrategyAttempts: [], selectedInputStrategy: undefined, events: [], inputTokenCount: 2,
      inputTokenIds: [1, 2], inputTensors: [], loadedModel: undefined, generatedTokenIds: [3],
      generatedText: "reference", naturalGeneration: undefined, toolProtocolProbe: undefined, modelType: "model", error: undefined,
    }];
    run.productionLane = {
      status: "passed",
      observation: {
        firstTurn: { status: "failed", error: { name: "FixtureFirstTurnError", message: "first turn failed" } },
        continuity: { status: "not-run", reason: "First Production turn failed" },
        toolResultContinuation: { status: "not-run", reason: "not requested" },
        reasoning: { status: "unavailable", reason: "not supported" },
        multimodal: { status: "unavailable", strategy: "standard", reason: "not supported" },
      } as never,
      error: undefined,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-first-turn-failed-after-reference-success",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
      summary: expect.stringContaining("Independent Production probes continued"),
    }));
  });

  it("classifies persistence serialization that changes model-visible history at the Naidan adapter boundary", () => {
    const run = baseRun();
    run.persistenceRoundTrip = {
      status: 'observed', fixtureId: 'tool-call-history-v1', method: 'chat-content-dto-json-roundtrip-v1',
      serializedByteLength: 64, serializedSha256: 'b'.repeat(64),
      originalMessages: [{ role: 'assistant', content: 'before', tool_calls: undefined, tool_call_id: undefined }],
      restoredMessages: [{ role: 'assistant', content: 'after', tool_calls: undefined, tool_call_id: undefined }],
      exactModelVisibleMatch: false, firstMismatchIndex: 0,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: 'persistence-roundtrip-altered-model-visible-history',
      boundary: 'naidan-production-adapter',
      basis: 'exact-observation',
    }));
  });

  it("keeps a failed persistence serialization probe cross-boundary", () => {
    const run = baseRun();
    run.persistenceRoundTrip = {
      status: 'failed', fixtureId: 'tool-call-history-v1', method: 'chat-content-dto-json-roundtrip-v1',
      error: { name: 'FixturePersistenceError', message: 'roundtrip failed' },
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: 'persistence-roundtrip-failed',
      boundary: 'cross-boundary',
      evidencePaths: ['continuity/persistence-roundtrip.json', 'errors.json'],
    }));
  });

  it("classifies persistence serialization that changes model-visible history at the Naidan adapter boundary", () => {
    const run = baseRun();
    run.persistenceRoundTrip = {
      status: "observed", fixtureId: "tool-call-history-v1", method: "chat-content-dto-json-roundtrip-v1",
      serializedByteLength: 64, serializedSha256: "b".repeat(64),
      originalMessages: [{ role: "assistant", content: "before", tool_calls: undefined, tool_call_id: undefined }],
      restoredMessages: [{ role: "assistant", content: "after", tool_calls: undefined, tool_call_id: undefined }],
      exactModelVisibleMatch: false, firstMismatchIndex: 0,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "persistence-roundtrip-altered-model-visible-history", boundary: "naidan-production-adapter", basis: "exact-observation",
    }));
  });

  it("keeps a failed persistence serialization probe cross-boundary", () => {
    const run = baseRun();
    run.persistenceRoundTrip = {
      status: "failed", fixtureId: "tool-call-history-v1", method: "chat-content-dto-json-roundtrip-v1",
      error: { name: "FixturePersistenceError", message: "roundtrip failed" },
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "persistence-roundtrip-failed", boundary: "cross-boundary",
      evidencePaths: ["continuity/persistence-roundtrip.json", "errors.json"],
    }));
  });

  it("classifies exact Qwen3.5 prefix evidence blocked by the message-count cache gate", () => {
    const run = baseRun();
    run.productionLane = {
      status: "passed",
      observation: {
        continuity: {
          status: "passed",
          secondTurn: {
            pastKeyValuesProvided: false,
            cacheDecision: { status: "not-reused", reason: "qwen3_5-message-count-mismatch" },
          },
          prefixComparison: {
            mode: "full-input-prefix",
            comparisonInputSource: "reconstructed-full-conversation",
            exactPrefixMatch: true,
            firstMismatchIndex: undefined,
          },
        },
        toolResultContinuation: { status: "not-run", reason: "not requested" },
      } as never,
      error: undefined,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-exact-prefix-cache-reuse-blocked-by-message-count",
      boundary: "naidan-production-adapter",
      basis: "exact-observation",
    }));
  });

  it("classifies KV reuse across a reconstructed token-prefix divergence as a Production adapter defect", () => {
    const run = baseRun();
    run.productionLane = {
      status: "passed",
      observation: {
        continuity: {
          status: "passed",
          secondTurn: {
            pastKeyValuesProvided: true,
            cacheDecision: { status: "reused", reason: "qwen3_5-no-tool-continuation" },
          },
          prefixComparison: {
            mode: "full-input-prefix",
            comparisonInputSource: "reconstructed-full-conversation",
            exactPrefixMatch: false,
            firstMismatchIndex: 2,
            firstMismatchContext: { expectedText: "expected", actualText: "actual" },
          },
        },
        toolResultContinuation: { status: "not-run", reason: "not requested" },
      } as never,
      error: undefined,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-cache-reused-with-prefix-divergence",
      boundary: "naidan-production-adapter",
      summary: expect.stringContaining("expected \"expected\", actual \"actual\""),
    }));
  });

  it("classifies a tool-result Production input divergence at the Naidan adapter boundary", () => {
    const run = baseRun();
    run.productionLane = {
      status: "passed",
      observation: {
        continuity: undefined,
        toolResultContinuation: {
          status: "passed",
          source: "reference-parser-roundtrip",
          strategy: "standard",
          messages: [],
          expectedInputTokenIds: [1, 2],
          inputTokenExactMatch: false,
          firstInputMismatchIndex: 1,
          turn: { generatedTokenIds: [3] },
        },
      } as never,
      error: undefined,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-tool-result-input-diverged-from-template-roundtrip",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
    }));
  });

  it("keeps a tool-result Production generation failure unresolved", () => {
    const run = baseRun();
    run.productionLane = {
      status: "passed",
      observation: {
        continuity: undefined,
        toolResultContinuation: {
          status: "failed",
          source: "reference-parser-roundtrip",
          strategy: "standard",
          messages: [],
          expectedInputTokenIds: [1, 2],
          error: { name: "Error", message: "generation failed" },
        },
      } as never,
      error: undefined,
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-tool-result-continuation-failed",
      boundary: "unresolved",
      basis: "exact-observation",
    }));
  });

  it("classifies a Reference and Production input-token divergence without guessing a parser root cause", () => {
    const run = baseRun();
    run.loadAttempts = [{
      attemptId: "reference", candidateId: "webgpu-q4", device: "webgpu", dtype: "q4",
      autoClass: "AutoModelForCausalLM", resolvedRevision: "a".repeat(40),
      startedAt: run.startedAt, completedAt: run.completedAt!, status: "passed", failureStage: undefined,
      inputStrategyAttempts: [],
      selectedInputStrategy: undefined,
      events: [], inputTokenCount: 2, inputTokenIds: [1, 2], inputTensors: [], loadedModel: undefined,
      generatedTokenIds: [3], generatedText: "reference", naturalGeneration: undefined, toolProtocolProbe: undefined,
      modelType: "model", error: undefined,
    }];
    run.productionLane = {
      status: "passed",
      observation: {
        firstTurn: { status: "passed", turn: { generatedTokenIds: [4] } },
        toolResultContinuation: { status: "not-run", reason: "not requested" },
      } as never,
      error: undefined,
    };
    run.laneComparison = {
      scenarioCaseId: "user-generation", referenceAttemptId: "reference", exactInputMatch: false,
      firstInputMismatchIndex: 1, referenceInputTokenIds: [1, 2], productionInputTokenIds: [1, 9],
      referenceGeneratedTokenIds: [3], productionGeneratedTokenIds: [4],
      productionRoute: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "standard", modelType: "model" },
    };

    expect(assessSupportBoundaries({ run })).toContainEqual(expect.objectContaining({
      assessmentId: "production-input-diverged-from-reference",
      boundary: "naidan-production-adapter",
      basis: "differential-observation",
    }));
  });

});
