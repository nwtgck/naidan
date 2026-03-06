import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider, OpenAIProvider } from './llm';
import { EMPTY_LM_PARAMETERS } from '../models/types';

// Mock useGlobalEvents
vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: vi.fn(() => ({
    addErrorEvent: vi.fn(),
  })),
}));

describe('LLM Providers Reasoning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  describe('OpenAIProvider reasoning', () => {
    it('should include reasoning_effort in the request', async () => {
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1' });
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'medium' },
        },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/chat/completions'),
        expect.objectContaining({
          body: expect.stringContaining('"reasoning_effort":"medium"'),
        })
      );
    });

    it('should NOT include reasoning_effort when effort is undefined', async () => {
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1' });
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: undefined },
        },
      });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('should NOT include any optional parameters when parameters is undefined (title gen)', async () => {
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1' });
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        onChunk: () => {},
        parameters: undefined,
      });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('should wrap reasoning tokens in <think> tags', async () => {
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1' });
      const chunks = [
        'data: {"choices":[{"delta":{"reasoning_content":"Thinking hard"}}]}',
        'data: {"choices":[{"delta":{"content":"Hello!"}}]}',
        'data: [DONE]'
      ];
      let chunkIndex = 0;

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockImplementation(async () => {
              if (chunkIndex >= chunks.length) return { done: true };
              const value = new TextEncoder().encode(chunks[chunkIndex++] + '\n');
              return { done: false, value };
            }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const receivedChunks: string[] = [];
      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        onChunk: (c) => receivedChunks.push(c),
      });

      expect(receivedChunks).toContain('<think>');
      expect(receivedChunks).toContain('Thinking hard');
      expect(receivedChunks).toContain('</think>');
      expect(receivedChunks).toContain('Hello!');
      // Verify order
      const full = receivedChunks.join('');
      expect(full).toBe('<think>Thinking hard</think>Hello!');
    });

    it('should support "reasoning" field (Ollama/DeepSeek style)', async () => {
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1' });
      const chunks = [
        'data: {"choices":[{"delta":{"reasoning":"Alternative field"}}]}',
        'data: {"choices":[{"delta":{"content":"Done"}}]}',
        'data: [DONE]'
      ];
      let chunkIndex = 0;

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockImplementation(async () => {
              if (chunkIndex >= chunks.length) return { done: true };
              const value = new TextEncoder().encode(chunks[chunkIndex++] + '\n');
              return { done: false, value };
            }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const receivedChunks: string[] = [];
      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        onChunk: (c) => receivedChunks.push(c),
      });

      expect(receivedChunks.join('')).toBe('<think>Alternative field</think>Done');
    });

    it('should close <think> tag if stream ends abruptly', async () => {
      const provider = new OpenAIProvider({ endpoint: 'http://localhost:11434/v1' });
      const chunks = [
        'data: {"choices":[{"delta":{"reasoning_content":"Unfinished thoughts"}}]}'
      ];
      let chunkIndex = 0;

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockImplementation(async () => {
              if (chunkIndex >= chunks.length) return { done: true };
              const value = new TextEncoder().encode(chunks[chunkIndex++] + '\n');
              return { done: false, value };
            }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const receivedChunks: string[] = [];
      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        onChunk: (c) => receivedChunks.push(c),
      });

      expect(receivedChunks.join('')).toBe('<think>Unfinished thoughts</think>');
    });
  });

  describe('OllamaProvider reasoning & retry logic', () => {
    it('should include think effort string in the request', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'medium' },
        },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/chat'),
        expect.objectContaining({
          body: expect.stringContaining('"think":"medium"'),
        })
      );
    });

    it('should map effort: "none" to think: false', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'none' },
        },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/chat'),
        expect.objectContaining({
          body: expect.stringContaining('"think":false'),
        })
      );
    });

    it('should NOT include think when effort is undefined (Default)', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: undefined },
        },
      });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.think).toBeUndefined();
    });

    it('should NOT include think when parameters is undefined (title gen)', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: undefined,
      });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.think).toBeUndefined();
    });

    it('should retry with think: true when model does not support string effort level', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });

      const mockErrorResponse = {
        ok: false,
        status: 400,
        clone: () => mockErrorResponse,
        json: vi.fn().mockResolvedValue({
          error: 'think value "medium" is not supported for this model'
        }),
      };

      const mockSuccessResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValueOnce({ done: true }),
          }),
        },
      };

      (global.fetch as any)
        .mockResolvedValueOnce(mockErrorResponse)
        .mockResolvedValueOnce(mockSuccessResponse);

      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'medium' },
        },
      });

      // Verification
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect((global.fetch as any).mock.calls[0][1].body).toContain('"think":"medium"');
      expect((global.fetch as any).mock.calls[1][1].body).toContain('"think":true');
    });

    it('should FAIL and NOT retry if the fallback request (think: true) also fails', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });

      const mockErrorResponse1 = {
        ok: false,
        status: 400,
        clone: () => mockErrorResponse1,
        json: vi.fn().mockResolvedValue({
          error: 'think value "medium" is not supported for this model'
        }),
      };

      const mockErrorResponse2 = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        clone: () => mockErrorResponse2,
        json: vi.fn().mockResolvedValue({ error: 'Crash' }),
      };

      (global.fetch as any)
        .mockResolvedValueOnce(mockErrorResponse1)
        .mockResolvedValueOnce(mockErrorResponse2);

      await expect(provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'medium' },
        },
      })).rejects.toThrow('Ollama API Error (500): Crash');

      expect(global.fetch).toHaveBeenCalledTimes(2); // Attempted original + 1 retry
    });

    it('should NOT fallback to think: true when original think was false (Off)', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });

      const mockErrorResponse = {
        ok: false,
        status: 400,
        clone: () => mockErrorResponse,
        json: vi.fn().mockResolvedValue({
          error: 'think value "false" is not supported' // Should not trigger retry because think is not a string
        }),
      };

      (global.fetch as any).mockResolvedValue(mockErrorResponse);

      await expect(provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'none' },
        },
      })).rejects.toThrow('Ollama API Error (400)');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should NOT fallback when parameters is missing (title gen)', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });

      const mockErrorResponse = {
        ok: false,
        status: 400,
        clone: () => mockErrorResponse,
        json: vi.fn().mockResolvedValue({
          error: 'some error'
        }),
      };

      (global.fetch as any).mockResolvedValue(mockErrorResponse);

      await expect(provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: undefined,
      })).rejects.toThrow('Ollama API Error (400)');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry when error message does not match "not supported"', async () => {
      const provider = new OllamaProvider({ endpoint: 'http://localhost:11434' });

      const mockErrorResponse = {
        ok: false,
        status: 400,
        clone: () => mockErrorResponse,
        json: vi.fn().mockResolvedValue({
          error: 'Invalid parameter: temperature'
        }),
      };

      (global.fetch as any).mockResolvedValue(mockErrorResponse);

      await expect(provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'qwen3.5',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'medium' },
        },
      })).rejects.toThrow('Ollama API Error (400)');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
