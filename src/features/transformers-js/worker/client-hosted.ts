import * as Comlink from 'comlink';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import type {
  ITransformersJsWorker,
  TransformersJsWorkerClient,
  WorkerToolDefinition,
  ProgressInfo,
  ModelLoadResult,
  TransformersJsProgressCallback,
  TransformersJsChunkCallback,
  TransformersJsToolCallsCallback,
} from '@/features/transformers-js/types';

function createUnavailableEnvironmentError(): Error {
  return new Error('Transformers.js worker is not available in this environment');
}

export function createTransformersJsWorkerClient(): TransformersJsWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async downloadModel({ modelId: _modelId, progressCallback: _progressCallback }) {
        throw createUnavailableEnvironmentError();
      },
      async prefetchUrls({ urls: _urls, progressCallback: _progressCallback }) {
        throw createUnavailableEnvironmentError();
      },
      async loadModel({ modelId: _modelId, progressCallback: _progressCallback }) {
        throw createUnavailableEnvironmentError();
      },
      async unloadModel() {
        throw createUnavailableEnvironmentError();
      },
      async interrupt() {
        throw createUnavailableEnvironmentError();
      },
      async resetCache() {
        throw createUnavailableEnvironmentError();
      },
      async generateText({ messages: _messages, onChunk: _onChunk, onToolCalls: _onToolCalls, params: _params, tools: _tools }) {
        throw createUnavailableEnvironmentError();
      },
      async dispose() {
      },
    };
  }

  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    { type: 'module' },
  );

  const remote = Comlink.wrap<ITransformersJsWorker>(worker);

  return {
    async downloadModel({ modelId, progressCallback }: {
      modelId: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<void> {
      return remote.downloadModel(modelId, Comlink.proxy((info: ProgressInfo) => progressCallback({ info })));
    },
    async prefetchUrls({ urls, progressCallback }: {
      urls: string[],
      progressCallback: TransformersJsProgressCallback,
    }): Promise<void> {
      return remote.prefetchUrls(urls, Comlink.proxy((info: ProgressInfo) => progressCallback({ info })));
    },
    async loadModel({ modelId, progressCallback }: {
      modelId: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<ModelLoadResult> {
      return remote.loadModel(modelId, Comlink.proxy((info: ProgressInfo) => progressCallback({ info })));
    },
    async unloadModel(): Promise<void> {
      return remote.unloadModel();
    },
    async interrupt(): Promise<void> {
      return remote.interrupt();
    },
    async resetCache(): Promise<void> {
      return remote.resetCache();
    },
    async generateText({ messages, onChunk, onToolCalls, params, tools }: {
      messages: ChatMessage[],
      onChunk: TransformersJsChunkCallback,
      onToolCalls: TransformersJsToolCallsCallback,
      params?: LmParameters,
      tools?: WorkerToolDefinition[],
    }): Promise<void> {
      return remote.generateText(
        messages,
        Comlink.proxy((chunk: string) => onChunk({ chunk })),
        Comlink.proxy((toolCalls: ToolCall[]) => onToolCalls({ toolCalls })),
        params,
        tools,
      );
    },
    async dispose(): Promise<void> {
      try {
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
