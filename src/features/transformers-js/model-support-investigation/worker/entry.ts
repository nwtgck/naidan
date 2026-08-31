/* eslint-disable no-restricted-imports -- Hosted investigation worker intentionally imports the Transformers.js runtime directly. */
import {
  AutoModel,
  AutoModelForAudioTextToText,
  AutoModelForCausalLM,
  AutoModelForImageTextToText,
  AutoModelForSeq2SeqLM,
  AutoModelForSpeechSeq2Seq,
  AutoModelForVision2Seq,
  AutoTokenizer,
  ModelRegistry,
  PretrainedConfig,
  Tensor as TransformersTensor,
  TextStreamer,
  type PreTrainedTokenizer,
  type ProgressCallback as TransformersProgressCallback,
  env,
} from "@huggingface/transformers";
import { InferenceSession, Tensor as OrtTensor } from "onnxruntime-web";
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationGenerationAutoClassName,
  ModelSupportInvestigationInputTensorMetadata,
  ModelSupportInvestigationJsonValue,
  ModelSupportInvestigationTemplateCase,
  ModelSupportInvestigationTextInputStrategy,
} from "@/features/transformers-js/model-support-investigation/types";
import { exposeWorkerRemote, type WorkerServerApi } from "@/utils/worker-transport";
import { parseInvestigationJson } from "@/features/transformers-js/model-support-investigation/logic/json-value-schema";
import { runRuntimeIntegrityPreflight } from "@/features/transformers-js/model-support-investigation/logic/run-runtime-integrity-preflight";
import { runPartialModelSupportInvestigation } from "@/features/transformers-js/model-support-investigation/logic/run-partial-model-support-investigation";
import { toPlanningWorkerRun } from "@/features/transformers-js/model-support-investigation/logic/planning-worker-run";
import { inspectHuggingFaceRepository } from "@/features/transformers-js/model-support-investigation/logic/inspect-hugging-face-repository";
import { inspectModelCache } from "@/features/transformers-js/model-support-investigation/logic/inspect-model-cache";
import {
  MODEL_CACHE_PROVENANCE_MAXIMUM_FILE_COUNT,
  MODEL_CACHE_PROVENANCE_RANGE_BYTES,
  verifyModelCacheProvenance,
} from "@/features/transformers-js/model-support-investigation/logic/verify-model-cache-provenance";
import { evaluateCandidateRequiredFileCoverage } from "@/features/transformers-js/model-support-investigation/logic/evaluate-candidate-required-file-coverage";
import { inspectModelDeclarations } from "@/features/transformers-js/model-support-investigation/logic/inspect-model-declarations";
import { inspectTemplateBehavior } from "@/features/transformers-js/model-support-investigation/logic/inspect-template-behavior";
import { investigationModelLoadRevision } from "@/features/transformers-js/model-support-investigation/logic/investigation-model-load-revision";
import { inspectModelFilePlan } from "@/features/transformers-js/model-support-investigation/logic/inspect-model-file-plan";
import { inspectChatPersistenceRoundTrip } from "@/features/transformers-js/model-support-investigation/logic/inspect-chat-persistence-roundtrip";
import { inspectRuntimeEnvironment } from "@/features/transformers-js/model-support-investigation/logic/inspect-runtime-environment";
import { correlateSessionFiles } from "@/features/transformers-js/model-support-investigation/logic/correlate-session-files";
import { runCandidateLoadAttempt } from "@/features/transformers-js/model-support-investigation/logic/run-candidate-load-attempt";
import { createModelLoadProgressTracker } from "@/features/transformers-js/model-support-investigation/logic/model-load-progress";
import { createForcedTokenSequenceLogitsProcessorList } from "@/features/transformers-js/model-support-investigation/worker/forced-token-sequence-logits-processor";
import { compareForcedTokenSequence } from "@/features/transformers-js/model-support-investigation/logic/plan-tool-protocol-probe";
import { selectGenerationAutoClass } from "@/features/transformers-js/model-support-investigation/logic/select-generation-auto-class";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";
import { MODEL_SUPPORT_INVESTIGATION_REFERENCE_PLAIN_TEXT } from "@/features/transformers-js/model-support-investigation/fixtures/reference-plain-text";
import { observeProductionToolParser } from "@/features/transformers-js/model-support-investigation/worker/observe-production-tool-parser";
import { observeToolResultTemplateRoundTrip } from "@/features/transformers-js/model-support-investigation/worker/observe-tool-result-template-roundtrip";
import { selectGenerationStrategy } from "@/features/transformers-js/generation-strategies";
import { configureHostedTransformersRuntime } from "@/features/transformers-js/runtime/configure-hosted-runtime";
import { createHostedTransformersModelFetch } from "@/features/transformers-js/runtime/model-fetch";
import { createOpfsModelCache } from "@/features/transformers-js/runtime/opfs-model-cache";
import {
  createRuntimeControlModelBytes,
  RUNTIME_CONTROL_FIXTURE_ID,
  RUNTIME_CONTROL_FIXTURE_SHA256,
} from "@/features/transformers-js/model-support-investigation/fixtures/runtime-control-model";

const originalFetch = self.fetch;
const { assets, runtimeFetch } = configureHostedTransformersRuntime({
  env,
  workerLocationUrl: self.location.href,
  environment: import.meta.env.DEV ? "development" : "production",
  userAgent: navigator.userAgent,
  vendor: navigator.vendor,
  hardwareConcurrency: navigator.hardwareConcurrency,
  originalFetch,
  createDecompressionStream: () => new DecompressionStream("gzip"),
});
const modelFetch = createHostedTransformersModelFetch({ runtimeFetch });
const downloadedModelCacheOnlyFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new Error(
    `Model Support Investigation MUST NOT fetch model artifacts while loading; required downloaded file is missing: ${url}`,
  );
};
self.fetch = modelFetch;
env.fetch = downloadedModelCacheOnlyFetch;
// Investigation loads must match Production's downloaded-model contract. The
// shared OPFS cache is readable but MUST NOT be mutated, and Transformers.js
// MUST NOT start/resume/repair a model download when an artifact is missing.
// Transformers.js 4.2 requires local lookup to remain enabled when
// local_files_only=true, even when the custom OPFS cache contains the file.
// Repository/provenance HTTP inspection remains separate and uses runtimeFetch.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = createOpfsModelCache({ mutationPolicy: 'read-only' });

type CandidateModel =
  | Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>>
  | Awaited<ReturnType<typeof AutoModelForSeq2SeqLM.from_pretrained>>
  | Awaited<ReturnType<typeof AutoModelForVision2Seq.from_pretrained>>
  | Awaited<ReturnType<typeof AutoModelForImageTextToText.from_pretrained>>
  | Awaited<ReturnType<typeof AutoModelForAudioTextToText.from_pretrained>>
  | Awaited<ReturnType<typeof AutoModelForSpeechSeq2Seq.from_pretrained>>;

type CandidateTextInput = {
  tokenizer: PreTrainedTokenizer,
  modelInputs: Record<string, TransformersTensor>,
  inputTokenIds: number[],
  inputText?: string,
};

function tensorMetadata({ name, tensor }: {
  name: string,
  tensor: TransformersTensor,
}): ModelSupportInvestigationInputTensorMetadata {
  return {
    name,
    dtype: tensor.type,
    dims: [...tensor.dims],
    location: tensor.location,
  };
}

function tokenIdsFromTensor({ tensor }: { tensor: TransformersTensor }): number[] {
  if (tensor.dims.length !== 2 || tensor.dims[0] !== 1) {
    throw new Error(`Expected a single-batch input_ids Tensor, got [${tensor.dims.join(",")}]`);
  }
  return Array.from(tensor.data as ArrayLike<number | bigint>, value => Number(value));
}

function tensorInputsFromUnknown({ value }: { value: unknown }): Record<string, TransformersTensor> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Tokenizer did not return a model input dictionary");
  }
  const result: Record<string, TransformersTensor> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const tensor = Reflect.get(value, key);
    if (tensor instanceof TransformersTensor) result[key] = tensor;
  }
  if (result.input_ids === undefined) {
    throw new Error("Tokenizer model input dictionary did not contain a Transformers.js input_ids Tensor");
  }
  return result;
}

function buildObservedTokenIdInput({ tokenizer, inputIds }: {
  tokenizer: PreTrainedTokenizer,
  inputIds: number[],
}): CandidateTextInput {
  if (inputIds.length === 0) {
    throw new Error("The deterministic user-generation template case did not produce input token IDs");
  }
  const inputIdsTensor = new TransformersTensor(
    "int64",
    BigInt64Array.from(inputIds, value => BigInt(value)),
    [1, inputIds.length],
  );
  const attentionMask = new TransformersTensor(
    "int64",
    BigInt64Array.from(inputIds, () => 1n),
    [1, inputIds.length],
  );
  return {
    tokenizer,
    modelInputs: { input_ids: inputIdsTensor, attention_mask: attentionMask },
    inputTokenIds: [...inputIds],
  };
}

function buildFixedPlainTextInput({ tokenizer }: {
  tokenizer: PreTrainedTokenizer,
}): CandidateTextInput & { inputText: string } {
  const value = tokenizer(MODEL_SUPPORT_INVESTIGATION_REFERENCE_PLAIN_TEXT, { return_tensor: true });
  const modelInputs = tensorInputsFromUnknown({ value });
  return {
    tokenizer,
    modelInputs,
    inputTokenIds: tokenIdsFromTensor({ tensor: modelInputs.input_ids! }),
    inputText: MODEL_SUPPORT_INVESTIGATION_REFERENCE_PLAIN_TEXT,
  };
}

function buildChatTemplateInput({ tokenizer, templateCase }: {
  tokenizer: PreTrainedTokenizer,
  templateCase: ModelSupportInvestigationTemplateCase | undefined,
}): CandidateTextInput {
  if (templateCase === undefined) {
    throw new Error("The deterministic user-generation template case is unavailable");
  }
  const value = tokenizer.apply_chat_template(
    templateCase.messages as Parameters<PreTrainedTokenizer["apply_chat_template"]>[0],
    {
      add_generation_prompt: templateCase.addGenerationPrompt,
      ...(templateCase.tools === undefined ? {} : { tools: templateCase.tools }),
      tokenize: true,
      return_tensor: true,
      return_dict: true,
    },
  );
  const modelInputs = tensorInputsFromUnknown({ value });
  return {
    tokenizer,
    modelInputs,
    inputTokenIds: tokenIdsFromTensor({ tensor: modelInputs.input_ids! }),
  };
}

function buildCandidateTextInput({ tokenizer, strategy, templateCase, observedInputIds }: {
  tokenizer: PreTrainedTokenizer,
  strategy: ModelSupportInvestigationTextInputStrategy,
  templateCase: ModelSupportInvestigationTemplateCase | undefined,
  observedInputIds: number[],
}): CandidateTextInput {
  switch (strategy) {
  case "chat-template-tensor-dict":
    return buildChatTemplateInput({ tokenizer, templateCase });
  case "observed-token-ids-transformers-tensor":
    return buildObservedTokenIdInput({ tokenizer, inputIds: observedInputIds });
  case "fixed-plain-text-tokenizer-tensor-dict":
    return buildFixedPlainTextInput({ tokenizer });
  default: {
    const _ex: never = strategy;
    return _ex;
  }
  }
}

function disposeCandidateTextInput({ input }: { input: CandidateTextInput }): void {
  const disposed = new Set<TransformersTensor>();
  for (const tensor of Object.values(input.modelInputs)) {
    if (disposed.has(tensor)) continue;
    disposed.add(tensor);
    tensor.dispose();
  }
}

async function loadDownloadedCandidateModel({
  autoClass,
  modelId,
  revision,
  config,
  device,
  dtype,
  onProgress,
}: {
  autoClass: ModelSupportInvestigationGenerationAutoClassName,
  modelId: string,
  revision: string | undefined,
  config: PretrainedConfig,
  device: "webgpu" | "wasm",
  dtype: "q4f16" | "q4",
  onProgress: TransformersProgressCallback,
}): Promise<CandidateModel> {
  const options = {
    ...(revision === undefined ? {} : { revision }),
    config,
    device,
    dtype,
    progress_callback: onProgress,
    local_files_only: true,
  };
  switch (autoClass) {
  case "AutoModelForCausalLM":
    return AutoModelForCausalLM.from_pretrained(modelId, options);
  case "AutoModelForSeq2SeqLM":
    return AutoModelForSeq2SeqLM.from_pretrained(modelId, options);
  case "AutoModelForVision2Seq":
    return AutoModelForVision2Seq.from_pretrained(modelId, options);
  case "AutoModelForImageTextToText":
    return AutoModelForImageTextToText.from_pretrained(modelId, options);
  case "AutoModelForAudioTextToText":
    return AutoModelForAudioTextToText.from_pretrained(modelId, options);
  case "AutoModelForSpeechSeq2Seq":
    return AutoModelForSpeechSeq2Seq.from_pretrained(modelId, options);
  default: {
    const _ex: never = autoClass;
    return _ex;
  }
  }
}

function generatedSequence({ output }: { output: unknown }): number[] {
  if (typeof output !== "object" || output === null) {
    throw new Error("Minimum generation did not return a Tensor-like result");
  }
  const sequence = Object.hasOwn(output, "sequences") ? Reflect.get(output, "sequences") : output;
  if (typeof sequence !== "object" || sequence === null) {
    throw new Error("Minimum generation result did not contain sequences");
  }
  const data = Reflect.get(sequence, "data");
  if (!ArrayBuffer.isView(data) && !Array.isArray(data)) {
    throw new Error("Minimum generation sequences did not expose typed token data");
  }
  return Array.from(data as ArrayLike<number | bigint>, value => Number(value));
}

function stringArray({ value }: { value: unknown }): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function optionalJsonValue({ value, label }: {
  value: unknown,
  label: string,
}): ModelSupportInvestigationJsonValue | undefined {
  if (value === undefined) return undefined;
  return parseInvestigationJson({ value, label });
}

function observeCandidateModel({ model }: { model: CandidateModel }) {
  const sessions = Object.entries(model.sessions)
    .map(([name, session]) => ({
      name,
      inputNames: stringArray({ value: Reflect.get(session, "inputNames") }),
      outputNames: stringArray({ value: Reflect.get(session, "outputNames") }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const generationConfig = model.generation_config;
  return {
    modelType: typeof model.config.model_type === "string" ? model.config.model_type : undefined,
    isEncoderDecoder: typeof model.config.is_encoder_decoder === "boolean"
      ? model.config.is_encoder_decoder
      : undefined,
    sessions,
    effectiveMinimumGenerationConfig: {
      maxNewTokens: 1 as const,
      doSample: false as const,
      bosTokenId: optionalJsonValue({ value: generationConfig?.bos_token_id, label: 'generation_config.bos_token_id' }),
      eosTokenId: optionalJsonValue({ value: generationConfig?.eos_token_id, label: 'generation_config.eos_token_id' }),
      padTokenId: optionalJsonValue({ value: generationConfig?.pad_token_id, label: 'generation_config.pad_token_id' }),
      decoderStartTokenId: optionalJsonValue({ value: generationConfig?.decoder_start_token_id, label: 'generation_config.decoder_start_token_id' }),
    },
  };
}

function reconstructProductionTextStreamerChunks({
  tokenizer,
  inputTokenIds,
  generatedTokenIds,
  skipSpecialTokens,
}: {
  tokenizer: PreTrainedTokenizer,
  inputTokenIds: number[],
  generatedTokenIds: number[],
  skipSpecialTokens: boolean,
}): string[] {
  const chunks: string[] = [];
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: skipSpecialTokens,
    callback_function: (output: string) => chunks.push(output),
  });
  streamer.put([inputTokenIds.map(BigInt)]);
  for (const tokenId of generatedTokenIds) streamer.put([[BigInt(tokenId)]]);
  streamer.end();
  return chunks;
}

const worker: WorkerServerApi<IModelSupportInvestigationWorker> = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback must be a top-level remote argument to remain transferable.
  async runPartialInvestigation(modelId, onEvent, onRunCheckpoint) {
    const run = await runPartialModelSupportInvestigation({
      inspectPersistenceRoundTrip: () => inspectChatPersistenceRoundTrip(),
      runRuntimePreflight: () => runRuntimeIntegrityPreflight({
        modelId,
        assets,
        applicationOrigin: self.location.origin,
        runtimeFetch,
        importRuntimeModule: async ({ url }) => {
          await import(/* @vite-ignore */ url);
        },
        runWasmControl: async () => {
          const session = await InferenceSession.create(createRuntimeControlModelBytes(), {
            executionProviders: ["wasm"],
          });
          try {
            const outputs = await session.run({
              x: new OrtTensor("float32", Float32Array.from([7]), [1]),
            });
            const output = outputs.y;
            if (output === undefined || output.data.length !== 1) {
              throw new Error("ONNX Runtime WASM control did not return the expected output tensor");
            }
            return {
              fixtureId: RUNTIME_CONTROL_FIXTURE_ID,
              fixtureSha256: RUNTIME_CONTROL_FIXTURE_SHA256,
              executionProvider: "wasm",
              status: "passed",
              inputName: "x",
              outputName: "y",
              inputValue: 7,
              outputValue: Number(output.data[0]),
              error: undefined,
            };
          } finally {
            await session.release();
          }
        },
        runWebGpuControl: async () => {
          const hasWebGpu = (navigator as Navigator & { gpu?: unknown }).gpu !== undefined;
          if (!hasWebGpu) {
            return {
              fixtureId: RUNTIME_CONTROL_FIXTURE_ID,
              fixtureSha256: RUNTIME_CONTROL_FIXTURE_SHA256,
              executionProvider: "webgpu",
              status: "not-available",
              inputName: "x",
              outputName: "y",
              inputValue: 7,
              outputValue: undefined,
              error: undefined,
            };
          }
          const session = await InferenceSession.create(createRuntimeControlModelBytes(), {
            executionProviders: ["webgpu"],
          });
          try {
            const outputs = await session.run({
              x: new OrtTensor("float32", Float32Array.from([7]), [1]),
            });
            const output = outputs.y;
            if (output === undefined || output.data.length !== 1) {
              throw new Error("ONNX Runtime WebGPU control did not return the expected output tensor");
            }
            const outputValue = Number(output.data[0]);
            if (outputValue !== 7) {
              throw new Error(`ONNX Runtime WebGPU control returned an unexpected value: ${outputValue}`);
            }
            return {
              fixtureId: RUNTIME_CONTROL_FIXTURE_ID,
              fixtureSha256: RUNTIME_CONTROL_FIXTURE_SHA256,
              executionProvider: "webgpu",
              status: "passed",
              inputName: "x",
              outputName: "y",
              inputValue: 7,
              outputValue,
              error: undefined,
            };
          } finally {
            await session.release();
          }
        },
        inspectEnvironment: () => inspectRuntimeEnvironment({
          navigatorValue: navigator,
          crossOriginIsolatedValue: globalThis.crossOriginIsolated === true,
        }),
        inspectWasmConfiguration: () => {
          const wasm = env.backends.onnx.wasm;
          return {
            numThreads: typeof wasm?.numThreads === "number" ? wasm.numThreads : undefined,
            proxy: typeof wasm?.proxy === "boolean" ? wasm.proxy : undefined,
          };
        },
        onEvent,
        onRunUpdate: ({ run }) => onRunCheckpoint({ run }),
        createRunId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
      }),
      inspectRepository: () => inspectHuggingFaceRepository({
        modelId,
        requestedRevision: "main",
        repositoryFetch: runtimeFetch,
      }),
      inspectCache: async () => inspectModelCache({
        modelId,
        storageRoot: await navigator.storage.getDirectory(),
      }),
      verifyCacheProvenance: async ({ repository, cache }) => verifyModelCacheProvenance({
        inventory: cache,
        repository,
        storageRoot: await navigator.storage.getDirectory(),
        repositoryFetch: runtimeFetch,
        rangeBytes: MODEL_CACHE_PROVENANCE_RANGE_BYTES,
        maximumFileCount: MODEL_CACHE_PROVENANCE_MAXIMUM_FILE_COUNT,
      }),
      inspectDeclarations: ({ repository }) => inspectModelDeclarations({
        repository,
        repositoryFetch: runtimeFetch,
        autoClasses: {
          AutoModel,
          AutoModelForAudioTextToText,
          AutoModelForCausalLM,
          AutoModelForImageTextToText,
          AutoModelForSeq2SeqLM,
          AutoModelForSpeechSeq2Seq,
          AutoModelForVision2Seq,
        },
      }),
      inspectTemplateBehavior: ({ repository }) => inspectTemplateBehavior({
        repository,
        loadTokenizer: async ({ modelId: tokenizerModelId, revision }) => AutoTokenizer.from_pretrained(
          tokenizerModelId,
          {
            ...(revision === undefined ? {} : { revision }),
            local_files_only: true,
          },
        ),
      }),
      inspectModelFilePlan: async ({ repository, declarations, cache }) => {
        const config = new PretrainedConfig(declarations.config);
        return inspectModelFilePlan({
          repository,
          declarations,
          cache,
          getModelFiles: ({ modelId: registryModelId, device, dtype }) => ModelRegistry.get_model_files(
            registryModelId,
            { config, device, dtype },
          ),
        });
      },
      onEvent,
      onRunUpdate: ({ run: updatedRun }) => onRunCheckpoint({ run: toPlanningWorkerRun({ run: updatedRun }) }),
      now: () => new Date().toISOString(),
    });
    return toPlanningWorkerRun({ run });
  },
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callbacks must be top-level remote arguments to remain transferable.
  async runCandidateAttempt(repository, declarations, templateBehavior, candidate, onEvent, onAttemptEvent, onAttemptCheckpoint) {
    // Keep the measured load path identical to normal Chat. Repository SHA
    // resolution is Evidence/provenance metadata, not a second cache namespace.
    const modelLoadProgress = createModelLoadProgressTracker({ candidateId: candidate.candidateId });
    let modelLoadActive = false;
    env.customCache = createOpfsModelCache({
      mutationPolicy: 'read-only',
      onMatchObservation: ({ observation }) => {
        if (!modelLoadActive) return;
        modelLoadProgress.observeCacheMatch({ observation, at: new Date().toISOString() });
      },
    });
    const loadRevision = investigationModelLoadRevision({ requestedRevision: repository.requestedRevision });
    const config = new PretrainedConfig(declarations.config);
    const autoClass = selectGenerationAutoClass({ repository, declarations });
    let candidateTokenizer: PreTrainedTokenizer | undefined;
    const loadCandidateTokenizer = async (): Promise<PreTrainedTokenizer> => {
      candidateTokenizer ??= await AutoTokenizer.from_pretrained(repository.normalizedModelId, {
        ...(loadRevision === undefined ? {} : { revision: loadRevision }),
        local_files_only: true,
      });
      return candidateTokenizer;
    };
    const attempt = await runCandidateLoadAttempt({
      repository,
      declarations,
      templateBehavior,
      candidate,
      autoClass,
      loadDownloadedModel: async ({ onProgressObservation }) => {
        if (autoClass === undefined) {
          throw new Error("No public generative Auto class is available");
        }
        const publishProgress = ({ progress }: {
          progress: NonNullable<ReturnType<typeof modelLoadProgress.flush>>,
        }): void => {
          onProgressObservation({ progress });
          onEvent({
            event: {
              stepId: "loading-investigation",
              status: "running",
              detail: `${candidate.candidateId}: model-load`,
              progress,
            },
          });
        };
        const previousFetch = env.fetch;
        modelLoadActive = true;
        env.fetch = async input => {
          modelLoadProgress.observeRemoteFetchAttempt({ at: new Date().toISOString() });
          return await downloadedModelCacheOnlyFetch(input);
        };
        try {
          return await loadDownloadedCandidateModel({
            autoClass,
            modelId: repository.normalizedModelId,
            revision: loadRevision,
            config,
            device: candidate.device,
            dtype: candidate.dtype,
            onProgress: info => {
              const progress = modelLoadProgress.observe({
                info,
                at: new Date().toISOString(),
                nowMs: performance.now(),
              });
              if (progress === undefined) return;
              publishProgress({ progress });
            },
          });
        } finally {
          modelLoadActive = false;
          env.fetch = previousFetch;
          const finalLoadProgress = modelLoadProgress.flush();
          if (finalLoadProgress !== undefined) publishProgress({ progress: finalLoadProgress });
        }
      },
      observeLoadedModel: ({ model }) => {
        const observation = observeCandidateModel({ model });
        return {
          ...observation,
          sessionFileCorrelations: correlateSessionFiles({
            sessions: observation.sessions,
            files: candidate.files,
          }),
        };
      },
      buildInput: async ({ inputIds, strategy }) => {
        const tokenizer = await loadCandidateTokenizer();
        const input = buildCandidateTextInput({
          tokenizer,
          strategy,
          templateCase: templateBehavior?.cases.find(item => item.caseId === "user-generation"),
          observedInputIds: inputIds,
        });
        return {
          input,
          inputTokenIds: [...input.inputTokenIds],
          tensors: Object.entries(input.modelInputs).map(([name, tensor]) => tensorMetadata({ name, tensor })),
          ...(input.inputText === undefined ? {} : { inputText: input.inputText }),
        };
      },
      generateMinimumToken: async ({ model, input }) => {
        const output = await model.generate({
          ...input.modelInputs,
          max_new_tokens: 1,
          do_sample: false,
        });
        const sequence = generatedSequence({ output });
        const inputTokenCount = input.inputTokenIds.length;
        const generatedTokenIds = model.config.is_encoder_decoder
          ? sequence
          : sequence.slice(inputTokenCount);
        return {
          generatedTokenIds,
          generatedText: input.tokenizer.decode(generatedTokenIds, { skip_special_tokens: false }),
          modelType: typeof model.config.model_type === "string" ? model.config.model_type : undefined,
        };
      },
      generateNaturalBaseline: async ({ model, input }) => {
        const output = await model.generate({
          ...input.modelInputs,
          max_new_tokens: 16,
          do_sample: false,
        });
        const sequence = generatedSequence({ output });
        const inputTokenCount = input.inputTokenIds.length;
        const generatedTokenIds = model.config.is_encoder_decoder
          ? sequence
          : sequence.slice(inputTokenCount);
        return {
          status: "observed",
          forced: false,
          maxNewTokens: 16,
          doSample: false,
          generatedTokenIds,
          generatedText: input.tokenizer.decode(generatedTokenIds, { skip_special_tokens: false }),
          termination: generatedTokenIds.length >= 16 ? "limit-reached" : "ended-before-limit",
        };
      },
      generateToolProtocolProbe: async ({ model, inputTokenIds, forcedTokenIds, inputStrategy }) => {
        const tokenizer = await loadCandidateTokenizer();
        const probeInput = buildCandidateTextInput({
          tokenizer,
          strategy: inputStrategy,
          templateCase: templateBehavior?.cases.find(item => item.caseId === "tools-generation"),
          observedInputIds: inputTokenIds,
        });
        try {
          const output = await model.generate({
            ...probeInput.modelInputs,
            max_new_tokens: forcedTokenIds.length,
            do_sample: false,
            logits_processor: createForcedTokenSequenceLogitsProcessorList({
              promptLength: probeInput.inputTokenIds.length,
              forcedTokenIds,
            }),
          });
          const sequence = generatedSequence({ output });
          const generatedTokenIds = sequence.slice(probeInput.inputTokenIds.length);
          const comparison = compareForcedTokenSequence({
            expected: forcedTokenIds,
            actual: generatedTokenIds,
          });
          const strategy = selectGenerationStrategy({
            modelType: typeof model.config.model_type === "string" ? model.config.model_type : undefined,
            activeModelId: repository.normalizedModelId,
            hasTools: true,
          }).kind;
          let parserObservation;
          let inputChunks: string[] = [];
          try {
            switch (strategy) {
            case "standard":
            case "qwen3_5":
              inputChunks = reconstructProductionTextStreamerChunks({
                tokenizer,
                inputTokenIds: probeInput.inputTokenIds,
                generatedTokenIds,
                skipSpecialTokens: true,
              });
              break;
            case "gpt-oss":
              inputChunks = reconstructProductionTextStreamerChunks({
                tokenizer,
                inputTokenIds: probeInput.inputTokenIds,
                generatedTokenIds,
                skipSpecialTokens: false,
              });
              break;
            case "gemma4":
              break;
            default: {
              const exhaustive: never = strategy;
              return exhaustive;
            }
            }
            parserObservation = observeProductionToolParser({ strategy, inputChunks });
          } catch (error) {
            parserObservation = {
              status: "failed" as const,
              strategy,
              inputChunks,
              error: serializeInvestigationError({ error }),
            };
          }
          const toolResultTemplateRoundTrip = (() => {
            try {
              return observeToolResultTemplateRoundTrip({ tokenizer, parserObservation });
            } catch (error) {
              return { status: "failed" as const, error: serializeInvestigationError({ error }) };
            }
          })();
          return {
            status: "observed",
            forced: true,
            source: "chat-template-render",
            generationCaseId: "tools-generation",
            assistantToolCallCaseId: "assistant-tool-call-history",
            toolResultContinuationCaseId: "tool-result-continuation",
            inputTokenIds: [...probeInput.inputTokenIds],
            forcedTokenIds: [...forcedTokenIds],
            generatedTokenIds,
            generatedText: tokenizer.decode(generatedTokenIds, { skip_special_tokens: false }),
            exactMatch: comparison.exactMatch,
            firstMismatchIndex: comparison.firstMismatchIndex,
            termination: comparison.exactMatch
              ? "complete-forced-sequence"
              : "ended-before-forced-sequence",
            parserObservation,
            toolResultTemplateRoundTrip,
          };
        } finally {
          disposeCandidateTextInput({ input: probeInput });
        }
      },
      disposeInput: async ({ input }) => {
        disposeCandidateTextInput({ input });
      },
      disposeModel: async ({ model }) => {
        await model.dispose();
      },
      onAttemptEvent: ({ event }) => {
        onAttemptEvent({ event });
        onEvent({
          event: {
            stepId: "loading-investigation",
            status: "running",
            detail: event.detail,
          },
        });
      },
      onAttemptUpdate: ({ attempt: checkpoint }) => {
        onAttemptCheckpoint({ attempt: checkpoint });
      },
      now: () => new Date().toISOString(),
      createAttemptId: () => crypto.randomUUID(),
    });
    try {
      const inventory = await inspectModelCache({
        modelId: repository.normalizedModelId,
        storageRoot: await navigator.storage.getDirectory(),
      });
      return {
        ...attempt,
        postAttemptCache: {
          status: "observed",
          inventory,
          requiredFileCoverage: evaluateCandidateRequiredFileCoverage({ candidate, inventory }),
        },
      };
    } catch (error) {
      return {
        ...attempt,
        postAttemptCache: {
          status: "failed",
          error: serializeInvestigationError({ error }),
        },
      };
    }
  },
};

exposeWorkerRemote<IModelSupportInvestigationWorker>({ api: worker, endpoint: undefined });

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
