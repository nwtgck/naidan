/* eslint-disable no-restricted-imports -- Worker-facing transformers.js type references are centralized here to keep service and worker contracts aligned. */
import type { AutoProcessor, AutoTokenizer, AutoModelForCausalLM, AutoModelForImageTextToText } from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/models/types';

/**
 * Shared types for Transformers.js service and worker
 */

export interface ProgressInfo {
  status: string;
  progress?: number;
  loaded?: number;
  total?: number;
  name?: string;
  file?: string;
}

export interface ModelLoadResult {
  device: string;
}

export interface ScannedModelFile {
  url: string;
}

export type ScanTask =
  | { type: 'tokenizer'; modelId: string; options: Parameters<typeof AutoTokenizer.from_pretrained>[1] }
  | { type: 'processor'; modelId: string; options: Parameters<typeof AutoProcessor.from_pretrained>[1] }
  | { type: 'causal-lm'; modelId: string; options: Parameters<typeof AutoModelForCausalLM.from_pretrained>[1] }
  | { type: 'image-text-to-text'; modelId: string; options: Parameters<typeof AutoModelForImageTextToText.from_pretrained>[1] };

export interface ScanOptions {
  tasks: ScanTask[];
}

export interface ITransformersJsScannerWorker {
  scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }>;
}

export interface TransformersJsScannerWorkerClient {
  scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }>;
  dispose(): Promise<void>;
}

export interface WorkerToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type TransformersJsProgressCallback = ({ info }: { info: ProgressInfo }) => void;
export type TransformersJsChunkCallback = ({ chunk }: { chunk: string }) => void;
export type TransformersJsToolCallsCallback = ({ toolCalls }: { toolCalls: ToolCall[] }) => void;

// We define the interface here so that the service can use it
// without importing the entire worker file.
export interface ITransformersJsWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<void>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  prefetchUrls(urls: string[], progressCallback: (x: ProgressInfo) => void): Promise<void>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  loadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<ModelLoadResult>;
  unloadModel(): Promise<void>;
  interrupt(): Promise<void>;
  resetCache(): Promise<void>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
  generateText(
    messages: ChatMessage[],
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onChunk: (chunk: string) => void,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    onToolCalls: (toolCalls: ToolCall[]) => void,
    params?: LmParameters,
    tools?: WorkerToolDefinition[]
  ): Promise<void>;
}

export interface TransformersJsWorkerClient {
  downloadModel({ modelId, progressCallback }: {
    modelId: string
    progressCallback: TransformersJsProgressCallback
  }): Promise<void>;
  prefetchUrls({ urls, progressCallback }: {
    urls: string[]
    progressCallback: TransformersJsProgressCallback
  }): Promise<void>;
  loadModel({ modelId, progressCallback }: {
    modelId: string
    progressCallback: TransformersJsProgressCallback
  }): Promise<ModelLoadResult>;
  unloadModel(): Promise<void>;
  interrupt(): Promise<void>;
  resetCache(): Promise<void>;
  generateText({ messages, onChunk, onToolCalls, params, tools }: {
    messages: ChatMessage[]
    onChunk: TransformersJsChunkCallback
    onToolCalls: TransformersJsToolCallsCallback
    params?: LmParameters
    tools?: WorkerToolDefinition[]
  }): Promise<void>;
  dispose(): Promise<void>;
}
