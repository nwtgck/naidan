import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider, OllamaProvider } from './llm';
import type { MessageNode } from '../models/types';
import { useErrorEvents } from '../composables/useErrorEvents';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider();
    vi.resetAllMocks();
    const { clearErrorEvents } = useErrorEvents();
    clearErrorEvents();
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
    const { clearErrorEvents } = useErrorEvents();
    clearErrorEvents();
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
  
      const { errorEventCount } = useErrorEvents();
      const messages: MessageNode[] = [];
      const onChunk = vi.fn();
  
      await provider.chat(messages, 'llama3', 'http://localhost:11434', onChunk);
  
      expect(onChunk).toHaveBeenCalledTimes(2);
      expect(errorEventCount.value).toBe(0); // Should be empty
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
    
        const { errorEvents, errorEventCount } = useErrorEvents();
        const onChunk = vi.fn();
        
        await provider.chat([], 'llama3', 'http://localhost:11434', onChunk);
    
        expect(onChunk).toHaveBeenCalledWith('valid');
        expect(onChunk).toHaveBeenCalledTimes(1);
        
        // Assert error reporting
        expect(errorEventCount.value).toBe(1);
        expect(errorEvents.value[0]?.source).toBe('OllamaProvider');
        expect(errorEvents.value[0]?.message).toContain('Failed to parse or validate Ollama JSON');
        
        // Verify details contain the problematic line
        const details = errorEvents.value[0]?.details as any;
        expect(details.line).toBe('{"invalid json on purpose": true');
      });});
