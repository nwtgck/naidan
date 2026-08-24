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
    productionLane: { status: "not-run", observation: undefined, error: undefined },
    laneComparison: undefined, error: undefined,
  };
}

describe("assessSupportBoundaries", () => {
  it("classifies missing public Auto class support without guessing a runtime root cause", () => {
    const run = baseRun();
    run.declarations = {
      normalizedModelId: "org/model", resolvedRevision: "a".repeat(40), files: [],
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
      control: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "wasm", inputName: "x", outputName: "y", inputValue: 7, outputValue: 7 },
      webGpuControl: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "webgpu", status: "not-available", inputName: "x", outputName: "y", inputValue: 7, outputValue: undefined, error: undefined },
    };
    run.loadAttempts = [{
      attemptId: "attempt", candidateId: "wasm-q4", device: "wasm", dtype: "q4", autoClass: "AutoModelForCausalLM",
      resolvedRevision: "a".repeat(40), startedAt: run.startedAt, completedAt: run.completedAt!, status: "failed",
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
      control: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "wasm", inputName: "x", outputName: "y", inputValue: 7, outputValue: 7 },
      webGpuControl: { fixtureId: "identity-float32-v1", fixtureSha256: "sha", executionProvider: "webgpu", status: "not-available", inputName: "x", outputName: "y", inputValue: 7, outputValue: undefined, error: undefined },
    };
    run.loadAttempts = [{
      attemptId: "attempt", candidateId: "wasm-q4", device: "wasm", dtype: "q4", autoClass: "AutoModelForCausalLM",
      resolvedRevision: "a".repeat(40), startedAt: run.startedAt, completedAt: run.completedAt!, status: "failed",
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


  it("does not manufacture an assessment when no boundary evidence exists", () => {
    expect(assessSupportBoundaries({ run: baseRun() })).toEqual([]);
  });
  it("classifies an exact template-derived sequence rejected by the production parser at the Naidan adapter boundary", () => {
    const run = baseRun();
    run.loadAttempts = [{
      attemptId: "reference", candidateId: "webgpu-q4", device: "webgpu", dtype: "q4",
      autoClass: "AutoModelForCausalLM", resolvedRevision: "a".repeat(40),
      startedAt: run.startedAt, completedAt: run.completedAt!, status: "passed", failureStage: undefined,
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
      events: [], inputTokenCount: 2, inputTokenIds: [1, 2], inputTensors: [], loadedModel: undefined,
      generatedTokenIds: [3], generatedText: "reference", naturalGeneration: undefined, toolProtocolProbe: undefined,
      modelType: "model", error: undefined,
    }];
    run.productionLane = { status: "passed", observation: { toolResultContinuation: { status: "not-run", reason: "not requested" } } as never, error: undefined };
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
