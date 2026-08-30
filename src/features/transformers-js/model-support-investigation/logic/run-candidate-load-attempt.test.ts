import { describe, expect, it, vi } from "vitest";
import type {
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationTemplateBehavior,
} from "@/features/transformers-js/model-support-investigation/types";
import { runCandidateLoadAttempt } from "@/features/transformers-js/model-support-investigation/logic/run-candidate-load-attempt";

const repository = {
  normalizedModelId: "org/model",
  resolvedRevision: "a".repeat(40),
} as ModelSupportInvestigationRepository;
const declarations = {
  modelType: "llama",
} as ModelSupportInvestigationModelDeclarations;
const templateBehavior = {
  cases: [{
    caseId: "user-generation",
    status: "passed",
    inputIds: [1, 2, 3],
  }],
} as ModelSupportInvestigationTemplateBehavior;
const candidate: ModelSupportInvestigationCandidateFilePlan = {
  candidateId: "webgpu-q4",
  device: "webgpu",
  dtype: "q4",
  registryStatus: "planned",
  registryError: undefined,
  registryReturnedFileCount: 0,
  duplicatePaths: [],
  files: [],
  requiredFileCount: 0,
  optionalFileCount: 0,
  missingRequiredFileCount: 0,
  zeroByteRequiredFileCount: 0,
  missingOptionalFileCount: 0,
  cacheObservedRequiredFileCount: 0,
  cacheCompleteMarkerRequiredFileCount: 0,
  eligibility: "eligible",
  ineligibleReasons: [],
};

function now(): () => string {
  let count = 0;
  return () => `2026-08-06T00:00:${String(count++).padStart(2, "0")}Z`;
}

describe("runCandidateLoadAttempt", () => {
  it("records model load, one-token generation, and disposal", async () => {
    const model = { id: "model" };
    const disposeModel = vi.fn(async () => undefined);
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior,
      candidate,
      autoClass: "AutoModelForCausalLM",
      loadModel: async () => model,
      observeLoadedModel: () => ({
        modelType: "llama",
        isEncoderDecoder: false,
        sessions: [{ name: "model", inputNames: ["input_ids"], outputNames: ["logits"] }],
        sessionFileCorrelations: [{
          sessionName: "model",
          status: "exact",
          matchBasis: "exact-session-name-to-core-onnx-basename",
          coreFilePaths: ["onnx/model.onnx"],
          externalDataPaths: [],
        }],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: 1,
          eosTokenId: 2,
          padTokenId: 0,
          decoderStartTokenId: undefined,
        },
      }),
      buildInput: async ({ inputIds, strategy }) => ({
        input: { inputIds, strategy },
        inputTokenIds: [...inputIds],
        tensors: [{ name: "input_ids", dtype: "int64", dims: [1, inputIds.length], location: "cpu" }],
      }),
      generateMinimumToken: async ({ input }) => ({
        generatedTokenIds: [42],
        generatedText: "answer",
        modelType: "llama",
        inputIds: input.inputIds,
      }),
      generateNaturalBaseline: async () => ({
        status: "observed",
        forced: false,
        maxNewTokens: 16,
        doSample: false,
        generatedTokenIds: [43, 44],
        generatedText: "natural",
        termination: "ended-before-limit",
      }),
      generateToolProtocolProbe: vi.fn(),
      disposeInput: vi.fn(async () => undefined),
      disposeModel,
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-1",
    });

    expect(result).toMatchObject({
      attemptId: "attempt-1",
      status: "passed",
      failureStage: undefined,
      inputTokenCount: 3,
      generatedTokenIds: [42],
      generatedText: "answer",
      naturalGeneration: {
        status: "observed",
        generatedTokenIds: [43, 44],
        termination: "ended-before-limit",
      },
      modelType: "llama",
      selectedInputStrategy: "chat-template-tensor-dict",
      inputStrategyAttempts: [{
        strategy: "chat-template-tensor-dict",
        status: "passed",
      }],
    });
    expect(disposeModel).toHaveBeenCalledWith({ model });
    expect(result.events.map(event => [event.stage, event.status])).toEqual([
      ["worker-start", "passed"],
      ["auto-class-selection", "passed"],
      ["model-load", "running"],
      ["model-load", "passed"],
      ["input-build", "running"],
      ["input-build", "passed"],
      ["first-generation", "running"],
      ["first-generation", "passed"],
      ["natural-generation", "running"],
      ["natural-generation", "passed"],
      ["tool-protocol-probe", "skipped"],
      ["dispose", "running"],
      ["dispose", "passed"],
    ]);
  });

  it("preserves the model-load failure and does not dispose an absent model", async () => {
    const disposeModel = vi.fn(async () => undefined);
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior,
      candidate,
      autoClass: "AutoModelForCausalLM",
      loadModel: async () => {
        throw new TypeError("session create failed");
      },
      observeLoadedModel: vi.fn(),
      buildInput: vi.fn(),
      generateMinimumToken: vi.fn(),
      generateNaturalBaseline: vi.fn(),
      generateToolProtocolProbe: vi.fn(),
      disposeInput: vi.fn(async () => undefined),
      disposeModel,
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-2",
    });

    expect(result.status).toBe("failed");
    expect(result.failureStage).toBe("model-load");
    expect(result.error).toMatchObject({ name: "TypeError", message: "session create failed" });
    expect(disposeModel).not.toHaveBeenCalled();
  });

  it("blocks before loading when no public generative Auto class was observed", async () => {
    const loadModel = vi.fn();
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior,
      candidate,
      autoClass: undefined,
      loadModel,
      observeLoadedModel: vi.fn(),
      buildInput: vi.fn(),
      generateMinimumToken: vi.fn(),
      generateNaturalBaseline: vi.fn(),
      generateToolProtocolProbe: vi.fn(),
      disposeInput: vi.fn(),
      disposeModel: vi.fn(),
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-3",
    });

    expect(result.status).toBe("blocked");
    expect(result.failureStage).toBe("auto-class-selection");
    expect(result.error?.name).toBe("GenerativeAutoClassUnavailableError");
    expect(loadModel).not.toHaveBeenCalled();
  });

  it("preserves multimodal model-load evidence instead of submitting invalid text-only tensors", async () => {
    const model = { id: "vision-model" };
    const buildInput = vi.fn();
    const generateMinimumToken = vi.fn();
    const disposeModel = vi.fn(async () => undefined);
    const result = await runCandidateLoadAttempt({
      repository: { ...repository, pipelineTag: "image-text-to-text" },
      declarations,
      templateBehavior,
      candidate,
      autoClass: "AutoModelForImageTextToText",
      loadModel: async () => model,
      observeLoadedModel: () => ({
        modelType: "vision-model",
        isEncoderDecoder: false,
        sessions: [{ name: "model", inputNames: ["input_ids", "pixel_values"], outputNames: ["logits"] }],
        sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: 1,
          eosTokenId: 2,
          padTokenId: 0,
          decoderStartTokenId: undefined,
        },
      }),
      buildInput,
      generateMinimumToken,
      generateNaturalBaseline: vi.fn(),
      generateToolProtocolProbe: vi.fn(),
      disposeInput: vi.fn(),
      disposeModel,
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-multimodal",
    });

    expect(result).toMatchObject({
      status: "failed",
      failureStage: "input-build",
      loadedModel: { modelType: "vision-model" },
      error: { name: "ReferenceInputBuilderUnavailableError" },
    });
    expect(buildInput).not.toHaveBeenCalled();
    expect(generateMinimumToken).not.toHaveBeenCalled();
    expect(disposeModel).toHaveBeenCalledWith({ model });
  });

  it("loads the model before reporting unavailable template input", async () => {
    const model = { id: "model" };
    const loadModel = vi.fn(async () => model);
    const disposeModel = vi.fn(async () => undefined);
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior: undefined,
      candidate,
      autoClass: "AutoModelForCausalLM",
      loadModel,
      observeLoadedModel: () => ({
        modelType: "llama",
        isEncoderDecoder: false,
        sessions: [{ name: "model", inputNames: ["input_ids"], outputNames: ["logits"] }],
        sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: 1,
          eosTokenId: 2,
          padTokenId: 0,
          decoderStartTokenId: undefined,
        },
      }),
      buildInput: vi.fn(),
      generateMinimumToken: vi.fn(),
      generateNaturalBaseline: vi.fn(),
      generateToolProtocolProbe: vi.fn(),
      disposeInput: vi.fn(),
      disposeModel,
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-template-missing",
    });

    expect(loadModel).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "failed",
      failureStage: "input-build",
      loadedModel: { modelType: "llama" },
      error: { name: "ReferenceInputStrategiesExhaustedError" },
    });
    expect(disposeModel).toHaveBeenCalledWith({ model });
    expect(result.events.map(event => [event.stage, event.status])).toEqual([
      ["worker-start", "passed"],
      ["auto-class-selection", "passed"],
      ["model-load", "running"],
      ["model-load", "passed"],
      ["input-build", "running"],
      ["input-build", "failed"],
      ["input-build", "running"],
      ["input-build", "failed"],
      ["input-build", "running"],
      ["input-build", "failed"],
      ["dispose", "running"],
      ["dispose", "passed"],
    ]);
  });

  it("falls back to deterministic plain-text tokenizer input when chat-template inputs are unavailable", async () => {
    const model = { id: "model" };
    const generateMinimumToken = vi.fn(async () => ({ generatedTokenIds: [42], generatedText: "answer", modelType: "llama" }));
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior: undefined,
      candidate,
      autoClass: "AutoModelForCausalLM",
      loadModel: async () => model,
      observeLoadedModel: () => ({
        modelType: "llama",
        isEncoderDecoder: false,
        sessions: [],
        sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: 1,
          eosTokenId: 2,
          padTokenId: 0,
          decoderStartTokenId: undefined,
        },
      }),
      buildInput: async ({ strategy }) => {
        if (strategy !== "fixed-plain-text-tokenizer-tensor-dict") {
          throw new Error(`Unavailable input strategy: ${strategy}`);
        }
        return {
          input: { strategy },
          inputTokenIds: [11, 12],
          tensors: [{ name: "input_ids", dtype: "int64", dims: [1, 2], location: "cpu" }],
          inputText: "Hello",
        };
      },
      generateMinimumToken,
      generateNaturalBaseline: async () => ({
        status: "observed",
        forced: false,
        maxNewTokens: 16,
        doSample: false,
        generatedTokenIds: [43],
        generatedText: "natural",
        termination: "ended-before-limit",
      }),
      generateToolProtocolProbe: vi.fn(),
      disposeInput: vi.fn(async () => undefined),
      disposeModel: vi.fn(async () => undefined),
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-plain-text-fallback",
    });

    expect(result).toMatchObject({
      status: "passed",
      selectedInputStrategy: "fixed-plain-text-tokenizer-tensor-dict",
      inputTokenIds: [11, 12],
      inputStrategyAttempts: [
        { strategy: "chat-template-tensor-dict", status: "failed", failureStage: "input-build" },
        { strategy: "observed-token-ids-transformers-tensor", status: "failed", failureStage: "input-build" },
        {
          strategy: "fixed-plain-text-tokenizer-tensor-dict",
          status: "passed",
          failureStage: undefined,
          inputText: "Hello",
        },
      ],
    });
    expect(generateMinimumToken).toHaveBeenCalledOnce();
  });

  it("records a failed input strategy and continues with the next deterministic strategy", async () => {
    const model = { id: "model" };
    const disposeInput = vi.fn(async () => undefined);
    const generateMinimumToken = vi.fn(async ({ input }: { input: { strategy: string } }) => {
      if (input.strategy === "chat-template-tensor-dict") {
        throw new TypeError("first adapter rejected the model input shape");
      }
      return { generatedTokenIds: [42], generatedText: "answer", modelType: "llama" };
    });
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior,
      candidate,
      autoClass: "AutoModelForCausalLM",
      loadModel: async () => model,
      observeLoadedModel: () => ({
        modelType: "llama",
        isEncoderDecoder: false,
        sessions: [],
        sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: 1,
          eosTokenId: 2,
          padTokenId: 0,
          decoderStartTokenId: undefined,
        },
      }),
      buildInput: async ({ inputIds, strategy }) => ({
        input: { strategy },
        inputTokenIds: [...inputIds],
        tensors: [{ name: "input_ids", dtype: "int64", dims: [1, inputIds.length], location: "cpu" }],
      }),
      generateMinimumToken,
      generateNaturalBaseline: async () => ({
        status: "observed",
        forced: false,
        maxNewTokens: 16,
        doSample: false,
        generatedTokenIds: [43],
        generatedText: "natural",
        termination: "ended-before-limit",
      }),
      generateToolProtocolProbe: vi.fn(),
      disposeInput,
      disposeModel: vi.fn(async () => undefined),
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-fallback",
    });

    expect(result).toMatchObject({
      status: "passed",
      selectedInputStrategy: "observed-token-ids-transformers-tensor",
      inputStrategyAttempts: [{
        strategy: "chat-template-tensor-dict",
        status: "failed",
        failureStage: "first-generation",
        error: { name: "TypeError" },
      }, {
        strategy: "observed-token-ids-transformers-tensor",
        status: "passed",
        failureStage: undefined,
      }],
    });
    expect(generateMinimumToken).toHaveBeenCalledTimes(2);
    expect(disposeInput).toHaveBeenCalledTimes(2);
  });
  it("aborts input-strategy fallback when a failed strategy input cannot be disposed", async () => {
    const model = { id: "model" };
    const firstInput = { strategy: "chat-template-tensor-dict" };
    const secondInput = { strategy: "observed-token-ids-transformers-tensor" };
    const disposeInput = vi.fn(async ({ input }: { input: { strategy: string } }) => {
      if (input === firstInput) throw new Error("input cleanup failed");
    });
    const generateMinimumToken = vi.fn(async ({ input }: { input: { strategy: string } }) => {
      if (input === firstInput) throw new TypeError("first adapter rejected the model input shape");
      return { generatedTokenIds: [42], generatedText: "answer", modelType: "llama" };
    });
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior,
      candidate,
      autoClass: "AutoModelForCausalLM",
      loadModel: async () => model,
      observeLoadedModel: () => ({
        modelType: "llama",
        isEncoderDecoder: false,
        sessions: [],
        sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: 1,
          eosTokenId: 2,
          padTokenId: 0,
          decoderStartTokenId: undefined,
        },
      }),
      buildInput: async ({ inputIds, strategy }) => ({
        input: strategy === "chat-template-tensor-dict" ? firstInput : secondInput,
        inputTokenIds: [...inputIds],
        tensors: [{ name: "input_ids", dtype: "int64", dims: [1, inputIds.length], location: "cpu" }],
      }),
      generateMinimumToken,
      generateNaturalBaseline: vi.fn(),
      generateToolProtocolProbe: vi.fn(),
      disposeInput,
      disposeModel: vi.fn(async () => undefined),
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-cleanup-failure",
    });

    expect(result).toMatchObject({
      status: "failed",
      failureStage: "dispose",
      error: { name: "Error", message: "input cleanup failed" },
      inputStrategyAttempts: [{
        strategy: "chat-template-tensor-dict",
        status: "failed",
        failureStage: "first-generation",
      }],
    });
    expect(generateMinimumToken).toHaveBeenCalledTimes(1);
    expect(disposeInput).toHaveBeenCalledTimes(2);
  });

  it("continues the independent tool probe when the natural baseline fails", async () => {
    const model = { id: "model" };
    const generateToolProtocolProbe = vi.fn(async ({ inputTokenIds, forcedTokenIds }: { inputTokenIds: number[], forcedTokenIds: number[] }) => ({
      status: "observed" as const,
      forced: true as const,
      source: "chat-template-render" as const,
      generationCaseId: "tools-generation" as const,
      assistantToolCallCaseId: "assistant-tool-call-history" as const,
      toolResultContinuationCaseId: "tool-result-continuation" as const,
      inputTokenIds,
      forcedTokenIds,
      generatedTokenIds: [...forcedTokenIds],
      generatedText: "tool",
      exactMatch: true,
      firstMismatchIndex: undefined,
      termination: "complete-forced-sequence" as const,
      parserObservation: {
        status: "observed" as const,
        strategy: "standard" as const,
        parserKind: "standard-tool-call-stream-parser" as const,
        inputMode: "production-text-streamer-reconstruction" as const,
        inputChunks: ["tool"],
        visibleText: "tool",
        callBoundaryCount: undefined,
        toolCalls: [],
        recognized: false,
      },
    }));
    const result = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior: {
        ...templateBehavior,
        toolTemplateProvenance: {
          status: "observed",
          source: "chat-template-render",
          generationCaseId: "tools-generation",
          assistantToolCallCaseId: "assistant-tool-call-history",
          toolResultContinuationCaseId: "tool-result-continuation",
          generationInputIds: [1, 2, 3],
          assistantToolCallInputIds: [1, 2, 3, 7],
          toolResultContinuationInputIds: [1, 2, 3, 7],
          generationPromptPrefixMatch: true,
          firstMismatchIndex: undefined,
          assistantToolCallSuffixTokenIds: [7],
        },
      },
      candidate,
      autoClass: "AutoModelForCausalLM",
      loadModel: async () => model,
      observeLoadedModel: () => ({
        modelType: "llama",
        isEncoderDecoder: false,
        sessions: [],
        sessionFileCorrelations: [],
        effectiveMinimumGenerationConfig: {
          maxNewTokens: 1,
          doSample: false,
          bosTokenId: 1,
          eosTokenId: 2,
          padTokenId: 0,
          decoderStartTokenId: undefined,
        },
      }),
      buildInput: async ({ inputIds, strategy }) => ({
        input: { strategy },
        inputTokenIds: [...inputIds],
        tensors: [{ name: "input_ids", dtype: "int64", dims: [1, inputIds.length], location: "cpu" }],
      }),
      generateMinimumToken: async () => ({ generatedTokenIds: [42], generatedText: "answer", modelType: "llama" }),
      generateNaturalBaseline: async () => {
        throw new Error("natural generation failed");
      },
      generateToolProtocolProbe,
      disposeInput: vi.fn(async () => undefined),
      disposeModel: vi.fn(async () => undefined),
      onAttemptEvent: vi.fn(),
      now: now(),
      createAttemptId: () => "attempt-natural-failure",
    });

    expect(result.status).toBe("passed");
    expect(result.naturalGeneration).toMatchObject({
      status: "failed",
      error: { name: "Error", message: "natural generation failed" },
    });
    expect(result.toolProtocolProbe).toMatchObject({ status: "observed", exactMatch: true });
    expect(generateToolProtocolProbe).toHaveBeenCalledTimes(1);
    expect(result.events.map(event => [event.stage, event.status])).toEqual(expect.arrayContaining([
      ["natural-generation", "failed"],
      ["tool-protocol-probe", "running"],
      ["tool-protocol-probe", "passed"],
    ]));
  });

});
