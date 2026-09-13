import type { TransformersJsInferenceOperation } from './inference-operation';
import type { TransformersJsProviderService } from './provider-hosted';

/** Pass-through scope for Provider-only fixtures, not a concurrency oracle. */
export async function runProviderTestInferenceOperation({ service, signal, operation }: TransformersJsInferenceOperation & {
  service: Pick<TransformersJsProviderService, 'getState' | 'loadDownloadedModel' | 'generateText'>,
}): Promise<void> {
  const activeSignal = signal ?? new AbortController().signal;
  await operation({ scope: {
    signal: activeSignal,
    assertActive() {
      if (activeSignal.aborted) throw new Error('Generation aborted');
    },
    getState: () => service.getState(),
    loadDownloadedModel: ({ modelId }) => service.loadDownloadedModel({ modelId }),
    generateText: ({ messages, onChunk, onToolCalls, params, tools, continuationOwner }) => service.generateText({ messages, onChunk, onToolCalls, params, tools, continuationOwner, signal: activeSignal }),
  } });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
