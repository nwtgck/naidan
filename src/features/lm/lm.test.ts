import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '@/features/lm/openai';
import { OllamaProvider } from '@/features/lm/ollama';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import type { LmProvider } from '@/01-models/lm';
import type { LmFetch } from './fetch';
import { consumeProviderGenerationForTest } from './provider-test-support';

function request({ model }: { model: string }): Parameters<LmProvider['chat']>[0] {
  return { debug: undefined, messages: [], model, parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined };
}
const fetchMock = vi.fn<LmFetch>();
const { events, errorCount, clearEvents } = useGlobalEvents();
beforeEach(() => {
  fetchMock.mockReset(); clearEvents();
});
afterEach(() => {
  vi.unstubAllGlobals(); expect(errorCount.value).toBe(0);
});

describe('OpenAIProvider', () => {
  it('should call the correct endpoint and consume the new generation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`\
data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}

`));
    const provider = new OpenAIProvider({ endpoint: 'http://localhost:8282/v1', fetcher: fetchMock });
    const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ model: 'gpt-3.5' }) });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8282/v1/chat/completions');
    expect(node.parts).toMatchObject([{ type: 'text', text: 'Hello', completeness: 'complete' }]);
    expect(result).toEqual({ type: 'finished', next: 'user' });
  });

  it('should include custom headers in chat request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    const headers: [string, string][] = [['X-Custom-Header', 'test-value']];
    const provider = new OpenAIProvider({ endpoint: 'http://localhost:8282/v1', headers, fetcher: fetchMock });
    await consumeProviderGenerationForTest({ provider, request: request({ model: 'gpt-3.5' }) });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/chat/completions'), expect.objectContaining({ headers: expect.arrayContaining(headers) }));
  });

  it('should include custom headers in listModels request', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 'm1' }] }));
    const headers: [string, string][] = [['Authorization', 'Bearer secret']];
    const provider = new OpenAIProvider({ endpoint: 'http://localhost:8282/v1', headers, fetcher: fetchMock });
    expect(await provider.listModels({ signal: undefined })).toEqual(['m1']);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/models'), expect.objectContaining({ headers }));
  });
});

describe('OllamaProvider', () => {
  it('should parse Ollama NDJSON chunks correctly', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`\
{"message":{"content":"Hi"}}
{"message":{"content":" there"},"done":true}
`));
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
    const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ model: 'llama3' }) });
    expect(node.parts).toMatchObject([{ type: 'text', text: 'Hi there', completeness: 'complete' }]);
    expect(node.parts).toHaveLength(1); expect(result).toEqual({ type: 'finished', next: 'user' });
  });

  it('keeps accepted content but stops and reports malformed JSON instead of skipping it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`\
{"message":{"content":"accepted"}}
{"invalid json on purpose": true
{"message":{"content":"must not be appended"},"done":true}
`));
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
    const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ model: 'llama3' }) });
    expect(node.parts).toMatchObject([{ type: 'text', text: 'accepted', completeness: 'partial' }]);
    expect(node.parts).toHaveLength(1); expect(result.type).toBe('error');
    expect(errorCount.value).toBe(1);
    expect(events.value[0]?.source).toBe('OllamaProvider');
    expect(events.value[0]?.message).toContain('Failed to read or validate Ollama JSON');
    clearEvents();
  });

  it('keeps native thinking separate rather than wrapping it in think tags', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`\
{"message":{"thinking":"I am thinking"}}
{"message":{"thinking":" more"}}
{"message":{"content":"Final answer"},"done":true}
`));
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
    const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ model: 'llama3' }) });
    expect(node.parts).toMatchObject([{ type: 'reasoning', text: 'I am thinking more', completeness: 'complete' }, { type: 'text', text: 'Final answer', completeness: 'complete' }]);
    expect(node.parts).toHaveLength(2); expect(result).toEqual({ type: 'finished', next: 'user' });
  });

  it('finishes a thinking-only response without adding a synthetic closing tag', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message":{"thinking":"thought"},"done":true}\n'));
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
    const { node, result } = await consumeProviderGenerationForTest({ provider, request: request({ model: 'llama3' }) });
    expect(node.parts).toMatchObject([{ type: 'reasoning', text: 'thought', completeness: 'complete' }]);
    expect(node.parts).toHaveLength(1); expect(result).toEqual({ type: 'finished', next: 'user' });
  });

  it('should include custom headers in chat request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message":{"content":"Hi"},"done":true}\n'));
    const headers: [string, string][] = [['X-Custom', 'ollama-test']];
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', headers, fetcher: fetchMock });
    await consumeProviderGenerationForTest({ provider, request: request({ model: 'llama3' }) });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/chat'), expect.objectContaining({ headers: expect.arrayContaining(headers) }));
  });

  it('should include custom headers in listModels request', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ models: [{ name: 'm1' }] }));
    const headers: [string, string][] = [['X-Header', 'val']];
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', headers, fetcher: fetchMock });
    expect(await provider.listModels({ signal: undefined })).toEqual(['m1']);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/tags'), expect.objectContaining({ headers }));
  });

  it('should include OLLAMA_ORIGINS hint when fetch fails on file protocol', async () => {
    vi.stubGlobal('location', { protocol: 'file:' });
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
    await expect(provider.listModels({ signal: undefined })).rejects.toThrow(/OLLAMA_ORIGINS='\*' ollama serve/);
    expect(errorCount.value).toBe(1); expect(events.value[0]?.message).toContain("OLLAMA_ORIGINS='*'"); clearEvents();
  });

  it('should extract detailed error message from response JSON', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Specific API Error Message' }, { status: 400, statusText: 'Bad Request' }));
    const provider = new OllamaProvider({ endpoint: 'http://localhost:11434', fetcher: fetchMock });
    await expect(provider.listModels({ signal: undefined })).rejects.toThrow(/Failed to fetch models \(400\): Specific API Error Message/);
    expect(errorCount.value).toBe(1); expect(events.value[0]?.message).toContain('Specific API Error Message'); clearEvents();
  });
});
