import type { TransformersJsInferenceScope, TransformersJsInferenceOperation } from './inference-operation';
import type { TransformersJsProviderService } from './provider-hosted';

/** Pass-through scope for Provider-only fixtures, not a concurrency oracle. */
export async function runProviderTestInferenceOperation({ service, signal, operation }: TransformersJsInferenceOperation & {
  service: Pick<TransformersJsProviderService, 'getState' | 'loadDownloadedModel' | 'generateText'> & {
    generateMessage?: ({ messages, onEvent, params, tools, continuationOwner, signal }: Parameters<TransformersJsInferenceScope['generateMessage']>[0] & { signal: AbortSignal }) => Promise<void>,
  },
}): Promise<void> {
  const activeSignal = signal ?? new AbortController().signal;
  await operation({ scope: {
    signal: activeSignal,
    assertActive() {
      if (activeSignal.aborted) throw new Error('Generation aborted');
    },
    getState: () => service.getState(),
    loadDownloadedModel: ({ modelId }) => service.loadDownloadedModel({ modelId }),
    generateMessage: ({ messages, onEvent, params, tools, continuationOwner }) => {
      if (service.generateMessage === undefined) throw new Error('The fixture must supply a structured generation, not infer it from text callbacks.');
      return service.generateMessage({ messages, onEvent, params, tools, continuationOwner, signal: activeSignal });
    },
    generateText: ({ messages, onChunk, onToolCalls, params, tools, continuationOwner }) => service.generateText({ messages, onChunk, onToolCalls, params, tools, continuationOwner, signal: activeSignal }),
  } });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
