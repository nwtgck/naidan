import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider, OllamaProvider } from './llm';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import http from 'http';
import type { AddressInfo } from 'net';

describe('LLM Providers Integration Tests', () => {
  let server: http.Server;
  let baseUrl: string;
  const { errorCount, clearEvents, events } = useGlobalEvents();

  // Helper to start a mock server
  const startServer = (handler: http.RequestListener) => {
    return new Promise<void>((resolve) => {
      server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  };

  beforeEach(() => {
    clearEvents();
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  describe('OpenAIProvider', () => {
    it('should handle a full streaming conversation', async () => {
      await startServer((req, res) => {
        expect(req.url).toBe('/v1/chat/completions');
        expect(req.method).toBe('POST');

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
    });

    it('should normalize endpoint URL by removing trailing slash', async () => {
      await startServer((req, res) => {
        expect(req.url).toBe('/chat/completions');
        res.writeHead(200);
        res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
      });

      const provider = new OpenAIProvider({ endpoint: `${baseUrl}/` });
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: () => {}
      });
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
      await startServer((req, res) => {
        expect(req.headers['authorization']).toBe('Bearer test-token');
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

    it('should handle complex parameters in chat request', async () => {
      let receivedBody: any;
      await startServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
        });
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

      expect(receivedBody).toEqual({
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

  describe('OllamaProvider', () => {
    it('should handle streaming with reasoning and content', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { thinking: 'Let me see' } }) + '\n');
        res.write(JSON.stringify({ message: { thinking: '...' } }) + '\n');
        res.write(JSON.stringify({ message: { content: 'The answer is 42' } }) + '\n');
        res.write(JSON.stringify({ done: true }) + '\n');
        res.end();
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [{ role: 'user', content: 'What is the answer?' }],
        model: 'llama3',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('<think>Let me see...</think>The answer is 42');
      expect(errorCount.value).toBe(0);
    });

    it('should normalize endpoint URL by removing trailing slash', async () => {
      await startServer((req, res) => {
        expect(req.url).toBe('/api/chat');
        res.writeHead(200);
        res.end(JSON.stringify({ done: true }) + '\n');
      });

      const provider = new OllamaProvider({ endpoint: `${baseUrl}/` });
      await provider.chat({
        messages: [],
        model: 'any',
        onChunk: () => {}
      });
    });

    it('should handle split NDJSON chunks', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const json = JSON.stringify({ message: { content: 'Partial' } });
        res.write(json.slice(0, 10));
        res.write(json.slice(10) + '\n');
        res.write(JSON.stringify({ done: true }) + '\n');
        res.end();
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'llama3',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Partial');
    });

    it('should handle mid-stream disconnection gracefully', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: 'Halfway' } }) + '\n');
        setTimeout(() => {
          res.destroy();
        }, 10);
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      let result = '';
      try {
        await provider.chat({
          messages: [],
          model: 'llama3',
          onChunk: (chunk) => {
            result += chunk;
          }
        });
      } catch (e) {
        // Expected
      }
      expect(result).toBe('Halfway');
    });

    it('should handle multimodal content conversion', async () => {
      let receivedBody: any;
      await startServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200);
          res.end(JSON.stringify({ done: true }) + '\n');
        });
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await provider.chat({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this image:' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BfAQJAAgtOXYgAAAAASUVORK5CYII=' } }
          ]
        }],
        model: 'llava',
        onChunk: () => {}
      });

      expect(receivedBody.messages[0].content).toBe('Analyze this image:');
      expect(receivedBody.messages[0].images).toHaveLength(1);
      expect(receivedBody.messages[0].images[0]).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BfAQJAAgtOXYgAAAAASUVORK5CYII=');
    });

    it('should handle multiple images in multimodal content', async () => {
      let receivedBody: any;
      await startServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200);
          res.end(JSON.stringify({ done: true }) + '\n');
        });
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await provider.chat({
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }
          ]
        }],
        model: 'multimodal',
        onChunk: () => {}
      });

      expect(receivedBody.messages[0].images).toEqual(['AAA', 'BBB']);
    });

    it('should handle multiple text parts in multimodal content', async () => {
      let receivedBody: any;
      await startServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200);
          res.end(JSON.stringify({ done: true }) + '\n');
        });
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await provider.chat({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Part 1. ' },
            { type: 'text', text: 'Part 2.' }
          ]
        }],
        model: 'llama3',
        onChunk: () => {}
      });

      expect(receivedBody.messages[0].content).toBe('Part 1. Part 2.');
    });

    it('should handle all Ollama parameters', async () => {
      let receivedBody: any;
      await startServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200);
          res.end(JSON.stringify({ done: true }) + '\n');
        });
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await provider.chat({
        messages: [],
        model: 'test-model',
        onChunk: () => {},
        parameters: {
          temperature: 0.5,
          topP: 0.8,
          maxCompletionTokens: 50,
          presencePenalty: 0.1,
          frequencyPenalty: 0.2,
          stop: ['END'],
          reasoning: { effort: 'none' }
        }
      });

      expect(receivedBody.options).toEqual({
        temperature: 0.5,
        top_p: 0.8,
        num_predict: 50,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        stop: ['END']
      });
      expect(receivedBody.think).toBe(false);
    });

    it('should retry without specific effort if Ollama reports it is not supported', async () => {
      let callCount = 0;
      await startServer((_req, res) => {
        callCount++;
        if (callCount === 1) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'think value "high" is not supported' }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ message: { content: 'Recovered' }, done: true }) + '\n');
        }
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'llama3',
        onChunk: (chunk) => {
          result += chunk;
        },
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'high' }
        }
      });

      expect(callCount).toBe(2);
      expect(result).toBe('Recovered');
    });

    it('should NOT retry on other 400 errors even with reasoning', async () => {
      let callCount = 0;
      await startServer((_req, res) => {
        callCount++;
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Some other bad request' }));
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await expect(provider.chat({
        messages: [],
        model: 'llama3',
        onChunk: () => {},
        parameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'high' }
        }
      })).rejects.toThrow(/Some other bad request/);

      expect(callCount).toBe(1);
    });

    it('should handle generateImage with progress', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ done: false, completed: 1, total: 10 }) + '\n');
        res.write(JSON.stringify({ done: false, completed: 5, total: 10 }) + '\n');
        res.write(JSON.stringify({ done: true, image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BfAQJAAgtOXYgAAAAASUVORK5CYII=' }) + '\n');
        res.end();
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      const progress: any[] = [];
      const result = await provider.generateImage({
        prompt: 'a sunset',
        model: 'stable-diffusion',
        width: 512,
        height: 512,
        steps: 10,
        seed: 42,
        images: [],
        onProgress: (p) => {
          progress.push(p);
        },
        signal: undefined
      });

      expect(progress).toEqual([
        { currentStep: 1, totalSteps: 10 },
        { currentStep: 5, totalSteps: 10 }
      ]);
      expect(result.image).toBeInstanceOf(Blob);
      expect(result.totalSteps).toBe(10);
    });

    it('should handle generateImage when final image is in trailing buffer', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ done: false, completed: 1, total: 2 }) + '\n');
        // Write final JSON without trailing newline, it will be in buffer
        res.write(JSON.stringify({ done: true, image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BfAQJAAgtOXYgAAAAASUVORK5CYII=' }));
        res.end();
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      const result = await provider.generateImage({
        prompt: 'test',
        model: 'flux',
        width: 10,
        height: 10,
        steps: 2,
        seed: 1,
        images: [],
        onProgress: () => {},
        signal: undefined
      });

      expect(result.image).toBeInstanceOf(Blob);
    });

    it('should respect AbortSignal in generateImage', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ done: false, completed: 1, total: 10 }) + '\n');
        // Delayed response
      });

      const controller = new AbortController();
      const provider = new OllamaProvider({ endpoint: baseUrl });
      const promise = provider.generateImage({
        prompt: 'test',
        model: 'flux',
        width: 512,
        height: 512,
        steps: 10,
        seed: 1,
        images: [],
        onProgress: () => {
          controller.abort();
        },
        signal: controller.signal
      });

      await expect(promise).rejects.toThrow();
    });

    it('should throw error if generateImage response contains no image data', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ done: true }) + '\n');
        res.end();
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await expect(provider.generateImage({
        prompt: 'a car',
        model: 'flux',
        width: 10,
        height: 10,
        steps: 1,
        seed: 1,
        images: [],
        onProgress: () => {},
        signal: undefined
      })).rejects.toThrow('Could not find image data in Ollama response.');
    });

    it('should handle generateImage errors with JSON bodies', async () => {
      await startServer((_req, res) => {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Access denied to this model' }));
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await expect(provider.generateImage({
        prompt: 'any',
        model: 'restricted',
        width: 512,
        height: 512,
        steps: 10,
        seed: 1,
        images: [],
        onProgress: () => {},
        signal: undefined
      })).rejects.toThrow('Ollama Image Generation Error (/api/generate, 403): Access denied to this model');

      expect(errorCount.value).toBe(1);
    });

    it('should handle listModels correctly', async () => {
      await startServer((_req, res) => {
        res.writeHead(200);
        res.end(JSON.stringify({
          models: [
            { name: 'llama3:latest' },
            { name: 'mistral:latest' }
          ]
        }));
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      const models = await provider.listModels({});
      expect(models).toEqual(['llama3:latest', 'mistral:latest']);
    });

    it('should include custom headers in all Ollama methods', async () => {
      let lastHeaders: any;
      await startServer((req, res) => {
        lastHeaders = req.headers;
        res.writeHead(200);
        res.end(JSON.stringify({ done: true, models: [], image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BfAQJAAgtOXYgAAAAASUVORK5CYII=' }) + '\n');
      });

      const provider = new OllamaProvider({
        endpoint: baseUrl,
        headers: [['X-Test', 'Ollama']]
      });

      await provider.chat({ messages: [], model: 'm', onChunk: () => {} });
      expect(lastHeaders['x-test']).toBe('Ollama');

      await provider.listModels({});
      expect(lastHeaders['x-test']).toBe('Ollama');

      await provider.generateImage({
        prompt: 'p', model: 'm', width: 1, height: 1, steps: 1, seed: 1, images: [], onProgress: () => {}, signal: undefined
      });
      expect(lastHeaders['x-test']).toBe('Ollama');
    });

    it('should handle listModels API error with JSON message', async () => {
      await startServer((_req, res) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Ollama crashed' }));
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await expect(provider.listModels({})).rejects.toThrow(/Ollama crashed/);
      expect(errorCount.value).toBe(1);
    });

    it('should fail listModels if models field is missing in Ollama response', async () => {
      await startServer((_req, res) => {
        res.writeHead(200);
        res.end(JSON.stringify({ not_models: [] }));
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      await expect(provider.listModels({})).rejects.toThrow();
    });

    it('should handle invalid Ollama chat chunk structure', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write('{"wrong_key": "val"}\n');
        res.write('{"message":{"content":"Valid"}}\n');
        res.write('{"done":true}\n');
        res.end();
      });

      const provider = new OllamaProvider({ endpoint: baseUrl });
      let result = '';
      await provider.chat({
        messages: [],
        model: 'llama3',
        onChunk: (chunk) => {
          result += chunk;
        }
      });

      expect(result).toBe('Valid');
      // OllamaChatChunkSchema uses .optional() for message, so it actually validates {}
      // But if it's completely wrong, it might fail depending on exact schema.
      // Current OllamaChatChunkSchema is very permissive (all optional).
    });

    it('should respect AbortSignal in listModels', async () => {
      await startServer((_req, res) => {
        // Delayed response
        setTimeout(() => {
          res.writeHead(200);
          res.end(JSON.stringify({ models: [] }));
        }, 100);
      });

      const controller = new AbortController();
      const provider = new OllamaProvider({ endpoint: baseUrl });
      const promise = provider.listModels({ signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toThrow();
    });
  });
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
