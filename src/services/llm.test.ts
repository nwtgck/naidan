import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider, OllamaProvider } from './llm';
import type { MessageNode } from '../models/types';
import { useGlobalEvents } from '../composables/useGlobalEvents';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;
  const { errorCount, clearEvents } = useGlobalEvents();

  beforeEach(() => {
    provider = new OpenAIProvider();
    vi.resetAllMocks();
    clearEvents();
  });

  afterEach(() => {
    expect(errorCount.value).toBe(0);
  });

  it('should call the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n') })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const messages: MessageNode[] = [];
    const onChunk = vi.fn();

    await provider.chat(messages, 'gpt-3.5', 'http://localhost:8282/v1', onChunk);

    expect(onChunk).toHaveBeenCalledWith('Hello');
  });

  it('should include custom headers in chat request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n') })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const headers: [string, string][] = [['X-Custom-Header', 'test-value']];
    await provider.chat([], 'gpt-3.5', 'http://localhost:8282/v1', vi.fn(), {}, headers);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/chat/completions'),
      expect.objectContaining({
        headers: expect.arrayContaining([['X-Custom-Header', 'test-value']]),
      })
    );
  });

  it('should include custom headers in listModels request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'm1' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const headers: [string, string][] = [['Authorization', 'Bearer secret']];
    await provider.listModels('http://localhost:8282/v1', headers);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/models'),
      expect.objectContaining({
        headers: headers,
      })
    );
  });
});

describe('OllamaProvider', () => {
  let provider: OllamaProvider;
  const { events, errorCount, clearEvents } = useGlobalEvents();

  beforeEach(() => {
    provider = new OllamaProvider();
    vi.resetAllMocks();
    clearEvents();
  });

  it('should parse Ollama NDJSON chunks correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode('{"message":{"content":"Hi"}}\n{"message":{"content":" there"},"done":true}\n'),
            })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const messages: MessageNode[] = [];
    const onChunk = vi.fn();

    await provider.chat(messages, 'llama3', 'http://localhost:11434', onChunk);

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(errorCount.value).toBe(0);
  });

  it('should handle malformed JSON in chunks gracefully and report error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode('{"invalid json on purpose": true\n{"message":{"content":"valid"}}\n'),
            })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const onChunk = vi.fn();
    await provider.chat([], 'llama3', 'http://localhost:11434', onChunk);

    expect(onChunk).toHaveBeenCalledWith('valid');
    expect(onChunk).toHaveBeenCalledTimes(1);
    
    // Assert error reporting
    expect(errorCount.value).toBe(1);
    expect(events.value[0]?.source).toBe('OllamaProvider');
    expect(events.value[0]?.message).toContain('Failed to parse or validate Ollama JSON');
    
    const details = events.value[0]?.details as Record<string, unknown>;
    expect(details.line).toBe('{"invalid json on purpose": true');

    clearEvents();
  });

  it('should handle native thinking field and wrap in <think> tags', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(
                '{"message":{"thinking":"I am thinking"}}\n' +
                '{"message":{"thinking":" more"}}\n' +
                '{"message":{"content":"Final answer"}}\n'
              ),
            })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const onChunk = vi.fn();
    await provider.chat([], 'llama3', 'http://localhost:11434', onChunk);

    const calls = onChunk.mock.calls.map(c => c[0]);
    expect(calls).toEqual(['<think>', 'I am thinking', ' more', '</think>', 'Final answer']);
  });

  it('should close <think> tag if stream finishes while thinking', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode('{"message":{"thinking":"thought"},"done":true}\n'),
            })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const onChunk = vi.fn();
    await provider.chat([], 'llama3', 'http://localhost:11434', onChunk);

    const calls = onChunk.mock.calls.map(c => c[0]);
    expect(calls).toEqual(['<think>', 'thought', '</think>']);
  });

  it('should include custom headers in chat request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"message":{"content":"Hi"},"done":true}\n') })
            .mockResolvedValueOnce({ done: true }),
        }),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const headers: [string, string][] = [['X-Custom', 'ollama-test']];
    await provider.chat([], 'llama3', 'http://localhost:11434', vi.fn(), {}, headers);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/chat'),
      expect.objectContaining({
        headers: expect.arrayContaining([['X-Custom', 'ollama-test']]),
      })
    );
  });

  it('should include custom headers in listModels request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: 'm1' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const headers: [string, string][] = [['X-Header', 'val']];
    await provider.listModels('http://localhost:11434', headers);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/tags'),
      expect.objectContaining({
        headers: headers,
      })
    );
  });

  it('should include OLLAMA_ORIGINS hint when fetch fails on file:// protocol', async () => {
    vi.stubGlobal('location', { protocol: 'file:' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));

    await expect(provider.listModels('http://localhost:11434')).rejects.toThrow(
      /OLLAMA_ORIGINS='\*' ollama serve/
    );

    expect(errorCount.value).toBe(1);
    expect(events.value[0]?.message).toContain("OLLAMA_ORIGINS='*'");
    
    clearEvents();
  });

  it('should extract detailed error message from response JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: 'Specific API Error Message' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.listModels('http://localhost:11434')).rejects.toThrow(
      /Failed to fetch models \(400\): Specific API Error Message/
    );

    expect(errorCount.value).toBe(1);
    expect(events.value[0]?.message).toContain('Specific API Error Message');
    
    clearEvents();
  });

  afterEach(() => {
    expect(errorCount.value).toBe(0);
  });
});