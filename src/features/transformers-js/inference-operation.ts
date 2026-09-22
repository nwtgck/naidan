import type { InferenceGenerationCallback } from './generation-events';
import type { LmParameters } from '@/01-models/types';
import type { InferenceMessage } from '@/features/transformers-js/types';
import type { TransformersJsChunkCallback, TransformersJsToolCallsCallback, WorkerToolDefinition } from './types';

export interface TransformersJsInferenceScope {
  readonly signal: AbortSignal,
  assertActive(): void,
  getState(): { status: 'idle' | 'loading' | 'ready' | 'error', activeModelId: string | undefined },
  loadDownloadedModel({ modelId }: { modelId: string }): Promise<void>,
  generateText({ messages, onChunk, onToolCalls, params, tools, continuationOwner }: {
    messages: InferenceMessage[],
    onChunk: TransformersJsChunkCallback,
    onToolCalls: TransformersJsToolCallsCallback,
    params: LmParameters | undefined,
    tools: WorkerToolDefinition[] | undefined,
    continuationOwner: string | undefined,
  }): Promise<void>,
  generateMessage({ messages, onEvent, params, tools, continuationOwner }: {
    messages: InferenceMessage[],
    onEvent: InferenceGenerationCallback,
    params: LmParameters | undefined,
    tools: WorkerToolDefinition[] | undefined,
    continuationOwner: string | undefined,
  }): Promise<void>,
}

export interface TransformersJsInferenceOperation {
  signal: AbortSignal | undefined,
  operation: ({ scope }: { scope: TransformersJsInferenceScope }) => Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
