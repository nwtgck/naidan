import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
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

  chat({ messages, model, parameters, tools, readBinaryObject, debug, signal }: Parameters<LmProvider['chat']>[0]): AsyncIterable<ChatGenerationItem> {
    return createLlamaCppGeneration({ request: { messages, model, parameters, tools, readBinaryObject, debug, signal }, generate: this.service.generate.bind(this.service) });
  }

  async runChatOperation({ signal, operation }: Parameters<NonNullable<LmProvider['runChatOperation']>>[0]): Promise<void> {
    await this.service.runGenerationOperation({ signal, operation: async ({ scope }) => {
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
    } });
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
