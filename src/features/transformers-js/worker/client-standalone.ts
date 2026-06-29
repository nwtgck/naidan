import type { ChatMessage, LmParameters } from '@/01-models/types';
import type {
  TransformersJsWorkerClient,
  ModelLoadResult,
  WorkerToolDefinition,
  TransformersJsProgressCallback,
  TransformersJsChunkCallback,
  TransformersJsToolCallsCallback,
} from '@/features/transformers-js/types';

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode');
}

export function createTransformersJsWorkerClient(): TransformersJsWorkerClient {
  return {
    async downloadModel({ modelId: _modelId, progressCallback: _progressCallback }: {
      modelId: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<void> {
      throw createUnsupportedError();
    },
    async prefetchUrls({ urls: _urls, progressCallback: _progressCallback }: {
      urls: string[],
      progressCallback: TransformersJsProgressCallback,
    }): Promise<void> {
      throw createUnsupportedError();
    },
    async loadModel({ modelId: _modelId, progressCallback: _progressCallback }: {
      modelId: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<ModelLoadResult> {
      throw createUnsupportedError();
    },
    async unloadModel(): Promise<void> {
      throw createUnsupportedError();
    },
    async interrupt(): Promise<void> {
      throw createUnsupportedError();
    },
    async resetCache(): Promise<void> {
      throw createUnsupportedError();
    },
    async generateText({ messages: _messages, onChunk: _onChunk, onToolCalls: _onToolCalls, params: _params, tools: _tools }: {
      messages: ChatMessage[],
      onChunk: TransformersJsChunkCallback,
      onToolCalls: TransformersJsToolCallsCallback,
      params?: LmParameters,
      tools?: WorkerToolDefinition[],
    }): Promise<void> {
      throw createUnsupportedError();
    },
    async dispose(): Promise<void> {
    },
  };
}
