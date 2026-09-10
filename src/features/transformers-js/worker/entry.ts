/* eslint-disable no-restricted-imports -- Dedicated worker entry intentionally imports transformers.js runtime directly. */
import { generationContinuationOwnerSchema } from './generation-continuation-owner';
import {
  AutoConfig,
  AutoProcessor,
  AutoTokenizer,
  AutoModelForCausalLM,
  AutoModelForImageTextToText,
  InterruptableStoppingCriteria,
  ModelRegistry,
  Tensor,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressCallback as TransformersProgressCallback,
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import { exposeWorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { createGenerationDelivery } from './generation-delivery';
import { splitAssistantThinking } from '@/logic/assistant-thinking';
import type {
  ProgressInfo,
  ModelLoadResult,
  ProductionModelLoadAcceptanceResult,
  ITransformersJsWorker,
  WorkerToolDefinition,
  TransformersJsProductionInvestigationAutoClass,
  TransformersJsProductionInvestigationActiveCandidateLoadAttempt,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProductionInvestigationCandidateLoadAttempt,
  TransformersJsProductionInvestigationCandidateLoadError,
  TransformersJsModelLoadProgressObservation,
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
} from '@/features/transformers-js/types';
import {
  isGemma4Model,
  type Gemma4ProcessorLike,
} from '@/features/transformers-js/models/gemma4';
import {
  normalizeTransformersJsProductionModelId,
  selectTransformersJsProductionAutoClass,
  supportsQwen3_5MultimodalRoute,
  selectTransformersJsProductionRuntimeArtifactLoader,
} from '@/features/transformers-js/production-routing';
import { TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES } from '@/features/transformers-js/production-load-candidates';
import {
  selectGenerationStrategy,
  type GenerationStrategy,
  type GenerationStrategyObservationSink,
  type WorkerGenerationRuntimeState,
} from '@/features/transformers-js/generation-strategies';
import { configureHostedTransformersRuntime } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { fetchProductionRuntimeModule } from '@/features/transformers-js/runtime/production-runtime-module';
import { importProductionRuntimeModule } from '@/features/transformers-js/runtime/import-production-runtime-module';
import type { RequestProductionRuntimeModule } from './production-worker-startup';
import { createHostedTransformersModelFetch } from '@/features/transformers-js/runtime/model-fetch';
import { createDownloadedModelReadOnlyCache } from '@/features/transformers-js/runtime/downloaded-model-cache';
import { createProductionLoadReceiptRecorder, type ProductionLoadReceipt } from '@/features/transformers-js/runtime/production-load-receipt';
import { createProductionLoadReceiptSlot, type ProductionLoadReceiptOwner } from './load-receipt';
import { createOpfsModelCache } from '@/features/transformers-js/runtime/opfs-model-cache';
import {
  downloadedModelCandidatePlanError,
  planDownloadedModelCandidates,
  MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME,
} from '@/features/transformers-js/runtime/plan-downloaded-model-candidates';
import { selectProductionModelResources } from '@/features/transformers-js/runtime/production-resource-selector';
import { createRequiredDownloadedResourceOperation, disposeRejectedDownloadedRuntime, RequiredDownloadedModelResourceError, RequiredDownloadedResourceCleanupError } from '@/features/transformers-js/runtime/required-downloaded-resource-operation';
import { isTransformersJsOptionalConfigurationError } from '@/features/transformers-js/runtime/transformers-js-optional-configuration-error';
import { DOWNLOADED_MODEL_PREPARATION_ERROR_NAME, downloadedModelPreparationError, withDownloadedModelPreparationPhase } from '@/features/transformers-js/runtime/downloaded-model-preparation-error';
import { promiseAllKeyed } from '@/utils/promise';
import { createGenerationCapture, recordGenerationCapture, type GenerationCaptureCall } from './generation-capture';
import { createProductionLoadIdentityTracker } from './load-identity';
import {
  generationCaptureRequestSchema, generationCaptureReadRequestSchema,
  type GenerationCaptureRequest, type GenerationCaptureReadRequest, type GenerationCaptureReadResult,
} from './generation-capture-protocol';

let generationCapture: ReturnType<typeof createGenerationCapture> | undefined;
let generationCaptureLimits: string | undefined;
const productionLoadIdentity = createProductionLoadIdentityTracker();
const productionLoadReceipt = createProductionLoadReceiptSlot();

function beginGenerationCapture({ request }: { request: GenerationCaptureRequest | undefined }): GenerationCaptureCall | undefined {
  if (request === undefined) return undefined;
  let call: GenerationCaptureCall | undefined;
  recordGenerationCapture({ record: () => {
    const parsed = generationCaptureRequestSchema.safeParse(request);
    if (!parsed.success) {
      generationCapture?.noteIncomplete({ reason: 'invalid-context' });
      return;
    }
    const { context, limits } = parsed.data;
    if (generationCapture === undefined) {
      generationCapture = createGenerationCapture({ run: { runId: context.runId, workerEpoch: context.workerEpoch }, limits, tensorClass: Tensor });
      generationCaptureLimits = JSON.stringify(limits);
    }
    if (generationCaptureLimits !== JSON.stringify(limits)) {
      generationCapture.noteIncomplete({ reason: 'limits-mismatch' });
      return;
    }
    call = generationCapture.beginCall({ context, loadIdentity: productionLoadIdentity.snapshot() });
  } });
  return call;
}

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
const { assets: runtimeAssets, runtimeFetch } = configureHostedTransformersRuntime({
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

const downloadedModelCache = createOpfsModelCache({ mutationPolicy: 'read-only' });

// Keep the worker's model cache read-only. This Worker has no download mode or
// write-capable cache; explicit online work belongs to the Download Worker.
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
  qwen3_5ConversationState: undefined,
  generationStateOwner: {},
  qwen3_5SequenceCache: undefined,
};
const stoppingCriteria = new InterruptableStoppingCriteria();
let activeStoppingCriteria = stoppingCriteria;

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
  modelCache,
  cacheOnlyFetch = downloadedModelCacheOnlyFetch,
}: {
  run: () => Promise<T>,
  modelCache: ReturnType<typeof createOpfsModelCache>,
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

function invalidateGenerationState(): void {
  generationRuntimeState.generationStateOwner = {};
  generationRuntimeState.gptOssPastKeyValues = null;
  generationRuntimeState.qwen3_5SequenceCache = undefined;
  generationRuntimeState.qwen3_5ConversationState = undefined;
}

function resetGenerationContinuationState(): void {
  invalidateGenerationState();
  stoppingCriteria.reset();
}

function clearLoadedRuntimeState({ loadIdentityOperation }: {
  loadIdentityOperation: ReturnType<typeof productionLoadIdentity.beginLoad> | undefined,
}): void {
  // Diagnostic invalidation never decides whether the actual runtime clears.
  recordGenerationCapture({ record: () => {
    if (loadIdentityOperation === undefined) productionLoadIdentity.clear();
    else loadIdentityOperation.clear();
  } });
  model = null;
  gemma4Processor = null;
  generationRuntimeState.gemma4Processor = null;
  qwen3_5Processor = null;
  generationRuntimeState.qwen3_5Processor = null;
  tokenizer = null;
  resetGenerationContinuationState();
  activeModelId = null;
  generationRuntimeState.activeModelId = null;
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
  receipt: ProductionLoadReceipt | undefined,
};

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
  modelType,
  revision,
  progressCallback,
}: {
  cleanModelId: string,
  modelType: string | undefined,
  revision: string | undefined,
  progressCallback: TransformersProgressCallback,
}): Promise<TransformersJsProductionInvestigationProcessor> {
  const sharedOptions = {
    progress_callback: progressCallback,
    local_files_only: true,
    ...(revision === undefined ? {} : { revision }),
  };
  const runtimeArtifactLoader = selectTransformersJsProductionRuntimeArtifactLoader({
    modelId: cleanModelId,
    modelType,
  });
  switch (runtimeArtifactLoader) {
  case 'gemma4-processor':
    gemma4Processor = await AutoProcessor.from_pretrained(cleanModelId, sharedOptions) as unknown as Gemma4ProcessorLike;
    generationRuntimeState.gemma4Processor = gemma4Processor;
    tokenizer = gemma4Processor.tokenizer;
    return runtimeArtifactLoader;
  case 'qwen3_5-processor':
    qwen3_5Processor = await AutoProcessor.from_pretrained(cleanModelId, sharedOptions) as unknown as Qwen3_5ProcessorLike;
    generationRuntimeState.qwen3_5Processor = qwen3_5Processor;
    tokenizer = qwen3_5Processor.tokenizer;
    return runtimeArtifactLoader;
  case 'tokenizer':
    tokenizer = await AutoTokenizer.from_pretrained(cleanModelId, sharedOptions);
    return runtimeArtifactLoader;
  default: {
    const _ex: never = runtimeArtifactLoader;
    throw new Error(`Unhandled Production runtime artifact loader: ${_ex}`);
  }
  }
}


async function loadProductionRuntime({
  loadIdentitySource,
  loadReceiptOwner,
  modelId,
  revision,
  candidates,
  progressCallback,
  runtimePreparationProgressCallback = progressCallback,
  serializeError,
  modelCache,
  cacheOnlyFetch = downloadedModelCacheOnlyFetch,
  onCandidateStart = () => undefined,
  onCandidateAttempt = () => undefined,
  onRuntimePhase,
}: {
  loadIdentitySource: 'ordinary' | 'non-ordinary',
  loadReceiptOwner: ProductionLoadReceiptOwner | undefined,
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
  onRuntimePhase?: ({ phase }: {
    phase: 'config' | 'candidate-plan' | 'model-session' | 'tokenizer-processor' | 'ready',
  }) => void,
}): Promise<ProductionLoadRoute> {
  invalidateGenerationState();
  const receiptOperation = productionLoadReceipt.begin({ owner: loadReceiptOwner });
  const receiptRecorder = createProductionLoadReceiptRecorder({ modelId, revision });
  let loadIdentityOperation: ReturnType<typeof productionLoadIdentity.beginLoad> | undefined;
  recordGenerationCapture({ record: () => {
    loadIdentityOperation = productionLoadIdentity.beginLoad({ source: loadIdentitySource, modelId, revision });
  } });
  try {
    const cleanModelId = normalizeTransformersJsProductionModelId({ modelId });
    assertGemma4RuntimeSupport({ modelId: cleanModelId });
    const rawProgressCallback: TransformersProgressCallback = info => progressCallback({ info });
    const runtimeModelCache = modelCache ?? createDownloadedModelReadOnlyCache({
      modelId: cleanModelId,
      revision,
      onScopedMatchObservation: receiptRecorder.observe,
    });

    const route = await withDownloadedModelAccessMode({
      modelCache: runtimeModelCache,
      cacheOnlyFetch,
      run: async () => {
        onRuntimePhase?.({ phase: 'config' });
        const config = await withDownloadedModelPreparationPhase({
          phase: 'config',
          run: () => AutoConfig.from_pretrained(cleanModelId, {
            local_files_only: true,
            progress_callback: info => runtimePreparationProgressCallback({ info }),
            ...(revision === undefined ? {} : { revision }),
          }),
        });
        const modelType = typeof config.model_type === 'string' ? config.model_type : undefined;
        let autoClass = selectTransformersJsProductionAutoClass({ modelId: cleanModelId, modelType });
        const runtimeArtifactLoader = selectTransformersJsProductionRuntimeArtifactLoader({
          modelId: cleanModelId,
          modelType,
        });
        onRuntimePhase?.({ phase: 'candidate-plan' });
        const planCandidates = () => withDownloadedModelPreparationPhase({
          phase: 'candidate-plan',
          run: () => planDownloadedModelCandidates({
            modelId: cleanModelId,
            revision,
            candidates,
            modelCache: runtimeModelCache,
            getModelFiles: async ({ candidate }) => selectProductionModelResources({ autoClass, config, candidate }).paths,
            getRuntimeFiles: async () => {
              const tokenizerPaths = await ModelRegistry.get_tokenizer_files(cleanModelId);
              switch (runtimeArtifactLoader) {
              case 'tokenizer':
                return tokenizerPaths;
              case 'gemma4-processor':
              case 'qwen3_5-processor':
                return [...tokenizerPaths, ...await ModelRegistry.get_processor_files(cleanModelId)];
              default: {
                const _ex: never = runtimeArtifactLoader;
                throw new Error(`Unhandled Production runtime artifact loader: ${_ex}`);
              }
              }
            },
            workerLocationUrl: self.location.href,
          }),
        });
        let candidatePlan = await planCandidates();
        // Prefer a complete multimodal route before native loading begins. Old
        // language-only caches remain usable for text without fetching missing
        // vision files. Never downgrade after a native/resource failure.
        if (supportsQwen3_5MultimodalRoute({ modelType })
          && candidatePlan.every(entry => entry.status === 'checked' && !entry.complete)) {
          autoClass = 'AutoModelForCausalLM';
          candidatePlan = await planCandidates();
        }
        const completeCandidates = candidatePlan
          .filter(entry => entry.status === 'checked')
          .filter(entry => entry.complete);
        if (completeCandidates.length === 0) {
          throw downloadedModelCandidatePlanError({
            modelId: cleanModelId,
            revision,
            entries: candidatePlan,
          });
        }

        let selectedCandidate: ProductionLoadCandidate | undefined;
        let selectedResources: ReturnType<typeof createRequiredDownloadedResourceOperation> | undefined;
        let selectedRequiredPaths: string[] = [];
        let lastError: unknown;
        const loadAttempts: TransformersJsProductionInvestigationCandidateLoadAttempt[] = [];
        for (const plan of completeCandidates) {
          const { candidate } = plan;
          const resources = createRequiredDownloadedResourceOperation({
            modelId: cleanModelId,
            revision,
            // AutoModel re-reads this required config after the initial AutoConfig
            // and plan. Registry metadata lists do not include that second read.
            requiredPaths: ['config.json', ...plan.requiredModelPaths, ...plan.requiredRuntimePaths],
            workerLocationUrl: self.location.href,
            modelCache: runtimeModelCache,
            cacheOnlyFetch,
          });
          onCandidateStart({ candidate });
          // This boundary includes cache reads and session creation. File progress
          // alone cannot distinguish those operations or prove that either ended.
          onRuntimePhase?.({ phase: 'model-session' });
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
            model = await withDownloadedModelAccessMode({
              modelCache: resources.cache,
              cacheOnlyFetch: resources.fetch,
              run: () => loadDownloadedProductionModelCandidate({
                cleanModelId,
                autoClass,
                candidate,
                revision,
                progressCallback: rawProgressCallback,
              }),
            });
            // Upstream tryCache and metadata prepasses may swallow our exception.
            // A returned model is not success until this candidate's reads agree.
            resources.assertHealthy();
            const modelLoadDurationMs = Math.max(0, performance.now() - startedAt);
            selectedCandidate = candidate;
            selectedResources = resources;
            selectedRequiredPaths = ['config.json', ...plan.requiredModelPaths, ...plan.requiredRuntimePaths];
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
            try {
              await resources.close();
            } catch (cleanupError) {
              lastError = cleanupError;
            }
            try {
              resources.assertHealthy();
            } catch (resourceError) {
              lastError = resourceError;
            }
            if (model !== null) {
              const rejectedModel = model;
              model = null;
              // Cleanup must not replace the original required-resource failure.
              try {
                await disposeRejectedDownloadedRuntime({ dispose: () => rejectedModel.dispose(), cause: lastError });
              } catch (cleanupError) {
                lastError = cleanupError;
              }
            }
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
            if (lastError instanceof RequiredDownloadedModelResourceError || lastError instanceof RequiredDownloadedResourceCleanupError
            || isTransformersJsOptionalConfigurationError({ error: lastError })) {
              clearLoadedRuntimeState({ loadIdentityOperation });
              throw lastError;
            }
          }
        }

        if (model === null || selectedCandidate === undefined || selectedResources === undefined) {
          throw lastError instanceof Error ? lastError : new Error('No production load candidate succeeded');
        }

        const runtimePreparationStartedAt = performance.now();
        onRuntimePhase?.({ phase: 'tokenizer-processor' });
        let processor: Awaited<ReturnType<typeof loadDownloadedProductionTokenizerOrProcessor>>;
        try {
          processor = await withDownloadedModelAccessMode({
            modelCache: selectedResources.cache,
            cacheOnlyFetch: selectedResources.fetch,
            run: () => loadDownloadedProductionTokenizerOrProcessor({
              cleanModelId,
              modelType,
              revision,
              progressCallback: info => runtimePreparationProgressCallback({ info }),
            }),
          });
          selectedResources.assertHealthy();
          await selectedResources.close();
          selectedResources.assertHealthy();
        } catch (error) {
        // close may have already timed out; cleanup must still reach the model.
          await selectedResources.close().catch(() => undefined);
          const rejectedModel = model;
          clearLoadedRuntimeState({ loadIdentityOperation });
          let resourceError = error;
          try {
            selectedResources.assertHealthy();
          } catch (failure) {
            resourceError = failure;
          }
          const preparationError = downloadedModelPreparationError({ phase: 'tokenizer-processor', cause: resourceError });
          await disposeRejectedDownloadedRuntime({ dispose: () => rejectedModel.dispose(), cause: preparationError });
          selectedResources.assertHealthy();
          throw preparationError;
        }
        const runtimePreparationDurationMs = Math.max(0, performance.now() - runtimePreparationStartedAt);
        onRuntimePhase?.({ phase: 'ready' });

        return {
          cleanModelId,
          autoClass,
          processor,
          candidate: selectedCandidate,
          loadAttempts,
          runtimePreparationDurationMs,
          receipt: receiptRecorder.finish({ autoClass, processor, candidate: selectedCandidate, plannedRequiredPaths: selectedRequiredPaths }),
        };
      },
    });
    recordGenerationCapture({ record: () => loadIdentityOperation?.finish({ route }) });
    receiptOperation.finish({ receipt: route.receipt });
    return route;
  } finally {
    receiptOperation.fail();
    // Idempotent after success; on rejection retains no stale ready identity.
    recordGenerationCapture({ record: () => loadIdentityOperation?.finish({ route: undefined }) });
  }
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
    onGenerateInvocation() {
      // The legacy observation DTO has no actual-invocation settings field.
      // Keep its existing capture phase until the dedicated collector is wired.
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
    generationCapture: undefined,
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
  /**
   * Loads an already-downloaded model into memory/runtime sessions.
   *
   * IMPORTANT: This operation MUST NOT start, resume, repair, or otherwise
   * perform any model download. Missing/incomplete artifacts must fail here.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  async loadDownloadedModel(modelId: string, revision: string | undefined, progressCallback: (x: ProgressInfo) => void, loadReceiptOwner?: ProductionLoadReceiptOwner): Promise<ModelLoadResult> {
    console.log('[transformersJsWorker] Starting loadDownloadedModel:', modelId);

    await this.unloadModel();
    activeModelId = modelId;
    generationRuntimeState.activeModelId = modelId;

    try {
      const route = await loadProductionRuntime({
        loadIdentitySource: 'ordinary',
        loadReceiptOwner,
        modelId,
        revision,
        candidates: [...TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES],
        progressCallback: ({ info }) => progressCallback(info),
        serializeError: ({ error }) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          return {
            name: normalized.name,
            message: normalized.message,
            stack: normalized.stack,
          };
        },
      });
      console.log('[transformersJsWorker] Model loaded successfully.');
      // The opt-in capture slot owns Load evidence. It must not leak into the
      // ordinary public Load result or change its transport shape.
      return { device: route.candidate.device, dtype: route.candidate.dtype };
    } catch (error) {
      const errorMessage = typeof error === 'number'
        ? `Low-level engine error (code ${error}). This usually means memory allocation failed or the model format is incompatible.`
        : (error instanceof Error ? error.message : String(error));
      console.error('[transformersJsWorker] Detailed load error:', error, errorMessage);
      if (error instanceof Error) throw error;
      throw new Error(errorMessage);
    }
  },

  /**
   * Download Verification acceptance primitive. This intentionally reuses the
   * same Production runtime loader while constraining it to one candidate.
   * The access mode remains cache-only, so missing artifacts fail closed.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink remote boundaries use positional top-level arguments.
  async verifyDownloadedModelCandidate(modelId, revision, candidate, progressCallback): Promise<ProductionModelLoadAcceptanceResult> {
    await this.unloadModel();
    activeModelId = modelId;
    generationRuntimeState.activeModelId = modelId;

    const route = await loadProductionRuntime({
      loadIdentitySource: 'non-ordinary',
      loadReceiptOwner: undefined,
      modelId,
      revision,
      candidates: [candidate],
      progressCallback: ({ info }) => progressCallback(info),
      onRuntimePhase: ({ phase }) => progressCallback({ status: `cache-acceptance-${phase}` }),
      serializeError: ({ error }) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        return {
          name: normalized.name,
          message: normalized.message,
          stack: normalized.stack,
        };
      },
    });
    return { device: route.candidate.device, dtype: route.candidate.dtype, ...(route.receipt === undefined ? {} : { receipt: route.receipt }) };
  },

  /**
   * Download Verification revision acceptance primitive. It runs the exact
   * Production fallback sequence against one explicit cache revision.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink remote boundaries use positional top-level arguments.
  async verifyDownloadedModelRevision(modelId, revision, progressCallback): Promise<ProductionModelLoadAcceptanceResult> {
    await this.unloadModel();
    activeModelId = modelId;
    generationRuntimeState.activeModelId = modelId;

    const attempts: TransformersJsProductionInvestigationCandidateLoadAttempt[] = [];
    let candidatePassed = false;
    try {
      const route = await loadProductionRuntime({
        loadIdentitySource: 'non-ordinary',
        loadReceiptOwner: undefined,
        modelId,
        revision,
        candidates: [...TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES],
        progressCallback: ({ info }) => progressCallback(info),
        onRuntimePhase: ({ phase }) => progressCallback({ status: `cache-acceptance-${phase}` }),
        serializeError: ({ error }) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          return {
            name: normalized.name,
            message: normalized.message,
            stack: normalized.stack,
          };
        },
        onCandidateAttempt: ({ attempt }) => {
          attempts.push(attempt);
          switch (attempt.status) {
          case 'passed':
            candidatePassed = true;
            break;
          case 'failed':
            break;
          default: {
            const _ex: never = attempt.status;
            throw new Error(`Unhandled Production candidate attempt status: ${String(_ex)}`);
          }
          }
        },
      });
      return { device: route.candidate.device, dtype: route.candidate.dtype, ...(route.receipt === undefined ? {} : { receipt: route.receipt }) };
    } catch (error) {
      if (error instanceof RequiredDownloadedModelResourceError || error instanceof RequiredDownloadedResourceCleanupError
        || (error instanceof Error && error.name === DOWNLOADED_MODEL_PREPARATION_ERROR_NAME)
        || isTransformersJsOptionalConfigurationError({ error })) throw error;
      // If no candidate ever loaded, do not let a final missing-artifact error
      // erase an earlier runtime rejection. Explicit Download may repair only a
      // genuinely incomplete cache; runtime rejection is not evidence that a
      // multi-GB re-download will help.
      if (!candidatePassed) {
        const nonMissingFailure = attempts.find(attempt => (
          attempt.status === 'failed'
          && attempt.error !== undefined
          && attempt.error.name !== MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME
        ));
        if (nonMissingFailure?.error !== undefined) {
          const preserved = new Error(nonMissingFailure.error.message);
          preserved.name = nonMissingFailure.error.name;
          throw preserved;
        }
      }
      throw error;
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
      const observedModelCache = createDownloadedModelReadOnlyCache({
        modelId: scenario.modelId,
        revision: scenario.loadRevision,
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
          loadIdentitySource: 'non-ordinary',
          loadReceiptOwner: undefined,
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
        if (scenario.runContinuity === false) {
          return {
            status: 'not-run',
            reason: 'Continuity / KV cache was not selected by investigation scope',
          };
        }
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
            // Reconstruct ordinary stored chat from settled strategy output.
            // Native decoded text remains separate evidence, even when the
            // visible stream is empty or contains only completed thinking.
            content: splitAssistantThinking({ content: firstTurn.turn.streamChunks.join('') }).content,
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
        if (scenario.runCapabilityProbes === false) {
          return {
            status: 'not-run',
            reason: 'Capability probes were not selected by investigation scope',
          };
        }
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

      const reasoning: TransformersJsProductionInvestigationObservation['reasoning'] = scenario.runCapabilityProbes === false
        ? undefined
        : await (async () => {
          reportStage({ status: 'model-support-production-reasoning-differential' });
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

      const multimodal: TransformersJsProductionInvestigationObservation['multimodal'] = scenario.runCapabilityProbes === false
        ? undefined
        : await (async () => {
          reportStage({ status: 'model-support-production-multimodal' });
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
    productionLoadReceipt.clear();
    const unloadingModel = model;
    clearLoadedRuntimeState({ loadIdentityOperation: undefined });
    if (unloadingModel) {
      await unloadingModel.dispose();
    }
  },

  async interrupt() {
    invalidateGenerationState();
    activeStoppingCriteria.interrupt();
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
    capture?: GenerationCaptureRequest,
    continuationOwner?: string,
  ): Promise<void> {
    const cacheGeneration = {};
    generationRuntimeState.generationStateOwner = cacheGeneration;
    const requestStoppingCriteria = new InterruptableStoppingCriteria();
    activeStoppingCriteria = requestStoppingCriteria;
    const captureCall = beginGenerationCapture({ request: capture });
    let captureOutcome: 'fulfilled' | 'rejected' = 'rejected';
    try {
      if (!model || !tokenizer) throw new Error('Model not loaded');
      const validatedContinuationOwner = generationContinuationOwnerSchema.parse(continuationOwner);

      const generationStart = performance.now();
      const strategy = selectGenerationStrategy({
        modelType: (model as ModelInternals | null)?.config?.model_type,
        activeModelId,
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
        const delivery = createGenerationDelivery({ onFailure: () => {
          if (generationRuntimeState.generationStateOwner === cacheGeneration) {
            invalidateGenerationState();
          }
          // This criterion belongs only to this request, even after a newer
          // request has taken ownership of shared continuation state.
          requestStoppingCriteria.interrupt();
        } });
        let generationFailure: { error: unknown } | undefined;
        try {
          await strategy.generate({
            continuationOwner: validatedContinuationOwner,
            model,
            tokenizer,
            messages,
            onChunk: ({ chunk }) => {
              if (captureCall !== undefined) recordGenerationCapture({ record: () => captureCall.recordChunk({ phase: 'strategy-output', chunk }) });
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
              delivery.enqueue({ deliver: () => {
                if (captureCall !== undefined) recordGenerationCapture({ record: () => captureCall.recordChunk({ phase: 'worker-send', chunk }) });
                return onChunk(chunk);
              } });
            },
            onRawChunk: ({ chunk }) => {
              if (captureCall !== undefined) recordGenerationCapture({ record: () => captureCall.recordChunk({ phase: 'strategy-raw', chunk }) });
              console.debug('[transformersJsWorker] raw token:', JSON.stringify(chunk));
            },
            onToolCalls: ({ toolCalls }) => pendingToolCalls.push(...toolCalls),
            params,
            tools,
            runtimeState: generationRuntimeState,
            stoppingCriteria: requestStoppingCriteria,
            debugLog,
            observationSink: undefined,
            generationCapture: captureCall,
          });
          if (pendingToolCalls.length > 0) {
            delivery.enqueue({ deliver: () => onToolCalls(pendingToolCalls) });
          }
        } catch (error) {
          generationFailure = { error };
        }
        try {
          await delivery.finish();
        } catch (error) {
          // Preserve an inference failure when delivery also failed while
          // settling its already emitted output.
          if (generationFailure === undefined) throw error;
        }
        if (generationFailure !== undefined) throw generationFailure.error;
        debugLog({
          event: 'generation complete',
          details: {
            activeModelId,
            strategy: strategy.kind,
            elapsedMs: Math.round(performance.now() - generationStart),
          },
        });
      } catch (err) {
        if (generationRuntimeState.generationStateOwner === cacheGeneration) {
          invalidateGenerationState();
        }
        console.error('[transformersJsWorker] Generation error:', err);
        throw err;
      }
      captureOutcome = 'fulfilled';
    } finally {
      if (activeStoppingCriteria === requestStoppingCriteria) activeStoppingCriteria = stoppingCriteria;
      if (captureCall !== undefined) recordGenerationCapture({ record: () => captureCall.finish({ outcome: captureOutcome }) });
    }
  },

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Validate the entire untrusted Comlink request before reading its fields.
  async takeGenerationCapture(request: GenerationCaptureReadRequest): Promise<GenerationCaptureReadResult> {
    const parsed = generationCaptureReadRequestSchema.safeParse(request);
    if (!parsed.success) return { status: 'invalid-context' };
    const result = generationCapture === undefined ? { status: 'not-started' as const } : generationCapture.take({ run: parsed.data });
    switch (result.status) {
    case 'captured': case 'not-started': {
      const loadObservation = productionLoadReceipt.snapshot({ owner: parsed.data });
      return { ...result, ...(loadObservation === undefined ? {} : { loadObservation }) };
    }
    case 'already-taken': case 'wrong-run': case 'busy': case 'invalid-context': return result;
    default: { const exhaustive: never = result; return exhaustive; }
    }
  },
};

let initializationStarted = false;

/** The only entry-publication path, shared by bootstrap and direct-entry replay. */
export async function initializeProductionWorkerRuntime({ requestRuntimeModule }: {
  requestRuntimeModule: RequestProductionRuntimeModule;
}): Promise<{ requestId: string }> {
  if (initializationStarted) throw new Error('Production runtime initialization is one-shot');
  initializationStarted = true;
  const bytes = await fetchProductionRuntimeModule({ assets: runtimeAssets, runtimeFetch });
  const { requestId, objectUrl } = await requestRuntimeModule({ variant: runtimeAssets.variant, bytes });
  const leasedUrl = new URL(objectUrl);
  if (leasedUrl.protocol !== 'blob:' || leasedUrl.origin !== new URL(self.location.href).origin) {
    throw new Error('Production runtime lease must be a same-origin Blob URL');
  }
  // Evaluate the pinned module, but never invoke its factory. CSP/Blob import
  // failures are startup failures, not model incompatibility or another dtype.
  await importProductionRuntimeModule({ objectUrl });
  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error('Production ONNX Runtime environment is unavailable');
  wasm.wasmPaths = { mjs: objectUrl, wasm: runtimeAssets.wasmUrl };
  exposeWorkerRemote<ITransformersJsWorker>({ api: transformersJsWorker, endpoint: undefined });
  return { requestId };
}
export type { ITransformersJsWorker as TransformersJsWorker };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
