import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
import { transformersJsService } from './index';
import { createInferenceGeneration } from './create-inference-generation';
import { createScopedChat, generateScopedMessage, snapshotChatRequest } from './provider-chat-operation';

export type TransformersJsProviderService = Pick<typeof transformersJsService,
  'loadDownloadedModel' | 'generateText' | 'listCachedModels' | 'runInferenceOperation'> & {
    getState(): Pick<ReturnType<typeof transformersJsService.getState>, 'status' | 'activeModelId'>,
  };

class HostedTransformersJsProvider implements LmProvider {
  private readonly service: TransformersJsProviderService;

  constructor({ service }: { service: TransformersJsProviderService }) {
    this.service = service;
  }

  chat({ messages, model, parameters, tools, readBinaryObject, debug, signal }: Parameters<LmProvider['chat']>[0]): AsyncIterable<ChatGenerationItem> {
    const request = snapshotChatRequest({ messages, model, parameters, tools, readBinaryObject, debug, signal });
    // Direct callers own one generation. A common tool loop uses the scoped
    // facade below so its intervening waits keep the same lane and cache owner.
    return createInferenceGeneration({ signal, generate: async ({ onEvent, signal }) => {
      await this.service.runInferenceOperation({ signal, operation: async ({ scope }) => {
        await generateScopedMessage({ scope, request, signal, onEvent, continuationOwner: crypto.randomUUID() });
      } });
    } });
  }

  async runChatOperation({ signal, operation }: Parameters<NonNullable<LmProvider['runChatOperation']>>[0]): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let callbackCompleted = false;
    try {
      await this.service.runInferenceOperation({ signal: controller.signal, operation: async ({ scope }) => {
        const owned = createScopedChat({ scope, controller, continuationOwner: crypto.randomUUID() });
        let failure: { error: unknown } | undefined;
        try {
          await operation({ chat: owned.chat, signal: scope.signal });
        } catch (error) {
          failure = { error };
        }
        try {
          await owned.close();
        } catch (error) {
          if (failure !== undefined && error !== failure.error) {
            throw new AggregateError([failure.error, error], 'Chat operation and cleanup failed.');
          }
          throw error;
        }
        if (failure !== undefined) throw failure.error;
        callbackCompleted = true;
      } });
    } catch (error) {
      // The lane rejects an ordinary cancellation at release. If the callback
      // already consumed and recorded that interruption, do not replace it with
      // another failure. Revoked runtimes and callback failures still propagate.
      if (!(callbackCompleted && signal?.aborted && error instanceof Error && error.name === 'AbortError')) throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async listModels({ signal: _signal }: { signal: AbortSignal | undefined }): Promise<string[]> {
    try {
      const models = await this.service.listCachedModels();
      return models.filter(model => model.isComplete).map(model => model.id);
    } catch (error) {
      console.warn('Failed to list local models for provider:', error);
      return [];
    }
  }
}

/** The ordinary facade and isolated owners use the same generation implementation. */
export function createTransformersJsProvider({ service }: { service: TransformersJsProviderService }): LmProvider {
  return new HostedTransformersJsProvider({ service });
}

export class TransformersJsProvider extends HostedTransformersJsProvider {
  constructor() {
    super({ service: transformersJsService });
  }
}

export const TEST_ONLY = {
};
