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
            .mockResolvedValueOnce({ done: true })
        })
      }
    });
    vi.stubGlobal('fetch', fetchMock);

    const messages: MessageNode[] = [];
    const onChunk = vi.fn();

    await provider.chat(messages, 'gpt-3.5', 'http://localhost:8282/v1', onChunk);

    expect(onChunk).toHaveBeenCalledWith('Hello');
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
              value: new TextEncoder().encode('{"message":{"content":"Hi"}}\n{"message":{"content":" there"},"done":true}\n')
            })
            .mockResolvedValueOnce({ done: true })
        })
      }
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
              value: new TextEncoder().encode('{"invalid json on purpose": true\n{"message":{"content":"valid"}}\n')
            })
            .mockResolvedValueOnce({ done: true })
        })
      }
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

  afterEach(() => {
    expect(errorCount.value).toBe(0);
  });
});