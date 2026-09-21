import { describe, expect, it, vi } from 'vitest';
import { consumeChatGeneration } from './consume-chat-generation';
import type { AssistantMessageNode } from '@/01-models/types';
import type { ChatGenerationItem, ChatGenerationResult } from '@/01-models/lm';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';

function fresh(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'new' }), role: 'assistant', createdAt: 4, parts: [], modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}
async function* strings({ chunks }: { chunks: string[] }): AsyncGenerator<string, void, void> {
  yield* chunks;
}
async function* sequence({ items }: { items: ChatGenerationItem[] }): AsyncGenerator<ChatGenerationItem, void, void> {
  yield* items;
}
function part({ id, index, type, text, completeness }: { id: string, index: number, type: 'text' | 'reasoning', text: string[], completeness: 'complete' | 'partial' }): Extract<ChatGenerationItem, { type: 'text' | 'reasoning' }> {
  return { type, partId: id, index, chunks: strings({ chunks: text }), completeness: Promise.resolve(completeness) };
}
function completed(): Extract<ChatGenerationItem, { type: 'result' }> {
  return { type: 'result', result: { type: 'finished', next: 'user' } };
}
function call(): Extract<ChatGenerationItem, { type: 'tool_call' }> {
  return { type: 'tool_call', partId: 'call', index: 3, toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'f', arguments: ' {"x":1} ' } } };
}
function consume({ node, items, onChange, abortController }: { node: AssistantMessageNode, items: AsyncIterable<ChatGenerationItem>, onChange: () => void | Promise<void>, abortController: AbortController }) {
  return consumeChatGeneration({ node, items, onChange, abortController });
}

describe('consume nested chat generation', () => {
  it('retains text tags, Unicode chunks, empty parts, and separate reasoning without normalization', async () => {
    const node = fresh();
    await consume({ node, items: sequence({ items: [
      part({ id: 'r', index: 0, type: 'reasoning', text: ['  理由\n', ' '], completeness: 'complete' }),
      part({ id: 'e', index: 1, type: 'text', text: [], completeness: 'complete' }),
      part({ id: 't', index: 2, type: 'text', text: ['<thi', 'nk>literal</think>', '\ud83d', '\ude42'], completeness: 'complete' }), completed(),
    ] }), abortController: new AbortController(), onChange: () => {} });
    expect(createChatMessageSnapshot({ node }).parts).toEqual([
      { id: 'r', type: 'reasoning', text: '  理由\n ', completeness: 'complete' },
      { id: 'e', type: 'text', text: '', completeness: 'complete' },
      { id: 't', type: 'text', text: '<think>literal</think>🙂', completeness: 'complete' },
    ]);
  });

  it('drives later children while an earlier child waits for their consumption', async () => {
    const nextChild = Promise.withResolvers<void>();
    const node = fresh();
    const first = part({ id: 'first', index: 0, type: 'reasoning', text: [], completeness: 'complete' });
    first.chunks = (async function* () {
      yield 'A'; await nextChild.promise; yield 'C';
    })();
    const second = part({ id: 'second', index: 1, type: 'text', text: [], completeness: 'complete' });
    second.chunks = (async function* () {
      yield 'B'; nextChild.resolve();
    })();
    await consume({ node, items: sequence({ items: [first, second, completed()] }), abortController: new AbortController(), onChange: () => {} });
    expect(node.parts).toMatchObject([{ text: 'AC' }, { text: 'B' }]);
  });

  it('waits for pending child contents and acknowledgments even after the outer result', async () => {
    const release = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
    const node = fresh(); const item = part({ id: 'p', index: 0, type: 'text', text: [], completeness: 'complete' });
    item.chunks = (async function* () {
      yield 'A'; await release.promise; yield 'B';
    })();
    let completedRun = false;
    const running = consume({ node, items: sequence({ items: [item, completed()] }), abortController: new AbortController(), onChange: () => {
      if (JSON.stringify(node.parts).includes('"A"')) started.resolve();
    } }).then(value => {
      completedRun = true; return value;
    });
    await started.promise;
    expect(node.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' }); expect(completedRun).toBe(false);
    release.resolve(); await running;
    expect(node.parts[0]).toMatchObject({ text: 'AB', completeness: 'complete' });
  });

  it('serializes async history notifications from parallel children', async () => {
    const node = fresh(); let active = 0; let maximum = 0;
    const onChange = async () => {
      active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--;
    };
    const items = Array.from({ length: 6 }, (_, index) => part({ id: String(index), index, type: 'text', text: ['A', 'B'], completeness: 'complete' }));
    await consume({ node, items: sequence({ items: [...items, completed()] }), abortController: new AbortController(), onChange });
    expect(maximum).toBe(1); expect(node.parts).toHaveLength(6);
  });

  it('drains accepted content and completed calls after an ordinary user stop', async () => {
    const node = fresh(); const controller = new AbortController();
    const cancelled: ChatGenerationItem = { type: 'result', result: { type: 'interrupted', reason: 'aborted' } };
    const result = await consume({ node, items: sequence({ items: [part({ id: 'p', index: 0, type: 'text', text: ['A', 'B'], completeness: 'partial' }), call(), cancelled] }), abortController: controller, onChange: () => {
      controller.abort();
    } });
    expect(result).toEqual(cancelled.result);
    expect(node.parts).toMatchObject([{ text: 'AB', completeness: 'partial' }, { type: 'tool_call' }]);
    expect(node.interruption).toBeUndefined();
  });

  it.each<ChatGenerationResult>([
    { type: 'interrupted', reason: 'aborted' },
    { type: 'interrupted', reason: 'limit' },
    { type: 'interrupted', reason: 'stop_sequence' },
    { type: 'interrupted', reason: 'unknown' },
    { type: 'error', error: new Error('offline') },
  ])('preserves partial text for a normal non-success result $type', async result => {
    const node = fresh();
    const value = await consume({ node, items: sequence({ items: [part({ id: 'p', index: 0, type: 'text', text: ['partial'], completeness: 'partial' }), { type: 'result', result }] }), abortController: new AbortController(), onChange: () => {} });
    expect(value).toEqual(result); expect(node.parts[0]).toMatchObject({ text: 'partial', completeness: 'partial' });
  });

  it('keeps no parts when cancellation occurs before the first content', async () => {
    const node = fresh(); const result: ChatGenerationResult = { type: 'interrupted', reason: 'aborted' };
    expect(await consume({ node, items: sequence({ items: [{ type: 'result', result }] }), abortController: new AbortController(), onChange: () => {} })).toEqual(result);
    expect(node.parts).toEqual([]);
  });

  it('rejects partial success while retaining what was already received', async () => {
    const node = fresh();
    await expect(consume({ node, items: sequence({ items: [part({ id: 'p', index: 0, type: 'text', text: ['A'], completeness: 'partial' }), completed()] }), abortController: new AbortController(), onChange: () => {} })).rejects.toThrow('partial');
    expect(node.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' });
  });

  it('does not execute calls and checks the required next action', async () => {
    const node = fresh();
    expect(await consume({ node, items: sequence({ items: [call(), { type: 'result', result: { type: 'finished', next: 'tool_results' } }] }), abortController: new AbortController(), onChange: () => {} })).toEqual({ type: 'finished', next: 'tool_results' });
    expect(node.parts[0]).toMatchObject({ toolCall: { function: { arguments: ' {"x":1} ' } } });
    await expect(consume({ node: fresh(), items: sequence({ items: [{ type: 'result', result: { type: 'finished', next: 'tool_results' } }] }), abortController: new AbortController(), onChange: () => {} })).rejects.toThrow('without a completed call');
  });

  it('copies result metadata before the producer reuses it', async () => {
    const result = completed();
    const items = (async function* () {
      yield result; result.result = { type: 'error', error: new Error('later') };
    })();
    expect(await consume({ node: fresh(), items, abortController: new AbortController(), onChange: () => {} })).toEqual({ type: 'finished', next: 'user' });
  });

  it('rejects EOF without a result and duplicate final results', async () => {
    for (const items of [[], [completed(), completed()]]) {
      const controller = new AbortController();
      await expect(consume({ node: fresh(), items: sequence({ items }), abortController: controller, onChange: () => {} })).rejects.toThrow(/without a result|followed its final result/);
      expect(controller.signal.aborted).toBe(true);
    }
  });

  it('fails a duplicate part and stops cooperative producers', async () => {
    const controller = new AbortController(); const node = fresh(); let outerClosed = false;
    const items = (async function* () {
      try {
        yield part({ id: 'p', index: 0, type: 'text', text: ['A'], completeness: 'complete' });
        yield part({ id: 'p', index: 1, type: 'text', text: ['B'], completeness: 'complete' });
        await new Promise<void>(resolve => {
          if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        outerClosed = true;
      }
    })();
    await expect(consume({ node, items, abortController: controller, onChange: () => {} })).rejects.toThrow('Duplicate');
    expect(outerClosed).toBe(true); expect(node.parts).toHaveLength(1);
  });

  it('does not turn an observer exception into a model error result', async () => {
    const fault = new Error('render failed'); const node = fresh(); const controller = new AbortController(); let childClosed = false;
    const item = part({ id: 'p', index: 0, type: 'text', text: [], completeness: 'complete' });
    item.chunks = (async function* () {
      try {
        yield 'A'; yield 'B';
      } finally {
        childClosed = true;
      }
    })();
    await expect(consume({ node, items: sequence({ items: [item, completed()] }), abortController: controller, onChange: () => {
      if (JSON.stringify(node.parts).includes('"A"')) throw fault;
    } })).rejects.toBe(fault);
    expect(controller.signal.aborted).toBe(true); expect(childClosed).toBe(true);
    expect(node.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' });
  });

  it('owns early completeness rejection and unblocks a pending cooperative child', async () => {
    const fault = new Error('worker gone'); const controller = new AbortController(); const completion = Promise.withResolvers<'complete' | 'partial'>();
    const node = fresh(); const item = part({ id: 'p', index: 0, type: 'text', text: [], completeness: 'complete' });
    item.completeness = completion.promise;
    item.chunks = (async function* () {
      yield 'A'; completion.reject(fault);
      await new Promise<void>(resolve => {
        if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })();
    await expect(consume({ node, items: sequence({ items: [item, completed()] }), abortController: controller, onChange: () => {} })).rejects.toBe(fault);
    expect(controller.signal.aborted).toBe(true); expect(node.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' });
  });

  it('preserves consumer and cleanup failures separately', async () => {
    const fault = new Error('apply'); const cleanup = new Error('close');
    const item = part({ id: 'p', index: 0, type: 'text', text: [], completeness: 'complete' });
    item.chunks = { [Symbol.asyncIterator]() {
      return { next: async () => ({ value: 'A', done: false }), return: async () => {
        throw cleanup;
      } };
    } };
    const node = fresh();
    const running = consume({ node, items: sequence({ items: [item, completed()] }), abortController: new AbortController(), onChange: () => {
      throw fault;
    } });
    await expect(running).rejects.toMatchObject({ errors: [fault, cleanup] });
  });

  it('captures child routing at receipt rather than later after asynchronous updates', async () => {
    const item = part({ id: 'p', index: 0, type: 'text', text: ['A'], completeness: 'complete' });
    const items = (async function* () {
      yield item; item.partId = 'mutated'; item.index = 99; yield completed();
    })();
    const node = fresh(); await consume({ node, items, abortController: new AbortController(), onChange: vi.fn() });
    expect(node.parts[0]?.id).toBe('p');
  });
});
