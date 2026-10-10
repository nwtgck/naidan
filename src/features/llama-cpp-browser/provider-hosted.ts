import type { ChatGenerationItem, LmOperationProgress, LmProvider } from '@/01-models/lm';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { createLlamaCppGeneration, createScopedGeneration } from './provider-generation';
import type { LlamaCppBrowserService } from './service-contract';

class HostedLlamaCppBrowserProvider implements LmProvider {
  private readonly service: Pick<LlamaCppBrowserService, 'listModels' | 'generate' | 'runGenerationOperation'>;

  constructor({ service }: { service: Pick<LlamaCppBrowserService, 'listModels' | 'generate' | 'runGenerationOperation'> }) {
    this.service = service;
  }

  async listModels({ signal }: { signal: AbortSignal | undefined }): Promise<string[]> {
    return (await this.service.listModels({ signal })).map(model => model.name);
  }

  chat({ messages, model, parameters, tools, readBinaryObject, debug, signal }: { messages: Parameters<LmProvider['chat']>[0]['messages'], model: Parameters<LmProvider['chat']>[0]['model'], parameters: Parameters<LmProvider['chat']>[0]['parameters'], tools: Parameters<LmProvider['chat']>[0]['tools'], readBinaryObject: Parameters<LmProvider['chat']>[0]['readBinaryObject'], debug: Parameters<LmProvider['chat']>[0]['debug'], signal: Parameters<LmProvider['chat']>[0]['signal'] }): AsyncIterable<ChatGenerationItem> {
    return createLlamaCppGeneration({ request: { messages, model, parameters, tools, readBinaryObject, debug, signal }, generate: this.service.generate.bind(this.service) });
  }

  async runChatOperation({ signal, operation, onProgress }: { signal: Parameters<NonNullable<LmProvider['runChatOperation']>>[0]['signal'], operation: Parameters<NonNullable<LmProvider['runChatOperation']>>[0]['operation'], onProgress?: Parameters<NonNullable<LmProvider['runChatOperation']>>[0]['onProgress'] }): Promise<void> {
    const notify = ({ progress }: { progress: LmOperationProgress }): void => {
      try {
        if (onProgress) void Promise.resolve(onProgress({ progress })).catch(() => undefined);
      } catch { /* Display-only, independent of operation success. */ }
    };
    if (!signal?.aborted) notify({ progress: { phase: 'queued', completed: 0, total: 0 } });
    await this.service.runGenerationOperation({
      signal,
      onProgress({ progress }) {
        if (signal?.aborted) return;
        const { phase, completed, total } = progress;
        switch (phase) {
        case 'initializing': case 'loading': case 'prefill': case 'generating': notify({ progress: { phase, completed, total } }); break;
        case 'importing': case 'decoding-audio': break;
        default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
        }
      },
      operation: async ({ scope }) => {
        const owned = createScopedGeneration({ scope });
        let failure: { error: unknown } | undefined;
        try {
          await operation({ chat: owned.chat, signal: scope.signal });
        } catch (error) {
          failure = { error };
        }
        try {
          await owned.close();
        } catch (error) {
          if (failure !== undefined && failure.error !== error) throw new AggregateError([failure.error, error], 'Chat operation and cleanup failed.');
          throw error;
        }
        if (failure !== undefined) throw failure.error;
      },
    });
  }
}

export function createLlamaCppProvider({ service }: { service: Pick<LlamaCppBrowserService, 'listModels' | 'generate' | 'runGenerationOperation'> }): LmProvider {
  return new HostedLlamaCppBrowserProvider({ service });
}

export class LlamaCppBrowserProvider extends HostedLlamaCppBrowserProvider {
  constructor() {
    super({ service: llamaCppBrowserService });
  }
}
export const TEST_ONLY = {
};
