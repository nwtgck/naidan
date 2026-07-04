import { z } from 'zod';

import type { LmProvider } from '@/01-models/lm';
import type { LmParameters } from '@/01-models/types';

import { createPromptApiSession, getPromptApiAvailability } from './api';
import { PROMPT_API_MODEL_ID } from './constants';
import { PromptApiError, normalizePromptApiError } from './errors';
import { mapChatMessagesToPromptApi } from './message-mapper';

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

    const availability = await getPromptApiAvailability();
    switch (availability) {
    case 'available':
      break;
    case 'downloadable':
    case 'downloading':
      throw new PromptApiError({
        code: 'preparation_required',
        message: 'Prompt API model preparation is required.',
      });
    case 'unavailable':
      throw new PromptApiError({
        code: 'model_unavailable',
        message: 'Prompt API model is unavailable.',
      });
    default: {
      const _ex: never = availability;
      throw new Error(`Unhandled Prompt API availability: ${_ex}`);
    }
    }

    const { initialPrompts, prompt } = mapChatMessagesToPromptApi({ messages });
    const session = await createPromptApiSession({
      initialPrompts,
      signal,
      onDownloadProgress: undefined,
    });

    try {
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
      session.destroy();
    }
  }

  async listModels({ signal }: { signal?: AbortSignal }): Promise<string[]> {
    signal?.throwIfAborted();
    return [PROMPT_API_MODEL_ID];
  }
}

export const TEST_ONLY = {};
