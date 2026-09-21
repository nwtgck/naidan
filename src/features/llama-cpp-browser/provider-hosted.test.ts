import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateInputSchema, type GenerationResult } from './types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import { collectChatGeneration } from '@/logic/collect-chat-generation';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { LlamaCppBrowserService } from './service-contract';
import { LlamaCppBrowserProvider } from './provider-hosted';
import { chatRequest, createChatFixture, deliverNativeResult, finalText } from './test-utils/chat';
const service = vi.hoisted(() => ({ generate: vi.fn<LlamaCppBrowserService['generate']>(), listModels: vi.fn<LlamaCppBrowserService['listModels']>(), runGenerationOperation: vi.fn<LlamaCppBrowserService['runGenerationOperation']>() }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
beforeEach(async () => {
  vi.clearAllMocks(); await ensureAllStringsForTest({ locale: 'en' });
  service.generate.mockImplementation(async ({ onEvent }) => deliverNativeResult({ result: finalText({ text: 'done' }), onEvent }));
  service.runGenerationOperation.mockImplementation(async ({ signal, operation }) => {
    await operation({ scope: { signal: signal ?? new AbortController().signal, generate: service.generate } });
  });
});
function read({ request }: { request: ReturnType<typeof chatRequest> }) {
  return collectChatGeneration({ items: new LlamaCppBrowserProvider().chat(request), abortController: new AbortController() });
}
function called({ argumentsText, name, id }: { argumentsText: string, name: string, id: string }): GenerationResult {
  return { content: '', reasoningContent: '', finishReason: 'stop', toolCalls: [{ id, type: 'function', function: { name, arguments: argumentsText } }] };
}
describe('local model provider', () => {
  it('leaves an omitted completion limit unset and preserves explicit limit validation', async () => {
    await read({ request: chatRequest() });
    await read({ request: { ...chatRequest(), parameters: { ...EMPTY_LM_PARAMETERS, maxCompletionTokens: 37 } } });
    const inputs = service.generate.mock.calls.map(([{ input }]) => input);
    expect(inputs.map(input => input.maxTokens)).toEqual([undefined, 37]);
    const input = { ...inputs[0]!, options: { profile: 'cpu-wasm32' } };
    expect(generateInputSchema.safeParse(input).success).toBe(true);
    for (const maxTokens of [32768, 65536, Number.MAX_SAFE_INTEGER]) expect(generateInputSchema.safeParse({ ...input, maxTokens }).success).toBe(true);
    for (const maxTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(generateInputSchema.safeParse({ ...input, maxTokens }).success).toBe(false);
  });
  it('passes the diagnostic preference per request without retaining the preceding chat setting', async () => {
    await read({ request: { ...chatRequest(), debug: 'on' } });
    await read({ request: { ...chatRequest(), debug: 'off' } });
    await read({ request: chatRequest() });
    expect(service.generate.mock.calls.map(([{ input }]) => input.debug)).toEqual(['on', 'off', undefined]);
  });
  it('maps model identity and text messages without normalizing away content', async () => {
    service.listModels.mockResolvedValue([{ id: 'user/local-GGUF', name: 'local-GGUF', size: 100, importedAt: 1 }]);
    expect(await new LlamaCppBrowserProvider().listModels({ signal: undefined })).toEqual(['local-GGUF']);
    const request = chatRequest(); request.model = 'local-GGUF';
    request.messages = [{ id: toMessageId({ raw: 's' }), role: 'system', parts: [{ id: 'p', type: 'text', text: 'rules', completeness: 'complete' }] },
      { id: toMessageId({ raw: 'u' }), role: 'user', parts: ['first ', 'second'].map((text, index) => ({ id: `p${index}`, type: 'text', text, completeness: 'complete' })) }];
    expect((await read({ request })).text).toBe('done');
    expect(service.generate.mock.calls[0]?.[0].input.messages).toEqual([{ role: 'system', content: 'rules' }, { role: 'user', content: 'first second' }]);
    expect(service.generate.mock.calls[0]?.[0].input.model).toBe('local-GGUF');
  });
  it('rejects remote image references instead of fetching arbitrary resources', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const request = chatRequest();
    request.messages = [{ id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ id: 'p', type: 'attachment', attachment: {
      id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'https://private.invalid/image.png' }), originalName: 'x', size: 1, uploadedAt: 1, mimeType: 'image/png', status: 'missing',
    } }] }];
    expect((await read({ request })).result.type).toBe('error'); expect(service.generate).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();fetcher.mockRestore();
  });
  it('preserves ordered local image and text parts across the worker boundary', async () => {
    const request = chatRequest(); const blob = new Blob(['image'], { type: 'image/png' });
    request.messages = [{ id: toMessageId({ raw: 'u' }), role: 'user', parts: [
      { id: 'p1', type: 'text', text: 'before', completeness: 'complete' },
      { id: 'p2', type: 'attachment', attachment: { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'x', size: blob.size, uploadedAt: 1, mimeType: blob.type, status: 'memory', blob } },
      { id: 'p3', type: 'text', text: 'after', completeness: 'complete' },
    ] }];
    await read({ request });
    expect(service.generate.mock.calls[0]?.[0].input.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'image', blob }, { type: 'text', text: 'after' }] }]);
  });
  it('does not turn an unmatched tool-role result into ordinary assistant text', async () => {
    const request = chatRequest(); request.messages = [{ id: toMessageId({ raw: 't' }), role: 'tool', parts: [{ id: 'p', type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'unknown' }), status: 'success', content: { type: 'text', text: 'private tool result' } } }] }];
    expect((await read({ request })).result.type).toBe('error'); expect(service.generate).not.toHaveBeenCalled();
  });
  it('does not start generation for an already aborted request', async () => {
    const { result } = await read({ request: { ...chatRequest(), signal: AbortSignal.abort() } });
    expect(result).toEqual({ type: 'interrupted', reason: 'aborted' }); expect(service.generate).not.toHaveBeenCalled();
  });
});
describe('native tool turns through the shared runner', () => {
  it('validates arguments, preserves the visible call and sends matching results before the next assistant', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, content: '42' })); const request = chatRequest(); request.debug = 'on';
    const fixture = createChatFixture({ approvalContext: undefined, provider: new LlamaCppBrowserProvider(), request, tools: [{ name: 'lookup', description: 'Lookup', parametersSchema: z.object({ value: z.string(), unit: z.string().default('count') }), execute }], controller: new AbortController(), onToolEvent: () => {} });
    service.generate.mockImplementationOnce(async ({ onEvent }) => {
      request.debug = 'off';
      return deliverNativeResult({ result: { ...called({ argumentsText: '{"value":"42"}', name: 'lookup', id: '' }), content: 'Checking.' }, onEvent });
    });
    expect(await fixture.run()).toEqual({ type: 'finished', next: 'user' });
    expect(service.runGenerationOperation).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith(expect.objectContaining({ args: { value: '42', unit: 'count' }, signal: expect.any(AbortSignal) }));
    expect(fixture.nodes.map(n => n.role)).toEqual(['assistant', 'tool', 'assistant']);
    const next = service.generate.mock.calls[1]?.[0].input;
    const assistant = next?.messages[1]; const result = next?.messages[2];
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"value":"42"}'); expect(assistant?.tool_calls?.[0]?.id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(result?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id); expect(result?.content).toBe('42'); expect(result?.role).toBe('tool');
    expect(next?.tools?.[0]?.function.parameters.additionalProperties).toBe(false); expect(next?.debug).toBe('on');
  });
  it.each(['{"value":1,"unexpected":true}', '{'])('returns invalid arguments without executing the tool: %s', async argumentsText => {
    const execute = vi.fn(); service.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: called({ argumentsText, name: 'lookup', id: 'call' }), onEvent }));
    const fixture = createChatFixture({ approvalContext: undefined, provider: new LlamaCppBrowserProvider(), request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({ value: z.number() }), execute }], controller: new AbortController(), onToolEvent: () => {} });
    await fixture.run();expect(execute).not.toHaveBeenCalled();expect(service.generate.mock.calls[1]?.[0].input.messages.at(-1)?.content).toContain('Error [invalid_arguments]');
  });
  it('normalizes duplicate native call IDs and routes unknown tools through the outcome contract', async () => {
    service.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: { content: '', reasoningContent: '', finishReason: 'stop', toolCalls: [1, 2].map(() => called({ argumentsText: '{}', name: 'missing', id: 'same' }).toolCalls[0]!) }, onEvent }));
    const fixture = createChatFixture({ approvalContext: undefined, provider: new LlamaCppBrowserProvider(), request: chatRequest(), tools: [], controller: new AbortController(), onToolEvent: () => {} });
    await fixture.run();const next = service.generate.mock.calls[1]?.[0].input.messages; const calls = next?.[1]?.tool_calls;
    expect(calls?.[0]?.id).not.toBe(calls?.[1]?.id);expect(next?.[2]?.tool_call_id).toBe(calls?.[0]?.id);expect(next?.[3]?.tool_call_id).toBe(calls?.[1]?.id);expect(next?.[2]?.content).toContain('not found');
  });
  it('never executes an incomplete native turn and retains no draft call', async () => {
    service.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: { ...called({ argumentsText: '{}', name: 'lookup', id: '' }), finishReason: 'length' }, onEvent }));
    const execute = vi.fn();const fixture = createChatFixture({ approvalContext: undefined, provider: new LlamaCppBrowserProvider(), request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute }], controller: new AbortController(), onToolEvent: () => {} });
    expect(await fixture.run()).toEqual({ type: 'interrupted', reason: 'limit' });expect(execute).not.toHaveBeenCalled();expect(fixture.nodes[0]?.parts).toEqual([]);expect(fixture.nodes).toHaveLength(1);
  });
  it('passes the operation signal to tools, suppresses late events, and retains an observed post-cancel success', async () => {
    const controller = new AbortController();const onToolEvent = vi.fn();
    const execute = vi.fn<Tool['execute']>(async ({ signal, onEvent }) => {
      expect(signal?.aborted).toBe(false);controller.abort();expect(signal?.aborted).toBe(true);
      await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'late' } });return { status: 'success', content: 'late success' };
    });
    service.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: called({ argumentsText: '{}', name: 'lookup', id: 'id' }), onEvent }));
    const fixture = createChatFixture({ approvalContext: undefined, provider: new LlamaCppBrowserProvider(), request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute }], controller, onToolEvent });
    await expect(fixture.run()).rejects.toThrow();expect(execute).toHaveBeenCalledOnce();expect(onToolEvent).not.toHaveBeenCalled();expect(service.generate).toHaveBeenCalledOnce();
    expect(fixture.nodes[1]?.parts[0]).toMatchObject({ type: 'tool_result', result: { status: 'success', content: { text: 'late success' } } });
  });
});
it.each([undefined, 'none', 'low', 'medium', 'high'] as const)('preserves configured reasoning effort %s at the worker boundary', async effort => {
  await read({ request: { ...chatRequest(), parameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort } } } });
  expect(service.generate.mock.calls[0]?.[0].input.reasoningEffort).toBe(effort);
});
it('ignores tool events emitted after that execution has settled', async () => {
  let send: Parameters<Tool['execute']>[0]['onEvent'];const onToolEvent = vi.fn();
  service.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: called({ argumentsText: '{}', name: 'lookup', id: 'id' }), onEvent }));
  const fixture = createChatFixture({ approvalContext: undefined, provider: new LlamaCppBrowserProvider(), request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute: async ({ onEvent }) => {
    send = onEvent;await onEvent?.({ event: { type: 'started' } });return { status: 'success', content: 'done' };
  } }], controller: new AbortController(), onToolEvent });
  await fixture.run();await send?.({ event: { type: 'output', stream: 'stdout', text: 'late' } });expect(onToolEvent).toHaveBeenCalledOnce();expect(onToolEvent).toHaveBeenCalledWith(expect.objectContaining({ event: { type: 'started' } }));
});
it('executes multiple completed calls serially through the same host tool contract', async () => {
  const events: string[] = [];
  service.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: { content: '', reasoningContent: '', finishReason: 'stop', toolCalls: ['first', 'second'].map(value => called({ argumentsText: JSON.stringify({ value }), name: 'lookup', id: value }).toolCalls[0]!) }, onEvent }));
  const fixture = createChatFixture({ approvalContext: undefined, provider: new LlamaCppBrowserProvider(), request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({ value: z.string() }), execute: async ({ args }) => {
    const { value } = z.object({ value: z.string() }).parse(args);events.push(`start:${value}`);await Promise.resolve();events.push(`finish:${value}`);return { status: 'success', content: value };
  } }], controller: new AbortController(), onToolEvent: () => {} });
  await fixture.run();expect(events).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);expect(service.generate.mock.calls[1]?.[0].input.messages.slice(-2).map(message => message.content)).toEqual(['first', 'second']);
});

it('passes the actual caller approval context into the common tool execution', async () => {
  const { toChatId } = await import('@/01-models/ids');
  const approvalContext = { chatId: toChatId({ raw: 'approval-chat' }), ensureApproval: vi.fn(async () => ({ status: 'approved' as const })) };
  const execute = vi.fn<Tool['execute']>(async ({ approvalContext: supplied, signal }) => {
    expect(supplied).toBe(approvalContext);expect(signal?.aborted).toBe(false);
    return { status: 'success', content: 'approved' };
  });
  service.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: called({ argumentsText: '{}', name: 'lookup', id: 'id' }), onEvent }));
  const fixture = createChatFixture({ provider: new LlamaCppBrowserProvider(), request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute }], controller: new AbortController(), onToolEvent: () => {}, approvalContext });
  await fixture.run();expect(execute).toHaveBeenCalledOnce();
});
