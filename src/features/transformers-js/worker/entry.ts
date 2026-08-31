/* eslint-disable no-restricted-imports -- Dedicated worker entry intentionally imports transformers.js runtime directly. */
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
import { exposeWorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import type {
  ProgressInfo,
  ModelLoadResult,
  ITransformersJsWorker,
  WorkerToolDefinition,
  TransformersJsProductionInvestigationAutoClass,
  TransformersJsProductionInvestigationActiveCandidateLoadAttempt,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProductionInvestigationCandidateLoadAttempt,
  TransformersJsProductionInvestigationCandidateLoadError,
  TransformersJsModelLoadProgressObservation,
  TransformersJsProductionInvestigationDevice,
  TransformersJsProductionInvestigationError,
  TransformersJsOpaqueStructureSummary,
  TransformersJsProductionInvestigationInputTensorMetadata,
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationPartialObservation,
  TransformersJsProductionInvestigationProcessor,
  TransformersJsProductionInvestigationReasoningObservation,
  TransformersJsProductionInvestigationReasoningEffortObservation,
  TransformersJsProductionInvestigationStrategy,
  TransformersJsProductionInvestigationStageStatus,
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
const downloadedModelCacheOnlyFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new Error(
    `loadDownloadedModel() MUST NOT fetch model artifacts; the required file is not in the downloaded-model cache: ${url}`,
  );
};

// Configure environment
env.allowLocalModels = true;
env.allowRemoteModels = false;
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

const downloadedModelCache = createOpfsModelCache({ mutationPolicy: 'read-only' });
const downloadModelCache = createOpfsModelCache({ mutationPolicy: 'read-write' });

// Keep the worker's default model cache read-only. Explicit download operations
// temporarily opt into the write-capable cache; loading/generation never do.
env.useCustomCache = true;
env.customCache = downloadedModelCache;
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

async function withDownloadModelAccessMode<T>({
  isLocal,
  run,
}: {
  isLocal: boolean,
  run: () => Promise<T>,
}): Promise<T> {
  const previousAllowLocalModels = env.allowLocalModels;
  const previousAllowRemoteModels = env.allowRemoteModels;
  const previousCustomCache = env.customCache;
  env.allowLocalModels = isLocal;
  env.allowRemoteModels = !isLocal;
  env.customCache = downloadModelCache;
  try {
    return await run();
  } finally {
    env.allowLocalModels = previousAllowLocalModels;
    env.allowRemoteModels = previousAllowRemoteModels;
    env.customCache = previousCustomCache;
  }
}

/**
 * Runs the memory/session loading phase for a model that is already downloaded.
 *
 * IMPORTANT: This phase MUST NOT start, resume, repair, or otherwise perform
 * any model download. Missing or incomplete local artifacts MUST fail the load
 * instead of falling back to a remote fetch, and loading MUST NOT mutate the
 * shared OPFS model cache. Model downloading is a separate explicit operation.
 */
async function withDownloadedModelAccessMode<T>({
  run,
  modelCache = downloadedModelCache,
  cacheOnlyFetch = downloadedModelCacheOnlyFetch,
}: {
  run: () => Promise<T>,
  modelCache?: ReturnType<typeof createOpfsModelCache>,
  cacheOnlyFetch?: typeof fetch,
}): Promise<T> {
  const previousAllowLocalModels = env.allowLocalModels;
  const previousAllowRemoteModels = env.allowRemoteModels;
  const previousCustomCache = env.customCache;
  const previousFetch = env.fetch;
  // Transformers.js 4.2 rejects local_files_only=true before consulting its
  // custom cache when allowLocalModels=false. Keep local lookup enabled so
  // downloaded OPFS entries can be read, then block every cache-miss fetch.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.customCache = modelCache;
  env.fetch = cacheOnlyFetch;
  try {
    return await run();
  } finally {
    env.allowLocalModels = previousAllowLocalModels;
    env.allowRemoteModels = previousAllowRemoteModels;
    env.customCache = previousCustomCache;
    env.fetch = previousFetch;
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

type ProductionLoadCandidate = TransformersJsProductionInvestigationCandidate;

type ProductionLoadRoute = {
  cleanModelId: string,
  autoClass: TransformersJsProductionInvestigationAutoClass,
  processor: TransformersJsProductionInvestigationProcessor,
  candidate: ProductionLoadCandidate,
  loadAttempts: TransformersJsProductionInvestigationCandidateLoadAttempt[],
  runtimePreparationDurationMs: number,
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

async function loadDownloadedProductionModelCandidate({
  cleanModelId,
  autoClass,
  candidate,
  revision,
  progressCallback,
}: {
  cleanModelId: string,
  autoClass: TransformersJsProductionInvestigationAutoClass,
  candidate: ProductionLoadCandidate,
  revision: string | undefined,
  progressCallback: TransformersProgressCallback,
}): Promise<PreTrainedModel> {
  const options = {
    dtype: candidate.dtype,
    device: candidate.device,
    progress_callback: progressCallback,
    local_files_only: true,
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

async function loadDownloadedProductionTokenizerOrProcessor({
  cleanModelId,
  revision,
  progressCallback,
}: {
  cleanModelId: string,
  revision: string | undefined,
  progressCallback: TransformersProgressCallback,
}): Promise<TransformersJsProductionInvestigationProcessor> {
  if (model === null) throw new Error('Production model is not loaded');
  const sharedOptions = {
    progress_callback: progressCallback,
    local_files_only: true,
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
  runtimePreparationProgressCallback = progressCallback,
  serializeError,
  modelCache = downloadedModelCache,
  cacheOnlyFetch = downloadedModelCacheOnlyFetch,
  onCandidateStart = () => undefined,
  onCandidateAttempt = () => undefined,
}: {
  modelId: string,
  revision: string | undefined,
  candidates: ProductionLoadCandidate[],
  progressCallback: TransformersJsProgressCallback,
  runtimePreparationProgressCallback?: TransformersJsProgressCallback,
  serializeError: ({ error }: { error: unknown }) => TransformersJsProductionInvestigationCandidateLoadError,
  modelCache?: ReturnType<typeof createOpfsModelCache>,
  cacheOnlyFetch?: typeof fetch,
  onCandidateStart?: ({ candidate }: { candidate: ProductionLoadCandidate }) => void,
  onCandidateAttempt?: ({ attempt }: {
    attempt: TransformersJsProductionInvestigationCandidateLoadAttempt,
  }) => TransformersJsProductionInvestigationCandidateLoadAttempt | void,
}): Promise<ProductionLoadRoute> {
  const cleanModelId = normalizeProductionModelId({ modelId });
  const autoClass = selectProductionAutoClass({ modelId: cleanModelId });
  assertGemma4RuntimeSupport({ modelId: cleanModelId });
  const rawProgressCallback: TransformersProgressCallback = info => progressCallback({ info });

  return await withDownloadedModelAccessMode({
    modelCache,
    cacheOnlyFetch,
    run: async () => {
      let selectedCandidate: ProductionLoadCandidate | undefined;
      let lastError: unknown;
      const loadAttempts: TransformersJsProductionInvestigationCandidateLoadAttempt[] = [];
      for (const candidate of candidates) {
        onCandidateStart({ candidate });
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
          model = await loadDownloadedProductionModelCandidate({
            cleanModelId,
            autoClass,
            candidate,
            revision,
            progressCallback: rawProgressCallback,
          });
          const modelLoadDurationMs = Math.max(0, performance.now() - startedAt);
          selectedCandidate = candidate;
          const rawAttempt: TransformersJsProductionInvestigationCandidateLoadAttempt = {
            candidate,
            status: 'passed',
            modelLoadDurationMs,
            modelLoadProgress: undefined,
            error: undefined,
          };
          const attempt = onCandidateAttempt({ attempt: rawAttempt }) ?? rawAttempt;
          loadAttempts.push(attempt);
          debugLog({
            event: 'worker tryLoad success',
            details: {
              activeModelId: cleanModelId,
              revision,
              autoClass,
              device: candidate.device,
              dtype: candidate.dtype,
              elapsedMs: Math.round(modelLoadDurationMs),
            },
          });
          break;
        } catch (error) {
          lastError = typeof error === 'number' ? new Error(`Numeric error ${error}`) : error;
          const modelLoadDurationMs = Math.max(0, performance.now() - startedAt);
          const rawAttempt: TransformersJsProductionInvestigationCandidateLoadAttempt = {
            candidate,
            status: 'failed',
            modelLoadDurationMs,
            modelLoadProgress: undefined,
            error: serializeError({ error: lastError }),
          };
          const attempt = onCandidateAttempt({ attempt: rawAttempt }) ?? rawAttempt;
          loadAttempts.push(attempt);
          debugLog({
            event: 'worker tryLoad failure',
            details: {
              activeModelId: cleanModelId,
              revision,
              autoClass,
              device: candidate.device,
              dtype: candidate.dtype,
              elapsedMs: Math.round(modelLoadDurationMs),
              error: lastError instanceof Error ? lastError.message : String(lastError),
            },
          });
        }
      }

      if (model === null || selectedCandidate === undefined) {
        throw lastError instanceof Error ? lastError : new Error('No production load candidate succeeded');
      }

      const runtimePreparationStartedAt = performance.now();
      const processor = await loadDownloadedProductionTokenizerOrProcessor({
        cleanModelId,
        revision,
        progressCallback: info => runtimePreparationProgressCallback({ info }),
      });
      const runtimePreparationDurationMs = Math.max(0, performance.now() - runtimePreparationStartedAt);

      return {
        cleanModelId,
        autoClass,
        processor,
        candidate: selectedCandidate,
        loadAttempts,
        runtimePreparationDurationMs,
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

function buildTokenMismatchContext({
  tokenizer,
  expectedTokenIds,
  actualTokenIds,
  mismatchIndex,
}: {
  tokenizer: PreTrainedTokenizer,
  expectedTokenIds: number[],
  actualTokenIds: number[],
  mismatchIndex: number,
}): Extract<TransformersJsProductionInvestigationObservation['continuity'], { status: 'passed' }>['prefixComparison']['firstMismatchContext'] {
  const radius = 8;
  const startIndex = Math.max(0, mismatchIndex - radius);
  const endIndex = mismatchIndex + radius + 1;
  const expectedWindow = expectedTokenIds.slice(startIndex, endIndex);
  const actualWindow = actualTokenIds.slice(startIndex, endIndex);
  const decode = ({ tokenIds }: { tokenIds: number[] }): string => {
    try {
      return tokenizer.decode(tokenIds, { skip_special_tokens: false });
    } catch (error) {
      return `<decode failed: ${error instanceof Error ? error.message : String(error)}>`;
    }
  };
  return {
    startIndex,
    expectedTokenIds: expectedWindow,
    actualTokenIds: actualWindow,
    expectedText: decode({ tokenIds: expectedWindow }),
    actualText: decode({ tokenIds: actualWindow }),
  };
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
  let fullConversationInput: TransformersJsProductionInvestigationTurnObservation['fullConversationInput'] = {
    status: 'unavailable',
    reason: 'generation-strategy-did-not-report-full-conversation-input',
  };
  let cacheDecision: TransformersJsProductionInvestigationTurnObservation['cacheDecision'] = {
    status: 'unavailable',
    reason: 'generation-strategy-did-not-report-cache-decision',
  };
  let pastKeyValuesProvided = false;
  let inputPastKeyValuesSummary = opaqueStructureSummary({ value: undefined });
  let outputPastKeyValuesSummary = opaqueStructureSummary({ value: undefined });
  let sequenceTokenIds: number[] = [];

  const observationSink: GenerationStrategyObservationSink = {
    onFullConversationInputPrepared({ inputs, cacheDecision: observedCacheDecision }) {
      fullConversationInput = {
        status: 'observed',
        inputTokenIds: numberArrayFromTensorLike({ value: inputs['input_ids'] }),
      };
      cacheDecision = observedCacheDecision;
    },
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
    onRawChunk: () => {},
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
    fullConversationInput,
    cacheDecision,
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

const transformersJsWorker: WorkerServerApi<ITransformersJsWorker> = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  async downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void) {
    console.log('[transformersJsWorker] Starting downloadModel:', modelId);
    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('user/');

    await withDownloadModelAccessMode({
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

  /**
   * Loads an already-downloaded model into memory/runtime sessions.
   *
   * IMPORTANT: This operation MUST NOT start, resume, repair, or otherwise
   * perform any model download. Missing/incomplete artifacts must fail here.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  async loadDownloadedModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<ModelLoadResult> {
    console.log('[transformersJsWorker] Starting loadDownloadedModel:', modelId);

    await this.unloadModel();
    activeModelId = modelId;
    generationRuntimeState.activeModelId = modelId;

    const cleanModelId = normalizeProductionModelId({ modelId });
    const autoClass = selectProductionAutoClass({ modelId: cleanModelId });
    let loadedDevice: TransformersJsProductionInvestigationDevice = 'wasm';

    try {
      assertGemma4RuntimeSupport({ modelId: cleanModelId });

      await withDownloadedModelAccessMode({
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
              const loadedModel = await loadDownloadedProductionModelCandidate({
                cleanModelId,
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

          await loadDownloadedProductionTokenizerOrProcessor({
            cleanModelId,
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
  async runModelSupportInvestigationScenario(scenario, progressCallback, observationCheckpointCallback): Promise<TransformersJsProductionInvestigationObservation> {
    await this.unloadModel();
    // Investigation must not change Production cache identity or mutate shared
    // model storage. Model loads are cache-only; missing artifacts fail instead
    // of starting/resuming a download.
    env.customCache = createOpfsModelCache({ mutationPolicy: 'read-only' });
    activeModelId = scenario.modelId;
    generationRuntimeState.activeModelId = scenario.modelId;

    try {
      const {
        errorSerialization,
        continuityClassification,
        tokenComparison,
        toolProtocolFixture,
        modelLoadProgress,
      } = await promiseAllKeyed({
        errorSerialization: import('@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error'),
        continuityClassification: import('@/features/transformers-js/model-support-investigation/logic/classify-continuity-prefix'),
        tokenComparison: import('@/features/transformers-js/model-support-investigation/logic/compare-token-sequences'),
        toolProtocolFixture: import('@/features/transformers-js/model-support-investigation/logic/tool-protocol-fixture'),
        modelLoadProgress: import('@/features/transformers-js/model-support-investigation/logic/model-load-progress'),
      });
      const { serializeInvestigationError } = errorSerialization;
      const { classifyContinuityPrefix } = continuityClassification;
      const { compareTokenSequences } = tokenComparison;
      const { createModelSupportToolResultContinuationMessages, MODEL_SUPPORT_TOOL_DEFINITIONS } = toolProtocolFixture;
      const { createModelLoadProgressTracker } = modelLoadProgress;
      const reportStage = ({ status }: { status: TransformersJsProductionInvestigationStageStatus }): void => {
        progressCallback({ event: { kind: 'stage', status } });
      };
      let activeLoadCandidate = scenario.candidates[0];
      let activeLoadStartedAtMs: number | undefined;
      let latestLoadProgress: TransformersJsModelLoadProgressObservation | undefined;
      let loadProgressTracker = createModelLoadProgressTracker({
        candidateId: `production-${activeLoadCandidate.device}-${activeLoadCandidate.dtype}`,
      });
      reportStage({ status: 'model-support-production-model-load' });
      const partialObservation: TransformersJsProductionInvestigationPartialObservation = {
        modelId: scenario.modelId,
        resolvedRevision: scenario.resolvedRevision,
        loaderRevisionOption: scenario.loadRevision ?? null,
        runtimeLoadDurationMs: undefined,
        runtimePreparationDurationMs: undefined,
        candidate: undefined,
        loadAttempts: [],
        activeLoadAttempt: undefined,
        route: undefined,
        isEncoderDecoder: undefined,
        firstTurn: undefined,
        continuity: undefined,
        toolResultContinuation: undefined,
        reasoning: undefined,
        multimodal: undefined,
      };
      const publishObservationCheckpoint = (): void => {
        observationCheckpointCallback({ observation: structuredClone(partialObservation) });
      };
      const updateActiveLoadAttempt = ({
        progress,
      }: {
        progress: TransformersJsModelLoadProgressObservation | undefined,
      }): void => {
        if (activeLoadStartedAtMs === undefined) return;
        const activeLoadAttempt: TransformersJsProductionInvestigationActiveCandidateLoadAttempt = {
          candidate: structuredClone(activeLoadCandidate),
          status: 'running',
          modelLoadDurationMs: Math.max(0, performance.now() - activeLoadStartedAtMs),
          modelLoadProgress: progress === undefined ? undefined : structuredClone(progress),
        };
        partialObservation.activeLoadAttempt = activeLoadAttempt;
      };
      const reportLoadProgress: TransformersJsProgressCallback = ({ info }) => {
        const progress = loadProgressTracker.observe({
          info,
          at: new Date().toISOString(),
          nowMs: performance.now(),
        });
        if (progress !== undefined) {
          latestLoadProgress = structuredClone(progress);
          updateActiveLoadAttempt({ progress });
          progressCallback({ event: { kind: 'model-load', progress } });
          publishObservationCheckpoint();
        }
      };
      const flushLoadProgress = (): void => {
        const progress = loadProgressTracker.flush();
        if (progress !== undefined) {
          latestLoadProgress = structuredClone(progress);
          updateActiveLoadAttempt({ progress });
          progressCallback({ event: { kind: 'model-load', progress } });
          publishObservationCheckpoint();
        }
      };
      publishObservationCheckpoint();
      const observedModelCache = createOpfsModelCache({
        mutationPolicy: 'read-only',
        onMatchObservation: ({ observation }) => {
          if (activeLoadStartedAtMs === undefined) return;
          loadProgressTracker.observeCacheMatch({ observation, at: new Date().toISOString() });
        },
      });
      const observedCacheOnlyFetch: typeof fetch = async input => {
        if (activeLoadStartedAtMs !== undefined) {
          loadProgressTracker.observeRemoteFetchAttempt({ at: new Date().toISOString() });
        }
        return await downloadedModelCacheOnlyFetch(input);
      };
      const runtimeLoadStartedAtMs = performance.now();
      let runtimePreparationStartedAtMs: number | undefined;
      let route: Awaited<ReturnType<typeof loadProductionRuntime>>;
      try {
        route = await loadProductionRuntime({
          modelId: scenario.modelId,
          revision: scenario.loadRevision,
          candidates: scenario.candidates,
          progressCallback: reportLoadProgress,
          runtimePreparationProgressCallback: () => undefined,
          serializeError: ({ error }) => serializeInvestigationError({ error }),
          modelCache: observedModelCache,
          cacheOnlyFetch: observedCacheOnlyFetch,
          onCandidateStart: ({ candidate }) => {
            activeLoadCandidate = candidate;
            activeLoadStartedAtMs = performance.now();
            latestLoadProgress = undefined;
            loadProgressTracker = createModelLoadProgressTracker({
              candidateId: `production-${activeLoadCandidate.device}-${activeLoadCandidate.dtype}`,
            });
            updateActiveLoadAttempt({ progress: undefined });
            publishObservationCheckpoint();
          },
          onCandidateAttempt: ({ attempt }) => {
            flushLoadProgress();
            const enrichedAttempt: TransformersJsProductionInvestigationCandidateLoadAttempt = {
              ...attempt,
              modelLoadProgress: latestLoadProgress === undefined ? undefined : structuredClone(latestLoadProgress),
            };
            const loadAttempts = partialObservation.loadAttempts ?? [];
            loadAttempts.push(structuredClone(enrichedAttempt));
            partialObservation.loadAttempts = loadAttempts;
            partialObservation.activeLoadAttempt = undefined;
            activeLoadStartedAtMs = undefined;
            switch (enrichedAttempt.status) {
            case 'passed':
              partialObservation.candidate = structuredClone(enrichedAttempt.candidate);
              runtimePreparationStartedAtMs = performance.now();
              reportStage({ status: 'model-support-production-runtime-preparation' });
              break;
            case 'failed':
              break;
            default: {
              const _exhaustive: never = enrichedAttempt.status;
              throw new Error(`Unhandled Production load attempt status: ${_exhaustive}`);
            }
            }
            publishObservationCheckpoint();
            return enrichedAttempt;
          },
        });
      } finally {
        const completedAtMs = performance.now();
        partialObservation.runtimeLoadDurationMs = Math.max(0, completedAtMs - runtimeLoadStartedAtMs);
        if (runtimePreparationStartedAtMs !== undefined) {
          partialObservation.runtimePreparationDurationMs = Math.max(0, completedAtMs - runtimePreparationStartedAtMs);
        }
        publishObservationCheckpoint();
      }
      flushLoadProgress();
      partialObservation.runtimePreparationDurationMs = route.runtimePreparationDurationMs;
      publishObservationCheckpoint();
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
      partialObservation.candidate = route.candidate;
      partialObservation.route = {
        autoClass: route.autoClass,
        processor: route.processor,
        strategy: strategy.kind,
        modelType,
      };
      partialObservation.isEncoderDecoder = isEncoderDecoder;
      publishObservationCheckpoint();
      reportStage({ status: 'model-support-production-first-turn' });
      const firstTurn: TransformersJsProductionInvestigationObservation['firstTurn'] = await (async () => {
        resetGenerationContinuationState();
        try {
          const turn = await runObservedProductionTurn({
            loadedModel,
            loadedTokenizer,
            strategy,
            messages: scenario.messages,
            maxNewTokens: scenario.maxNewTokens,
            isEncoderDecoder,
            tools: undefined,
          });
          return { status: 'passed', turn };
        } catch (error) {
          const serialized = serializeInvestigationError({ error, maxLength: 1024 });
          return {
            status: 'failed',
            error: serialized,
          };
        }
      })();
      partialObservation.firstTurn = firstTurn;
      publishObservationCheckpoint();

      const continuity: TransformersJsProductionInvestigationObservation['continuity'] = await (async () => {
        reportStage({ status: 'model-support-production-continuity' });
        switch (firstTurn.status) {
        case 'failed':
          return {
            status: 'not-run',
            reason: `First Production turn failed: ${firstTurn.error.name}: ${firstTurn.error.message}`,
          };
        case 'passed': {
          const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: firstTurn.turn.generatedText,
          };
          const secondTurnMessages = [
            ...scenario.messages,
            assistantMessage,
            scenario.followUpMessage,
          ];
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
            const reconstructedFullInputTokenIds = (() => {
              switch (secondTurn.fullConversationInput.status) {
              case 'observed':
                return secondTurn.fullConversationInput.inputTokenIds;
              case 'unavailable':
                return undefined;
              default: {
                const _ex: never = secondTurn.fullConversationInput;
                return _ex;
              }
              }
            })();
            const classifiedPrefix = classifyContinuityPrefix({
              isEncoderDecoder,
              firstGeneratedSequenceTokenIds: firstTurn.turn.generatedSequenceTokenIds,
              secondInputTokenIds: secondTurn.inputTokenIds,
              reconstructedFullInputTokenIds,
              secondTurnPastKeyValuesProvided: secondTurn.pastKeyValuesProvided,
            });
            const comparisonInputTokenIds = (() => {
              switch (classifiedPrefix.comparisonInputSource) {
              case 'reconstructed-full-conversation':
                return classifiedPrefix.reconstructedFullInputTokenIds;
              case 'actual-model-input':
                return classifiedPrefix.secondInputTokenIds;
              case 'not-applicable':
                return undefined;
              default: {
                const _ex: never = classifiedPrefix.comparisonInputSource;
                return _ex;
              }
              }
            })();
            const prefixComparison = classifiedPrefix.firstMismatchIndex === undefined || comparisonInputTokenIds === undefined
              ? classifiedPrefix
              : {
                ...classifiedPrefix,
                firstMismatchContext: buildTokenMismatchContext({
                  tokenizer: loadedTokenizer,
                  expectedTokenIds: classifiedPrefix.expectedPrefixTokenIds,
                  actualTokenIds: comparisonInputTokenIds,
                  mismatchIndex: classifiedPrefix.firstMismatchIndex,
                }),
              };
            return {
              status: 'passed',
              assistantMessage,
              followUpMessage: scenario.followUpMessage,
              secondTurn,
              prefixComparison,
            };
          } catch (error) {
            const serialized = serializeInvestigationError({ error, maxLength: 1024 });
            return {
              status: 'failed',
              assistantMessage,
              followUpMessage: scenario.followUpMessage,
              error: serialized,
            };
          }
        }
        default: {
          const _ex: never = firstTurn;
          return _ex;
        }
        }
      })();
      partialObservation.continuity = continuity;
      publishObservationCheckpoint();

      const toolResultContinuation = await (async (): Promise<TransformersJsProductionInvestigationObservation['toolResultContinuation']> => {
        const continuationScenario = scenario.toolResultContinuation;
        if (continuationScenario === undefined) {
          return {
            status: 'not-run',
            reason: 'Reference parser-to-template tool-result continuation evidence was unavailable',
          };
        }
        reportStage({ status: 'model-support-production-tool-result-continuation' });
        resetGenerationContinuationState();
        const messages = createModelSupportToolResultContinuationMessages({
          toolCall: continuationScenario.toolCall,
          toolResultContent: continuationScenario.toolResultContent,
        });
        let toolStrategyKind: TransformersJsProductionInvestigationStrategy | undefined;
        try {
          const toolStrategy = selectGenerationStrategy({
            modelType,
            activeModelId,
            hasTools: true,
          });
          toolStrategyKind = toolStrategy.kind;
          const turn = await runObservedProductionTurn({
            loadedModel,
            loadedTokenizer,
            strategy: toolStrategy,
            messages,
            maxNewTokens: continuationScenario.maxNewTokens,
            isEncoderDecoder,
            tools: MODEL_SUPPORT_TOOL_DEFINITIONS,
          });
          const { comparisonInputSource, comparisonInputTokenIds } = (() => {
            switch (turn.fullConversationInput.status) {
            case 'observed':
              return {
                comparisonInputSource: 'reconstructed-full-conversation' as const,
                comparisonInputTokenIds: turn.fullConversationInput.inputTokenIds,
              };
            case 'unavailable':
              return {
                comparisonInputSource: 'actual-model-input' as const,
                comparisonInputTokenIds: turn.inputTokenIds,
              };
            default: {
              const _ex: never = turn.fullConversationInput;
              return _ex;
            }
            }
          })();
          const comparison = compareTokenSequences({
            expected: continuationScenario.expectedInputTokenIds,
            actual: comparisonInputTokenIds,
          });
          return {
            status: 'passed',
            source: 'reference-parser-roundtrip',
            strategy: toolStrategyKind,
            messages,
            expectedInputTokenIds: continuationScenario.expectedInputTokenIds,
            comparisonInputSource,
            inputTokenExactMatch: comparison.exactMatch,
            firstInputMismatchIndex: comparison.firstMismatchIndex,
            turn,
          };
        } catch (error) {
          const serialized = serializeInvestigationError({ error, maxLength: 1024 });
          return {
            status: 'failed',
            source: 'reference-parser-roundtrip',
            strategy: toolStrategyKind,
            messages,
            expectedInputTokenIds: continuationScenario.expectedInputTokenIds,
            error: serialized,
          };
        }
      })();
      partialObservation.toolResultContinuation = toolResultContinuation;
      publishObservationCheckpoint();

      reportStage({ status: 'model-support-production-reasoning-differential' });
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

        type ReasoningEffortRunResult =
          | {
              effort: 'none' | 'high',
              status: 'passed',
              turn: TransformersJsProductionInvestigationTurnObservation,
            }
          | {
              effort: 'none' | 'high',
              status: 'failed',
              error: TransformersJsProductionInvestigationError,
            };
        const runReasoningEffort = async ({ effort }: { effort: 'none' | 'high' }): Promise<ReasoningEffortRunResult> => {
          resetGenerationContinuationState();
          try {
            return {
              effort,
              status: 'passed',
              turn: await runObservedProductionTurn({
                loadedModel,
                loadedTokenizer,
                strategy,
                messages: scenario.messages,
                maxNewTokens: 1,
                isEncoderDecoder,
                tools: undefined,
                reasoningEffort: effort,
              }),
            };
          } catch (error) {
            const serialized = serializeInvestigationError({ error, maxLength: 1024 });
            return {
              effort,
              status: 'failed',
              error: serialized,
            };
          }
        };
        const summarizeReasoningEffort = ({ attempt }: { attempt: ReasoningEffortRunResult }): TransformersJsProductionInvestigationReasoningEffortObservation => {
          switch (attempt.status) {
          case 'passed':
            return {
              effort: attempt.effort,
              status: 'passed',
              inputTokenCount: attempt.turn.inputTokenIds.length,
            };
          case 'failed':
            return {
              effort: attempt.effort,
              status: 'failed',
              error: attempt.error,
            };
          default: {
            const _ex: never = attempt;
            return _ex;
          }
          }
        };

        const disabledAttempt = await runReasoningEffort({ effort: 'none' });
        const enabledAttempt = await runReasoningEffort({ effort: 'high' });
        const failedObservation = ({
          firstFailure,
          disabledTurn,
          enabledTurn,
        }: {
          firstFailure: Extract<ReasoningEffortRunResult, { status: 'failed' }>,
          disabledTurn: TransformersJsProductionInvestigationTurnObservation | undefined,
          enabledTurn: TransformersJsProductionInvestigationTurnObservation | undefined,
        }): TransformersJsProductionInvestigationReasoningObservation => ({
          status: 'failed',
          source: 'existing-production-strategy',
          strategy: 'qwen3_5',
          failedEffort: firstFailure.effort,
          disabledTurn,
          enabledTurn,
          effortAttempts: [
            summarizeReasoningEffort({ attempt: disabledAttempt }),
            summarizeReasoningEffort({ attempt: enabledAttempt }),
          ],
          error: firstFailure.error,
        });

        switch (disabledAttempt.status) {
        case 'passed':
          switch (enabledAttempt.status) {
          case 'passed': {
            const comparison = compareTokenSequences({
              expected: disabledAttempt.turn.inputTokenIds,
              actual: enabledAttempt.turn.inputTokenIds,
            });
            return {
              status: 'observed',
              source: 'existing-production-strategy',
              strategy: 'qwen3_5',
              disabledEffort: 'none',
              enabledEffort: 'high',
              disabledTurn: disabledAttempt.turn,
              enabledTurn: enabledAttempt.turn,
              inputTokenExactMatch: comparison.exactMatch,
              firstInputMismatchIndex: comparison.firstMismatchIndex,
            };
          }
          case 'failed':
            return failedObservation({
              firstFailure: enabledAttempt,
              disabledTurn: disabledAttempt.turn,
              enabledTurn: undefined,
            });
          default: {
            const _ex: never = enabledAttempt;
            throw new Error(`Unhandled enabled reasoning attempt: ${((_ex satisfies never) as { readonly status: string }).status}`);
          }
          }
        case 'failed':
          switch (enabledAttempt.status) {
          case 'passed':
            return failedObservation({
              firstFailure: disabledAttempt,
              disabledTurn: undefined,
              enabledTurn: enabledAttempt.turn,
            });
          case 'failed':
            return failedObservation({
              firstFailure: disabledAttempt,
              disabledTurn: undefined,
              enabledTurn: undefined,
            });
          default: {
            const _ex: never = enabledAttempt;
            throw new Error(`Unhandled enabled reasoning attempt: ${((_ex satisfies never) as { readonly status: string }).status}`);
          }
          }
        default: {
          const _ex: never = disabledAttempt;
          throw new Error(`Unhandled disabled reasoning attempt: ${((_ex satisfies never) as { readonly status: string }).status}`);
        }
        }
      })();
      partialObservation.reasoning = reasoning;
      publishObservationCheckpoint();

      reportStage({ status: 'model-support-production-multimodal' });
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
              error: serialized,
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
      partialObservation.multimodal = multimodal;
      publishObservationCheckpoint();

      reportStage({ status: 'model-support-production-complete' });
      return {
        modelId: scenario.modelId,
        resolvedRevision: scenario.resolvedRevision,
        loaderRevisionOption: scenario.loadRevision ?? null,
        runtimeLoadDurationMs: partialObservation.runtimeLoadDurationMs,
        runtimePreparationDurationMs: route.runtimePreparationDurationMs,
        candidate: route.candidate,
        loadAttempts: route.loadAttempts,
        route: {
          autoClass: route.autoClass,
          processor: route.processor,
          strategy: strategy.kind,
          modelType,
        },
        isEncoderDecoder,
        firstTurn,
        continuity,
        toolResultContinuation,
        reasoning,
        multimodal,
      };
    } finally {
      env.customCache = downloadedModelCache;
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
      const pendingToolCalls: ToolCall[] = [];
      await strategy.generate({
        model,
        tokenizer,
        messages,
        onChunk: ({ chunk }) => {
          switch (strategy.kind) {
          case 'standard':
            break;
          case 'gpt-oss':
          case 'qwen3_5':
          case 'gemma4':
            console.debug('[transformersJsWorker] raw token:', JSON.stringify(chunk));
            break;
          default: {
            const _ex: never = strategy.kind;
            throw new Error(`Unhandled generation strategy: ${String(_ex)}`);
          }
          }
          onChunk(chunk);
        },
        onRawChunk: ({ chunk }) => {
          console.debug('[transformersJsWorker] raw token:', JSON.stringify(chunk));
        },
        onToolCalls: ({ toolCalls }) => pendingToolCalls.push(...toolCalls),
        params,
        tools,
        runtimeState: generationRuntimeState,
        stoppingCriteria,
        debugLog,
        observationSink: undefined,
      });
      if (pendingToolCalls.length > 0) {
        await onToolCalls(pendingToolCalls);
      }
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

exposeWorkerRemote<ITransformersJsWorker>({
  api: transformersJsWorker,
  endpoint: undefined,
});
export type { ITransformersJsWorker as TransformersJsWorker };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
