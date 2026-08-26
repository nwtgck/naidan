/* eslint-disable no-restricted-imports -- Worker-facing transformers.js type references are centralized here to keep service and worker contracts aligned. */
import type { AutoProcessor, AutoTokenizer, AutoModelForCausalLM, AutoModelForImageTextToText } from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';

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

export interface ModelLoadResult {
  device: string,
}

export interface ScannedModelFile {
  url: string,
}

export type ScanTask =
  | { type: 'tokenizer', modelId: string, options: Parameters<typeof AutoTokenizer.from_pretrained>[1] }
  | { type: 'processor', modelId: string, options: Parameters<typeof AutoProcessor.from_pretrained>[1] }
  | { type: 'causal-lm', modelId: string, options: Parameters<typeof AutoModelForCausalLM.from_pretrained>[1] }
  | { type: 'image-text-to-text', modelId: string, options: Parameters<typeof AutoModelForImageTextToText.from_pretrained>[1] };

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

export interface WorkerToolDefinition {
  type: 'function',
  function: {
    name: string,
    description: string,
    parameters: Record<string, unknown>,
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
      error: {
        name: string,
        message: string,
      },
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
export type TransformersJsProductionInvestigationStrategy =
  | 'standard'
  | 'gpt-oss'
  | 'qwen3_5'
  | 'gemma4';

export interface TransformersJsProductionInvestigationScenario {
  modelId: string,
  resolvedRevision: string,
  cacheRevisionAliases: TransformersJsCacheRevisionAlias[],
  candidate: {
    device: TransformersJsProductionInvestigationDevice,
    dtype: TransformersJsProductionInvestigationDtype,
  },
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

export interface TransformersJsProductionInvestigationTurnObservation {
  messages: ChatMessage[],
  inputKeys: string[],
  inputTensors: TransformersJsProductionInvestigationInputTensorMetadata[],
  inputTokenIds: number[],
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
        exactPrefixMatch: boolean | undefined,
        firstMismatchIndex: number | undefined,
      },
    }
  | {
      status: 'failed',
      assistantMessage: ChatMessage,
      followUpMessage: ChatMessage,
      error: {
        name: string,
        message: string,
      },
    };

export type TransformersJsProductionInvestigationToolResultContinuationObservation =
  | {
      status: 'passed',
      source: 'reference-parser-roundtrip',
      strategy: TransformersJsProductionInvestigationStrategy,
      messages: ChatMessage[],
      expectedInputTokenIds: number[],
      inputTokenExactMatch: boolean,
      firstInputMismatchIndex: number | undefined,
      turn: TransformersJsProductionInvestigationTurnObservation,
    }
  | {
      status: 'failed',
      source: 'reference-parser-roundtrip',
      strategy: TransformersJsProductionInvestigationStrategy,
      messages: ChatMessage[],
      expectedInputTokenIds: number[],
      error: {
        name: string,
        message: string,
      },
    }
  | {
      status: 'not-run',
      reason: string,
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
      error: {
        name: string,
        message: string,
      },
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
      error: {
        name: string,
        message: string,
      },
    }
  | {
      status: 'unavailable',
      strategy: TransformersJsProductionInvestigationStrategy,
      reason: string,
    };

export interface TransformersJsProductionInvestigationObservation extends TransformersJsProductionInvestigationTurnObservation {
  modelId: string,
  resolvedRevision: string,
  candidate: TransformersJsProductionInvestigationScenario['candidate'],
  route: {
    autoClass: TransformersJsProductionInvestigationAutoClass,
    processor: TransformersJsProductionInvestigationProcessor,
    strategy: TransformersJsProductionInvestigationStrategy,
    modelType: string | undefined,
  },
  isEncoderDecoder: boolean,
  continuity: TransformersJsProductionInvestigationContinuityObservation,
  toolResultContinuation: TransformersJsProductionInvestigationToolResultContinuationObservation,
  reasoning: TransformersJsProductionInvestigationReasoningObservation,
  multimodal: TransformersJsProductionInvestigationMultimodalObservation,
}

// We define the interface here so that the service can use it
// without importing the entire worker file.
export interface ITransformersJsWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<void>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  prefetchUrls(urls: string[], progressCallback: (x: ProgressInfo) => void): Promise<TransformersJsPrefetchResult>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  loadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<ModelLoadResult>,
  unloadModel(): Promise<void>,
  interrupt(): Promise<void>,
  resetCache(): Promise<void>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  generateText(
    messages: ChatMessage[],
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onChunk: (chunk: string) => void,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onToolCalls: (toolCalls: ToolCall[]) => void,
    params?: LmParameters,
    tools?: WorkerToolDefinition[]
  ): Promise<void>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callbacks must be top-level arguments; nested proxy callbacks are not structured-cloneable.
  runModelSupportInvestigationScenario(
    scenario: TransformersJsProductionInvestigationScenario,
    progressCallback: TransformersJsProgressCallback,
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
  loadModel({ modelId, progressCallback }: {
    modelId: string,
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
