import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '@/features/lm/openai';
import { OllamaProvider } from '@/features/lm/ollama';
import { EMPTY_LM_PARAMETERS, type LmParameters } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import type { LmFetch } from './fetch';
import { toMessageId } from '@/01-models/ids';
import { consumeProviderGenerationForTest } from './provider-test-support';
import { useGlobalEvents } from '@/composables/useGlobalEvents';

const fetchMock = vi.fn<LmFetch>();
const finishedOpenAi = 'data: [DONE]\n\n';
const finishedOllama = '{"done":true}\n';
function request({ parameters }: { parameters: LmParameters | undefined }): Parameters<LmProvider['chat']>[0] {
  return {
    debug: undefined,
    messages: [{ id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ type: 'text', text: 'Hi', completeness: 'complete' }] }],
    model: 'test-model', parameters, tools: undefined, readBinaryObject: undefined, signal: undefined,
  };
}
function body({ index }: { index: number }): Record<string, unknown> {
  const raw = fetchMock.mock.calls[index]?.[1]?.body;
  expect(typeof raw).toBe('string');
  if (typeof raw !== 'string') throw new Error('Expected a serialized request.');
  return JSON.parse(raw);
}
function failure({ message }: { message: string }): Response {
  return Response.json({ error: message }, { status: 400 });
}

describe('LM Providers Reasoning', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useGlobalEvents().clearEvents();
  });
  afterEach(() => useGlobalEvents().clearEvents());

  describe('OpenAIProvider reasoning', () => {
    it('should include reasoning_effort in the request', async () => {
      fetchMock.mockResolvedValueOnce(new Response(finishedOpenAi));
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1', fetcher: fetchMock });
      const { result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'medium' } } }) });
      expect(body({ index: 0 }).reasoning_effort).toBe('medium');
      expect(result).toEqual({ type: 'finished', next: 'user' });
    });

    it('should NOT include reasoning_effort when effort is undefined', async () => {
      fetchMock.mockResolvedValueOnce(new Response(finishedOpenAi));
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1', fetcher: fetchMock });
      await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: undefined } } }) });
      expect(Object.hasOwn(body({ index: 0 }), 'reasoning_effort')).toBe(false);
    });

    it('should NOT include any optional parameters when parameters is undefined (title gen)', async () => {
      fetchMock.mockResolvedValueOnce(new Response(finishedOpenAi));
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1', fetcher: fetchMock });
      const { result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: undefined }) });
      expect(body({ index: 0 })).toEqual({ model: 'test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true });
      expect(result).toEqual({ type: 'finished', next: 'user' });
    });

    it('keeps reasoning separate instead of wrapping it in synthetic think tags', async () => {
      fetchMock.mockResolvedValueOnce(new Response(`\
data: {"choices":[{"delta":{"reasoning_content":"Thinking hard"}}]}

data: {"choices":[{"delta":{"content":"Hello!"}}]}

data: [DONE]

`));
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1', fetcher: fetchMock });
      const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: undefined }) });
      expect(node.parts).toMatchObject([{ type: 'reasoning', text: 'Thinking hard', completeness: 'complete' }, { type: 'text', text: 'Hello!', completeness: 'complete' }]);
      expect(node.parts).toHaveLength(2);
      expect(result).toEqual({ type: 'finished', next: 'user' });
    });

    it('should support the reasoning field without changing its representation', async () => {
      fetchMock.mockResolvedValueOnce(new Response(`\
data: {"choices":[{"delta":{"reasoning":"Alternative field"}}]}

data: {"choices":[{"delta":{"content":"Done"}}]}

data: [DONE]

`));
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1', fetcher: fetchMock });
      const { node } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: undefined }) });
      expect(node.parts).toMatchObject([{ type: 'reasoning', text: 'Alternative field' }, { type: 'text', text: 'Done' }]);
      expect(node.parts).toHaveLength(2);
    });

    it('keeps unfinished reasoning partial on abrupt EOF instead of appending a closing tag', async () => {
      fetchMock.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"reasoning_content":"Unfinished thoughts"}}]}\n\n'));
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1', fetcher: fetchMock });
      const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: undefined }) });
      expect(node.parts).toMatchObject([{ type: 'reasoning', text: 'Unfinished thoughts', completeness: 'partial' }]);
      expect(node.parts).toHaveLength(1);
      expect(result).toEqual({ type: 'interrupted', reason: 'unknown' });
    });
  });

  describe('OllamaProvider reasoning & retry logic', () => {
    it('should include think effort string in the request', async () => {
      fetchMock.mockResolvedValueOnce(new Response(finishedOllama));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'medium' } } }) });
      expect(body({ index: 0 }).think).toBe('medium');
    });

    it('should map effort none to think false', async () => {
      fetchMock.mockResolvedValueOnce(new Response(finishedOllama));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'none' } } }) });
      expect(body({ index: 0 }).think).toBe(false);
    });

    it('should NOT include think when effort is undefined (Default)', async () => {
      fetchMock.mockResolvedValueOnce(new Response(finishedOllama));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: undefined } } }) });
      expect(Object.hasOwn(body({ index: 0 }), 'think')).toBe(false);
    });

    it('should NOT include think when parameters is undefined (title gen)', async () => {
      fetchMock.mockResolvedValueOnce(new Response(finishedOllama));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      await consumeProviderGenerationForTest({ provider, request: request({ parameters: undefined }) });
      expect(body({ index: 0 })).toEqual({ model: 'test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true });
    });

    it('should retry with think true when the model does not support string effort', async () => {
      fetchMock.mockResolvedValueOnce(failure({ message: 'think value "medium" is not supported' }))
        .mockResolvedValueOnce(new Response('{"message":{"content":"Success"},"done":true}\n'));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'medium' } } }) });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(body({ index: 0 }).think).toBe('medium'); expect(body({ index: 1 }).think).toBe(true);
      expect(node.parts).toMatchObject([{ type: 'text', text: 'Success', completeness: 'complete' }]);
      expect(result).toEqual({ type: 'finished', next: 'user' });
    });

    it('should FAIL and NOT retry again if the fallback request also fails', async () => {
      fetchMock.mockResolvedValueOnce(failure({ message: 'think value "medium" is not supported' }))
        .mockResolvedValueOnce(failure({ message: 'think is not supported' }));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'medium' } } }) });
      expect(fetchMock).toHaveBeenCalledTimes(2); expect(node.parts).toEqual([]);
      expect(result).toMatchObject({ type: 'error', error: { message: expect.stringContaining('Ollama API Error (400)') } });
    });

    it('should NOT fallback to think true when original think was false (Off)', async () => {
      fetchMock.mockResolvedValueOnce(failure({ message: 'think value "false" is not supported' }));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      const { result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'none' } } }) });
      expect(result.type).toBe('error'); expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('should NOT fallback when parameters is missing (title gen)', async () => {
      fetchMock.mockResolvedValueOnce(failure({ message: 'some error' }));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      const { result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: undefined }) });
      expect(result.type).toBe('error'); expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('should NOT retry when the error does not match not supported', async () => {
      fetchMock.mockResolvedValueOnce(failure({ message: 'Invalid parameter: temperature' }));
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
      const { result } = await consumeProviderGenerationForTest({ provider, request: request({ parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'medium' } } }) });
      expect(result.type).toBe('error'); expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
