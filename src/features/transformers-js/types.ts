import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import type { WorkerProxy } from '@/utils/worker-transport';

/**
 * Shared types for Transformers.js service and worker
 */

export interface ProgressInfo {
  status: string,
  progress?: number,
  loaded?: number,
  total?: number,
  name?: string,
  file?: string,
}

export interface TransformersJsModelLoadProgressObservation {
  kind: 'model-load',
  artifactSource: 'downloaded-model-cache',
  /** The source label is a load-policy assertion; cache counters below are the direct runtime observations. */
  artifactSourceBasis?: 'load-policy',
  candidateId: string,
  /** Raw Transformers.js progress status; `download` does not by itself mean network transfer. */
  sourceStatus: string,
  /** `loaded`/`total` measure response-body reads. Transport source is established by cache/fetch observations below. */
  progressByteSemantics?: 'response-body-read-not-network-proof',
  currentFile: string | undefined,
  fileLoaded: number | undefined,
  fileTotal: number | undefined,
  fileProgress: number | undefined,
  aggregateLoaded: number | undefined,
  aggregateTotal: number | undefined,
  aggregateProgress: number | undefined,
  eventCount: number,
  progressEventCount: number,
  progressTotalEventCount: number,
  forwardProgressCount: number,
  repeatedWithoutForwardProgressCount: number,
  publishedSampleCount: number,
  /** Actual custom-cache match calls observed while this candidate model was loading. */
  cacheMatchRequestCount?: number,
  cacheHitCount?: number,
  cacheMissCount?: number,
  cacheAliasHitCount?: number,
  /** Sum of full sizes of OPFS files that matched. This is not the number of bytes actually consumed before abort. */
  cacheMatchedBytes?: number,
  /** Cache-miss fetches attempted by Transformers.js. Investigation load paths fail these closed. */
  remoteFetchAttemptCount?: number,
  firstActivityAt: string,
  lastActivityAt: string,
  lastForwardProgressAt: string | undefined,
}

export interface ModelLoadResult {
  device: string,
  /** Exact Production dtype selected by runtime fallback when available. */
  dtype?: TransformersJsProductionInvestigationDtype,
}

export interface ScannedModelFile {
  url: string,
}

export interface ScanPretrainedOptions {
  revision?: string,
}

export interface ScanModelOptions extends ScanPretrainedOptions {
  dtype?: 'q4f16',
  device?: 'wasm',
}

export type ScanTask =
  | { type: 'tokenizer', modelId: string, options: ScanPretrainedOptions }
  | { type: 'processor', modelId: string, options: ScanPretrainedOptions }
  | { type: 'causal-lm', modelId: string, options: ScanModelOptions }
  | { type: 'image-text-to-text', modelId: string, options: ScanModelOptions };

export interface ScanOptions {
  tasks: ScanTask[],
}

export interface ITransformersJsScannerWorker {
  scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }>,
}

export interface TransformersJsScannerWorkerClient {
  scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }>,
  dispose(): Promise<void>,
}

export type WorkerToolJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkerToolJsonValue[]
  | WorkerToolJsonObject;

export interface WorkerToolJsonObject {
  [key: string]: WorkerToolJsonValue,
}

export interface WorkerToolDefinition {
  type: 'function',
  function: {
    name: string,
    description: string,
    parameters: WorkerToolJsonObject,
  },
}

export type TransformersJsPrefetchFailureStage =
  | 'resolve-path'
  | 'cache-check'
  | 'fetch'
  | 'response-status'
  | 'write'
  | 'verification';

export type TransformersJsPrefetchFileResult =
  | {
      status: 'cached' | 'downloaded',
      url: string,
      path: string,
      byteLength: number,
      expectedByteLength: number | undefined,
    }
  | {
      status: 'failed',
      url: string,
      path: string | undefined,
      failureStage: TransformersJsPrefetchFailureStage,
      httpStatus: number | undefined,
      error: TransformersJsProductionInvestigationError,
    };

export interface TransformersJsPrefetchResult {
  requestedCount: number,
  cachedCount: number,
  downloadedCount: number,
  failedCount: number,
  complete: boolean,
  files: TransformersJsPrefetchFileResult[],
}

export type TransformersJsProgressCallback = ({ info }: { info: ProgressInfo }) => void;

export type TransformersJsProductionInvestigationStageStatus =
  | 'model-support-production-model-load'
  | 'model-support-production-runtime-preparation'
  | 'model-support-production-first-turn'
  | 'model-support-production-continuity'
  | 'model-support-production-tool-result-continuation'
  | 'model-support-production-reasoning-differential'
  | 'model-support-production-multimodal'
  | 'model-support-production-complete';

export type TransformersJsProductionInvestigationProgressEvent =
  | {
      kind: 'stage',
      status: TransformersJsProductionInvestigationStageStatus,
    }
  | {
      kind: 'model-load',
      progress: TransformersJsModelLoadProgressObservation,
    };

export type TransformersJsProductionInvestigationProgressCallback = ({ event }: {
  event: TransformersJsProductionInvestigationProgressEvent,
}) => void;
export type TransformersJsChunkCallback = ({ chunk }: { chunk: string }) => void;
export type TransformersJsToolCallsCallback = ({ toolCalls }: { toolCalls: ToolCall[] }) => void;

export interface TransformersJsCacheRevisionAlias {
  modelId: string,
  resolvedRevision: string,
  sourceRevision: string,
  repositoryPaths: string[],
}

export type TransformersJsProductionInvestigationDevice = 'webgpu' | 'wasm';
export type TransformersJsProductionInvestigationDtype = 'q4f16' | 'q4';
export type TransformersJsProductionInvestigationAutoClass =
  | 'AutoModelForCausalLM'
  | 'AutoModelForImageTextToText';
export type TransformersJsProductionInvestigationProcessor =
  | 'tokenizer'
  | 'gemma4-processor'
  | 'qwen3_5-processor';

export interface TransformersJsRuntimeArtifactPreparationResult {
  processor: TransformersJsProductionInvestigationProcessor,
  modelType: string | undefined,
}
export type TransformersJsProductionInvestigationStrategy =
  | 'standard'
  | 'gpt-oss'
  | 'qwen3_5'
  | 'gemma4';

export interface TransformersJsProductionInvestigationCandidate {
  device: TransformersJsProductionInvestigationDevice,
  dtype: TransformersJsProductionInvestigationDtype,
}

export interface TransformersJsProductionInvestigationErrorCause {
  name: string,
  message: string,
  stack?: string,
  thrownType?: string,
  serializedOriginalThrownValue?: string,
}

export interface TransformersJsProductionInvestigationError extends TransformersJsProductionInvestigationErrorCause {
  cause?: TransformersJsProductionInvestigationErrorCause,
  causeChain?: TransformersJsProductionInvestigationErrorCause[],
}

export type TransformersJsProductionInvestigationCandidateLoadError = TransformersJsProductionInvestigationError;

export interface TransformersJsProductionInvestigationCandidateLoadAttempt {
  candidate: TransformersJsProductionInvestigationCandidate,
  status: 'passed' | 'failed',
  /** Wall-clock time spent in the model from_pretrained/load operation for this candidate. */
  modelLoadDurationMs?: number,
  /** Final bounded summary of raw Transformers.js model-load progress callbacks. */
  modelLoadProgress?: TransformersJsModelLoadProgressObservation,
  error: TransformersJsProductionInvestigationCandidateLoadError | undefined,
}

export interface TransformersJsProductionInvestigationActiveCandidateLoadAttempt {
  candidate: TransformersJsProductionInvestigationCandidate,
  status: 'running',
  /** Elapsed wall-clock time at the latest bounded Production load checkpoint. */
  modelLoadDurationMs?: number,
  /** Latest bounded summary of raw Transformers.js model-load progress callbacks. */
  modelLoadProgress?: TransformersJsModelLoadProgressObservation,
}

export interface TransformersJsProductionInvestigationScenario {
  modelId: string,
  resolvedRevision: string,
  loadRevision: string | undefined,
  candidates: [TransformersJsProductionInvestigationCandidate, ...TransformersJsProductionInvestigationCandidate[]],
  messages: ChatMessage[],
  followUpMessage: ChatMessage,
  toolResultContinuation: {
    toolCall: {
      name: string,
      arguments: string,
    },
    toolResultContent: string,
    expectedInputTokenIds: number[],
    maxNewTokens: 16,
  } | undefined,
  multimodalFixture: {
    fixtureId: 'single-transparent-pixel-png-v1',
    dataUrl: string,
    sha256: string,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    byteLength: 68,
    generationMethod: 'embedded-fixed-png-bytes',
    prompt: string,
    maxNewTokens: 1,
  },
  maxNewTokens: 16,
}

export interface TransformersJsProductionInvestigationInputTensorMetadata {
  name: string,
  dtype: string | undefined,
  dims: number[],
  location: string | undefined,
}

export interface TransformersJsOpaqueStructureSummary {
  kind: 'nullish' | 'array' | 'object' | 'primitive',
  valueType: string,
  constructorName: string | undefined,
  ownKeyCount: number,
  ownKeys: string[],
  arrayLength: number | undefined,
  truncated: boolean,
}

export type TransformersJsProductionInvestigationFullConversationInput =
  | {
      status: 'observed',
      inputTokenIds: number[],
    }
  | {
      status: 'unavailable',
      reason: string,
    };

export type TransformersJsProductionInvestigationCacheDecision =
  | {
      status: 'reused' | 'not-reused' | 'not-applicable',
      reason: string,
    }
  | {
      status: 'unavailable',
      reason: string,
    };

export interface TransformersJsProductionInvestigationTurnObservation {
  messages: ChatMessage[],
  inputKeys: string[],
  inputTensors: TransformersJsProductionInvestigationInputTensorMetadata[],
  inputTokenIds: number[],
  fullConversationInput: TransformersJsProductionInvestigationFullConversationInput,
  cacheDecision: TransformersJsProductionInvestigationCacheDecision,
  pastKeyValuesProvided: boolean,
  inputPastKeyValuesSummary: TransformersJsOpaqueStructureSummary,
  outputPastKeyValuesSummary: TransformersJsOpaqueStructureSummary,
  generatedSequenceTokenIds: number[],
  generatedTokenIds: number[],
  generatedText: string,
  streamChunks: string[],
  toolCalls: ToolCall[],
  effectiveGenerationConfig: {
    maxNewTokens: 1 | 16,
    temperature: 0,
    topP: 1,
    doSample: false,
  },
}

export type TransformersJsProductionInvestigationFirstTurnObservation =
  | {
      status: 'passed',
      turn: TransformersJsProductionInvestigationTurnObservation,
    }
  | {
      status: 'failed',
      error: TransformersJsProductionInvestigationError,
    };

export type TransformersJsProductionInvestigationContinuityObservation =
  | {
      status: 'passed',
      assistantMessage: ChatMessage,
      followUpMessage: ChatMessage,
      secondTurn: TransformersJsProductionInvestigationTurnObservation,
      prefixComparison: {
        mode: 'full-input-prefix' | 'cache-suffix' | 'not-applicable-encoder-decoder',
        expectedPrefixTokenIds: number[],
        secondInputTokenIds: number[],
        reconstructedFullInputTokenIds: number[] | undefined,
        comparisonInputSource: 'reconstructed-full-conversation' | 'actual-model-input' | 'not-applicable',
        exactPrefixMatch: boolean | undefined,
        firstMismatchIndex: number | undefined,
        firstMismatchContext: {
          startIndex: number,
          expectedTokenIds: number[],
          actualTokenIds: number[],
          expectedText: string,
          actualText: string,
        } | undefined,
      },
    }
  | {
      status: 'failed',
      assistantMessage: ChatMessage,
      followUpMessage: ChatMessage,
      error: TransformersJsProductionInvestigationError,
    }
  | {
      status: 'not-run',
      reason: string,
    };

export type TransformersJsProductionInvestigationToolResultContinuationObservation =
  | {
      status: 'passed',
      source: 'reference-parser-roundtrip',
      strategy: TransformersJsProductionInvestigationStrategy,
      messages: ChatMessage[],
      expectedInputTokenIds: number[],
      comparisonInputSource: 'reconstructed-full-conversation' | 'actual-model-input',
      inputTokenExactMatch: boolean,
      firstInputMismatchIndex: number | undefined,
      turn: TransformersJsProductionInvestigationTurnObservation,
    }
  | {
      status: 'failed',
      source: 'reference-parser-roundtrip',
      strategy: TransformersJsProductionInvestigationStrategy | undefined,
      messages: ChatMessage[],
      expectedInputTokenIds: number[],
      error: TransformersJsProductionInvestigationError,
    }
  | {
      status: 'not-run',
      reason: string,
    };

export type TransformersJsProductionInvestigationReasoningEffortObservation =
  | {
      effort: 'none' | 'high',
      status: 'passed',
      inputTokenCount: number,
    }
  | {
      effort: 'none' | 'high',
      status: 'failed',
      error: TransformersJsProductionInvestigationError,
    };

export type TransformersJsProductionInvestigationReasoningObservation =
  | {
      status: 'observed',
      source: 'existing-production-strategy',
      strategy: 'qwen3_5',
      disabledEffort: 'none',
      enabledEffort: 'high',
      disabledTurn: TransformersJsProductionInvestigationTurnObservation,
      enabledTurn: TransformersJsProductionInvestigationTurnObservation,
      inputTokenExactMatch: boolean,
      firstInputMismatchIndex: number | undefined,
    }
  | {
      status: 'failed',
      source: 'existing-production-strategy',
      strategy: 'qwen3_5',
      failedEffort: 'none' | 'high',
      disabledTurn: TransformersJsProductionInvestigationTurnObservation | undefined,
      enabledTurn: TransformersJsProductionInvestigationTurnObservation | undefined,
      effortAttempts: TransformersJsProductionInvestigationReasoningEffortObservation[],
      error: TransformersJsProductionInvestigationError,
    }
  | {
      status: 'unavailable',
      reason: string,
    };

export type TransformersJsProductionInvestigationMultimodalObservation =
  | {
      status: 'observed',
      source: 'fixed-synthetic-fixture-and-existing-production-strategy',
      strategy: 'gemma4',
      fixture: Omit<TransformersJsProductionInvestigationScenario['multimodalFixture'], 'dataUrl'>,
      turn: TransformersJsProductionInvestigationTurnObservation,
    }
  | {
      status: 'failed',
      source: 'fixed-synthetic-fixture-and-existing-production-strategy',
      strategy: 'gemma4',
      fixture: Omit<TransformersJsProductionInvestigationScenario['multimodalFixture'], 'dataUrl'>,
      error: TransformersJsProductionInvestigationError,
    }
  | {
      status: 'unavailable',
      strategy: TransformersJsProductionInvestigationStrategy,
      reason: string,
    };

export interface TransformersJsProductionInvestigationPartialObservation {
  modelId: string,
  resolvedRevision: string,
  loaderRevisionOption?: string | null,
  /** Wall-clock time for Production model candidate load plus tokenizer/processor preparation. */
  runtimeLoadDurationMs?: number,
  /** Wall-clock time spent preparing the Production tokenizer/processor after the model candidate loaded. */
  runtimePreparationDurationMs?: number,
  candidate: TransformersJsProductionInvestigationCandidate | undefined,
  loadAttempts?: TransformersJsProductionInvestigationCandidateLoadAttempt[],
  activeLoadAttempt?: TransformersJsProductionInvestigationActiveCandidateLoadAttempt,
  route: {
    autoClass: TransformersJsProductionInvestigationAutoClass,
    processor: TransformersJsProductionInvestigationProcessor,
    strategy: TransformersJsProductionInvestigationStrategy,
    modelType: string | undefined,
  } | undefined,
  isEncoderDecoder: boolean | undefined,
  firstTurn: TransformersJsProductionInvestigationFirstTurnObservation | undefined,
  continuity: TransformersJsProductionInvestigationContinuityObservation | undefined,
  toolResultContinuation: TransformersJsProductionInvestigationToolResultContinuationObservation | undefined,
  reasoning: TransformersJsProductionInvestigationReasoningObservation | undefined,
  multimodal: TransformersJsProductionInvestigationMultimodalObservation | undefined,
}

export interface TransformersJsProductionInvestigationObservation {
  modelId: string,
  resolvedRevision: string,
  loaderRevisionOption?: string | null,
  /** Wall-clock time for Production model candidate load plus tokenizer/processor preparation. */
  runtimeLoadDurationMs?: number,
  /** Wall-clock time spent preparing the Production tokenizer/processor after the model candidate loaded. */
  runtimePreparationDurationMs?: number,
  candidate: TransformersJsProductionInvestigationCandidate,
  loadAttempts?: TransformersJsProductionInvestigationCandidateLoadAttempt[],
  route: {
    autoClass: TransformersJsProductionInvestigationAutoClass,
    processor: TransformersJsProductionInvestigationProcessor,
    strategy: TransformersJsProductionInvestigationStrategy,
    modelType: string | undefined,
  },
  isEncoderDecoder: boolean,
  firstTurn: TransformersJsProductionInvestigationFirstTurnObservation,
  continuity: TransformersJsProductionInvestigationContinuityObservation,
  toolResultContinuation: TransformersJsProductionInvestigationToolResultContinuationObservation,
  reasoning: TransformersJsProductionInvestigationReasoningObservation,
  multimodal: TransformersJsProductionInvestigationMultimodalObservation,
}

// We define the interface here so that the service can use it
// without importing the entire worker file.
export interface ITransformersJsWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  downloadModel(modelId: string, progressCallback: WorkerProxy<(x: ProgressInfo) => void>): Promise<void>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  prefetchUrls(urls: string[], progressCallback: WorkerProxy<(x: ProgressInfo) => void>): Promise<TransformersJsPrefetchResult>,
  /**
   * Loads a model that has already been fully downloaded.
   *
   * IMPORTANT: This operation MUST NOT start, resume, repair, or otherwise
   * perform any model download. Missing or incomplete artifacts MUST fail the
   * load instead of falling back to a remote fetch.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  loadDownloadedModel(modelId: string, revision: string | undefined, progressCallback: WorkerProxy<(x: ProgressInfo) => void>): Promise<ModelLoadResult>,
  /**
   * Download Verification only: verifies exactly one Production candidate from
   * already-downloaded artifacts. No candidate fallback or remote model fetch.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  verifyDownloadedModelCandidate(
    modelId: string,
    revision: string | undefined,
    candidate: TransformersJsProductionInvestigationCandidate,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callback is proxied across the Comlink boundary.
    progressCallback: WorkerProxy<(x: ProgressInfo) => void>,
  ): Promise<ModelLoadResult>,
  /**
   * Download Verification only: verifies one cached revision using the full
   * Production candidate fallback sequence. No remote model fetch.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  verifyDownloadedModelRevision(
    modelId: string,
    revision: string | undefined,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callback is proxied across the Comlink boundary.
    progressCallback: WorkerProxy<(x: ProgressInfo) => void>,
  ): Promise<ModelLoadResult>,
  /**
   * Download Verification only: lets Transformers.js prepare config/tokenizer/processor
   * files for one immutable public Hub revision. Model/weight fetches are blocked.
   */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink remote boundaries use positional top-level arguments.
  prepareModelRuntimeArtifacts(
    modelId: string,
    revision: string,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callback is proxied across the Comlink boundary.
    progressCallback: WorkerProxy<(x: ProgressInfo) => void>,
  ): Promise<TransformersJsRuntimeArtifactPreparationResult>,
  unloadModel(): Promise<void>,
  interrupt(): Promise<void>,
  resetCache(): Promise<void>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  generateText(
    messages: ChatMessage[],
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onChunk: WorkerProxy<(chunk: string) => void>,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onToolCalls: WorkerProxy<(toolCalls: ToolCall[]) => void>,
    params?: LmParameters,
    tools?: WorkerToolDefinition[]
  ): Promise<void>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callbacks must be top-level arguments; nested proxy callbacks are not structured-cloneable.
  runModelSupportInvestigationScenario(
    scenario: TransformersJsProductionInvestigationScenario,
    progressCallback: WorkerProxy<TransformersJsProductionInvestigationProgressCallback>,
    observationCheckpointCallback: WorkerProxy<({ observation }: { observation: TransformersJsProductionInvestigationPartialObservation }) => void>,
  ): Promise<TransformersJsProductionInvestigationObservation>,
}

export interface TransformersJsWorkerClient {
  downloadModel({ modelId, progressCallback }: {
    modelId: string,
    progressCallback: TransformersJsProgressCallback,
  }): Promise<void>,
  prefetchUrls({ urls, progressCallback }: {
    urls: string[],
    progressCallback: TransformersJsProgressCallback,
  }): Promise<TransformersJsPrefetchResult>,
  /**
   * Loads a model that has already been fully downloaded. This MUST NOT start,
   * resume, repair, or otherwise perform any model download.
   */
  loadDownloadedModel({ modelId, revision, progressCallback }: {
    modelId: string,
    revision?: string,
    progressCallback: TransformersJsProgressCallback,
  }): Promise<ModelLoadResult>,
  unloadModel(): Promise<void>,
  interrupt(): Promise<void>,
  resetCache(): Promise<void>,
  generateText({ messages, onChunk, onToolCalls, params, tools }: {
    messages: ChatMessage[],
    onChunk: TransformersJsChunkCallback,
    onToolCalls: TransformersJsToolCallsCallback,
    params?: LmParameters,
    tools?: WorkerToolDefinition[],
  }): Promise<void>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
