import { z } from 'zod';

import type { LmProvider } from '@/01-models/lm';
import type { LmParameters } from '@/01-models/types';

import { PROMPT_API_MODEL_ID } from './constants';
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
  async chat({
    messages,
    model,
    onChunk,
    parameters,
    tools,
    onAssistantMessageStart,
    signal,
  }: Parameters<LmProvider['chat']>[0]): Promise<void> {

    signal?.throwIfAborted();

    if (model !== PROMPT_API_MODEL_ID) {
      throw new PromptApiError({
        code: 'unsupported_input',
        message: `Unsupported Prompt API model ID: ${model}`,
      });
    }
    if ((tools?.length ?? 0) > 0) {
      throw new PromptApiError({
        code: 'unsupported_input',
        message: 'Prompt API tools are not supported yet.',
      });
    }
    if (hasConfiguredLmParameters({ parameters })) {
      throw new PromptApiError({
        code: 'unsupported_input',
        message: 'Prompt API LM parameters are not supported yet.',
      });
    }

    const { initialPrompts, prompt } = mapChatMessagesToPromptApi({ messages });
    const lease = await acquirePromptApiGenerationSession({
      initialPrompts,
      signal,
    });

    try {
      const { session } = lease;
      signal?.throwIfAborted();
      onAssistantMessageStart?.();
      const stream = session.promptStreaming(prompt, { signal });
      const reader = stream.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          onChunk({ chunk: PromptApiChunkSchema.parse(result.value) });
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      throw normalizePromptApiError({ error });
    } finally {
      lease.release();
    }
  }

  async listModels({ signal }: { signal?: AbortSignal }): Promise<string[]> {
    signal?.throwIfAborted();
    return [PROMPT_API_MODEL_ID];
  }
}

export const TEST_ONLY = {};
