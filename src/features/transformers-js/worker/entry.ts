/* eslint-disable no-restricted-imports -- Dedicated worker entry intentionally imports transformers.js runtime directly. */
import * as Comlink from 'comlink';
import {
  AutoProcessor,
  AutoTokenizer,
  AutoModelForCausalLM,
  AutoModelForImageTextToText,
  InterruptableStoppingCriteria,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressCallback as TransformersProgressCallback,
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import type {
  ProgressInfo,
  ModelLoadResult,
  ITransformersJsWorker,
  WorkerToolDefinition,
  TransformersJsProductionInvestigationAutoClass,
  TransformersJsProductionInvestigationDtype,
  TransformersJsProductionInvestigationDevice,
  TransformersJsOpaqueStructureSummary,
  TransformersJsProductionInvestigationInputTensorMetadata,
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationProcessor,
  TransformersJsProductionInvestigationTurnObservation,
  TransformersJsProgressCallback,
  TransformersJsPrefetchFailureStage,
  TransformersJsPrefetchFileResult,
  TransformersJsPrefetchResult,
} from '@/features/transformers-js/types';
import {
  isGemma4Model,
  type Gemma4ProcessorLike,
} from '@/features/transformers-js/models/gemma4';
import {
  isQwen3_5Model,
} from '@/features/transformers-js/models/qwen3_5';
import {
  selectGenerationStrategy,
  type GenerationStrategy,
  type GenerationStrategyObservationSink,
  type WorkerGenerationRuntimeState,
} from '@/features/transformers-js/generation-strategies';
import { urlToPath, writeToOpfsWithStaging } from '@/features/transformers-js/utils';
import { configureHostedTransformersRuntime } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { createHostedTransformersModelFetch } from '@/features/transformers-js/runtime/model-fetch';
import { createOpfsModelCache } from '@/features/transformers-js/runtime/opfs-model-cache';
import { promiseAllKeyed } from '@/utils/promise';

/**
 * Internal interface for properties found on Transformers.js model instances
 */
interface ModelInternals {
  device?: string,
  config?: {
    model_type?: string,
  },
}

interface Qwen3_5ProcessorLike {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callable mirrors an external Transformers.js processor signature.
  (text: string): Promise<Record<string, unknown>>,
  tokenizer: PreTrainedTokenizer,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this method mirrors an external Transformers.js tokenizer signature.
  batch_decode(sequences: unknown, options: { skip_special_tokens: boolean }): string[],
}

interface AutoModelWithSupports {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callback mirrors an external Transformers.js model signature.
  supports?: (modelType: string) => boolean,
}

const QWEN_DEBUG_PREFIX = '[naidan-qwen-debug]';

// Intercept fetch to handle SPA 404 fallback and enforce local-only constraints.
// ONNX Runtime MJS/WASM is configured before model traffic so it can never
// silently fall back to the external default CDN.
const originalFetch = self.fetch;
const { runtimeFetch } = configureHostedTransformersRuntime({
  env,
  workerLocationUrl: self.location.href,
  environment: import.meta.env.DEV ? 'development' : 'production',
  userAgent: navigator.userAgent,
  vendor: navigator.vendor,
  hardwareConcurrency: navigator.hardwareConcurrency,
  originalFetch,
  createDecompressionStream: () => new DecompressionStream('gzip'),
});
const interceptedFetch = createHostedTransformersModelFetch({ runtimeFetch });
self.fetch = interceptedFetch;
env.fetch = interceptedFetch;

// Configure environment
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = false;
// Reduce log verbosity for performance
env.backends.onnx.logLevel = 'error';

function sanitizePrefetchUrl({ url }: { url: string }): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split(/[?#]/u, 1)[0] ?? url;
  }
}

function fileNameFromUrl({ url }: { url: string }): string | undefined {
  try {
    const pathParts = new URL(url).pathname.split('/');
    return pathParts.at(-1) || undefined;
  } catch {
    return url.split(/[?#]/u, 1)[0]?.split('/').at(-1) || undefined;
  }
}

function parseExpectedByteLength({ response }: { response: Response }): number | undefined {
  const rawValue = response.headers.get('content-length');
  if (rawValue === null) return undefined;
  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function serializePrefetchError({ error }: { error: unknown }): { name: string, message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: 'NonErrorThrownValue',
    message: typeof error === 'string' ? error : 'A non-Error value was thrown',
  };
}

function createPrefetchFailure({
  url,
  path,
  failureStage,
  httpStatus,
  error,
}: {
  url: string,
  path: string | undefined,
  failureStage: TransformersJsPrefetchFailureStage,
  httpStatus?: number,
  error: unknown,
}): Extract<TransformersJsPrefetchFileResult, { status: 'failed' }> {
  return {
    status: 'failed',
    url,
    path,
    failureStage,
    httpStatus,
    error: serializePrefetchError({ error }),
  };
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

async function removeOpfsEntryIfPresent({ directory, name }: {
  directory: FileSystemDirectoryHandle,
  name: string,
}): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (isNotFoundError({ error })) return;
    throw error;
  }
}

async function getCompletedOpfsByteLength({ path }: { path: string }): Promise<number | undefined> {
  const pathParts = path.split('/');
  const fileName = pathParts.pop();
  if (!fileName) return undefined;

  const root = await navigator.storage.getDirectory();
  let currentDir = root;
  for (const part of pathParts) {
    if (!part) continue;
    try {
      currentDir = await currentDir.getDirectoryHandle(part, { create: false });
    } catch (error) {
      if (isNotFoundError({ error })) return undefined;
      throw error;
    }
  }

  const markerName = `.${fileName}.complete`;
  try {
    await currentDir.getFileHandle(markerName, { create: false });
  } catch (error) {
    if (isNotFoundError({ error })) return undefined;
    throw error;
  }

  let file: File;
  try {
    const fileHandle = await currentDir.getFileHandle(fileName, { create: false });
    file = await fileHandle.getFile();
  } catch (error) {
    if (!isNotFoundError({ error })) throw error;
    await removeOpfsEntryIfPresent({ directory: currentDir, name: markerName });
    return undefined;
  }

  if (file.size > 0) return file.size;
  await removeOpfsEntryIfPresent({ directory: currentDir, name: markerName });
  await removeOpfsEntryIfPresent({ directory: currentDir, name: fileName });
  return undefined;
}

const opfsCache = createOpfsModelCache();

// Enable custom cache
env.useCustomCache = true;
env.customCache = opfsCache;
env.fetch = interceptedFetch;


// Singleton state
let model: PreTrainedModel | null = null;
let tokenizer: PreTrainedTokenizer | null = null;
let gemma4Processor: Gemma4ProcessorLike | null = null;
let qwen3_5Processor: Qwen3_5ProcessorLike | null = null;
let activeModelId: string | null = null;
const generationRuntimeState: WorkerGenerationRuntimeState = {
  activeModelId: null,
  gemma4Processor: null,
  qwen3_5Processor: null,
  gptOssPastKeyValues: null,
  qwen3_5PastKeyValues: null,
  qwen3_5ConversationState: undefined,
};
const stoppingCriteria = new InterruptableStoppingCriteria();

async function withModelAccessMode<T>({
  isLocal,
  run,
}: {
  isLocal: boolean,
  run: () => Promise<T>,
}): Promise<T> {
  const previousAllowLocalModels = env.allowLocalModels;
  env.allowLocalModels = isLocal;
  try {
    return await run();
  } finally {
    env.allowLocalModels = previousAllowLocalModels;
  }
}

function debugLog({ event, details }: { event: string, details: Record<string, unknown> }): void {
  console.log(`${QWEN_DEBUG_PREFIX} ${event}`, {
    at: new Date().toISOString(),
    ...details,
  });
}

function clearQwen3_5ContinuationState(): void {
  generationRuntimeState.qwen3_5ConversationState = undefined;
}

function resetGenerationContinuationState(): void {
  generationRuntimeState.gptOssPastKeyValues = null;
  generationRuntimeState.qwen3_5PastKeyValues = null;
  clearQwen3_5ContinuationState();
  stoppingCriteria.reset();
}

function assertGemma4RuntimeSupport({ modelId }: { modelId: string }): void {
  if (!isGemma4Model({
    modelType: undefined,
    activeModelId: modelId,
  })) {
    return;
  }

  const autoModel = AutoModelForImageTextToText as AutoModelWithSupports;
  if (typeof autoModel.supports === 'function' && autoModel.supports('gemma4')) {
    return;
  }

  throw new Error(
    'The active @huggingface/transformers runtime does not support gemma4. ' +
    'If you just upgraded dependencies, restart the Vite dev server so it rebuilds its optimized dependency cache.',
  );
}

type ProductionLoadCandidate = {
  device: TransformersJsProductionInvestigationDevice,
  dtype: TransformersJsProductionInvestigationDtype,
};

type ProductionLoadRoute = {
  cleanModelId: string,
  autoClass: TransformersJsProductionInvestigationAutoClass,
  processor: TransformersJsProductionInvestigationProcessor,
  candidate: ProductionLoadCandidate,
};

function normalizeProductionModelId({ modelId }: { modelId: string }): string {
  if (modelId.startsWith('hf.co/')) return modelId.substring(6);
  if (modelId.startsWith('https://huggingface.co/')) return modelId.substring(23);
  return modelId;
}

function selectProductionAutoClass({ modelId }: {
  modelId: string,
}): TransformersJsProductionInvestigationAutoClass {
  return isGemma4Model({ modelType: undefined, activeModelId: modelId })
    ? 'AutoModelForImageTextToText'
    : 'AutoModelForCausalLM';
}

async function loadProductionModelCandidate({
  cleanModelId,
  isLocal,
  autoClass,
  candidate,
  revision,
  progressCallback,
}: {
  cleanModelId: string,
  isLocal: boolean,
  autoClass: TransformersJsProductionInvestigationAutoClass,
  candidate: ProductionLoadCandidate,
  revision: string | undefined,
  progressCallback: TransformersProgressCallback,
}): Promise<PreTrainedModel> {
  const options = {
    dtype: candidate.dtype,
    device: candidate.device,
    progress_callback: progressCallback,
    local_files_only: isLocal,
    ...(revision === undefined ? {} : { revision }),
  };
  switch (autoClass) {
  case 'AutoModelForImageTextToText':
    return await AutoModelForImageTextToText.from_pretrained(cleanModelId, options);
  case 'AutoModelForCausalLM':
    return await AutoModelForCausalLM.from_pretrained(cleanModelId, options);
  default: {
    const _ex: never = autoClass;
    throw new Error(`Unhandled production Auto class: ${_ex}`);
  }
  }
}

async function loadProductionTokenizerOrProcessor({
  cleanModelId,
  isLocal,
  revision,
  progressCallback,
}: {
  cleanModelId: string,
  isLocal: boolean,
  revision: string | undefined,
  progressCallback: TransformersProgressCallback,
}): Promise<TransformersJsProductionInvestigationProcessor> {
  if (model === null) throw new Error('Production model is not loaded');
  const sharedOptions = {
    progress_callback: progressCallback,
    local_files_only: isLocal,
    ...(revision === undefined ? {} : { revision }),
  };
  if (isGemma4Model({
    modelType: (model as ModelInternals).config?.model_type,
    activeModelId: cleanModelId,
  })) {
    gemma4Processor = await AutoProcessor.from_pretrained(cleanModelId, sharedOptions) as unknown as Gemma4ProcessorLike;
    generationRuntimeState.gemma4Processor = gemma4Processor;
    tokenizer = gemma4Processor.tokenizer;
    return 'gemma4-processor';
  }
  if (isQwen3_5Model({
    modelType: (model as ModelInternals).config?.model_type,
    activeModelId: cleanModelId,
  })) {
    qwen3_5Processor = await AutoProcessor.from_pretrained(cleanModelId, sharedOptions) as unknown as Qwen3_5ProcessorLike;
    generationRuntimeState.qwen3_5Processor = qwen3_5Processor;
    tokenizer = qwen3_5Processor.tokenizer;
    return 'qwen3_5-processor';
  }
  tokenizer = await AutoTokenizer.from_pretrained(cleanModelId, sharedOptions);
  return 'tokenizer';
}

async function loadProductionRuntime({
  modelId,
  revision,
  candidates,
  progressCallback,
}: {
  modelId: string,
  revision: string | undefined,
  candidates: ProductionLoadCandidate[],
  progressCallback: TransformersJsProgressCallback,
}): Promise<ProductionLoadRoute> {
  const cleanModelId = normalizeProductionModelId({ modelId });
  const isLocal = cleanModelId.startsWith('user/');
  const autoClass = selectProductionAutoClass({ modelId: cleanModelId });
  assertGemma4RuntimeSupport({ modelId: cleanModelId });
  const rawProgressCallback: TransformersProgressCallback = info => progressCallback({ info });

  return await withModelAccessMode({
    isLocal,
    run: async () => {
      let selectedCandidate: ProductionLoadCandidate | undefined;
      let lastError: unknown;
      for (const candidate of candidates) {
        const startedAt = performance.now();
        debugLog({
          event: 'worker tryLoad start',
          details: {
            activeModelId: cleanModelId,
            revision,
            autoClass,
            device: candidate.device,
            dtype: candidate.dtype,
          },
        });
        try {
          model = await loadProductionModelCandidate({
            cleanModelId,
            isLocal,
            autoClass,
            candidate,
            revision,
            progressCallback: rawProgressCallback,
          });
          selectedCandidate = candidate;
          debugLog({
            event: 'worker tryLoad success',
            details: {
              activeModelId: cleanModelId,
              revision,
              autoClass,
              device: candidate.device,
              dtype: candidate.dtype,
              elapsedMs: Math.round(performance.now() - startedAt),
            },
          });
          break;
        } catch (error) {
          lastError = typeof error === 'number' ? new Error(`Numeric error ${error}`) : error;
          debugLog({
            event: 'worker tryLoad failure',
            details: {
              activeModelId: cleanModelId,
              revision,
              autoClass,
              device: candidate.device,
              dtype: candidate.dtype,
              elapsedMs: Math.round(performance.now() - startedAt),
              error: lastError instanceof Error ? lastError.message : String(lastError),
            },
          });
        }
      }

      if (model === null || selectedCandidate === undefined) {
        throw lastError instanceof Error ? lastError : new Error('No production load candidate succeeded');
      }

      const processor = await loadProductionTokenizerOrProcessor({
        cleanModelId,
        isLocal,
        revision,
        progressCallback: rawProgressCallback,
      });

      return {
        cleanModelId,
        autoClass,
        processor,
        candidate: selectedCandidate,
      };
    },
  });
}

function numberArrayFromTensorLike({ value }: { value: unknown }): number[] {
  if (value === undefined || value === null || typeof value !== 'object') return [];
  const data = Reflect.get(value, 'data');
  if (data === undefined || data === null || typeof data !== 'object') return [];
  if (!ArrayBuffer.isView(data)) return [];
  return Array.from(data as unknown as ArrayLike<number | bigint>, item => Number(item));
}

function inputTensorMetadata({ inputs }: {
  inputs: Record<string, unknown>,
}): TransformersJsProductionInvestigationInputTensorMetadata[] {
  return Object.entries(inputs).flatMap(([name, value]) => {
    if (value === null || typeof value !== 'object') return [];
    const dims = Reflect.get(value, 'dims');
    if (!Array.isArray(dims) || !dims.every(item => typeof item === 'number')) return [];
    const dtype = Reflect.get(value, 'type');
    const location = Reflect.get(value, 'location');
    return [{
      name,
      dtype: typeof dtype === 'string' ? dtype : undefined,
      dims: [...dims],
      location: typeof location === 'string' ? location : undefined,
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function generatedSequenceTokenIds({ result }: { result: unknown }): number[] {
  if (result === undefined || result === null || typeof result !== 'object') return [];
  return numberArrayFromTensorLike({ value: Reflect.get(result, 'sequences') });
}

function opaqueStructureSummary({ value }: { value: unknown }): TransformersJsOpaqueStructureSummary {
  if (value === undefined || value === null) {
    return {
      kind: 'nullish',
      valueType: value === null ? 'null' : 'undefined',
      constructorName: undefined,
      ownKeyCount: 0,
      ownKeys: [],
      arrayLength: undefined,
      truncated: false,
    };
  }
  if (typeof value !== 'object') {
    return {
      kind: 'primitive',
      valueType: typeof value,
      constructorName: undefined,
      ownKeyCount: 0,
      ownKeys: [],
      arrayLength: undefined,
      truncated: false,
    };
  }

  let ownKeys: string[] = [];
  let constructorName: string | undefined;
  try {
    ownKeys = Reflect.ownKeys(value).map(key => String(key));
    const constructor = Reflect.get(value, 'constructor');
    const name = constructor === undefined || constructor === null
      ? undefined
      : Reflect.get(constructor, 'name');
    constructorName = typeof name === 'string' ? name : undefined;
  } catch {
    ownKeys = [];
  }
  const maximumRecordedKeys = 32;
  return {
    kind: Array.isArray(value) ? 'array' : 'object',
    valueType: typeof value,
    constructorName,
    ownKeyCount: ownKeys.length,
    ownKeys: ownKeys.slice(0, maximumRecordedKeys),
    arrayLength: Array.isArray(value) ? value.length : undefined,
    truncated: ownKeys.length > maximumRecordedKeys,
  };
}

async function runObservedProductionTurn({
  loadedModel,
  loadedTokenizer,
  strategy,
  messages,
  maxNewTokens,
  isEncoderDecoder,
  tools,
  reasoningEffort = undefined,
}: {
  loadedModel: PreTrainedModel,
  loadedTokenizer: PreTrainedTokenizer,
  strategy: GenerationStrategy,
  messages: ChatMessage[],
  maxNewTokens: 1 | 16,
  isEncoderDecoder: boolean,
  tools: WorkerToolDefinition[] | undefined,
  reasoningEffort?: LmParameters["reasoning"]["effort"],
}): Promise<TransformersJsProductionInvestigationTurnObservation> {
  const streamChunks: string[] = [];
  const toolCalls: ToolCall[] = [];
  let inputKeys: string[] = [];
  let inputTensors: TransformersJsProductionInvestigationInputTensorMetadata[] = [];
  let inputTokenIds: number[] = [];
  let pastKeyValuesProvided = false;
  let inputPastKeyValuesSummary = opaqueStructureSummary({ value: undefined });
  let outputPastKeyValuesSummary = opaqueStructureSummary({ value: undefined });
  let sequenceTokenIds: number[] = [];

  const observationSink: GenerationStrategyObservationSink = {
    onGenerateStart({ inputs, pastKeyValues }) {
      inputKeys = Object.keys(inputs).sort();
      inputTensors = inputTensorMetadata({ inputs });
      inputTokenIds = numberArrayFromTensorLike({ value: inputs['input_ids'] });
      pastKeyValuesProvided = pastKeyValues !== null && pastKeyValues !== undefined;
      inputPastKeyValuesSummary = opaqueStructureSummary({ value: pastKeyValues });
    },
    onGenerateComplete({ result }) {
      sequenceTokenIds = generatedSequenceTokenIds({ result });
      outputPastKeyValuesSummary = opaqueStructureSummary({ value: Reflect.get(result, 'past_key_values') });
    },
  };

  stoppingCriteria.reset();
  await strategy.generate({
    model: loadedModel,
    tokenizer: loadedTokenizer,
    messages,
    onChunk: ({ chunk }) => streamChunks.push(chunk),
    onToolCalls: ({ toolCalls: observedToolCalls }) => toolCalls.push(...observedToolCalls),
    params: {
      temperature: 0,
      topP: 1,
      maxCompletionTokens: maxNewTokens,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: { effort: reasoningEffort },
    },
    tools,
    runtimeState: generationRuntimeState,
    stoppingCriteria,
    debugLog,
    observationSink,
  });

  const generatedTokenIds = isEncoderDecoder
    ? sequenceTokenIds
    : sequenceTokenIds.slice(inputTokenIds.length);
  return {
    messages,
    inputKeys,
    inputTensors,
    inputTokenIds,
    pastKeyValuesProvided,
    inputPastKeyValuesSummary,
    outputPastKeyValuesSummary,
    generatedSequenceTokenIds: sequenceTokenIds,
    generatedTokenIds,
    generatedText: generatedTokenIds.length > 0
      ? loadedTokenizer.decode(generatedTokenIds, { skip_special_tokens: false })
      : streamChunks.join(''),
    streamChunks,
    toolCalls,
    effectiveGenerationConfig: {
      maxNewTokens,
      temperature: 0,
      topP: 1,
      doSample: false,
    },
  };
}

// ---------------------------------------------------------------------------

const transformersJsWorker: ITransformersJsWorker = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  async downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void) {
    console.log('[transformersJsWorker] Starting downloadModel:', modelId);
    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('user/');

    await withModelAccessMode({
      isLocal,
      run: async () => {
        // Downloading should only warm the cache. Session creation during download
        // can poison the active runtime if ORT rejects a model/operator combination.
        await AutoTokenizer.from_pretrained(cleanModelId, {
          progress_callback: progressCallback,
          local_files_only: isLocal,
        });
      },
    });
    console.log('[transformersJsWorker] Download complete.');
  },

  /**
   * Directly downloads model files to OPFS via streaming fetch, bypassing
   * transformers.js's internal loader to prevent Out-of-Memory (OOM) errors
   * for large assets. This is called after the scanner has identified
   * all necessary URLs.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  async prefetchUrls(urls: string[], progressCallback: (x: ProgressInfo) => void): Promise<TransformersJsPrefetchResult> {
    console.log(`[transformersJsWorker] Starting prefetch of ${urls.length} URLs.`);
    const files: TransformersJsPrefetchFileResult[] = [];

    for (const originalUrl of urls) {
      const url = sanitizePrefetchUrl({ url: originalUrl });
      const path = urlToPath({ url: originalUrl });
      if (!path) {
        files.push(createPrefetchFailure({
          url,
          path: undefined,
          failureStage: 'resolve-path',
          error: new Error('The model URL could not be mapped to an OPFS path'),
        }));
        continue;
      }

      let cachedByteLength: number | undefined;
      try {
        cachedByteLength = await getCompletedOpfsByteLength({ path });
      } catch (error) {
        files.push(createPrefetchFailure({
          url,
          path,
          failureStage: 'cache-check',
          error,
        }));
        continue;
      }
      if (cachedByteLength !== undefined) {
        console.debug(`[transformersJsWorker] Already cached: ${path}`);
        files.push({
          status: 'cached',
          url,
          path,
          byteLength: cachedByteLength,
          expectedByteLength: undefined,
        });
        continue;
      }

      console.log(`[transformersJsWorker] Prefetching: ${url}`);
      let response: Response;
      try {
        response = await originalFetch(originalUrl);
      } catch (error) {
        files.push(createPrefetchFailure({ url, path, failureStage: 'fetch', error }));
        continue;
      }
      if (!response.ok) {
        files.push(createPrefetchFailure({
          url,
          path,
          failureStage: 'response-status',
          httpStatus: response.status,
          error: new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`),
        }));
        continue;
      }
      if (response.body === null) {
        files.push(createPrefetchFailure({
          url,
          path,
          failureStage: 'fetch',
          httpStatus: response.status,
          error: new Error('The model response did not include a readable body'),
        }));
        continue;
      }

      const expectedByteLength = parseExpectedByteLength({ response });
      let loaded = 0;
      const transformStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          progressCallback({
            status: 'progress',
            file: fileNameFromUrl({ url: originalUrl }),
            loaded,
            total: expectedByteLength,
          });
          controller.enqueue(chunk);
        },
      });
      const progressResponse = new Response(response.body.pipeThrough(transformStream), {
        headers: response.headers,
      });

      let writtenByteLength: number;
      try {
        ({ byteLength: writtenByteLength } = await writeToOpfsWithStaging({ path, response: progressResponse }));
      } catch (error) {
        files.push(createPrefetchFailure({
          url,
          path,
          failureStage: 'write',
          httpStatus: response.status,
          error,
        }));
        continue;
      }

      try {
        const verifiedByteLength = await getCompletedOpfsByteLength({ path });
        if (verifiedByteLength === undefined || verifiedByteLength !== writtenByteLength) {
          throw new Error(`Final OPFS verification failed for ${path}`);
        }
        if (expectedByteLength !== undefined && verifiedByteLength !== expectedByteLength) {
          throw new Error(`Final OPFS byte length mismatch for ${path}: expected ${expectedByteLength}, received ${verifiedByteLength}`);
        }
        files.push({
          status: 'downloaded',
          url,
          path,
          byteLength: verifiedByteLength,
          expectedByteLength,
        });
        console.log(`[transformersJsWorker] Prefetched and saved: ${path}`);
      } catch (error) {
        files.push(createPrefetchFailure({
          url,
          path,
          failureStage: 'verification',
          httpStatus: response.status,
          error,
        }));
      }
    }

    const cachedCount = files.filter(file => file.status === 'cached').length;
    const downloadedCount = files.filter(file => file.status === 'downloaded').length;
    const failedCount = files.filter(file => file.status === 'failed').length;
    return {
      requestedCount: urls.length,
      cachedCount,
      downloadedCount,
      failedCount,
      complete: files.length === urls.length && failedCount === 0,
      files,
    };
  },

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  async loadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<ModelLoadResult> {
    console.log('[transformersJsWorker] Starting loadModel:', modelId);

    await this.unloadModel();
    activeModelId = modelId;
    generationRuntimeState.activeModelId = modelId;

    const cleanModelId = normalizeProductionModelId({ modelId });
    const isLocal = cleanModelId.startsWith('user/');
    const autoClass = selectProductionAutoClass({ modelId: cleanModelId });
    let loadedDevice: TransformersJsProductionInvestigationDevice = 'wasm';

    try {
      assertGemma4RuntimeSupport({ modelId: cleanModelId });

      await withModelAccessMode({
        isLocal,
        run: async () => {
          const tryLoad = async ({ candidate }: { candidate: ProductionLoadCandidate }): Promise<PreTrainedModel> => {
            const startedAt = performance.now();
            debugLog({
              event: 'worker tryLoad start',
              details: {
                activeModelId: cleanModelId,
                device: candidate.device,
                dtype: candidate.dtype,
              },
            });
            try {
              const loadedModel = await loadProductionModelCandidate({
                cleanModelId,
                isLocal,
                autoClass,
                candidate,
                revision: undefined,
                progressCallback,
              });
              loadedDevice = candidate.device;
              debugLog({
                event: 'worker tryLoad success',
                details: {
                  activeModelId: cleanModelId,
                  device: candidate.device,
                  dtype: candidate.dtype,
                  elapsedMs: Math.round(performance.now() - startedAt),
                },
              });
              return loadedModel;
            } catch (error) {
              debugLog({
                event: 'worker tryLoad failure',
                details: {
                  activeModelId: cleanModelId,
                  device: candidate.device,
                  dtype: candidate.dtype,
                  elapsedMs: Math.round(performance.now() - startedAt),
                  error: error instanceof Error ? error.message : String(error),
                },
              });
              if (typeof error === 'number') throw new Error(`Numeric error ${error}`);
              throw error;
            }
          };

          try {
            model = await tryLoad({ candidate: { device: 'webgpu', dtype: 'q4f16' } });
          } catch (error) {
            console.warn('[transformersJsWorker] webgpu/q4f16 failed:', error);
            try {
              model = await tryLoad({ candidate: { device: 'webgpu', dtype: 'q4' } });
            } catch (secondError) {
              console.warn('[transformersJsWorker] webgpu/q4 failed, falling back to wasm/q4:', secondError);
              model = await tryLoad({ candidate: { device: 'wasm', dtype: 'q4' } });
            }
          }
          console.log('[transformersJsWorker] Model loaded successfully.');

          await loadProductionTokenizerOrProcessor({
            cleanModelId,
            isLocal,
            revision: undefined,
            progressCallback,
          });
        },
      });

      return { device: loadedDevice };
    } catch (error) {
      const errorMessage = typeof error === 'number'
        ? `Low-level engine error (code ${error}). This usually means memory allocation failed or the model format is incompatible.`
        : (error instanceof Error ? error.message : String(error));
      console.error('[transformersJsWorker] Detailed load error:', error, errorMessage);
      throw new Error(errorMessage);
    }
  },

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback must be a top-level remote argument to remain transferable.
  async runModelSupportInvestigationScenario(scenario, progressCallback): Promise<TransformersJsProductionInvestigationObservation> {
    await this.unloadModel();
    env.customCache = createOpfsModelCache({ revisionAliases: scenario.cacheRevisionAliases });
    activeModelId = scenario.modelId;
    generationRuntimeState.activeModelId = scenario.modelId;

    try {
      const {
        errorSerialization,
        continuityClassification,
        tokenComparison,
        toolProtocolFixture,
      } = await promiseAllKeyed({
        errorSerialization: import('@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error'),
        continuityClassification: import('@/features/transformers-js/model-support-investigation/logic/classify-continuity-prefix'),
        tokenComparison: import('@/features/transformers-js/model-support-investigation/logic/compare-token-sequences'),
        toolProtocolFixture: import('@/features/transformers-js/model-support-investigation/logic/tool-protocol-fixture'),
      });
      const { serializeInvestigationError } = errorSerialization;
      const { classifyContinuityPrefix } = continuityClassification;
      const { compareTokenSequences } = tokenComparison;
      const { createModelSupportToolResultContinuationMessages, MODEL_SUPPORT_TOOL_DEFINITIONS } = toolProtocolFixture;
      progressCallback({ info: { status: 'model-support-production-model-load' } });
      const route = await loadProductionRuntime({
        modelId: scenario.modelId,
        revision: scenario.resolvedRevision,
        candidates: [scenario.candidate],
        progressCallback,
      });
      const loadedModel = model;
      const loadedTokenizer = tokenizer;
      if (loadedModel === null || loadedTokenizer === null) {
        throw new Error('Production runtime did not retain the loaded model and tokenizer');
      }

      const modelType = (loadedModel as ModelInternals).config?.model_type;
      const strategy = selectGenerationStrategy({
        modelType,
        activeModelId,
        hasTools: false,
      });
      const isEncoderDecoder = Reflect.get(Reflect.get(loadedModel, 'config') ?? {}, 'is_encoder_decoder') === true;
      progressCallback({ info: { status: 'model-support-production-first-turn' } });
      const firstTurn = await runObservedProductionTurn({
        loadedModel,
        loadedTokenizer,
        strategy,
        messages: scenario.messages,
        maxNewTokens: scenario.maxNewTokens,
        isEncoderDecoder,
        tools: undefined,
      });
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: firstTurn.generatedText,
      };
      const secondTurnMessages = [
        ...scenario.messages,
        assistantMessage,
        scenario.followUpMessage,
      ];

      let continuity: TransformersJsProductionInvestigationObservation['continuity'];
      progressCallback({ info: { status: 'model-support-production-continuity' } });
      try {
        const secondTurn = await runObservedProductionTurn({
          loadedModel,
          loadedTokenizer,
          strategy,
          messages: secondTurnMessages,
          maxNewTokens: scenario.maxNewTokens,
          isEncoderDecoder,
          tools: undefined,
        });
        const prefixComparison = classifyContinuityPrefix({
          isEncoderDecoder,
          firstGeneratedSequenceTokenIds: firstTurn.generatedSequenceTokenIds,
          secondInputTokenIds: secondTurn.inputTokenIds,
          secondTurnPastKeyValuesProvided: secondTurn.pastKeyValuesProvided,
        });
        continuity = {
          status: 'passed',
          assistantMessage,
          followUpMessage: scenario.followUpMessage,
          secondTurn,
          prefixComparison,
        };
      } catch (error) {
        const serialized = serializeInvestigationError({ error, maxLength: 1024 });
        continuity = {
          status: 'failed',
          assistantMessage,
          followUpMessage: scenario.followUpMessage,
          error: {
            name: serialized.name,
            message: serialized.message,
          },
        };
      }

      const toolResultContinuation = await (async (): Promise<TransformersJsProductionInvestigationObservation['toolResultContinuation']> => {
        const continuationScenario = scenario.toolResultContinuation;
        if (continuationScenario === undefined) {
          return {
            status: 'not-run',
            reason: 'Reference parser-to-template tool-result continuation evidence was unavailable',
          };
        }
        progressCallback({ info: { status: 'model-support-production-tool-result-continuation' } });
        resetGenerationContinuationState();
        const messages = createModelSupportToolResultContinuationMessages({
          toolCall: continuationScenario.toolCall,
          toolResultContent: continuationScenario.toolResultContent,
        });
        const toolStrategy = selectGenerationStrategy({
          modelType,
          activeModelId,
          hasTools: true,
        });
        try {
          const turn = await runObservedProductionTurn({
            loadedModel,
            loadedTokenizer,
            strategy: toolStrategy,
            messages,
            maxNewTokens: continuationScenario.maxNewTokens,
            isEncoderDecoder,
            tools: MODEL_SUPPORT_TOOL_DEFINITIONS,
          });
          const comparison = compareTokenSequences({
            expected: continuationScenario.expectedInputTokenIds,
            actual: turn.inputTokenIds,
          });
          return {
            status: 'passed',
            source: 'reference-parser-roundtrip',
            strategy: toolStrategy.kind,
            messages,
            expectedInputTokenIds: continuationScenario.expectedInputTokenIds,
            inputTokenExactMatch: comparison.exactMatch,
            firstInputMismatchIndex: comparison.firstMismatchIndex,
            turn,
          };
        } catch (error) {
          const serialized = serializeInvestigationError({ error, maxLength: 1024 });
          return {
            status: 'failed',
            source: 'reference-parser-roundtrip',
            strategy: toolStrategy.kind,
            messages,
            expectedInputTokenIds: continuationScenario.expectedInputTokenIds,
            error: {
              name: serialized.name,
              message: serialized.message,
            },
          };
        }
      })();

      progressCallback({ info: { status: 'model-support-production-reasoning-differential' } });
      const reasoning: TransformersJsProductionInvestigationObservation['reasoning'] = await (async () => {
        switch (strategy.kind) {
        case 'standard':
        case 'gpt-oss':
        case 'gemma4':
          return {
            status: 'unavailable',
            reason: `The existing ${strategy.kind} Production strategy does not map Naidan reasoning effort to a model prompt.`,
          };
        case 'qwen3_5':
          break;
        default: {
          const _ex: never = strategy.kind;
          throw new Error(`Unhandled Production reasoning strategy: ${_ex}`);
        }
        }

        resetGenerationContinuationState();
        let disabledTurn: TransformersJsProductionInvestigationTurnObservation;
        try {
          disabledTurn = await runObservedProductionTurn({
            loadedModel,
            loadedTokenizer,
            strategy,
            messages: scenario.messages,
            maxNewTokens: 1,
            isEncoderDecoder,
            tools: undefined,
            reasoningEffort: 'none',
          });
        } catch (error) {
          const serialized = serializeInvestigationError({ error, maxLength: 1024 });
          return {
            status: 'failed',
            source: 'existing-production-strategy',
            strategy: 'qwen3_5',
            failedEffort: 'none',
            disabledTurn: undefined,
            error: { name: serialized.name, message: serialized.message },
          };
        }

        resetGenerationContinuationState();
        try {
          const enabledTurn = await runObservedProductionTurn({
            loadedModel,
            loadedTokenizer,
            strategy,
            messages: scenario.messages,
            maxNewTokens: 1,
            isEncoderDecoder,
            tools: undefined,
            reasoningEffort: 'high',
          });
          const comparison = compareTokenSequences({
            expected: disabledTurn.inputTokenIds,
            actual: enabledTurn.inputTokenIds,
          });
          return {
            status: 'observed',
            source: 'existing-production-strategy',
            strategy: 'qwen3_5',
            disabledEffort: 'none',
            enabledEffort: 'high',
            disabledTurn,
            enabledTurn,
            inputTokenExactMatch: comparison.exactMatch,
            firstInputMismatchIndex: comparison.firstMismatchIndex,
          };
        } catch (error) {
          const serialized = serializeInvestigationError({ error, maxLength: 1024 });
          return {
            status: 'failed',
            source: 'existing-production-strategy',
            strategy: 'qwen3_5',
            failedEffort: 'high',
            disabledTurn,
            error: { name: serialized.name, message: serialized.message },
          };
        }
      })();

      progressCallback({ info: { status: 'model-support-production-multimodal' } });
      const multimodal: TransformersJsProductionInvestigationObservation['multimodal'] = await (async () => {
        switch (strategy.kind) {
        case 'gemma4': {
          const {
            dataUrl,
            prompt,
            maxNewTokens,
            ...fixture
          } = scenario.multimodalFixture;
          resetGenerationContinuationState();
          try {
            const turn = await runObservedProductionTurn({
              loadedModel,
              loadedTokenizer,
              strategy,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              }],
              maxNewTokens,
              isEncoderDecoder,
              tools: undefined,
              reasoningEffort: undefined,
            });
            return {
              status: 'observed',
              source: 'fixed-synthetic-fixture-and-existing-production-strategy',
              strategy: 'gemma4',
              fixture: { ...fixture, prompt, maxNewTokens },
              turn,
            };
          } catch (error) {
            const serialized = serializeInvestigationError({ error, maxLength: 1024 });
            return {
              status: 'failed',
              source: 'fixed-synthetic-fixture-and-existing-production-strategy',
              strategy: 'gemma4',
              fixture: { ...fixture, prompt, maxNewTokens },
              error: { name: serialized.name, message: serialized.message },
            };
          }
        }
        case 'qwen3_5':
          return {
            status: 'unavailable',
            strategy: 'qwen3_5',
            reason: 'The existing Qwen3.5 Production strategy serializes multimodal message parts into text and does not pass fixed image bytes to its processor.',
          };
        case 'standard':
        case 'gpt-oss':
          return {
            status: 'unavailable',
            strategy: strategy.kind,
            reason: `The existing ${strategy.kind} Production strategy does not load an image processor.`,
          };
        default: {
          const _ex: never = strategy.kind;
          throw new Error(`Unhandled Production multimodal strategy: ${_ex}`);
        }
        }
      })();

      progressCallback({ info: { status: 'model-support-production-complete' } });
      return {
        modelId: scenario.modelId,
        resolvedRevision: scenario.resolvedRevision,
        candidate: scenario.candidate,
        route: {
          autoClass: route.autoClass,
          processor: route.processor,
          strategy: strategy.kind,
          modelType,
        },
        isEncoderDecoder,
        ...firstTurn,
        continuity,
        toolResultContinuation,
        reasoning,
        multimodal,
      };
    } finally {
      env.customCache = opfsCache;
      await this.unloadModel();
    }
  },

  async unloadModel() {
    if (model) {
      await model.dispose();
      model = null;
    }
    gemma4Processor = null;
    generationRuntimeState.gemma4Processor = null;
    qwen3_5Processor = null;
    generationRuntimeState.qwen3_5Processor = null;
    tokenizer = null;
    resetGenerationContinuationState();
    activeModelId = null;
    generationRuntimeState.activeModelId = null;
  },

  async interrupt() {
    stoppingCriteria.interrupt();
  },

  async resetCache() {
    resetGenerationContinuationState();
  },

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  async generateText(
    messages: ChatMessage[],
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onChunk: (chunk: string) => void,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onToolCalls: (toolCalls: ToolCall[]) => void,
    params?: LmParameters,
    tools?: WorkerToolDefinition[],
  ): Promise<void> {
    if (!model || !tokenizer) throw new Error('Model not loaded');

    stoppingCriteria.reset();
    const generationStart = performance.now();
    const strategy = selectGenerationStrategy({
      modelType: (model as ModelInternals | null)?.config?.model_type,
      activeModelId,
      hasTools: !!tools?.length,
    });
    debugLog({
      event: 'tool routing',
      details: {
        activeModelId,
        strategy: strategy.kind,
        hasTools: !!tools?.length,
        messageRoles: messages.map(message => ({
          role: message.role,
          hasToolCalls: !!message.tool_calls?.length,
          hasToolCallId: !!message.tool_call_id,
        })),
      },
    });

    try {
      debugLog({
        event: 'calling model.generate',
        details: {
          activeModelId,
          strategy: strategy.kind,
          elapsedMs: Math.round(performance.now() - generationStart),
        },
      });
      await strategy.generate({
        model,
        tokenizer,
        messages,
        onChunk: ({ chunk }) => {
          console.debug('[transformersJsWorker] raw token:', JSON.stringify(chunk));
          onChunk(chunk);
        },
        onToolCalls: ({ toolCalls }) => onToolCalls(toolCalls),
        params,
        tools,
        runtimeState: generationRuntimeState,
        stoppingCriteria,
        debugLog,
        observationSink: undefined,
      });
      debugLog({
        event: 'generation complete',
        details: {
          activeModelId,
          strategy: strategy.kind,
          elapsedMs: Math.round(performance.now() - generationStart),
        },
      });
    } catch (err) {
      clearQwen3_5ContinuationState();
      generationRuntimeState.gptOssPastKeyValues = null;
      generationRuntimeState.qwen3_5PastKeyValues = null;
      console.error('[transformersJsWorker] Generation error:', err);
      throw err;
    }
  },
};

Comlink.expose(transformersJsWorker);
export type { ITransformersJsWorker as TransformersJsWorker };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
