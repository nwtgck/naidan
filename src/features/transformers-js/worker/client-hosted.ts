import { workerProxy } from '@/utils/worker-transport';
import { createProductionWorkerSession } from './production-worker-session';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import type {
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
      async loadDownloadedModel({ modelId: _modelId, revision: _revision, progressCallback: _progressCallback }) {
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
    new URL('./bootstrap.ts', import.meta.url),
    { type: 'module' },
  );

  const session = createProductionWorkerSession({ worker, startupTimeoutMs: undefined });
  return {
    async loadDownloadedModel({ modelId, revision, progressCallback }: {
      modelId: string,
      revision?: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<ModelLoadResult> {
      return session.run({ operation: ({ remote }) => remote.loadDownloadedModel(
        modelId, revision,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
        workerProxy({ value: (info: ProgressInfo) => {
          if (session.isActive()) return progressCallback({ info });
        } }),
      ) });
    },
    async unloadModel(): Promise<void> {
      return session.run({ operation: ({ remote }) => remote.unloadModel() });
    },
    async interrupt(): Promise<void> {
      return session.run({ operation: ({ remote }) => remote.interrupt() });
    },
    async resetCache(): Promise<void> {
      return session.run({ operation: ({ remote }) => remote.resetCache() });
    },
    async generateText({ messages, onChunk, onToolCalls, params, tools }: {
      messages: ChatMessage[],
      onChunk: TransformersJsChunkCallback,
      onToolCalls: TransformersJsToolCallsCallback,
      params?: LmParameters,
      tools?: WorkerToolDefinition[],
    }): Promise<void> {
      return session.run({ operation: ({ remote }) => remote.generateText(
        messages,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
        workerProxy({ value: (chunk: string) => {
          if (session.isActive()) return onChunk({ chunk });
        } }),
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
        workerProxy({ value: (toolCalls: ToolCall[]) => {
          if (session.isActive()) return onToolCalls({ toolCalls });
        } }),
        params,
        tools,
      ) });
    },
    async dispose(): Promise<void> {
      session.dispose();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
