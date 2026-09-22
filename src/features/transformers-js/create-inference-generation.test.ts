import { describe, expect, it, vi } from 'vitest';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { AssistantMessageNode } from '@/01-models/types';
import type { InferenceGenerationCallback, InferenceGenerationEvent } from './generation-events';
import { createInferenceGeneration } from './create-inference-generation';
import { createGptOssGeneration } from './models/gpt-oss-generation';
import { createInferenceEventDelivery } from './worker/inference-event-delivery';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';

const done: InferenceGenerationEvent = { type: 'result', result: { type: 'finished', next: 'user' } };
const interrupted: InferenceGenerationEvent = { type: 'result', result: { type: 'interrupted', reason: 'aborted' } };
function fresh(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'new' }), role: 'assistant', createdAt: 1, modelId: undefined,
    lmParameters: undefined, parts: [], interruption: undefined, replies: { items: [] } };
}
async function run({ events }: { events: InferenceGenerationEvent[] }) {
  const node = fresh(); const controller = new AbortController();
  const result = await consumeChatGeneration({ node, abortController: controller, onChange: () => {},
    items: createInferenceGeneration({ signal: controller.signal, generate: async ({ onEvent }) => {
      for (const event of events) await onEvent({ event });
    } }),
  });
  return { node, result };
}

describe('native events to local nested parts', () => {
  it('keeps same-kind boundaries, empty text and literal tags', async () => {
    const { node, result } = await run({ events: [
      { type: 'part_start', index: 0, kind: 'reasoning' }, { type: 'text_delta', index: 0, text: '  R\n' }, { type: 'part_end', index: 0, completeness: 'complete' },
      { type: 'part_start', index: 1, kind: 'reasoning' }, { type: 'text_delta', index: 1, text: 'R2' }, { type: 'part_end', index: 1, completeness: 'complete' },
      { type: 'part_start', index: 2, kind: 'text' }, { type: 'part_end', index: 2, completeness: 'complete' },
      { type: 'part_start', index: 3, kind: 'text' }, { type: 'text_delta', index: 3, text: '<think>literal</think>🙂  ' }, { type: 'part_end', index: 3, completeness: 'complete' }, done,
    ] });
    expect(result).toEqual(done.type === 'result' ? done.result : undefined);
    expect(node.parts).toMatchObject([
      { type: 'reasoning', text: '  R\n' }, { type: 'reasoning', text: 'R2' },
      { type: 'text', text: '' }, { type: 'text', text: '<think>literal</think>🙂  ' },
    ]);
  });
  it('keeps partial separate from already closed content', async () => {
    const { node, result } = await run({ events: [
      { type: 'part_start', index: 0, kind: 'reasoning' }, { type: 'part_end', index: 0, completeness: 'complete' },
      { type: 'part_start', index: 1, kind: 'text' }, { type: 'text_delta', index: 1, text: '途中' }, { type: 'part_end', index: 1, completeness: 'partial' }, interrupted,
    ] });
    expect(result.type).toBe('interrupted'); expect(node.parts).toMatchObject([{ completeness: 'complete' }, { text: '途中', completeness: 'partial' }]);
  });
  it('reserves drafts without publishing them and does not lose a later completed call', async () => {
    const { node } = await run({ events: [
      { type: 'tool_start', index: 0 }, { type: 'tool_start', index: 1 },
      { type: 'tool_call', index: 1, toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'f', arguments: ' {"a": 1} ' } } }, interrupted,
    ] });
    expect(node.parts).toHaveLength(1); expect(node.parts[0]).toMatchObject({ type: 'tool_call', toolCall: { function: { arguments: ' {"a": 1} ' } } });
  });
  it.each([
    [{ type: 'part_start', index: 1, kind: 'text' }],
    [{ type: 'text_delta', index: 0, text: 'orphan' }],
    [{ type: 'part_end', index: 0, completeness: 'complete' }],
    [done, done],
    [{ type: 'result', result: { type: 'finished', next: 'tool_results' } }],
    [{ type: 'tool_start', index: 0 }, done],
    [{ type: 'part_start', index: 0, kind: 'text' }, done],
    [{ type: 'part_start', index: 0, kind: 'text' }, { type: 'part_start', index: 1, kind: 'reasoning' }],
    [{ type: 'part_start', index: 0, kind: 'text' }, { type: 'part_end', index: 0, completeness: 'partial' }, done],
    [],
  ] satisfies InferenceGenerationEvent[][])('reports malformed native ordering without inventing a success: %j', async (...events) => {
    const { result } = await run({ events }); expect(result.type).toBe('error');
  });
  it('waits for the underlying generation settlement after its result event', async () => {
    const release = Promise.withResolvers<void>(); const emitted = Promise.withResolvers<void>(); const node = fresh();
    const controller = new AbortController(); let settled = false;
    const pending = consumeChatGeneration({ node, abortController: controller, onChange: () => {}, items: createInferenceGeneration({ signal: controller.signal, generate: async ({ onEvent }) => {
      await onEvent({ event: done }); emitted.resolve(); await release.promise;
    } }) }).then(result => {
      settled = true; return result;
    });
    await emitted.promise; expect(settled).toBe(false); release.resolve(); expect((await pending).type).toBe('finished');
  });
  it('retains an RPC failure even after a native completion', async () => {
    const error = new Error('delivery failed'); const node = fresh();
    const result = await consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {}, items: createInferenceGeneration({ signal: undefined, generate: async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', kind: 'text', index: 0 } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: 'A' } });
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
      await onEvent({ event: done }); throw error;
    } }) });
    expect(result).toEqual({ type: 'error', error }); expect(node.parts[0]).toMatchObject({ text: 'A', completeness: 'complete' });
  });
  it('drains accepted output when a real stop signal reaches the source', async () => {
    const controller = new AbortController(); const entered = Promise.withResolvers<void>(); const node = fresh();
    const pending = consumeChatGeneration({ node, abortController: controller, onChange: () => {}, items: createInferenceGeneration({ signal: controller.signal, generate: async ({ onEvent, signal }) => {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: 'A' } });
      const stopped = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      entered.resolve(); await stopped;
      await onEvent({ event: { type: 'text_delta', index: 0, text: 'B' } });
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'partial' } });
      await onEvent({ event: interrupted });
    } }) });
    await entered.promise; controller.abort(); await pending;
    expect(node.parts[0]).toMatchObject({ text: 'AB', completeness: 'partial' });
  });
  it('ignores callbacks after their generation returned', async () => {
    let escaped: InferenceGenerationCallback | undefined; const node = fresh();
    await consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {}, items: createInferenceGeneration({ signal: undefined, generate: async ({ onEvent }) => {
      escaped = onEvent; await onEvent({ event: done });
    } }) });
    await escaped!({ event: { type: 'part_start', index: 0, kind: 'text' } }); expect(node.parts).toEqual([]);
  });
  it('connects the native Harmony decoder through bounded delivery to common parts', async () => {
    const node = fresh(); const failure = vi.fn();
    const result = await consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {}, items: createInferenceGeneration({ signal: undefined, generate: async ({ onEvent }) => {
      const delivery = createInferenceEventDelivery({ onEvent, onFailure: failure });
      const native = createGptOssGeneration({ emit: ({ event }) => delivery.enqueue({ event }) });
      native.control({ token: '<|channel|>' }); native.text({ text: 'analysis' }); native.control({ token: '<|message|>' }); native.text({ text: ' R\n' }); native.control({ token: '<|end|>' });
      native.control({ token: '<|start|>' }); native.text({ text: 'assistant to=functions.f' }); native.control({ token: '<|channel|>' }); native.text({ text: 'commentary' }); native.control({ token: '<|message|>' }); native.text({ text: ' {"a": 1} ' }); native.control({ token: '<|call|>' }); native.finish({ reason: 'unknown' });
      await delivery.finish();
    } }) });
    expect(result).toEqual({ type: 'finished', next: 'tool_results' }); expect(failure).not.toHaveBeenCalled();
    expect(node.parts).toMatchObject([{ type: 'reasoning', text: ' R\n', completeness: 'complete' }, { type: 'tool_call', toolCall: { function: { name: 'f', arguments: ' {"a": 1} ' } } }]);
  });
});
