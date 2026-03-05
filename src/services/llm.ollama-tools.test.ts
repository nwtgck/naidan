import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProvider } from './llm';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { z } from 'zod';
import type { Tool } from './tools/types';
import { startMockServer } from './llm-test-utils';

describe('OllamaProvider Tool Calls (Integration)', () => {
  const { errorCount, clearEvents } = useGlobalEvents();
  let serverInstance: Awaited<ReturnType<typeof startMockServer>> | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    clearEvents();
  });

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.close();
      serverInstance = null;
    }
    expect(errorCount.value).toBe(0);
  });

  it('should execute a tool and loop back to LLM', async () => {
    const mockTool: Tool = {
      name: 'get_weather',
      description: 'Get weather',
      parametersSchema: z.object({ location: z.string() }),
      execute: vi.fn().mockResolvedValue({ status: 'success', content: 'Rainy, 15C' }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        if (serverInstance?.capturedRequests.length === 1) {
          res.write(JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', function: { name: 'get_weather', arguments: { location: 'London' } } }]
            },
            done: true
          }) + '\n');
        } else {
          res.write(JSON.stringify({
            message: { role: 'assistant', content: 'It is rainy in London.' },
            done: true
          }) + '\n');
        }
        res.end();
      }
    });

    const provider = new OllamaProvider({ endpoint: serverInstance.baseUrl });
    let result = '';
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    await provider.chat({
      messages: [{ role: 'user', content: 'London weather?' }],
      model: 'llama3',
      onChunk: (chunk) => {
        result += chunk;
      },
      tools: [mockTool],
      onToolCall,
      onToolResult,
    });

    expect(result).toBe('It is rainy in London.');
    expect(mockTool.execute).toHaveBeenCalledWith({ args: { location: 'London' } });
    expect(onToolCall).toHaveBeenCalledWith({ id: 'c1', toolName: 'get_weather', args: { location: 'London' } });

    expect(serverInstance.capturedRequests).toHaveLength(2);
    const secondReqBody = serverInstance.capturedRequests[1].body;
    expect(secondReqBody.messages).toHaveLength(3);
    expect(secondReqBody.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'Rainy, 15C'
    });
  });

  it('should support interleaved text and tool calls', async () => {
    const mockTool: Tool = {
      name: 't',
      description: 'T',
      parametersSchema: z.object({}),
      execute: vi.fn().mockResolvedValue({ status: 'success', content: 'OK' }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write(JSON.stringify({ message: { content: 'Wait... ' }, done: false }) + '\n');
          res.write(JSON.stringify({ message: { tool_calls: [{ id: 'c1', function: { name: 't', arguments: {} } }] }, done: true }) + '\n');
        } else {
          res.write(JSON.stringify({ message: { content: 'Done.' }, done: true }) + '\n');
        }
        res.end();
      }
    });

    const provider = new OllamaProvider({ endpoint: serverInstance.baseUrl });
    let result = '';
    await provider.chat({
      messages: [],
      model: 'llama3',
      onChunk: (chunk) => {
        result += chunk;
      },
      tools: [mockTool],
    });

    expect(result).toBe('Wait... Done.');
    const secondReqBody = serverInstance.capturedRequests[1].body;
    expect(secondReqBody.messages[0].content).toBe('Wait... ');
  });

  it('should handle stringified arguments in Ollama response', async () => {
    const mockTool: Tool = {
      name: 'test',
      description: 'Test',
      parametersSchema: z.object({ val: z.number() }),
      execute: vi.fn().mockResolvedValue({ status: 'success', content: '42' }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write(JSON.stringify({
            message: { tool_calls: [{ id: 'id1', function: { name: 'test', arguments: '{"val": 123}' } }] },
            done: true
          }) + '\n');
        } else {
          res.write(JSON.stringify({ done: true }) + '\n');
        }
        res.end();
      }
    });

    const provider = new OllamaProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'llama3',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    expect(mockTool.execute).toHaveBeenCalledWith({ args: { val: 123 } });
  });

  it('should return error to LLM on invalid arguments (strict mode)', async () => {
    const mockTool: Tool = {
      name: 'strict',
      description: 'Strict',
      parametersSchema: z.object({ a: z.string() }),
      execute: vi.fn(),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write(JSON.stringify({
            message: { tool_calls: [{ id: 'c1', function: { name: 'strict', arguments: { hallucinated: true } } }] },
            done: true
          }) + '\n');
        } else {
          res.write(JSON.stringify({ message: { content: 'Bad args' }, done: true }) + '\n');
        }
        res.end();
      }
    });

    const provider = new OllamaProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'llama3',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    expect(mockTool.execute).not.toHaveBeenCalled();
    const secondReqBody = serverInstance.capturedRequests[1].body;
    expect(secondReqBody.messages[1].content).toContain('Invalid arguments');
  });

  it('should handle tool throwing an exception', async () => {
    const mockTool: Tool = {
      name: 'crash',
      description: 'Crash',
      parametersSchema: z.object({}),
      execute: vi.fn().mockRejectedValue(new Error('BOOM')),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write(JSON.stringify({ message: { tool_calls: [{ id: 'c1', function: { name: 'crash', arguments: {} } }] }, done: true }) + '\n');
        } else {
          res.write(JSON.stringify({ done: true }) + '\n');
        }
        res.end();
      }
    });

    const provider = new OllamaProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'llama3',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    const secondReqBody = serverInstance.capturedRequests[1].body;
    expect(secondReqBody.messages[1].content).toContain('BOOM');
  });

  it('should respect AbortSignal during tool execution turn', async () => {
    const mockTool: Tool = {
      name: 'long',
      description: 'Long',
      parametersSchema: z.object({}),
      execute: vi.fn().mockImplementation(async ({ signal }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ status: 'success', content: 'OK' }), 1000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          });
        });
      }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        res.write(JSON.stringify({ message: { tool_calls: [{ id: 'c1', function: { name: 'long', arguments: {} } }] }, done: true }) + '\n');
        res.end();
      }
    });

    const provider = new OllamaProvider({ endpoint: serverInstance.baseUrl });
    const controller = new AbortController();

    const chatPromise = provider.chat({
      messages: [],
      model: 'llama3',
      onChunk: vi.fn(),
      tools: [mockTool],
      onToolCall: () => {
        controller.abort();
      },
      signal: controller.signal,
    });

    await expect(chatPromise).rejects.toThrow();
    expect(serverInstance.capturedRequests).toHaveLength(1);
  });
});
