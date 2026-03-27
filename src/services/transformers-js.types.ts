import { AutoTokenizer, AutoModelForCausalLM } from '@huggingface/transformers';
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
  | { type: 'causal-lm'; modelId: string; options: Parameters<typeof AutoModelForCausalLM.from_pretrained>[1] };

export interface ScanOptions {
  tasks: ScanTask[];
}

export interface ITransformersJsScannerWorker {
  scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }>;
}

export interface WorkerToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// We define the interface here so that the service can use it
// without importing the entire worker file.
export interface ITransformersJsWorker {
  downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<void>;
  prefetchUrls(urls: string[], progressCallback: (x: ProgressInfo) => void): Promise<void>;
  loadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<ModelLoadResult>;
  unloadModel(): Promise<void>;
  interrupt(): Promise<void>;
  resetCache(): Promise<void>;
  generateText(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onToolCalls: (toolCalls: ToolCall[]) => void,
    params?: LmParameters,
    tools?: WorkerToolDefinition[]
  ): Promise<void>;
}