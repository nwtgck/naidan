import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider, OllamaProvider } from './llm';

describe('LLM Providers - Multimodal Requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('OpenAIProvider should format multimodal messages correctly', async () => {
    const provider = new OpenAIProvider();
    (global.fetch as any).mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n') })
            .mockResolvedValueOnce({ done: true })
        })
      }
    });

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
        ]
      }
    ];

    await provider.chat(messages as any, 'gpt-4-vision', 'http://test.api', () => {});

    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);

    expect(body.messages[0].content).toBeInstanceOf(Array);
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc' }
    });
  });

  it('OllamaProvider should handle multimodal messages correctly (string content + images array)', async () => {
    const provider = new OllamaProvider();
    (global.fetch as any).mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"message":{"content":"Hi"},"done":true}\n') })
            .mockResolvedValueOnce({ done: true })
        })
      }
    });

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'See this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } }
        ]
      }
    ];

    await provider.chat(messages as any, 'llava', 'http://test.api', () => {});

    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);

    // Ollama specific format
    expect(typeof body.messages[0].content).toBe('string');
    expect(body.messages[0].content).toBe('See this');
    expect(body.messages[0].images).toBeInstanceOf(Array);
    expect(body.messages[0].images).toHaveLength(1);
    expect(body.messages[0].images[0]).toBe('xyz'); // Prefix stripped
  });
});