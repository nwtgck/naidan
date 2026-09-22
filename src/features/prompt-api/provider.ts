import { z } from 'zod';

import type { LmProvider, ChatGenerationItem } from '@/01-models/lm';
import type { LmParameters } from '@/01-models/types';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { snapshotChatRequest } from '@/features/lm/chat-request';

import { BROWSER_PROVIDED_LM_MODEL_ID } from './constants';
import { PromptApiError, normalizePromptApiError } from './errors';
import { mapChatMessagesToPromptApi } from './message-mapper';
import { acquirePromptApiGenerationSession } from './runtime';

const PromptApiChunkSchema = z.string();

function hasConfiguredLmParameters({ parameters }: {
  parameters: LmParameters | undefined,
}): boolean {
  if (parameters === undefined) return false;
  return (
    parameters.temperature !== undefined
    || parameters.topP !== undefined
    || parameters.maxCompletionTokens !== undefined
    || parameters.presencePenalty !== undefined
    || parameters.frequencyPenalty !== undefined
    || parameters.stop !== undefined
    || parameters.reasoning.effort !== undefined
  );
}

export class PromptApiProvider implements LmProvider {
  chat({ messages, model, parameters, tools, readBinaryObject, signal }: Parameters<LmProvider['chat']>[0]): AsyncIterable<ChatGenerationItem> {
    const snapshot = snapshotChatRequest({ messages, parameters, tools });
    return createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
      if (model !== BROWSER_PROVIDED_LM_MODEL_ID) {
        throw new PromptApiError({ code: 'unsupported_input', message: `Unsupported Prompt API model ID: ${model}` });
      }
      if (snapshot.tools?.length) {
        throw new PromptApiError({ code: 'unsupported_input', message: 'Prompt API tools are not supported yet.' });
      }
      if (hasConfiguredLmParameters({ parameters: snapshot.parameters })) {
        throw new PromptApiError({ code: 'unsupported_input', message: 'Prompt API LM parameters are not supported yet.' });
      }
      const { initialPrompts, prompt, inputMode } = await mapChatMessagesToPromptApi({ messages: snapshot.messages, readBinaryObject, signal });
      const lease = await acquirePromptApiGenerationSession({ initialPrompts, signal, inputMode });
      try {
        signal.throwIfAborted();
        const reader = lease.session.promptStreaming(prompt, { signal }).getReader();
        // Stop pending reads even when an implementation ignores the prompt signal.
        // Already accepted writer chunks remain in the local generation queue.
        const stop = () => {
          void reader.cancel(signal.reason).catch(() => {});
        };
        signal.addEventListener('abort', stop, { once: true });
        try {
          if (signal.aborted) stop();
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            await writer.text({ type: 'text', text: PromptApiChunkSchema.parse(result.value) });
          }
          return signal.aborted
            ? { type: 'interrupted', reason: 'aborted' }
            : { type: 'finished', next: 'user' };
        } finally {
          signal.removeEventListener('abort', stop);
          try {
            await reader.cancel();
          } finally {
            reader.releaseLock();
          }
        }
      } catch (error) {
        throw normalizePromptApiError({ error });
      } finally {
        lease.release();
      }
    } });
  }

  async listModels({ signal }: { signal: AbortSignal | undefined }): Promise<string[]> {
    signal?.throwIfAborted();
    return [BROWSER_PROVIDED_LM_MODEL_ID];
  }
}

export const TEST_ONLY = {
};
