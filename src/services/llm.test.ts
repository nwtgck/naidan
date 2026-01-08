import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider, OllamaProvider } from './llm';
import type { MessageNode } from '../models/types';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider();
    vi.resetAllMocks();
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

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8282/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"stream":true')
      })
    );
    expect(onChunk).toHaveBeenCalledWith('Hello');
  });
});

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider();
    vi.resetAllMocks();
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

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"model":"llama3"')
      })
    );
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, 'Hi');
    expect(onChunk).toHaveBeenNthCalledWith(2, ' there');
  });

  it('should handle malformed JSON in chunks gracefully', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ 
              done: false, 
              value: new TextEncoder().encode('{"invalid": "json"\n{"message":{"content":"valid"}}\n') 
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
  });
});

