import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
import type { NaidanRpcRegistrationId } from '@/01-models/ids';
import type { NaidanPeerClient } from '@/features/naidan-rpc-integration/contract';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { createLlamaCppGeneration, createScopedGeneration } from '@/features/llama-cpp-browser/provider-generation';
import { prepareTranscript, receiveEvents } from '@/features/naidan-rpc-integration/codecs/chat-wire';
import { getRpcManager } from '@/features/naidan-rpc-integration/runtime/feature';

/** Adapts the derived caller to Naidan's existing chat/part pipeline. This
 * module imports no native runtime, model storage or Worker implementation. */
export class NaidanRpcLmProvider implements LmProvider {
  private readonly registrationId: NaidanRpcRegistrationId | undefined;
  constructor({ registrationId }: { registrationId: NaidanRpcRegistrationId | undefined }) {
    this.registrationId = registrationId;
  }
  private async client(): Promise<NaidanPeerClient> {
    if (!this.registrationId) throw new Error('Select a connection in Naidan RPC settings');
    return (await getRpcManager()).client({ id: this.registrationId });
  }
  async listModels({ signal }: { signal: AbortSignal | undefined }): Promise<string[]> {
    const call = (await this.client()).listChatModels({ input: {}, on: {}, signal, timeoutMs: undefined });
    try {
      const reader = (await call.result).getReader(), result: string[] = [];
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          if (result.length >= 256) throw new Error('Too many remote models');
          result.push(item.value.ref);
        }
      } finally {
        reader.releaseLock();
      }
      await call.closed; return result;
    } catch (error) {
      call.cancel({ reason: 'Model listing stopped' }); throw error;
    }
  }
  private generate({ client }: { client: NaidanPeerClient }): LlamaCppBrowserService['generate'] {
    return async ({ input, signal, onEvent }) => {
      signal?.throwIfAborted();
      const call = client.generateChat({
        input: { model: input.model, ...prepareTranscript({ input }) },
        on: { progress: undefined },
        signal,
        timeoutMs: undefined,
      });
      try {
        const output = await call.result;
        const result = await receiveEvents({ readable: output.events, onEvent, signal: signal ?? new AbortController().signal });
        await call.closed; return result;
      } catch (error) {
        call.cancel({ reason: 'Chat generation stopped' }); throw error;
      }
    };
  }
  chat({ ...request }: Parameters<LmProvider['chat']>[0]): AsyncIterable<ChatGenerationItem> {
    return createLlamaCppGeneration({ request, generate: async ({ ...args }) => this.generate({ client: await this.client() })(args) });
  }
  async runChatOperation({ signal, operation }: Parameters<NonNullable<LmProvider['runChatOperation']>>[0]): Promise<void> {
    // A multi-tool operation stays pinned to this session. A later reconnect
    // cannot silently redirect its next generation to a new RPC peer instance.
    const client = await this.client(); signal?.throwIfAborted();
    const stop = new AbortController();
    const scope = createScopedGeneration({ scope: { signal: signal ?? stop.signal, generate: this.generate({ client }) } });
    try {
      await operation({ chat: scope.chat, signal: signal ?? stop.signal });
    } finally {
      stop.abort(); await scope.close();
    }
  }
}
export const TEST_ONLY = {
};
