import { describe, expect, it, vi } from 'vitest';
import { createChatGenerationStream } from './create-chat-generation-stream';
import { consumeChatGeneration } from './consume-chat-generation';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { AssistantMessageNode } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';

function message(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [], interruption: undefined, replies: { items: [] } };
}
async function collect({ items, controller }: { items: ReturnType<LmProvider['chat']>, controller: AbortController }) {
  const node = message();
  const result = await consumeChatGeneration({ node, items, abortController: controller, onChange: () => {} });
  return { node, result };
}
describe('generation stream producer bridge', () => {
  it('starts lazily and keeps literal tags, whitespace, repeated deltas and channel changes', async () => {
    const run = vi.fn(async ({ writer }: Parameters<Parameters<typeof createChatGenerationStream>[0]['run']>[0]) => {
      await writer.text({ type: 'reasoning', text: '  R\n' });
      await writer.text({ type: 'text', text: '<think>example</think>' });
      await writer.text({ type: 'text', text: ' ' }); await writer.text({ type: 'text', text: ' ' });
      await writer.text({ type: 'reasoning', text: 'R2' });
      return { type: 'finished' as const, next: 'user' as const };
    });
    const controller = new AbortController(); const items = createChatGenerationStream({ signal: controller.signal, run });
    expect(run).not.toHaveBeenCalled();
    const { node, result } = await collect({ items, controller });
    expect(node.parts).toEqual([
      { type: 'reasoning', text: '  R\n', completeness: 'complete' },
      { type: 'text', text: '<think>example</think>  ', completeness: 'complete' },
      { type: 'reasoning', text: 'R2', completeness: 'complete' },
    ]);
    expect(result).toEqual({ type: 'finished', next: 'user' });
    expect(() => items[Symbol.asyncIterator]()).toThrow('once');
  });
  it('retains received text and closes partial on upstream failure', async () => {
    const fault = new Error('connection lost'); const controller = new AbortController();
    const { node, result } = await collect({ controller, items: createChatGenerationStream({ signal: controller.signal, run: async ({ writer }) => {
      await writer.text({ type: 'text', text: 'partial' }); throw fault;
    } }) });
    expect(node.parts[0]).toMatchObject({ text: 'partial', completeness: 'partial' });
    expect(result).toEqual({ type: 'error', error: fault });
  });
  it('does not publish drafts and preserves their position before a later completed call', async () => {
    const controller = new AbortController();
    const published: { partId: string, index: number }[] = [];
    const generation = createChatGenerationStream({ signal: undefined, run: async ({ writer }) => {
      writer.reserveCall({ key: 0 }); writer.reserveCall({ key: 1 });
      await writer.call({ key: 1, toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: ' {} ' } } });
      return { type: 'interrupted', reason: 'limit' };
    } });
    const items = (async function* () {
      for await (const item of generation) {
        if (item.type === 'tool_call') published.push({ partId: item.partId, index: item.index });
        yield item;
      }
    })();
    const { node, result } = await collect({ controller, items });
    expect(published).toEqual([{ partId: 'part_1', index: 1 }]);
    expect(node.parts).toHaveLength(1); expect(node.parts[0]).toMatchObject({ toolCall: { function: { arguments: ' {} ' } } });
    expect(result.type).toBe('interrupted');
  });
  it('wakes an aborted pending network operation, draining its accepted content', async () => {
    const controller = new AbortController(); const started = Promise.withResolvers<void>();
    const items = createChatGenerationStream({ signal: controller.signal, run: async ({ writer, signal }) => {
      await writer.text({ type: 'text', text: 'A' }); started.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { type: 'finished', next: 'user' };
    } });
    const pending = collect({ items, controller }); await started.promise; controller.abort();
    const { node, result } = await pending;
    expect(node.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' }); expect(result).toEqual({ type: 'interrupted', reason: 'aborted' });
  });
  it('can discard unread bounded queues without leaving the producer waiting', async () => {
    const cancelled = vi.fn();
    const items = createChatGenerationStream({ signal: undefined, run: async ({ writer, signal }) => {
      signal.addEventListener('abort', cancelled);
      for (let i = 0; i < 50; i++) await writer.text({ type: 'text', text: String(i) });
      return { type: 'finished', next: 'user' };
    } });
    const iterator = items[Symbol.asyncIterator](); const first = await iterator.next();
    expect(first.value.type).toBe('text');
    await iterator.return?.(); expect(cancelled).toHaveBeenCalledOnce();
    expect((await iterator.next()).done).toBe(true);
  });
});
