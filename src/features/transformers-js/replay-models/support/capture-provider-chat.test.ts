import { describe, expect, it, vi } from 'vitest';
import type { ChatGenerationItem, ChatGenerationResult, LmProvider } from '@/01-models/lm';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { captureProviderChat, type CapturedChatRequest } from './capture-provider-chat';

function request(): CapturedChatRequest {
  return {
    model: 'synthetic/test',
    messages: [{ id: toMessageId({ raw: 'user' }), role: 'user', parts: [{ type: 'text', text: 'Literal input.', completeness: 'complete' }] }],
    parameters: undefined, tools: undefined, readBinaryObject: undefined, debug: undefined,
    signal: new AbortController().signal,
  };
}

async function* values<T>({ items }: { items: readonly T[] }): AsyncIterable<T> {
  yield* items;
}

function text({ partId, index, chunks, completeness }: {
  partId: string; index: number; chunks: readonly string[]; completeness: 'complete' | 'partial';
}): ChatGenerationItem {
  return { type: 'text', partId, index, chunks: values({ items: chunks }), completeness: Promise.resolve(completeness) };
}

const finished: ChatGenerationItem = { type: 'result', result: { type: 'finished', next: 'user' } };

/** Deliberately synthetic transport controls; these are not model recordings. */
describe('public chat observation mechanics', () => {
  it('forwards the literal request, tool schemas, signal and binary resolver without executing them', async () => {
    const readBinaryObject = vi.fn(async () => new Blob(['image']));
    const supplied: CapturedChatRequest = { ...request(), debug: 'on', readBinaryObject,
      tools: [{ name: 'fixed_tool', description: 'Fixed', parameters: { type: 'object', properties: {} } }],
      parameters: { maxCompletionTokens: 16, temperature: 0, topP: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
    };
    const chat = vi.fn<LmProvider['chat']>(() => values({ items: [text({ partId: 'answer', index: 0, chunks: ['A'], completeness: 'complete' }), finished] }));
    const capture = captureProviderChat({ provider: { chat }, request: supplied });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0]).toBe(supplied);
    await capture.completion;
    expect(readBinaryObject).not.toHaveBeenCalled();
    expect(capture.snapshot()).toMatchObject({
      parts: [{ type: 'text', partId: 'answer', index: 0, chunks: ['A'], completeness: 'complete' }],
      result: { type: 'finished', next: 'user' }, settlement: { status: 'fulfilled' },
    });
    expect(capture.snapshot().events.at(-1)).toEqual({ kind: 'settled', outcome: 'fulfilled' });
  });

  it('retains raw reasoning, chunk boundaries and tool arguments in logical part order', async () => {
    const reasoning = Promise.withResolvers<void>();
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [
      { type: 'text', partId: 'answer', index: 2, chunks: values({ items: ['Answer', '</think>'] }), completeness: Promise.resolve('complete') },
      { type: 'reasoning', partId: 'reason', index: 0, chunks: {
        async *[Symbol.asyncIterator]() {
          await reasoning.promise;
          yield 'Reason';
          yield '<think>literal</think>';
        },
      }, completeness: Promise.resolve('complete') },
      { type: 'tool_call', partId: 'call', index: 1, toolCall: {
        id: toToolCallId({ raw: 'call-1' }), type: 'function', function: { name: 'weather', arguments: ' { "city": "Tokyo" } ' },
      } },
      { type: 'result', result: { type: 'finished', next: 'tool_results' } },
    ] }) }, request: request() });
    await vi.waitFor(() => expect(capture.snapshot().result).toEqual({ type: 'finished', next: 'tool_results' }));
    expect(capture.snapshot().settlement).toEqual({ status: 'pending' });
    reasoning.resolve();
    await capture.completion;
    const snapshot = capture.snapshot();
    expect(snapshot.parts).toEqual([
      { type: 'reasoning', partId: 'reason', index: 0, chunks: ['Reason', '<think>literal</think>'], completeness: 'complete' },
      { type: 'tool_call', partId: 'call', index: 1, toolCall: { id: 'call-1', type: 'function', function: { name: 'weather', arguments: ' { "city": "Tokyo" } ' } } },
      { type: 'text', partId: 'answer', index: 2, chunks: ['Answer', '</think>'], completeness: 'complete' },
    ]);
    expect(snapshot.events.filter(event => event.kind === 'part' || event.kind === 'tool-call').map(event => event.partId)).toEqual(['answer', 'reason', 'call']);
    expect(snapshot.events.filter(event => event.kind === 'chunk')).toEqual([
      { kind: 'chunk', partId: 'answer', chunk: 'Answer' },
      { kind: 'chunk', partId: 'answer', chunk: '</think>' },
      { kind: 'chunk', partId: 'reason', chunk: 'Reason' },
      { kind: 'chunk', partId: 'reason', chunk: '<think>literal</think>' },
    ]);
  });

  it('copies mutable tool payloads on receipt and returns detached snapshots', async () => {
    const toolCall = { id: toToolCallId({ raw: 'mutable' }), type: 'function' as const, function: { name: 'original', arguments: '{}' } };
    const capture = captureProviderChat({ provider: { chat: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'tool_call', partId: 'call', index: 0, toolCall };
        toolCall.function.name = 'changed';
        yield { type: 'result', result: { type: 'finished', next: 'tool_results' } };
      },
    }) }, request: request() });
    await capture.completion;
    const first = capture.snapshot();
    expect(first.parts).toMatchObject([{ toolCall: { function: { name: 'original' } } }]);
    const part = first.parts[0];
    if (part?.type !== 'tool_call') throw new Error('Expected a completed tool call');
    part.toolCall.function.name = 'snapshot mutation';
    first.events.length = 0;
    expect(capture.snapshot().parts).toMatchObject([{ toolCall: { function: { name: 'original' } } }]);
    expect(capture.snapshot().events).toHaveLength(3);
  });

  it('keeps early completeness pending until all child chunks have drained', async () => {
    const release = Promise.withResolvers<void>();
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [
      { type: 'text', partId: 'answer', index: 0, completeness: Promise.resolve('complete'), chunks: {
        async *[Symbol.asyncIterator]() {
          yield 'first'; await release.promise; yield 'last';
        },
      } }, finished,
    ] }) }, request: request() });
    await vi.waitFor(() => expect(capture.snapshot().parts).toEqual([
      { type: 'text', partId: 'answer', index: 0, chunks: ['first'], completeness: 'pending' },
    ]));
    expect(capture.snapshot().settlement).toEqual({ status: 'pending' });
    expect(capture.snapshot().events.some(event => event.kind === 'part-complete')).toBe(false);
    release.resolve();
    await capture.completion;
    expect(capture.snapshot().parts).toEqual([{ type: 'text', partId: 'answer', index: 0, chunks: ['first', 'last'], completeness: 'complete' }]);
    expect(capture.snapshot().events.slice(-3)).toEqual([
      { kind: 'chunk', partId: 'answer', chunk: 'last' },
      { kind: 'part-complete', partId: 'answer', completeness: 'complete' },
      { kind: 'settled', outcome: 'fulfilled' },
    ]);
  });

  it('preserves a synchronous thrown error as a provider exception', async () => {
    const error = new Error('synchronous native boundary');
    const capture = captureProviderChat({ provider: { chat: () => {
      throw error;
    } }, request: request() });
    await expect(capture.completion).rejects.toBe(error);
    expect(capture.snapshot()).toEqual({
      parts: [], result: undefined, events: [{ kind: 'settled', outcome: 'rejected' }],
      settlement: { status: 'rejected', source: 'provider', error },
    });
  });

  it('retains already consumed chunks when the outer iterator throws', async () => {
    const error = new Error('outer failure');
    const childFinished = Promise.withResolvers<void>();
    const capture = captureProviderChat({ provider: { chat: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', partId: 'answer', index: 0, completeness: Promise.resolve('complete'), chunks: {
          async *[Symbol.asyncIterator]() {
            yield 'partial'; childFinished.resolve();
          },
        } };
        await childFinished.promise;
        throw error;
      },
    }) }, request: request() });
    await expect(capture.completion).rejects.toBe(error);
    expect(capture.snapshot().parts).toMatchObject([{ chunks: ['partial'] }]);
    expect(capture.snapshot().settlement).toEqual({ status: 'rejected', source: 'outer', error });
  });

  it('identifies a child iterator exception without manufacturing completion', async () => {
    const error = new Error('child failure');
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [
      { type: 'text', partId: 'answer', index: 0, completeness: Promise.resolve('complete'), chunks: {
        async *[Symbol.asyncIterator]() {
          yield 'partial'; throw error;
        },
      } }, finished,
    ] }) }, request: request() });
    await expect(capture.completion).rejects.toBe(error);
    expect(capture.snapshot().parts).toEqual([{ type: 'text', partId: 'answer', index: 0, chunks: ['partial'], completeness: 'pending' }]);
    expect(capture.snapshot().settlement).toEqual({ status: 'rejected', source: 'chunks', error });
  });

  it('identifies rejected completeness without losing its error identity', async () => {
    const error = new Error('completeness failure');
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [
      { type: 'text', partId: 'answer', index: 0, chunks: values({ items: [] }), completeness: Promise.reject(error) }, finished,
    ] }) }, request: request() });
    await expect(capture.completion).rejects.toBe(error);
    expect(capture.snapshot().settlement).toEqual({ status: 'rejected', source: 'completeness', error });
  });

  it('does not accept late delivery from a child returned after an outer failure', async () => {
    const childRead = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<IteratorResult<string>>();
    const error = new Error('outer failure during a child read');
    const childReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    const capture = captureProviderChat({ provider: { chat: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', partId: 'answer', index: 0, completeness: Promise.resolve('complete'), chunks: {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              childRead.resolve(); return pending.promise;
            },
            return: childReturn,
          }),
        } };
        await childRead.promise;
        throw error;
      },
    }) }, request: request() });
    await expect(capture.completion).rejects.toBe(error);
    expect(childReturn).toHaveBeenCalledOnce();
    const snapshot = capture.snapshot();
    pending.resolve({ done: false, value: 'late text' });
    await Promise.resolve();
    await Promise.resolve();
    expect(capture.snapshot()).toEqual(snapshot);
    expect(snapshot.parts).toMatchObject([{ chunks: [], completeness: 'pending' }]);
  });

  it('does not manufacture a result or positive coverage for an empty producer', async () => {
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [] }) }, request: request() });
    await expect(capture.completion).rejects.toThrow('closed without a result');
    expect(capture.snapshot()).toMatchObject({ parts: [], result: undefined, settlement: { status: 'rejected', source: 'protocol' } });
    expect(capture.snapshot().events).toEqual([{ kind: 'settled', outcome: 'rejected' }]);
  });

  it('does not publish late completeness after an outer failure', async () => {
    const drained = Promise.withResolvers<void>();
    const completeness = Promise.withResolvers<'complete' | 'partial'>();
    const error = new Error('outer failure while waiting for completeness');
    const capture = captureProviderChat({ provider: { chat: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', partId: 'answer', index: 0, completeness: completeness.promise, chunks: {
          async *[Symbol.asyncIterator]() {
            yield 'partial';
            drained.resolve();
          },
        } };
        await drained.promise;
        throw error;
      },
    }) }, request: request() });
    await expect(capture.completion).rejects.toBe(error);
    const snapshot = capture.snapshot();
    completeness.resolve('complete');
    await completeness.promise;
    // Include the observer's derived completeness Promise in this microtask turn.
    await new Promise<void>(resolve => queueMicrotask(resolve));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(capture.snapshot()).toEqual(snapshot);
    expect(snapshot.parts).toMatchObject([{ chunks: ['partial'], completeness: 'pending' }]);
  });

  it('distinguishes a delivered error result from an iterator exception', async () => {
    const error = new Error('native failure');
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [
      text({ partId: 'answer', index: 0, chunks: ['partial'], completeness: 'partial' }),
      { type: 'result', result: { type: 'error', error } },
    ] }) }, request: request() });
    await capture.completion;
    const snapshot = capture.snapshot();
    expect(snapshot.settlement).toEqual({ status: 'fulfilled' });
    expect(snapshot.result).toEqual({ type: 'error', error });
    if (snapshot.result?.type !== 'error') throw new Error('Expected an error result');
    expect(snapshot.result.error).toBe(error);
    const event = snapshot.events.find(event => event.kind === 'result');
    if (event?.kind !== 'result' || event.result.type !== 'error') throw new Error('Expected an error event');
    expect(event.result.error).toBe(error);
    expect(capture.snapshot().parts).toMatchObject([{ completeness: 'partial' }]);
  });

  it.each(['aborted', 'limit', 'stop_sequence', 'unknown'] as const)('records interrupted %s as a delivered terminal result', async reason => {
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [
      text({ partId: 'answer', index: 0, chunks: ['partial'], completeness: 'partial' }),
      { type: 'result', result: { type: 'interrupted', reason } },
    ] }) }, request: request() });
    await capture.completion;
    expect(capture.snapshot()).toMatchObject({ result: { type: 'interrupted', reason }, settlement: { status: 'fulfilled' } });
  });

  it('drains accepted content on request abort without treating it as consumer disposal', async () => {
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const capture = captureProviderChat({ provider: { chat: ({ signal }) => createChatGenerationStream({ signal,
      run: async ({ writer, signal: ownedSignal }) => {
        await writer.text({ type: 'text', text: 'accepted' });
        ready.resolve();
        await new Promise<void>(resolve => ownedSignal.addEventListener('abort', () => resolve(), { once: true }));
        return { type: 'interrupted', reason: 'aborted' };
      },
    }) }, request: { ...request(), signal: controller.signal } });
    await ready.promise;
    controller.abort();
    await capture.completion;
    expect(capture.snapshot()).toMatchObject({
      parts: [{ chunks: ['accepted'], completeness: 'partial' }],
      result: { type: 'interrupted', reason: 'aborted' }, settlement: { status: 'fulfilled' },
    });
  });

  it('disposes pending outer and child reads and waits for their return cleanup', async () => {
    const childRead = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const outerPending = Promise.withResolvers<IteratorResult<ChatGenerationItem>>();
    const childPending = Promise.withResolvers<IteratorResult<string>>();
    const completeness = Promise.withResolvers<'complete' | 'partial'>();
    const outerReturn = vi.fn(async () => {
      await cleanup.promise; return { done: true as const, value: undefined };
    });
    const childReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    let reads = 0;
    const capture = captureProviderChat({ provider: { chat: () => ({ [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (reads++ !== 0) return outerPending.promise;
        return { done: false, value: { type: 'text', partId: 'pending', index: 0, completeness: completeness.promise, chunks: {
          [Symbol.asyncIterator]: () => ({ next: () => {
            childRead.resolve(); return childPending.promise;
          }, return: childReturn }),
        } } };
      },
      return: outerReturn,
    }) }) }, request: request() });
    await childRead.promise;
    const disposal = capture.dispose();
    await vi.waitFor(() => expect(outerReturn).toHaveBeenCalledOnce());
    expect(capture.snapshot().settlement).toEqual({ status: 'pending' });
    cleanup.resolve();
    await disposal;
    expect(childReturn).toHaveBeenCalledOnce();
    expect(capture.snapshot()).toMatchObject({ result: undefined, settlement: { status: 'disposed' } });
    expect(capture.snapshot().events.at(-1)).toEqual({ kind: 'settled', outcome: 'disposed' });
    const settled = capture.snapshot();
    childPending.resolve({ done: false, value: 'late' });
    outerPending.resolve({ done: false, value: finished });
    completeness.resolve('complete');
    await Promise.resolve();
    expect(capture.snapshot()).toEqual(settled);
  });

  it('does not hide a cleanup failure behind disposal', async () => {
    const pending = Promise.withResolvers<IteratorResult<ChatGenerationItem>>();
    const read = Promise.withResolvers<void>();
    const error = new Error('return failure');
    const capture = captureProviderChat({ provider: { chat: () => ({ [Symbol.asyncIterator]: () => ({
      next: () => {
        read.resolve(); return pending.promise;
      },
      return: async () => {
        throw error;
      },
    }) }) }, request: request() });
    await read.promise;
    await expect(capture.dispose()).rejects.toThrow('Generation consumption and cleanup failed');
    expect(capture.snapshot().settlement).toMatchObject({ status: 'rejected', source: 'cleanup' });
  });

  it('keeps captures independent when an abandoned read resolves after a later call starts', async () => {
    const oldRead = Promise.withResolvers<IteratorResult<ChatGenerationItem>>();
    let calls = 0;
    const provider: Pick<LmProvider, 'chat'> = { chat: () => {
      if (calls++ !== 0) return values({ items: [text({ partId: 'new', index: 0, chunks: ['new text'], completeness: 'complete' }), finished] });
      return { [Symbol.asyncIterator]: () => ({ next: () => oldRead.promise, return: async () => ({ done: true, value: undefined }) }) };
    } };
    const first = captureProviderChat({ provider, request: request() });
    await first.dispose();
    const second = captureProviderChat({ provider, request: request() });
    oldRead.resolve({ done: false, value: text({ partId: 'old', index: 0, chunks: ['old late text'], completeness: 'complete' }) });
    await second.completion;
    expect(first.snapshot().parts).toEqual([]);
    expect(first.snapshot().settlement).toEqual({ status: 'disposed' });
    expect(second.snapshot().parts).toMatchObject([{ partId: 'new', chunks: ['new text'] }]);
  });

  it.each([
    { name: 'an item after the result', items: [finished, text({ partId: 'late', index: 0, chunks: [], completeness: 'complete' })], message: 'followed its final result' },
    { name: 'duplicate logical positions', items: [text({ partId: 'one', index: 0, chunks: [], completeness: 'complete' }), text({ partId: 'two', index: 0, chunks: [], completeness: 'complete' }), finished], message: 'duplicate generated part position' },
    { name: 'successful partial content', items: [text({ partId: 'one', index: 0, chunks: ['partial'], completeness: 'partial' }), finished], message: 'successful generation cannot leave a partial part' },
  ])('uses production protocol checks for $name', async ({ items, message }) => {
    const capture = captureProviderChat({ provider: { chat: () => values({ items }) }, request: request() });
    await expect(capture.completion).rejects.toThrow(message);
    expect(capture.snapshot().settlement).toMatchObject({ status: 'rejected', source: 'protocol' });
  });

  it('does not change a completed result when disposed afterward', async () => {
    const result: ChatGenerationResult = { type: 'finished', next: 'user' };
    const capture = captureProviderChat({ provider: { chat: () => values({ items: [{ type: 'result', result }] }) }, request: request() });
    await capture.completion;
    const snapshot = capture.snapshot();
    await capture.dispose();
    expect(capture.snapshot()).toEqual(snapshot);
  });
});
