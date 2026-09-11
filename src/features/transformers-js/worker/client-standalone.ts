import type { ChatMessage, LmParameters } from '@/01-models/types';
import type { GenerationCaptureClient, GenerationCaptureRequest } from './generation-capture-protocol';
import type { DownloadedModelRevisionSelection } from '@/features/transformers-js/runtime/downloaded-model-revision-selection';
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

/** Standalone cannot create a Production recording Worker. */
export function createTransformersJsGenerationCaptureClient({ runId: _runId, workerEpoch: _workerEpoch, limits: _limits, getActiveRequest: _getActiveRequest }: {
  runId: string;
  workerEpoch: number;
  limits: GenerationCaptureRequest['limits'];
  getActiveRequest: () => { runId: string; requestId: string } | undefined;
}): GenerationCaptureClient {
  throw createUnsupportedError();
}

export function createTransformersJsWorkerClient(): TransformersJsWorkerClient {
  return {
    async loadDownloadedModel({ modelId: _modelId, revisionSelection: _revisionSelection, progressCallback: _progressCallback }: {
      modelId: string,
      revisionSelection: DownloadedModelRevisionSelection,
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
    async generateText({ messages: _messages, onChunk: _onChunk, onToolCalls: _onToolCalls, params: _params, tools: _tools, continuationOwner: _continuationOwner }: {
      messages: ChatMessage[],
      onChunk: TransformersJsChunkCallback,
      onToolCalls: TransformersJsToolCallsCallback,
      params?: LmParameters,
      tools?: WorkerToolDefinition[],
      continuationOwner?: string,
    }): Promise<void> {
      throw createUnsupportedError();
    },
    async dispose(): Promise<void> {
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
