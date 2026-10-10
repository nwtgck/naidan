import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, EMPTY_LM_PARAMETERS, type Endpoint, type LmParameters } from '@/01-models/types';
import { UnsupportedReasoningError } from '@/01-models/lm-errors';
import type { LmProvider } from '@/01-models/lm';
import { toMessageId } from '@/01-models/ids';
import { OpenAIProvider } from '@/features/lm/openai';
import { OllamaProvider } from '@/features/lm/ollama';
import type { LmFetch } from '@/features/lm/fetch';
import { createChatGenerationStream } from './create-chat-generation-stream';
import { collectTitleGeneration } from './collect-title-generation';

const fetcher = vi.fn<LmFetch>();
const off: LmParameters = { ...EMPTY_LM_PARAMETERS, temperature: 0.2, reasoning: { effort: 'none' } };
const messages = [{ id: toMessageId({ raw: 'u' }), role: 'user' as const, parts: [{ type: 'text' as const, text: 'A title', completeness: 'complete' as const }] }];
const openAiDone = `\
data: {"choices":[{"delta":{"content":"Title"}}]}

data: [DONE]

`;
const ollamaDone = `\
{"message":{"content":"Title"},"done":true}
`;

function body({ index }: { index: number }): Record<string, unknown> {
  const raw = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof raw !== 'string') throw new Error('Missing request body');
  return JSON.parse(raw);
}

function collect({ provider, endpoint, parameters, signal }: {
  provider: LmProvider, endpoint: Endpoint, parameters: LmParameters, signal: AbortSignal,
}) {
  return collectTitleGeneration({ provider, endpoint, parameters, signal, messages, model: 'model' });
}

beforeEach(() => {
  fetcher.mockReset();
});

describe('title-only thinking fallback', () => {
  it.each(['openai', 'ollama'] as const)('retries an explicit %s off rejection once without changing other parameters', async type => {
    const endpoint = { type, url: 'https://example.test' };
    const provider = type === 'openai' ? new OpenAIProvider({ endpoint: endpoint.url, fetcher }) : new OllamaProvider({ endpoint: endpoint.url, fetcher });
    const error = type === 'openai'
      ? { message: "Unsupported value: 'reasoning_effort' does not support 'none'", param: 'reasoning_effort', code: 'unsupported_value' }
      : 'think value false is not supported for this model';
    fetcher.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
    fetcher.mockResolvedValueOnce(new Response(type === 'openai' ? openAiDone : ollamaDone));
    const result = await collect({ provider, endpoint, parameters: off, signal: new AbortController().signal });
    expect(result.text).toBe('Title');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body({ index: 0 })[type === 'openai' ? 'reasoning_effort' : 'think']).toBe(type === 'openai' ? 'none' : false);
    expect(Object.hasOwn(body({ index: 1 }), type === 'openai' ? 'reasoning_effort' : 'think')).toBe(false);
    expect(type === 'openai' ? body({ index: 1 }).temperature : body({ index: 1 }).options).toEqual(type === 'openai' ? 0.2 : { temperature: 0.2 });
    expect(off.reasoning.effort).toBe('none');
  });

  it('retries a structured invalid enum only when it identifies reasoning_effort', async () => {
    const endpoint = { type: 'openai' as const, url: 'https://example.test' };
    const provider = new OpenAIProvider({ endpoint: endpoint.url, fetcher });
    fetcher.mockResolvedValueOnce(Response.json({
      error: {
        code: 'invalid_enum_value',
        param: 'reasoning_effort',
        message: "Expected one of 'low', 'medium', 'high'.",
      },
    }, { status: 422 }));
    fetcher.mockResolvedValueOnce(new Response(openAiDone));
    expect((await collect({ provider, endpoint, parameters: off, signal: new AbortController().signal })).text).toBe('Title');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body({ index: 0 }).reasoning_effort).toBe('none');
    expect(Object.hasOwn(body({ index: 1 }), 'reasoning_effort')).toBe(false);
  });

  it.each(['openai', 'ollama'] as const)('handles an initial %s streaming rejection without assuming HTTP failure', async type => {
    const endpoint = { type, url: 'https://example.test' };
    const provider = type === 'openai' ? new OpenAIProvider({ endpoint: endpoint.url, fetcher }) : new OllamaProvider({ endpoint: endpoint.url, fetcher });
    const error = JSON.stringify({ error: type === 'openai' ? 'reasoning_effort is not supported' : 'think value false is not supported' });
    fetcher.mockResolvedValueOnce(new Response(type === 'openai' ? `data: ${error}\n\n` : `${error}\n`));
    fetcher.mockResolvedValueOnce(new Response(type === 'openai' ? openAiDone : ollamaDone));
    expect((await collect({ provider, endpoint, parameters: off, signal: new AbortController().signal })).text).toBe('Title');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Object.hasOwn(body({ index: 1 }), type === 'openai' ? 'reasoning_effort' : 'think')).toBe(false);
  });

  it.each(['openai', 'ollama'] as const)('never retries a %s streaming rejection after output has started', async type => {
    const endpoint = { type, url: 'https://example.test' };
    const provider = type === 'openai' ? new OpenAIProvider({ endpoint: endpoint.url, fetcher }) : new OllamaProvider({ endpoint: endpoint.url, fetcher });
    const partial = type === 'openai'
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial' } }] })}\n\n`
      : `${JSON.stringify({ message: { role: 'assistant', content: 'Partial' }, done: false })}\n`;
    const error = JSON.stringify({ error: type === 'openai' ? 'reasoning_effort is not supported' : 'think value false is not supported' });
    fetcher.mockResolvedValueOnce(new Response(partial + (type === 'openai' ? `data: ${error}\n\n` : `${error}\n`)));
    const result = await collect({ provider, endpoint, parameters: off, signal: new AbortController().signal });
    expect(result.result.type).toBe('error');
    expect(result.text).toBe('Partial');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 429, 500, 503])('does not retry HTTP %s even when its message mentions reasoning', async status => {
    fetcher.mockResolvedValueOnce(Response.json({ error: "reasoning_effort is not supported" }, { status }));
    const endpoint = { type: 'openai' as const, url: 'https://example.test' };
    const result = await collect({ provider: new OpenAIProvider({ endpoint: endpoint.url, fetcher }), endpoint, parameters: off, signal: new AbortController().signal });
    expect(result.result.type).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { message: 'model was not found' },
    { message: 'reasoning_effort requires a supported temperature', param: 'temperature', code: 'unsupported_value' },
    { message: 'invalid request' },
  ])('does not retry an unrelated bad request: $message', async error => {
    fetcher.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
    const endpoint = { type: 'openai' as const, url: 'https://example.test' };
    await collect({ provider: new OpenAIProvider({ endpoint: endpoint.url, fetcher }), endpoint, parameters: off, signal: new AbortController().signal });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops after a failed fallback, without a third request', async () => {
    fetcher.mockImplementation(async () => Response.json({ error: 'reasoning_effort is not supported' }, { status: 422 }));
    const endpoint = { type: 'openai' as const, url: 'https://example.test' };
    const result = await collect({ provider: new OpenAIProvider({ endpoint: endpoint.url, fetcher }), endpoint, parameters: off, signal: new AbortController().signal });
    expect(result.result.type).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'high'] as const)('preserves an existing %s preference without off fallback', async effort => {
    fetcher.mockResolvedValueOnce(Response.json({ error: 'reasoning_effort is not supported' }, { status: 400 }));
    const endpoint = { type: 'openai' as const, url: 'https://example.test' };
    await collect({ provider: new OpenAIProvider({ endpoint: endpoint.url, fetcher }), endpoint, parameters: { ...off, reasoning: { effort } }, signal: new AbortController().signal });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(body({ index: 0 }).reasoning_effort).toBe(effort);
  });

  it('omits only off for Prompt API and preserves the saved preference', async () => {
    const chat = vi.fn<LmProvider['chat']>().mockImplementation(({ signal }) => createChatGenerationStream({ signal, run: async () => ({ type: 'finished', next: 'user' }) }));
    const provider: LmProvider = { chat, listModels: async () => ['model'] };
    const defaults = DEFAULT_SETTINGS.titleGeneration;
    if (defaults === 'disabled' || defaults.lmParameters === 'same_scope') throw new Error('Expected fresh title parameters');
    await collect({ provider, endpoint: { type: 'browser_provided_lm' }, parameters: defaults.lmParameters, signal: new AbortController().signal });
    expect(chat.mock.calls[0]?.[0].parameters).toBeUndefined();
    expect(defaults.lmParameters.reasoning.effort).toBe('none');
    await collect({ provider, endpoint: { type: 'browser_provided_lm' }, parameters: off, signal: new AbortController().signal });
    expect(chat.mock.calls[1]?.[0].parameters?.temperature).toBe(0.2);
  });

  it('does not retry after any generated reasoning or text', async () => {
    const chat = vi.fn<LmProvider['chat']>().mockImplementation(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'reasoning', text: 'partial' });
        throw new UnsupportedReasoningError({ message: 'late error' });
      },
    }));
    const result = await collect({ provider: { chat, listModels: async () => [] }, endpoint: { type: 'openai', url: 'https://example.test' }, parameters: off, signal: new AbortController().signal });
    expect(result.result.type).toBe('error');
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('never retries an abort between the first response and fallback', async () => {
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async () => {
      controller.abort();
      return Response.json({ error: 'reasoning_effort is not supported' }, { status: 400 });
    });
    const endpoint = { type: 'openai' as const, url: 'https://example.test' };
    await collect({ provider: new OpenAIProvider({ endpoint: endpoint.url, fetcher }), endpoint, parameters: off, signal: controller.signal }).catch(() => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
