import { describe, expect, it, vi } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import type { ToolExecutionOutcome, ToolExecutionEvent } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import { z } from 'zod';
import { captureProviderChat, type CapturedChatRequest } from './capture-provider-chat';

type ChatArguments = Parameters<LmProvider['chat']>[0];
function request(): CapturedChatRequest {
  return { model: 'synthetic/test', messages: [{ role: 'user', content: 'Literal input.' }], signal: new AbortController().signal };
}

describe('public chat observation mechanics', () => {
  it('forwards the literal request and original tool without invoking or wrapping its implementation', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, content: 'fixed' }));
    const supplied: CapturedChatRequest = { ...request(), tools: [{ name: 'fixed_tool', description: 'Fixed', parametersSchema: z.object({}), execute }],
      parameters: { maxCompletionTokens: 16, temperature: 0, topP: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } };
    const chat = vi.fn<LmProvider['chat']>(async args => {
      args.onAssistantMessageStart?.(); args.onChunk({ chunk: 'A' });
    });
    const capture = captureProviderChat({ provider: { chat }, request: supplied });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ model: 'synthetic/test', messages: [{ role: 'user', content: 'Literal input.' }] });
    expect(chat.mock.calls[0]?.[0].messages).toBe(supplied.messages);
    expect(chat.mock.calls[0]?.[0].tools).toBe(supplied.tools);
    expect(chat.mock.calls[0]?.[0].parameters).toBe(supplied.parameters);
    expect(chat.mock.calls[0]?.[0].signal).toBe(supplied.signal);
    expect(execute).not.toHaveBeenCalled();
    await capture.completion;
    expect(capture.snapshot()).toEqual({
      chunks: ['A'], responses: [['A']], preStartChunks: [], toolCalls: [], toolResults: [], toolEvents: [], lateEvents: [],
      events: [{ kind: 'assistant-start', assistantIndex: 0 }, { kind: 'chunk', assistantIndex: 0, chunk: 'A' }, { kind: 'settled', outcome: 'fulfilled' }],
      settlement: { status: 'fulfilled' },
    });
  });

  it('retains raw thinking text, chunk boundaries and interleaved callbacks across assistant messages', async () => {
    const id = toToolCallId({ raw: 'call-1' });
    const capture = captureProviderChat({ provider: { chat: async args => {
      args.onAssistantMessageStart?.();
      args.onChunk({ chunk: 'Reason' }); args.onChunk({ chunk: '</think>' });
      args.onToolCall?.({ id, toolName: 'weather', modelVisibleArguments: '{"city":"Tokyo"}' });
      args.onToolEvent?.({ id, event: { type: 'started' } });
      args.onToolResult?.({ id, result: { status: 'success', content: 'clear' } });
      args.onAssistantMessageStart?.(); args.onChunk({ chunk: 'Answer' });
    } }, request: request() });
    await capture.completion;
    const snapshot = capture.snapshot();
    expect(snapshot.responses).toEqual([['Reason', '</think>'], ['Answer']]);
    expect(snapshot.chunks.join('')).toBe('Reason</think>Answer');
    expect(snapshot.events).toEqual([
      { kind: 'assistant-start', assistantIndex: 0 },
      { kind: 'chunk', assistantIndex: 0, chunk: 'Reason' }, { kind: 'chunk', assistantIndex: 0, chunk: '</think>' },
      { kind: 'tool-call', id, toolName: 'weather', modelVisibleArguments: '{"city":"Tokyo"}' },
      { kind: 'tool-event', id, event: { type: 'started' } },
      { kind: 'tool-result', id, result: { status: 'success', content: 'clear' } },
      { kind: 'assistant-start', assistantIndex: 1 }, { kind: 'chunk', assistantIndex: 1, chunk: 'Answer' },
      { kind: 'settled', outcome: 'fulfilled' },
    ]);
    expect(snapshot.preStartChunks).toEqual([]); expect(snapshot.lateEvents).toEqual([]);
  });

  it('copies mutable callback payloads on receipt and returns detached snapshots', async () => {
    const id = toToolCallId({ raw: 'call-mutable' });
    const result: ToolExecutionOutcome = { status: 'success', content: 'original' };
    const event: ToolExecutionEvent = { type: 'output', stream: 'stdout', text: 'original' };
    const call = { id, toolName: 'original', modelVisibleArguments: '{}' };
    const capture = captureProviderChat({ provider: { chat: async args => {
      args.onToolCall?.(call); args.onToolResult?.({ id, result }); args.onToolEvent?.({ id, event });
      call.toolName = 'changed'; result.content = 'changed'; event.text = 'changed';
    } }, request: request() });
    await capture.completion;
    const first = capture.snapshot();
    expect(first.toolCalls).toEqual([{ id, toolName: 'original', modelVisibleArguments: '{}' }]);
    expect(first.toolResults).toEqual([{ id, result: { status: 'success', content: 'original' } }]);
    expect(first.toolEvents).toEqual([{ id, event: { type: 'output', stream: 'stdout', text: 'original' } }]);
    first.toolCalls[0]!.toolName = 'snapshot mutation'; first.events.length = 0;
    expect(capture.snapshot().toolCalls[0]?.toolName).toBe('original');
    expect(capture.snapshot().events).toHaveLength(4);
  });

  it('records pre-start and late callbacks around fulfilled settlement', async () => {
    let callbacks: ChatArguments | undefined;
    const pending = Promise.withResolvers<void>();
    const capture = captureProviderChat({ provider: { chat: args => {
      callbacks = args; args.onChunk({ chunk: 'early' }); return pending.promise;
    } }, request: request() });
    expect(capture.snapshot().settlement).toEqual({ status: 'pending' });
    expect(capture.snapshot().preStartChunks).toEqual(['early']);
    pending.resolve();
    await capture.completion;
    callbacks!.onAssistantMessageStart?.(); callbacks!.onChunk({ chunk: 'late' });
    expect(capture.snapshot().lateEvents).toEqual([
      { kind: 'assistant-start', assistantIndex: 0 }, { kind: 'chunk', assistantIndex: 0, chunk: 'late' },
    ]);
    expect(capture.snapshot().events.map(event => event.kind)).toEqual(['chunk', 'settled', 'assistant-start', 'chunk']);
  });

  it('records pre-start and late callbacks around rejected settlement', async () => {
    let callbacks: ChatArguments | undefined;
    const pending = Promise.withResolvers<void>();
    const capture = captureProviderChat({ provider: { chat: args => {
      callbacks = args; args.onChunk({ chunk: 'early' }); return pending.promise;
    } }, request: request() });
    expect(capture.snapshot().settlement).toEqual({ status: 'pending' });
    expect(capture.snapshot().preStartChunks).toEqual(['early']);
    const error = new Error('original rejection');
    pending.reject(error);
    await expect(capture.completion).rejects.toBe(error);
    callbacks!.onAssistantMessageStart?.(); callbacks!.onChunk({ chunk: 'late' });
    expect(capture.snapshot().lateEvents).toEqual([
      { kind: 'assistant-start', assistantIndex: 0 }, { kind: 'chunk', assistantIndex: 0, chunk: 'late' },
    ]);
    expect(capture.snapshot().events.map(event => event.kind)).toEqual(['chunk', 'settled', 'assistant-start', 'chunk']);
  });

  it('preserves a synchronous thrown error as the completion rejection, with partial callbacks intact', async () => {
    const error = new Error('synchronous native boundary');
    const capture = captureProviderChat({ provider: { chat: args => {
      args.onAssistantMessageStart?.(); args.onChunk({ chunk: 'partial' }); throw error;
    } }, request: request() });
    await expect(capture.completion).rejects.toBe(error);
    expect(capture.snapshot().settlement).toEqual({ status: 'rejected', error });
    expect(capture.snapshot().responses).toEqual([['partial']]);
    expect(capture.snapshot().events.at(-1)).toEqual({ kind: 'settled', outcome: 'rejected' });
  });

  it('does not manufacture positive callback coverage when chat makes no callbacks', async () => {
    const capture = captureProviderChat({ provider: { chat: async () => {} }, request: request() });
    await capture.completion;
    expect(capture.snapshot().responses).toEqual([]);
    expect(capture.snapshot().chunks).toEqual([]);
    expect(capture.snapshot().toolCalls).toEqual([]);
    expect(capture.snapshot().events).toEqual([{ kind: 'settled', outcome: 'fulfilled' }]);
  });

  it('keeps captures independent when an earlier operation emits after a later call starts', async () => {
    const callbacks: ChatArguments[] = [];
    const provider = { chat: async (args: ChatArguments) => {
      callbacks.push(args);
    } };
    const first = captureProviderChat({ provider, request: request() });
    await first.completion;
    const second = captureProviderChat({ provider, request: { ...request(), messages: [{ role: 'user', content: 'Independent.' }] } });
    callbacks[0]!.onChunk({ chunk: 'old late text' });
    callbacks[1]!.onAssistantMessageStart?.(); callbacks[1]!.onChunk({ chunk: 'new text' });
    await second.completion;
    expect(first.snapshot().lateEvents).toEqual([{ kind: 'chunk', assistantIndex: undefined, chunk: 'old late text' }]);
    expect(second.snapshot().responses).toEqual([['new text']]);
    expect(second.snapshot().lateEvents).toEqual([]);
  });
});
