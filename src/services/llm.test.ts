import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from './llm';
import type { Message } from '../models/types';

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

    const messages: Message[] = [];
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
