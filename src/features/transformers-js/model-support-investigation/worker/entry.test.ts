import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IModelSupportInvestigationWorker } from "@/features/transformers-js/model-support-investigation/types";
import type { WorkerServerApi } from "@/utils/worker-transport";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  modelFromPretrained: vi.fn(),
  tokenizerFromPretrained: vi.fn(),
  tokenizerCall: vi.fn(),
  tokenizerDecode: vi.fn(),
  modelGenerate: vi.fn(),
  modelDispose: vi.fn(),
  runtimeFetch: vi.fn(),
  configValues: [] as Record<string, unknown>[],
}));

vi.mock("comlink", () => ({ expose: mocks.expose }));

vi.mock("@/features/transformers-js/runtime/configure-hosted-runtime", () => ({
  configureHostedTransformersRuntime: () => ({
    assets: {
      variant: "asyncify",
      baseUrl: "https://naidan.example/transformers/",
      mjsUrl: "https://naidan.example/transformers/ort.mjs",
      wasmUrl: "https://naidan.example/transformers/ort.wasm",
      physicalWasmUrl: "https://naidan.example/transformers/ort.wasm.gz",
      wasmTransport: "gzip-worker-decompression",
    },
    runtimeFetch: mocks.runtimeFetch,
  }),
}));

vi.mock("@huggingface/transformers", () => {
  class Tensor {
    readonly type: string;
    readonly data: BigInt64Array | Float32Array;
    readonly dims: number[];
    readonly location = "cpu";
    dispose = vi.fn();

    constructor(type: string, data: BigInt64Array | Float32Array, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }

    tolist(): Array<Array<number | bigint>> {
      return [Array.from(this.data as Iterable<number | bigint>)];
    }
  }
  class LogitsProcessor {
    _call(): never {
      throw new Error("Not implemented");
    }
  }
  class LogitsProcessorList {
    processors: unknown[] = [];

    push(item: unknown): void {
      this.processors.push(item);
    }

    *[Symbol.iterator](): IterableIterator<unknown> {
      yield* this.processors;
    }
  }
  class TextStreamer {
    private readonly tokenizer: { decode(values: number[], options: { skip_special_tokens: boolean }): string };
    private readonly callback: (output: string) => void;
    private readonly skipPrompt: boolean;
    private readonly skipSpecialTokens: boolean;
    private nextTokensArePrompt = true;

    constructor(tokenizer: { decode(values: number[], options: { skip_special_tokens: boolean }): string }, options: {
      skip_prompt?: boolean,
      skip_special_tokens?: boolean,
      callback_function?: (output: string) => void,
    }) {
      this.tokenizer = tokenizer;
      this.callback = options.callback_function ?? (() => undefined);
      this.skipPrompt = options.skip_prompt ?? false;
      this.skipSpecialTokens = options.skip_special_tokens ?? true;
    }

    put(value: bigint[][]): void {
      if (this.nextTokensArePrompt) {
        this.nextTokensArePrompt = false;
        if (this.skipPrompt) return;
      }
      const output = this.tokenizer.decode(value[0]?.map(Number) ?? [], {
        skip_special_tokens: this.skipSpecialTokens,
      });
      if (output.length > 0) this.callback(output);
    }

    end(): void {
      this.nextTokensArePrompt = true;
    }
  }
  class PretrainedConfig {
    model_type: string | undefined;

    constructor(values: Record<string, unknown>) {
      mocks.configValues.push(values);
      this.model_type = typeof values.model_type === "string" ? values.model_type : undefined;
    }
  }
  const modelClass = {
    from_pretrained: mocks.modelFromPretrained,
    supports: vi.fn(() => true),
  };
  return {
    AutoModel: { supports: vi.fn(() => true) },
    AutoModelForAudioTextToText: modelClass,
    AutoModelForCausalLM: modelClass,
    AutoModelForImageTextToText: modelClass,
    AutoModelForSeq2SeqLM: modelClass,
    AutoModelForSpeechSeq2Seq: modelClass,
    AutoModelForVision2Seq: modelClass,
    AutoTokenizer: {
      from_pretrained: async (...args: unknown[]) => {
        const base = await mocks.tokenizerFromPretrained(...args) as Record<string, unknown>;
        const tokenizer = (text: string, options: unknown) => {
          mocks.tokenizerCall(text, options);
          const ids = [5n, 6n];
          return {
            input_ids: new Tensor("int64", BigInt64Array.from(ids), [1, ids.length]),
            attention_mask: new Tensor("int64", BigInt64Array.from(ids, () => 1n), [1, ids.length]),
          };
        };
        return Object.assign(tokenizer, base, {
          apply_chat_template: (_messages: unknown, options: unknown) => {
            const hasTools = typeof options === "object"
              && options !== null
              && Reflect.get(options, "tools") !== undefined;
            const ids = hasTools ? [7n, 8n] : [1n, 2n];
            return {
              input_ids: new Tensor("int64", BigInt64Array.from(ids), [1, ids.length]),
              attention_mask: new Tensor("int64", BigInt64Array.from(ids, () => 1n), [1, ids.length]),
            };
          },
        });
      },
    },
    LogitsProcessor,
    LogitsProcessorList,
    ModelRegistry: { get_model_files: vi.fn() },
    PretrainedConfig,
    Tensor,
    TextStreamer,
    env: {
      backends: { onnx: { wasm: {} } },
      fetch: undefined,
    },
  };
});

vi.mock("onnxruntime-web", () => ({
  InferenceSession: { create: vi.fn() },
  Tensor: class {
    data: BigInt64Array | Float32Array;
    dims: number[];
    dispose = vi.fn();

    constructor(_type: string, data: BigInt64Array | Float32Array, dims: number[]) {
      this.data = data;
      this.dims = dims;
    }
  },
}));

vi.stubGlobal("self", {
  fetch: mocks.runtimeFetch,
  location: {
    origin: "https://naidan.example",
    href: "https://naidan.example/assets/investigation-worker.js",
  },
});
vi.stubGlobal("navigator", {
  userAgent: "Mozilla/5.0 Chrome/140",
  vendor: "Google Inc.",
  hardwareConcurrency: 4,
  storage: { getDirectory: vi.fn() },
});
vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "attempt-1") });

function exposedWorker(): WorkerServerApi<IModelSupportInvestigationWorker> {
  const value = mocks.expose.mock.calls[0]?.[0] as WorkerServerApi<IModelSupportInvestigationWorker> | undefined;
  if (value === undefined) throw new Error("Investigation Worker was not exposed");
  return value;
}

describe("model-support-investigation worker", () => {
  it("uses the shared OPFS model cache for candidate loads", async () => {
    await import("@/features/transformers-js/model-support-investigation/worker/entry");
    const { env } = await import("@huggingface/transformers");

    expect(env.allowLocalModels).toBe(false);
    expect(env.allowRemoteModels).toBe(true);
    expect(env.useBrowserCache).toBe(false);
    expect(env.useCustomCache).toBe(true);
    expect(env.customCache).toHaveProperty("match");
    expect(env.customCache).toHaveProperty("put");
  });

  it("uses the Production SPA fallback guard for remote model artifacts", async () => {
    await import("@/features/transformers-js/model-support-investigation/worker/entry");
    const { env } = await import("@huggingface/transformers");
    mocks.runtimeFetch.mockResolvedValueOnce(new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));

    const configuredFetch = env.fetch;
    if (typeof configuredFetch !== "function") throw new Error("Investigation fetch was not configured");
    const response = await configuredFetch("https://huggingface.co/org/model/resolve/main/tokenizer.json");

    expect(response.status).toBe(404);
    expect(response.statusText).toBe("Not Found");
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.configValues.length = 0;
    mocks.tokenizerDecode.mockReturnValue("token-42");
    mocks.tokenizerFromPretrained.mockResolvedValue({ decode: mocks.tokenizerDecode });
    mocks.modelGenerate.mockResolvedValue({
      data: BigInt64Array.from([1n, 2n, 42n]),
      dims: [1, 3],
    });
    mocks.modelFromPretrained.mockResolvedValue({
      config: { model_type: "llama", is_encoder_decoder: false },
      sessions: {
        model: {
          inputNames: ["input_ids", "attention_mask"],
          outputNames: ["logits"],
        },
      },
      generation_config: {
        bos_token_id: 1,
        eos_token_id: 2,
        pad_token_id: 0,
      },
      generate: mocks.modelGenerate,
      dispose: mocks.modelDispose,
    });
    mocks.modelDispose.mockResolvedValue(undefined);
    await import("./entry");
  });

  it("loads the fixed candidate at the resolved revision and performs one real generate call", async () => {
    const notFoundError = new Error("Not found");
    notFoundError.name = "NotFoundError";
    vi.mocked(navigator.storage.getDirectory).mockResolvedValue({
      getDirectoryHandle: vi.fn().mockRejectedValue(notFoundError),
    } as never);
    const onEvent = vi.fn();
    const onAttemptCheckpoint = vi.fn();
    const result = await exposedWorker().runCandidateAttempt(
      {
        normalizedModelId: "org/model",
        resolvedRevision: "a".repeat(40),
        pipelineTag: "text-generation",
      } as never,
      {
        config: { model_type: "llama" },
        modelType: "llama",
        classCapabilities: [{
          autoClass: "AutoModelForCausalLM",
          supports: true,
          notEvaluatedReason: undefined,
        }],
      } as never,
      {
        cases: [{
          caseId: "user-generation",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: undefined,
          addGenerationPrompt: true,
          status: "passed",
          inputIds: [1, 2],
        }],
      } as never,
      [],
      {
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        eligibility: "eligible",
        ineligibleReasons: [],
        files: [{ path: "onnx/model.onnx", kind: "core-onnx", requirement: "required" }],
      } as never,
      onEvent,
      vi.fn(),
      onAttemptCheckpoint,
    );

    expect(mocks.configValues).toEqual([{ model_type: "llama" }]);
    expect(mocks.modelFromPretrained).toHaveBeenCalledWith("org/model", expect.objectContaining({
      revision: "a".repeat(40),
      device: "webgpu",
      dtype: "q4",
      config: expect.objectContaining({ model_type: "llama" }),
    }));
    expect(mocks.tokenizerFromPretrained).toHaveBeenCalledWith("org/model", {
      revision: "a".repeat(40),
    });
    expect(mocks.modelGenerate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      max_new_tokens: 1,
      do_sample: false,
      input_ids: expect.objectContaining({ dims: [1, 2] }),
      attention_mask: expect.objectContaining({ dims: [1, 2] }),
    }));
    const firstGenerationInputIds = Reflect.get(mocks.modelGenerate.mock.calls[0]?.[0] ?? {}, "input_ids");
    expect(firstGenerationInputIds).toHaveProperty("tolist", expect.any(Function));
    expect(firstGenerationInputIds.tolist()).toEqual([[1n, 2n]]);
    expect(onAttemptCheckpoint).toHaveBeenCalledWith({
      attempt: expect.objectContaining({
        status: "running",
        loadedModel: expect.objectContaining({ modelType: "llama" }),
      }),
    });
    expect(mocks.modelGenerate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      max_new_tokens: 16,
      do_sample: false,
      input_ids: expect.objectContaining({ dims: [1, 2] }),
      attention_mask: expect.objectContaining({ dims: [1, 2] }),
    }));
    expect(mocks.tokenizerDecode).toHaveBeenCalledWith([42], { skip_special_tokens: false });
    expect(mocks.modelDispose).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      attemptId: "attempt-1",
      status: "passed",
      candidateId: "webgpu-q4",
      autoClass: "AutoModelForCausalLM",
      generatedTokenIds: [42],
      generatedText: "token-42",
      naturalGeneration: {
        forced: false,
        maxNewTokens: 16,
        generatedTokenIds: [42],
        generatedText: "token-42",
        termination: "ended-before-limit",
      },
      toolProtocolProbe: {
        status: "unavailable",
        forced: false,
      },
      modelType: "llama",
    });
    expect(result.postAttemptCache).toEqual({
      status: "observed",
      inventory: expect.objectContaining({
        normalizedModelId: "org/model",
        exists: false,
        revisionProvenance: "unknown",
        fileCount: 0,
      }),
      requiredFileCoverage: {
        expectedPaths: ["onnx/model.onnx"],
        completePaths: [],
        sizeMismatchPaths: [],
        incompletePaths: [],
        missingPaths: ["onnx/model.onnx"],
        revisionProvenance: "unknown",
      },
    });
    expect(result.loadedModel?.sessionFileCorrelations).toEqual([{
      sessionName: "model",
      status: "exact",
      matchBasis: "exact-session-name-to-core-onnx-basename",
      coreFilePaths: ["onnx/model.onnx"],
      externalDataPaths: [],
    }]);
    expect(onEvent).toHaveBeenCalledWith({
      event: expect.objectContaining({
        stepId: "loading-investigation",
        status: "running",
      }),
    });
  });

  it("uses the fixed plain-text tokenizer fallback when chat-template evidence is unavailable", async () => {
    const notFoundError = new Error("Not found");
    notFoundError.name = "NotFoundError";
    vi.mocked(navigator.storage.getDirectory).mockResolvedValue({
      getDirectoryHandle: vi.fn().mockRejectedValue(notFoundError),
    } as never);

    const result = await exposedWorker().runCandidateAttempt(
      {
        normalizedModelId: "org/model",
        resolvedRevision: "a".repeat(40),
        pipelineTag: "text-generation",
      } as never,
      {
        config: { model_type: "llama" },
        modelType: "llama",
        classCapabilities: [{
          autoClass: "AutoModelForCausalLM",
          supports: true,
          notEvaluatedReason: undefined,
        }],
      } as never,
      undefined,
      [],
      {
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        eligibility: "eligible",
        ineligibleReasons: [],
        files: [{ path: "onnx/model.onnx", kind: "core-onnx", requirement: "required" }],
      } as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );

    expect(mocks.tokenizerCall).toHaveBeenCalledWith("Hello", { return_tensor: true });
    expect(mocks.modelGenerate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      input_ids: expect.objectContaining({ dims: [1, 2], tolist: expect.any(Function) }),
      max_new_tokens: 1,
      do_sample: false,
    }));
    expect(result).toMatchObject({
      status: "passed",
      selectedInputStrategy: "fixed-plain-text-tokenizer-tensor-dict",
      inputTokenIds: [5, 6],
      inputStrategyAttempts: [
        { strategy: "chat-template-tensor-dict", status: "failed", failureStage: "input-build" },
        { strategy: "observed-token-ids-transformers-tensor", status: "failed", failureStage: "input-build" },
        { strategy: "fixed-plain-text-tokenizer-tensor-dict", status: "passed", inputText: "Hello" },
      ],
    });
  });

  it("forces the exact chat-template-derived tool continuation sequence", async () => {
    mocks.modelGenerate
      .mockResolvedValueOnce({ data: BigInt64Array.from([1n, 2n, 42n]), dims: [1, 3] })
      .mockResolvedValueOnce({ data: BigInt64Array.from([1n, 2n, 43n]), dims: [1, 3] })
      .mockResolvedValueOnce({ data: BigInt64Array.from([7n, 8n, 9n, 10n]), dims: [1, 4] });

    const result = await exposedWorker().runCandidateAttempt(
      {
        normalizedModelId: "org/model",
        resolvedRevision: "a".repeat(40),
        pipelineTag: "text-generation",
      } as never,
      {
        config: { model_type: "llama" },
        modelType: "llama",
        classCapabilities: [{
          autoClass: "AutoModelForCausalLM",
          supports: true,
          notEvaluatedReason: undefined,
        }],
      } as never,
      {
        cases: [{
          caseId: "user-generation",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: undefined,
          addGenerationPrompt: true,
          status: "passed",
          inputIds: [1, 2],
        }, {
          caseId: "tools-generation",
          messages: [{ role: "user", content: "Use the weather tool for Tokyo." }],
          tools: [{ type: "function" }],
          addGenerationPrompt: true,
          status: "passed",
          inputIds: [7, 8],
        }],
        toolTemplateProvenance: {
          status: "observed",
          source: "chat-template-render",
          generationCaseId: "tools-generation",
          assistantToolCallCaseId: "assistant-tool-call-history",
          toolResultContinuationCaseId: "tool-result-continuation",
          generationInputIds: [7, 8],
          assistantToolCallInputIds: [7, 8, 9, 10],
          toolResultContinuationInputIds: [7, 8, 9, 10],
          generationPromptPrefixMatch: true,
          firstMismatchIndex: undefined,
          assistantToolCallSuffixTokenIds: [9, 10],
        },
      } as never,
      [],
      {
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        eligibility: "eligible",
        ineligibleReasons: [],
        files: [{ path: "onnx/model.onnx", kind: "core-onnx", requirement: "required" }],
      } as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );

    expect(mocks.modelGenerate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      max_new_tokens: 2,
      do_sample: false,
      logits_processor: expect.objectContaining({ processors: [expect.anything()] }),
      input_ids: expect.objectContaining({ dims: [1, 2] }),
      attention_mask: expect.objectContaining({ dims: [1, 2] }),
    }));
    expect(result.toolProtocolProbe).toEqual({
      status: "observed",
      forced: true,
      source: "chat-template-render",
      generationCaseId: "tools-generation",
      assistantToolCallCaseId: "assistant-tool-call-history",
      toolResultContinuationCaseId: "tool-result-continuation",
      inputTokenIds: [7, 8],
      forcedTokenIds: [9, 10],
      generatedTokenIds: [9, 10],
      generatedText: "token-42",
      exactMatch: true,
      firstMismatchIndex: undefined,
      termination: "complete-forced-sequence",
      parserObservation: {
        status: "observed",
        strategy: "standard",
        parserKind: "standard-tool-call-stream-parser",
        inputMode: "production-text-streamer-reconstruction",
        inputChunks: ["token-42", "token-42"],
        visibleText: "token-42token-42",
        callBoundaryCount: undefined,
        toolCalls: [],
        recognized: false,
      },
      toolResultTemplateRoundTrip: {
        status: "unavailable",
        reason: "Production parser did not recognize exactly one tool call",
      },
    });
  });
});
