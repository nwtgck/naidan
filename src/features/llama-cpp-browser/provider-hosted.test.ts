import { generateInputSchema } from './types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import type { LlamaCppBrowserService } from './service-contract';
import { LlamaCppBrowserProvider } from './provider-hosted';
const service = vi.hoisted(() => ({ generate: vi.fn<LlamaCppBrowserService['generate']>(), listModels: vi.fn<LlamaCppBrowserService['listModels']>() }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
beforeEach(() => {
  vi.clearAllMocks(); service.generate.mockResolvedValue();
});
function request(): Parameters<LmProvider['chat']>[0] {
  return { messages: [{ role: 'user', content: 'hello' }], model: 'local.gguf', onChunk: vi.fn(), onAssistantMessageStart: vi.fn() };
}
describe('local model provider', () => {
  it('leaves an omitted completion limit unset and preserves explicit limit validation', async () => {
    const provider = new LlamaCppBrowserProvider();
    await provider.chat(request());
    await provider.chat({ ...request(), parameters: { ...EMPTY_LM_PARAMETERS, maxCompletionTokens: 37 } });
    const inputs = service.generate.mock.calls.map(([{ input }]) => input);
    expect(inputs.map(input => input.maxTokens)).toEqual([undefined, 37]);
    const input = { ...inputs[0]!, options: { profile: 'cpu-wasm32' } };
    expect(generateInputSchema.safeParse(input).success).toBe(true);
    expect(generateInputSchema.safeParse({ ...input, maxTokens: 32768 }).success).toBe(true);
    expect(generateInputSchema.safeParse({ ...input, maxTokens: 65536 }).success).toBe(true);
    expect(generateInputSchema.safeParse({ ...input, maxTokens: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    for (const maxTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(generateInputSchema.safeParse({ ...input, maxTokens }).success).toBe(false);
    }
  });
  it('passes the diagnostic preference per request without retaining the preceding chat setting', async () => {
    const provider = new LlamaCppBrowserProvider();
    await provider.chat({ ...request(), debug: 'on' });
    await provider.chat({ ...request(), debug: 'off' });
    await provider.chat(request());
    expect(service.generate.mock.calls.map(([{ input }]) => input.debug)).toEqual(['on', 'off', undefined]);
  });
  it('maps model identity and text messages without normalizing away content', async () => {
    service.listModels.mockResolvedValue([{ id: 'user/local-GGUF', name: 'local-GGUF', size: 100, importedAt: 1 }]);
    const provider = new LlamaCppBrowserProvider();
    expect(await provider.listModels({})).toEqual(['local-GGUF']);
    const input = request(); input.model = 'local-GGUF'; input.messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'second' }] }];
    await provider.chat(input);
    expect(input.onAssistantMessageStart).toHaveBeenCalledOnce();
    expect(service.generate).toHaveBeenCalledOnce();
    expect(service.generate.mock.calls[0]?.[0].input.messages).toEqual([{ role: 'system', content: 'rules' }, { role: 'user', content: 'first second' }]);
    expect(service.generate.mock.calls[0]?.[0].input.model).toBe('local-GGUF');
    expect(service.generate.mock.calls[0]?.[0].onChunk).toBe(input.onChunk);
  });
  it('rejects remote image URLs instead of fetching arbitrary resources', async () => {
    const input = request(); input.messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.invalid/image.png' } }] }];
    await expect(new LlamaCppBrowserProvider().chat(input)).rejects.toThrow('unsupported-input');
    expect(input.onAssistantMessageStart).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
  });
  it('preserves ordered local image and text parts across the worker boundary', async () => {
    const input = request(); input.messages = [{ role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }, { type: 'text', text: 'after' }] }];
    await new LlamaCppBrowserProvider().chat(input);
    expect(service.generate.mock.calls[0]?.[0].input.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'image', blob: expect.any(Blob) }, { type: 'text', text: 'after' }] }]);
  });
  it('does not turn tool-role messages into ordinary assistant text', async () => {
    const input = request(); input.messages = [{ role: 'tool', content: 'private tool result' }];
    await expect(new LlamaCppBrowserProvider().chat(input)).rejects.toThrow('unsupported-input');
    expect(input.onAssistantMessageStart).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
  });
  it('does not start generation for an already aborted request', async () => {
    const input = request(); input.signal = AbortSignal.abort();
    await expect(new LlamaCppBrowserProvider().chat(input)).rejects.toThrow('aborted');
    expect(input.onAssistantMessageStart).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
  });
});

describe('native tool turns on the host', () => {
  it('validates arguments, preserves the visible call and sends matching results before starting another assistant message', async () => {
    const events: string[] = [];
    const execute = vi.fn(async () => ({ status: 'success' as const, content: '42' }));
    const { z } = await import('zod');
    const input = request();
    input.debug = 'on';
    input.tools = [{ name: 'lookup', description: 'Lookup', parametersSchema: z.object({ value: z.string(), unit: z.string().default('count') }), execute }];
    input.onAssistantMessageStart = () => {
      events.push('assistant');
    };
    input.onToolCall = ({ modelVisibleArguments }) => {
      events.push(`call:${modelVisibleArguments}`);
    };
    input.onToolResult = ({ result }) => {
      events.push(`result:${result.status}`);
    };
    const signal = new AbortController().signal;
    let next: Parameters<LlamaCppBrowserService['generate']>[0]['input'] | undefined;
    service.generate.mockImplementation(async ({ onResult }) => {
      input.debug = 'off';
      next = await onResult?.({ result: { content: 'Checking.', reasoningContent: '', finishReason: 'stop',
        toolCalls: [{ id: '', type: 'function', function: { name: 'lookup', arguments: '{"value":"42"}' } }],
      }, signal });
      expect(await onResult?.({ result: { content: '42', reasoningContent: '', toolCalls: [], finishReason: 'stop' }, signal })).toBeUndefined();
    });
    await new LlamaCppBrowserProvider().chat(input);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ args: { value: '42', unit: 'count' }, signal }));
    expect(events).toEqual(['assistant', 'call:{"value":"42"}', 'result:success', 'assistant']);
    const assistant = next?.messages[1]; const result = next?.messages[2];
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"value":"42"}');
    expect(assistant?.tool_calls?.[0]?.id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(result?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
    expect(result?.content).toBe('42'); expect(result?.role).toBe('tool');
    expect(next?.tools?.[0]?.function.parameters.additionalProperties).toBe(false);
    expect(next?.debug).toBe('on');
  });
  it.each(['{"value":1,"unexpected":true}', '{'])('returns invalid arguments without executing the tool: %s', async argumentsText => {
    const { z } = await import('zod'); const execute = vi.fn(); const input = request();
    input.tools = [{ name: 'lookup', description: '', parametersSchema: z.object({ value: z.number() }), execute }];
    input.onToolResult = vi.fn();
    service.generate.mockImplementation(async ({ onResult }) => {
      const next = await onResult?.({ result: { content: '', reasoningContent: '', finishReason: 'stop', toolCalls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: argumentsText } }] }, signal: new AbortController().signal });
      expect(next?.messages.at(-1)?.content).toContain('Error [invalid_arguments]');
    });
    await new LlamaCppBrowserProvider().chat(input);
    expect(execute).not.toHaveBeenCalled(); expect(input.onToolResult).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ code: 'invalid_arguments' }) }));
  });
  it('normalizes duplicate native call IDs and routes unknown tools through the existing outcome contract', async () => {
    const input = request(); input.onToolCall = vi.fn(); input.onToolResult = vi.fn();
    service.generate.mockImplementation(async ({ onResult }) => {
      const next = await onResult?.({ result: { content: '', reasoningContent: '', finishReason: 'stop', toolCalls: [1, 2].map(() => ({ id: 'same', type: 'function', function: { name: 'missing', arguments: '{}' } })) }, signal: new AbortController().signal });
      const calls = next?.messages[1]?.tool_calls;
      expect(calls?.[0]?.id).not.toBe(calls?.[1]?.id);
      expect(next?.messages[2]?.tool_call_id).toBe(calls?.[0]?.id);
      expect(next?.messages[3]?.tool_call_id).toBe(calls?.[1]?.id);
      expect(next?.messages[2]?.content).toContain('not found');
    });
    await new LlamaCppBrowserProvider().chat(input);
    expect(input.onToolCall).toHaveBeenCalledTimes(2); expect(input.onToolResult).toHaveBeenCalledTimes(2);
  });
  it('never executes an incomplete turn and does not emit tool callbacks', async () => {
    const input = request(); input.onToolCall = vi.fn(); input.onToolResult = vi.fn();
    service.generate.mockImplementation(async ({ onResult }) => {
      expect(await onResult?.({ result: { content: '', reasoningContent: '', finishReason: 'length', toolCalls: [{ id: '', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, signal: new AbortController().signal })).toBeUndefined();
    });
    await new LlamaCppBrowserProvider().chat(input);
    expect(input.onToolCall).not.toHaveBeenCalled(); expect(input.onToolResult).not.toHaveBeenCalled();
  });
  it('passes approval and the operation signal to tools and suppresses post-cancel events/results/turns', async () => {
    const { z } = await import('zod'); const controller = new AbortController(); const input = request();
    const execute = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBe(controller.signal); controller.abort(); return { status: 'success' as const, content: 'late' };
    });
    input.tools = [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute }];
    input.onToolResult = vi.fn(); input.onToolEvent = vi.fn();
    service.generate.mockImplementation(async ({ onResult }) => {
      await onResult?.({ result: { content: '', reasoningContent: '', finishReason: 'stop', toolCalls: [{ id: 'id', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, signal: controller.signal });
    });
    await expect(new LlamaCppBrowserProvider().chat(input)).rejects.toThrow('aborted');
    expect(execute).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith(expect.objectContaining({ approvalContext: input.toolApprovalContext }));
    expect(input.onToolResult).not.toHaveBeenCalled(); expect(input.onAssistantMessageStart).toHaveBeenCalledOnce();
  });
});


it.each([undefined, 'none', 'low', 'medium', 'high'] as const)('preserves the configured reasoning effort %s at the worker boundary', async effort => {
  const input = request(); input.parameters = { ...EMPTY_LM_PARAMETERS, reasoning: { effort } };
  await new LlamaCppBrowserProvider().chat(input);
  expect(service.generate.mock.calls[0]?.[0].input.reasoningEffort).toBe(effort);
});


it('ignores tool events emitted after that execution has settled', async () => {
  const { z } = await import('zod'); const input = request(); input.onToolEvent = vi.fn();
  let send: Parameters<Tool['execute']>[0]['onEvent'];
  input.tools = [{ name: 'lookup', description: '', parametersSchema: z.object({}),
    execute: async ({ onEvent }) => {
      send = onEvent; await onEvent?.({ event: { type: 'started' } });
      return { status: 'success', content: 'done' };
    },
  }];
  service.generate.mockImplementation(async ({ onResult }) => {
    await onResult?.({ result: { content: '', reasoningContent: '', finishReason: 'stop', toolCalls: [{ id: 'id', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, signal: new AbortController().signal });
    await send?.({ event: { type: 'output', stream: 'stdout', text: 'late' } });
  });
  await new LlamaCppBrowserProvider().chat(input);
  expect(input.onToolEvent).toHaveBeenCalledOnce();
  expect(input.onToolEvent).toHaveBeenCalledWith(expect.objectContaining({ event: { type: 'started' } }));
});

it('executes multiple model calls serially through the same host tool contract', async () => {
  const { z } = await import('zod'); const input = request(); const events: string[] = [];
  input.tools = [{ name: 'lookup', description: '', parametersSchema: z.object({ value: z.string() }),
    execute: async ({ args }) => {
      const { value } = z.object({ value: z.string() }).parse(args);
      events.push(`start:${value}`); await Promise.resolve(); events.push(`finish:${value}`);
      return { status: 'success', content: value };
    },
  }];
  service.generate.mockImplementation(async ({ onResult }) => {
    const next = await onResult?.({ result: { content: '', reasoningContent: '', finishReason: 'stop',
      toolCalls: ['first', 'second'].map(value => ({ id: value, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ value }) } })),
    }, signal: new AbortController().signal });
    expect(next?.messages.slice(-2).map(message => message.content)).toEqual(['first', 'second']);
  });
  await new LlamaCppBrowserProvider().chat(input);
  expect(events).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);
});
