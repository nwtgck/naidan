import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from './llm';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { z } from 'zod';
import type { Tool } from './tools/types';
import { startMockServer } from './llm-test-utils';

describe('OpenAIProvider Tool Calls (Integration)', () => {
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
      execute: vi.fn().mockResolvedValue({ status: 'success', content: 'Sunny, 25C' }),
    };

    let requestCount = 0;
    serverInstance = await startMockServer({
      handler: (_req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (requestCount === 1) {
          // First call: tool_calls
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Tokyo\\"}"}}]}}]}\n\n');
          res.write('data: [DONE]\n\n');
        } else {
          // Second call: final answer
          res.write('data: {"choices":[{"delta":{"content":"The weather in Tokyo is Sunny."}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    let result = '';
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    await provider.chat({
      messages: [{ role: 'user', content: 'Tokyo weather?' }],
      model: 'gpt-4',
      onChunk: (chunk) => {
        result += chunk;
      },
      tools: [mockTool],
      onToolCall,
      onToolResult,
    });

    expect(result).toBe('The weather in Tokyo is Sunny.');
    expect(mockTool.execute).toHaveBeenCalledWith({ args: { location: 'Tokyo' } });
    expect(onToolCall).toHaveBeenCalledWith({ id: 'call_1', toolName: 'get_weather', args: { location: 'Tokyo' } });
    expect(onToolResult).toHaveBeenCalledWith({ id: 'call_1', result: { status: 'success', content: 'Sunny, 25C' } });

    expect(serverInstance!.capturedRequests).toHaveLength(2);
    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages).toHaveLength(3);
    expect(secondReqBody.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Sunny, 25C'
    });
  });

  it('should handle fragmented SSE chunks for tool calls', async () => {
    const mockTool: Tool = {
      name: 'calc',
      description: 'Calc',
      parametersSchema: z.object({ e: z.string() }),
      execute: vi.fn().mockResolvedValue({ status: 'success', content: '4' }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (serverInstance?.capturedRequests.length === 1) {
          // Stream tool call in multiple tiny chunks
          const payloads = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ca"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lc"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"e\\":\\"2"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"+2\\"}"}}]}}]}\n\n',
            'data: [DONE]\n\n'
          ];
          payloads.forEach(p => res.write(p));
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Done"}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    expect(mockTool.execute).toHaveBeenCalledWith({ args: { e: '2+2' } });
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
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"content":"Thinking..."}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{}"}}]}}]}\n\n');
          res.write('data: [DONE]\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":" Done."}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    let result = '';
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: (chunk) => {
        result += chunk;
      },
      tools: [mockTool],
    });

    expect(result).toBe('Thinking... Done.');
    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages).toHaveLength(2);
    expect(secondReqBody.messages[0]).toEqual({
      role: 'assistant',
      content: 'Thinking...',
      tool_calls: [expect.objectContaining({ id: 'c1' })]
    });
    expect(secondReqBody.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'OK'
    });
  });

  it('should return error to LLM on invalid arguments (strict mode)', async () => {
    const mockTool: Tool = {
      name: 'strict_tool',
      description: 'Strict',
      parametersSchema: z.object({ a: z.string() }),
      execute: vi.fn(),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"strict_tool","arguments":"{\\"hallucinated\\": true}"}}]}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Sorry, bad args"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    expect(mockTool.execute).not.toHaveBeenCalled();
    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages[1].content).toContain('Invalid arguments');
  });

  it('should handle tool execution errors gracefully', async () => {
    const mockTool: Tool = {
      name: 'fail_tool',
      description: 'Fail',
      parametersSchema: z.object({}),
      execute: vi.fn().mockResolvedValue({ status: 'error', code: 'execution_failed', message: 'Something went wrong' }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fail_tool","arguments":"{}"}}]}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Handling error"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages[1].content).toContain('Error [execution_failed]: Something went wrong');
  });

  it('should handle malformed JSON in tool arguments', async () => {
    const mockTool: Tool = {
      name: 't',
      description: 'T',
      parametersSchema: z.object({ a: z.number() }),
      execute: vi.fn(),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"t","arguments":"{\\"a\\": 123"}}]}}]}\n\n'); // Unclosed JSON
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Fixed"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages[1].content).toContain('Failed to parse tool arguments');
  });

  it('should handle tool throwing an exception', async () => {
    const mockTool: Tool = {
      name: 'crash',
      description: 'Crash',
      parametersSchema: z.object({}),
      execute: vi.fn().mockRejectedValue(new Error('KABOOM')),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"crash","arguments":"{}"}}]}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Ouch"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages[1].content).toContain('KABOOM');
  });

  it('should report tool not found error to LLM', async () => {
    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"err","function":{"name":"missing","arguments":"{}"}}]}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Sorry"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [], // No tools
    });

    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages[1].content).toContain('not found');
  });

  it('should respect AbortSignal during tool execution turn', async () => {
    const mockTool: Tool = {
      name: 'long',
      description: 'Long',
      parametersSchema: z.object({}),
      execute: vi.fn().mockImplementation(async ({ signal }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ status: 'success', content: 'Done' }), 1000);
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
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"long","arguments":"{}"}}]}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    const controller = new AbortController();

    const chatPromise = provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
      onToolCall: () => {
        controller.abort();
      },
      signal: controller.signal,
    });

    await expect(chatPromise).rejects.toThrow();
    // Should NOT have made a second request to LLM
    expect(serverInstance!.capturedRequests).toHaveLength(1);
  });

  it('should handle multiple tool calls in one response', async () => {
    const mockTool: Tool = {
      name: 't',
      description: 'T',
      parametersSchema: z.object({ v: z.number() }),
      execute: vi.fn().mockImplementation(async ({ args }) => ({ status: 'success', content: String((args as any).v * 2) })),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"id1","function":{"name":"t","arguments":"{\\"v\\":1}"}},' +
            '{"index":1,"id":"id2","function":{"name":"t","arguments":"{\\"v\\":10}"}}' +
            ']}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Summary received"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages).toHaveLength(3);
    expect(secondReqBody.messages[1].content).toBe('2');
    expect(secondReqBody.messages[2].content).toBe('20');
  });

  it('should handle mixed tool execution results in one response', async () => {
    const successTool: Tool = {
      name: 'ok',
      description: 'OK',
      parametersSchema: z.object({}),
      execute: vi.fn().mockResolvedValue({ status: 'success', content: 'GOOD' }),
    };
    const failTool: Tool = {
      name: 'fail',
      description: 'FAIL',
      parametersSchema: z.object({}),
      execute: vi.fn().mockResolvedValue({ status: 'error', code: 'bad', message: 'BAD' }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        if (serverInstance?.capturedRequests.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"id1","function":{"name":"ok","arguments":"{}"}},' +
            '{"index":1,"id":"id2","function":{"name":"fail","arguments":"{}"}}' +
            ']}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Summary received"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [successTool, failTool],
    });

    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    expect(secondReqBody.messages).toHaveLength(3);
    expect(secondReqBody.messages[1].content).toBe('GOOD');
    expect(secondReqBody.messages[2].content).toContain('BAD');
  });

  it('should send non-empty tool parameters schema to the LLM', async () => {
    const mockTool: Tool = {
      name: 't',
      description: 'T',
      parametersSchema: z.object({ arg1: z.string().describe('DESC') }),
      execute: vi.fn(),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200);
        res.write('data: {"choices":[{"delta":{"content":"Done"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    const firstReqBody = serverInstance!.capturedRequests[0]!.body as any;
    const toolDef = firstReqBody.tools[0].function;
    expect(toolDef.name).toBe('t');

    // CRITICAL: Parameters must NOT be empty
    expect(toolDef.parameters).toHaveProperty('type', 'object');
    expect(toolDef.parameters).toHaveProperty('properties');
    expect(toolDef.parameters.properties).toHaveProperty('arg1');
    expect(toolDef.parameters.properties.arg1).toHaveProperty('description', 'DESC');
  });

  it('should handle redundant full-string deltas in tool calls (duplication fix)', async () => {
    const mockTool: Tool = {
      name: 'calc',
      description: 'Calc',
      parametersSchema: z.object({ e: z.string() }),
      execute: vi.fn().mockResolvedValue({ status: 'success', content: '4' }),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (serverInstance?.capturedRequests.length === 1) {
          // Provider repeats FULL name and FULL arguments in every chunk
          const payloads = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"calc"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"calc","arguments":"{\\"e\\":\\"2+2\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"calc","arguments":"{\\"e\\":\\"2+2\\"}"}}]}}]}\n\n', // Repeated
            'data: [DONE]\n\n'
          ];
          payloads.forEach(p => res.write(p));
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Done"}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    // Should NOT have 'calccalc' or '{"e":"2+2"}{"e":"2+2"}'
    expect(mockTool.execute).toHaveBeenCalledWith({ args: { e: '2+2' } });
  });

  it('should treat concatenated JSON objects as a parse error and report to LLM (correct protocol enforcement)', async () => {
    const mockTool: Tool = {
      name: 'calc',
      description: 'Calc',
      parametersSchema: z.object({ e: z.string() }),
      execute: vi.fn(),
    };

    serverInstance = await startMockServer({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (serverInstance?.capturedRequests.length === 1) {
          // Provider sends TWO different JSON objects concatenated in ONE tool call arguments string (INVALID)
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"calc","arguments":"{\\"e\\":\\"1+1\\"}{\\"e\\":\\"2+2\\"}"}}]}}]}\n\n');
          res.write('data: [DONE]\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Format error detected"}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      }
    });

    const provider = new OpenAIProvider({ endpoint: serverInstance.baseUrl });
    await provider.chat({
      messages: [],
      model: 'gpt-4',
      onChunk: vi.fn(),
      tools: [mockTool],
    });

    // Should NOT have executed the tool
    expect(mockTool.execute).not.toHaveBeenCalled();

    // Verify the second request to LLM contains the parse error message
    const secondReqBody = serverInstance!.capturedRequests[1]!.body as { messages: any[] };
    const toolMsg = secondReqBody.messages.find(m => m.role === 'tool');
    expect(toolMsg.content).toContain('Failed to parse tool arguments');
  });
});
