import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from './openai';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import http from 'http';
import type { AddressInfo } from 'net';

describe('OpenAIProvider Integration Tests', () => {
  let server: http.Server | null = null;
  let baseUrl: string;
  const { errorCount, clearEvents, events } = useGlobalEvents();

  let capturedRequests: {
    url?: string;
    method?: string;
    headers: http.IncomingHttpHeaders;
    body?: any;
  }[] = [];

  // Helper to start a mock server
  const startServer = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
    return new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const captured: any = {
            url: req.url,
            method: req.method,
            headers: req.headers,
          };
          if (body) {
            try {
              captured.body = JSON.parse(body);
            } catch {
              captured.body = body;
            }
          }
          capturedRequests.push(captured);
          handler(req, res);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  };

  beforeEach(() => {
    clearEvents();
    capturedRequests = [];
    server = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise(r => server!.close(r));
    }
  });

  // MOVE_OPENAI_TESTS_START
  describe('OpenAIProvider', () => {
    it('should handle a full streaming conversation', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const provider = new OpenAIProvider({ endpoint: `${baseUrl}/v1` });
      let result = '';
      await provider.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Hello world');
      expect(errorCount.value).toBe(0);
      expect(capturedRequests[0]!.url).toBe('/v1/chat/completions');
      expect(capturedRequests[0]!.method).toBe('POST');
    });

    it('should normalize endpoint URL by removing trailing slash', async () => {
      await startServer((_req, res) => {
        res.writeHead(200);
        res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: `${baseUrl}/` });
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: () => {}
      });
      expect(capturedRequests[0]!.url).toBe('/chat/completions');
    });

    it('should handle API errors with JSON bodies', async () => {
      await startServer((_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid model' } }));
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      await expect(provider.chat({
        messages: [],
        model: 'invalid',
        onChunk: () => {}
      })).rejects.toThrow('OpenAI API Error (400): Invalid model');

      expect(errorCount.value).toBe(1);
      expect(events.value[0]?.message).toContain('Invalid model');
    });

    it('should handle network errors gracefully', async () => {
      const provider = new OpenAIProvider({ endpoint: 'http://127.0.0.1:1' });
      await expect(provider.chat({
        messages: [],
        model: 'any',
        onChunk: () => {}
      })).rejects.toThrow();

      expect(errorCount.value).toBe(1);
    });

    it('should validate listModels response with Zod', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'gpt-4' },
            { id: 'gpt-3.5-turbo' }
          ]
        }));
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      const models = await provider.listModels({});
      expect(models).toEqual(['gpt-4', 'gpt-3.5-turbo']);
    });

    it('should include Authorization header if provided', async () => {
      await startServer((_req, res) => {
        res.writeHead(200);
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({
        endpoint: baseUrl,
        headers: [['Authorization', 'Bearer test-token']]
      });
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: () => {}
      });
      expect(capturedRequests[0]!.headers['authorization']).toBe('Bearer test-token');
    });

    it('should handle listModels API error with JSON message', async () => {
      await startServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal Server Error' } }));
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      await expect(provider.listModels({})).rejects.toThrow(/Internal Server Error/);
      expect(errorCount.value).toBe(1);
    });

    it('should fail listModels if data is missing from response', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ not_data: [] }));
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      await expect(provider.listModels({})).rejects.toThrow();
    });

    it('should handle various HTTP error status codes correctly in listModels', async () => {
      const errorCodes = [401, 429, 500];
      for (const code of errorCodes) {
        clearEvents();
        await startServer((_req, res) => {
          res.writeHead(code);
          res.end(JSON.stringify({ error: { message: `Err ${code}` } }));
        });

        const provider = new OpenAIProvider({ endpoint: baseUrl });
        await expect(provider.listModels({})).rejects.toThrow(new RegExp(`${code}`));

        expect(capturedRequests[0]!.url).toBe('/models');

        await new Promise(r => server!.close(r));
        server = null;
        capturedRequests = [];
      }
    });

    it('should be resilient to extra fields in OpenAI response', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"A"}}], "extra": "garbage", "usage": {"tokens": 10}}\n\n');
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('A');
      expect(errorCount.value).toBe(0);
    });

    it('should handle invalid chunk structure in OpenAI chat', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":{}}\n\n'); // choices should be array
        res.write('data: {"choices":[{"delta":{"content":"Valid"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Valid');
      expect(errorCount.value).toBe(1);
    });

    it('should handle stop parameter correctly', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });

      // Array version
      await provider.chat({
        messages: [], model: 'm', onChunk: () => {},
        parameters: { ...EMPTY_LM_PARAMETERS, stop: ['A', 'B'] }
      });
      expect(capturedRequests[0]!.body.stop).toEqual(['A', 'B']);
    });
    it('should handle complex parameters in chat request', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      await provider.chat({
        messages: [],
        model: 'test-model',
        onChunk: () => {},
        parameters: {
          temperature: 0.7,
          topP: 0.9,
          maxCompletionTokens: 100,
          presencePenalty: 0.5,
          frequencyPenalty: 0.3,
          stop: ['STOP'],
          reasoning: { effort: 'medium' }
        }
      });

      expect(capturedRequests[0]!.body).toEqual({
        model: 'test-model',
        messages: [],
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        max_completion_tokens: 100,
        presence_penalty: 0.5,
        frequency_penalty: 0.3,
        stop: ['STOP'],
        reasoning_effort: 'medium'
      });
    });

    it('should ignore malformed SSE lines but report them', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: { "invalid": "json" }\n\n');
        res.write('data: {"choices":[{"delta":{"content":"Valid"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Valid');
      expect(errorCount.value).toBe(1);
      expect(events.value[0]?.message).toContain('Failed to parse or validate SSE line');
    });

    it('should handle [DONE] message correctly', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.write('data: {"choices":[{"delta":{"content":"B"}}]}\n\n');
        res.end();
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('AB');
    });

    it('should handle SSE with messy formatting', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('\n'); // Empty line
        res.write(' : ping\n'); // Comment line
        res.write('data: {"choices":[{"delta":{"content":"Clean"}}]}\n');
        res.write('\r\n'); // Windows style empty line
        res.write('data: {"choices":[{"delta":{"content":"er"}}]}\n\n');
        res.write('ignored line\n');
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Cleaner');
    });

    it('should handle SSE data prefix being split across chunks', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('d');
        res.write('a');
        res.write('t');
        res.write('a');
        res.write(': {"choices":[{"delta":{"content":"Fragmented"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Fragmented');
    });

    it('should handle split SSE data lines and split JSON across chunks', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('da');
        res.write('ta: {"choices":[{"delta":{"content":"Split"}}]}\n\n');
        const json = JSON.stringify({ choices: [{ delta: { content: ' Fractured' } }] });
        res.write(`data: ${json.slice(0, 10)}`);
        res.write(`${json.slice(10)}\n\n`);
        res.end('data: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Split Fractured');
    });

    it('should handle mid-stream disconnection gracefully', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Halfway"}}]}\n\n');
        setTimeout(() => {
          res.destroy();
        }, 10);
      });

      const provider = new OpenAIProvider({ endpoint: baseUrl });
      let result = '';
      try {
        await provider.chat({
          messages: [],
          model: 'any',
          onChunk: (chunk) => {
            result += chunk;
          }
        });
      } catch (e) {
        // Expected
      }
      expect(result).toBe('Halfway');
    });

    it('should respect AbortSignal in chat', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        // Do not end, wait for client to abort
      });

      const controller = new AbortController();
      const provider = new OpenAIProvider({ endpoint: baseUrl });

      const chatPromise = provider.chat({
        messages: [],
        model: 'any',
        onChunk: (chunk) => {
          if (chunk === 'A') controller.abort();
        },
        signal: controller.signal
      });

      await expect(chatPromise).rejects.toThrow();
    });
  });
  // MOVE_OPENAI_TESTS_END
});

const EMPTY_LM_PARAMETERS = {
  temperature: undefined,
  topP: undefined,
  maxCompletionTokens: undefined,
  presencePenalty: undefined,
  frequencyPenalty: undefined,
  stop: undefined,
  reasoning: { effort: undefined },
};
