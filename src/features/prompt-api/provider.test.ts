import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROMPT_API_MODEL_ID } from './constants';
import { PromptApiProvider } from './provider';

function createTextStream({ chunks }: { chunks: string[] }): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PromptApiProvider', () => {
  it('restores history with initialPrompts and streams delta chunks', async () => {
    const destroy = vi.fn();
    const promptStreaming = vi.fn(() => createTextStream({ chunks: ['hello', ' world'] }));
    const create = vi.fn(async () => ({ promptStreaming, destroy }));
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    const chunks: string[] = [];
    const onAssistantMessageStart = vi.fn();
    const provider = new PromptApiProvider();

    await provider.chat({
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
        { role: 'user', content: 'Current question' },
      ],
      model: PROMPT_API_MODEL_ID,
      onChunk: ({ chunk }) => chunks.push(chunk),
      onAssistantMessageStart,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompts: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
      ],
    }));
    expect(promptStreaming).toHaveBeenCalledWith('Current question', { signal: undefined });
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(['hello', ' world']);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the session when streaming fails', async () => {
    const destroy = vi.fn();
    const promptStreaming = vi.fn(() => new ReadableStream<string>({
      start(controller) {
        controller.error(new Error('stream failed'));
      },
    }));
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(async () => ({ promptStreaming, destroy })),
    });

    const provider = new PromptApiProvider();
    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: PROMPT_API_MODEL_ID,
      onChunk: vi.fn(),
    })).rejects.toThrow('stream failed');

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does not start a model download implicitly', async () => {
    const create = vi.fn();
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('downloadable'),
      create,
    });

    const provider = new PromptApiProvider();
    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: PROMPT_API_MODEL_ID,
      onChunk: vi.fn(),
    })).rejects.toMatchObject({ code: 'preparation_required' });

    expect(create).not.toHaveBeenCalled();
  });

  it('rejects tools and configured LM parameters', async () => {
    const provider = new PromptApiProvider();

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: PROMPT_API_MODEL_ID,
      onChunk: vi.fn(),
      tools: [{
        name: 'example',
        description: 'Example',
        parametersSchema: {} as never,
        execute: vi.fn(),
      }],
    })).rejects.toThrow('tools are not supported');

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: PROMPT_API_MODEL_ID,
      onChunk: vi.fn(),
      parameters: {
        temperature: 0.5,
        topP: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: { effort: undefined },
      },
    })).rejects.toThrow('LM parameters are not supported');
  });

  it('returns one stable logical model ID without checking availability', async () => {
    const provider = new PromptApiProvider();
    await expect(provider.listModels({ signal: undefined })).resolves.toEqual([
      PROMPT_API_MODEL_ID,
    ]);
  });
});
