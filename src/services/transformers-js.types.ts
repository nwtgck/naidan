import type { ChatMessage, LmParameters } from '../models/types';

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

// We define the interface here so that the service can use it
// without importing the entire worker file.
export interface ITransformersJsWorker {
  downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<void>;
  loadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<ModelLoadResult>;
  unloadModel(): Promise<void>;
  interrupt(): Promise<void>;
  resetCache(): Promise<void>;
  generateText(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    params?: LmParameters
  ): Promise<void>;
}