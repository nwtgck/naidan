import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
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
  TransformersJsPrefetchResult,
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

  const remote = wrapWorkerRemote<ITransformersJsWorker>({ endpoint: worker });
  return {
    async downloadModel({ modelId, progressCallback }: {
      modelId: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<void> {
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
      return remote.downloadModel(modelId, workerProxy({ value: (info: ProgressInfo) => progressCallback({ info }) }));
    },
    async prefetchUrls({ urls, progressCallback }: {
      urls: string[],
      progressCallback: TransformersJsProgressCallback,
    }): Promise<TransformersJsPrefetchResult> {
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
      return remote.prefetchUrls(urls, workerProxy({ value: (info: ProgressInfo) => progressCallback({ info }) }));
    },
    async loadModel({ modelId, progressCallback }: {
      modelId: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<ModelLoadResult> {
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
      return remote.loadModel(modelId, workerProxy({ value: (info: ProgressInfo) => progressCallback({ info }) }));
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
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
        workerProxy({ value: (chunk: string) => onChunk({ chunk }) }),
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
        workerProxy({ value: (toolCalls: ToolCall[]) => onToolCalls({ toolCalls }) }),
        params,
        tools,
      );
    },
    async dispose(): Promise<void> {
      try {
        await releaseWorkerRemote({ remote });
      } finally {
        worker.terminate();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
