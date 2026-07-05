import { afterEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_PROVIDED_LM_MODEL_ID } from './constants';
import type { PromptApiPrompt, PromptApiPromptOptions } from './language-model';
import { PromptApiProvider } from './provider';
import { TEST_ONLY as RUNTIME_TEST_ONLY } from './runtime';

function createTextStream({ chunks }: { chunks: string[] }): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

afterEach(() => {
  RUNTIME_TEST_ONLY.reset();
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
      model: BROWSER_PROVIDED_LM_MODEL_ID,
      onChunk: ({ chunk }) => chunks.push(chunk),
      onAssistantMessageStart,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      expectedInputs: [{ type: 'text' }],
      expectedOutputs: [{ type: 'text' }],
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

  it('creates an image session for downloadable image input and passes image Blobs', async () => {
    const destroy = vi.fn();
    let receivedPrompt: PromptApiPrompt | undefined;
    const promptStreaming = vi.fn((input: PromptApiPrompt, _options?: PromptApiPromptOptions) => {
      receivedPrompt = input;
      return createTextStream({ chunks: ['image response'] });
    });
    const availability = vi.fn().mockResolvedValue('downloadable');
    const create = vi.fn(async () => ({ promptStreaming, destroy }));
    vi.stubGlobal('LanguageModel', { availability, create });

    const provider = new PromptApiProvider();
    await provider.chat({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      }],
      model: BROWSER_PROVIDED_LM_MODEL_ID,
      onChunk: vi.fn(),
    });

    expect(availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: 'image' }],
      expectedOutputs: [{ type: 'text' }],
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      expectedInputs: [{ type: 'image' }],
      expectedOutputs: [{ type: 'text' }],
      initialPrompts: [],
    }));

    const prompt = receivedPrompt;
    expect(prompt).toMatchObject([{
      role: 'user',
      content: [
        { type: 'text', value: 'Describe this image.' },
        { type: 'image' },
      ],
    }]);
    if (!Array.isArray(prompt)) throw new Error('Expected a multimodal prompt.');
    const message = prompt[0];
    if (message === undefined || typeof message.content === 'string') {
      throw new Error('Expected multimodal message content.');
    }
    const image = message.content.find(part => part.type === 'image');
    if (image === undefined || image.type !== 'image') {
      throw new Error('Expected image content.');
    }
    expect(image.value).toBeInstanceOf(Blob);
    expect(image.value.type).toBe('image/png');
    await expect(image.value.text()).resolves.toBe('hello');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects unavailable image input without disabling text generation', async () => {
    const create = vi.fn();
    const availability = vi.fn().mockResolvedValue('unavailable');
    vi.stubGlobal('LanguageModel', { availability, create });

    const provider = new PromptApiProvider();
    await expect(provider.chat({
      messages: [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aGVsbG8=' },
        }],
      }],
      model: BROWSER_PROVIDED_LM_MODEL_ID,
      onChunk: vi.fn(),
    })).rejects.toMatchObject({ code: 'unsupported_input' });

    expect(create).not.toHaveBeenCalled();
    expect(RUNTIME_TEST_ONLY.getSessionState().hasWarmKeeper).toBe(false);
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
      model: BROWSER_PROVIDED_LM_MODEL_ID,
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
      model: BROWSER_PROVIDED_LM_MODEL_ID,
      onChunk: vi.fn(),
    })).rejects.toMatchObject({ code: 'preparation_required' });

    expect(create).not.toHaveBeenCalled();
  });

  it('rejects tools and configured LM parameters', async () => {
    const provider = new PromptApiProvider();

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: BROWSER_PROVIDED_LM_MODEL_ID,
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
      model: BROWSER_PROVIDED_LM_MODEL_ID,
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
      BROWSER_PROVIDED_LM_MODEL_ID,
    ]);
  });
});
