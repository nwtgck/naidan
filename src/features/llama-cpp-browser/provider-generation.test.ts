import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessageNode } from '@/01-models/types';
import type { ChatGenerationItem, ToolCallDraft } from '@/01-models/lm';
import { toMessageId } from '@/01-models/ids';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { createLlamaCppGeneration, createScopedGeneration } from './provider-generation';
import { chatRequest, deliverNativeResult, finalText } from './test-utils/chat';
import type { GenerationCallback, GenerationEvent, GenerationResult } from './types';
import { LlamaCppBrowserError } from './types';
import type { LlamaCppBrowserService } from './service-contract';

function observation({ items, controller }: { items: AsyncIterable<ChatGenerationItem>, controller: AbortController }) {
  const node: AssistantMessageNode = { id: toMessageId({ raw: 'new' }), role: 'assistant', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
  const drafts: ToolCallDraft[][] = [];
  const onChange = vi.fn();
  const result = consumeChatGeneration({ node, items, abortController: controller, onChange, onToolCallDraftsChange: ({ drafts: current }) => {
    drafts.push(current.map(draft => ({ ...draft })));
  } });
  return { node, result, drafts, onChange };
}
function source({ generate, controller }: { generate: LlamaCppBrowserService['generate'], controller: AbortController }) {
  return createLlamaCppGeneration({ request: { ...chatRequest(), signal: controller.signal }, generate });
}
const call = { id: 'call1', type: 'function' as const, function: { name: 'lookup', arguments: ' {"x": "\\u3042"} ' } };
const called = (): GenerationResult => ({ ...finalText({ text: '' }), toolCalls: [call] });
describe('native llama.cpp events into common parts', () => {
  it('keeps parallel native previews transient and replaces them only with authoritative completed calls', async () => {
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    let waiting = false;
    const secondCall = { ...call, id: 'call2', function: { name: 'second', arguments: '{"b":2}' } };
    const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      for (const event of [
        { type: 'tool_call_start', index: 0 },
        { type: 'tool_call_start', index: 1 },
        { type: 'tool_call_draft', index: 1, name: 'second', arguments: { offset: 0, text: '{"b":' } },
        { type: 'tool_call_draft', index: 0, name: 'lookup', arguments: { offset: 0, text: '{"x":"old"}' } },
        { type: 'tool_call_draft', index: 0, name: undefined, arguments: { offset: 6, text: 'new' } },
      ] satisfies GenerationEvent[]) await onEvent({ event });
      waiting = true;
      await gate.promise;
      await onEvent({ event: { type: 'tool_call', index: 0, toolCall: call } });
      await onEvent({ event: { type: 'tool_call', index: 1, toolCall: secondCall } });
      return { ...called(), toolCalls: [call, secondCall] };
    };
    const observed = observation({ items: source({ generate, controller }), controller });
    try {
      await vi.waitFor(() => {
        expect(waiting).toBe(true);
        expect(observed.drafts.at(-1)?.map(draft => [draft.index, draft.name, draft.arguments])).toEqual([
          [0, 'lookup', '{"x":"new'], [1, 'second', '{"b":'],
        ]);
      });
      expect(observed.node.parts).toEqual([]);
      expect(observed.onChange).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
    }
    expect(await observed.result).toEqual({ type: 'finished', next: 'tool_results' });
    expect(observed.node.parts).toEqual([{ type: 'tool_call', toolCall: call }, { type: 'tool_call', toolCall: secondCall }]);
    expect(observed.drafts.at(-1)).toEqual([]);
  });

  it.each(['length', 'aborted', 'error'] as const)('discards an incomplete native preview on %s without writing it into history', async termination => {
    const controller = new AbortController();
    const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      await onEvent({ event: { type: 'tool_call_start', index: 0 } });
      await onEvent({ event: { type: 'tool_call_draft', index: 0, name: 'lookup', arguments: { offset: 0, text: '{"x":' } } });
      if (termination === 'aborted') controller.abort();
      if (termination === 'error') throw new Error('Native generation failed');
      return { ...called(), finishReason: 'length' };
    };
    const observed = observation({ items: source({ generate, controller }), controller });
    expect((await observed.result).type).toBe(termination === 'error' ? 'error' : 'interrupted');
    expect(observed.node.parts).toEqual([]);
    expect(observed.onChange).not.toHaveBeenCalled();
    expect(observed.drafts.at(-1)).toEqual([]);
  });

  it.each(['before reservation', 'after completion', 'invalid patch offset'] as const)('rejects a native preview %s', async defect => {
    const controller = new AbortController();
    const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      if (defect === 'after completion') await deliverNativeResult({ result: called(), onEvent });
      if (defect === 'invalid patch offset') await onEvent({ event: { type: 'tool_call_start', index: 0 } });
      await onEvent({ event: { type: 'tool_call_draft', index: 0, name: 'lookup', arguments: { offset: 5, text: 'x' } } });
      return called();
    };
    const observed = observation({ items: source({ generate, controller }), controller });
    if (defect === 'invalid patch offset') await expect(observed.result).rejects.toThrow('Invalid tool call draft argument offset');
    else expect((await observed.result).type).toBe('error');
    expect(observed.node.parts).toHaveLength(defect === 'after completion' ? 1 : 0);
  });

  it('keeps reasoning separate, with raw text tags, whitespace, and repeated deltas unchanged', async () => {
    const controller = new AbortController();
    const generate = vi.fn<LlamaCppBrowserService['generate']>(async ({ onEvent }) => {
      for (const event of [{ type: 'reasoning', text: ' R\n' }, { type: 'text', text: '<think>literal</think> ' }, { type: 'text', text: ' ' }] satisfies GenerationEvent[]) await onEvent({ event });
      return { ...finalText({ text: '<think>literal</think>  ' }), reasoningContent: ' R\n' };
    });
    const { node, result } = observation({ items: source({ generate, controller }), controller });
    expect(await result).toEqual({ type: 'finished', next: 'user' });
    expect(node.parts).toEqual([{ type: 'reasoning', text: ' R\n', completeness: 'complete' }, { type: 'text', text: '<think>literal</think>  ', completeness: 'complete' }]);
  });
  it.each(['length', 'stop_sequence'] as const)('retains partial text after native %s', async finishReason => {
    const controller = new AbortController();const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => deliverNativeResult({ result: { ...finalText({ text: ' 途中\n' }), finishReason }, onEvent });
    const { node, result } = observation({ items: source({ generate, controller }), controller });
    expect(await result).toEqual({ type: 'interrupted', reason: finishReason === 'length' ? 'limit' : 'stop_sequence' });
    expect(node.parts[0]).toMatchObject({ text: ' 途中\n', completeness: 'partial' });
  });
  it('does not treat a final native result as undelivered content', async () => {
    const controller = new AbortController(); const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'accepted' } });return finalText({ text: 'accepted but not sent' });
    };
    const { node, result } = observation({ items: source({ generate, controller }), controller });
    expect((await result).type).toBe('error');expect(node.parts[0]).toMatchObject({ text: 'accepted', completeness: 'partial' });
  });
  it('retains a completed call delivered before a cancelled RPC rejects', async () => {
    const controller = new AbortController();const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      await deliverNativeResult({ result: called(), onEvent });controller.abort();throw new LlamaCppBrowserError({ code: 'aborted' });
    };
    const { node, result } = observation({ items: source({ generate, controller }), controller });
    expect(await result).toEqual({ type: 'interrupted', reason: 'aborted' });
    expect(node.parts[0]).toMatchObject({ type: 'tool_call', toolCall: call });
  });
  it('keeps a prior complete call and unrepresentable subsequent text but rejects tool execution', async () => {
    const controller = new AbortController(); const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      await deliverNativeResult({ result: called(), onEvent });await onEvent({ event: { type: 'text', text: 'after call' } });return { ...called(), content: 'after call' };
    };
    const { node, result } = observation({ items: source({ generate, controller }), controller });
    expect((await result).type).toBe('error');expect(node.parts.map(p => p.type)).toEqual(['tool_call', 'text']);expect(node.parts[1]).toMatchObject({ text: 'after call', completeness: 'partial' });
  });
  it('preserves a later reasoning block without flattening it into the first reasoning', async () => {
    const controller = new AbortController();const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      for (const event of [{ type: 'reasoning', text: 'R' }, { type: 'text', text: 'A' }, { type: 'reasoning', text: 'S' }] satisfies GenerationEvent[]) await onEvent({ event });
      return { ...finalText({ text: 'A' }), reasoningContent: 'RS' };
    };
    const { node, result } = observation({ items: source({ generate, controller }), controller });expect((await result).type).toBe('error');expect(node.parts.map(p => p.type)).toEqual(['reasoning', 'text', 'reasoning']);
  });
  it.each(['missing reservation', 'duplicate call', 'result only'] as const)('rejects %s instead of fabricating completed calls', async defect => {
    const controller = new AbortController();const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      switch (defect) {
      case 'missing reservation': await onEvent({ event: { type: 'tool_call', index: 0, toolCall: call } }); break;
      case 'duplicate call': await deliverNativeResult({ result: called(), onEvent });await onEvent({ event: { type: 'tool_call', index: 0, toolCall: call } });break;
      case 'result only': break;
      default: { const exhaustive: never = defect; throw new Error(`Unknown defect: ${exhaustive}`); }
      }
      return called();
    };
    const { node, result } = observation({ items: source({ generate, controller }), controller });expect((await result).type).toBe('error');expect(node.parts).toHaveLength(defect === 'duplicate call' ? 1 : 0);
  });
  it('does not seal an unfinished call after a length limit', async () => {
    const controller = new AbortController(); const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'before' } });await onEvent({ event: { type: 'tool_call_start', index: 0 } });
      return { ...called(), content: 'before', finishReason: 'length' };
    };
    const { node, result } = observation({ items: source({ generate, controller }), controller });expect((await result).type).toBe('interrupted');expect(node.parts.map(p => p.type)).toEqual(['text']);
  });
  it('does not release the operation on an event before the native request completes', async () => {
    const gate = Promise.withResolvers<void>();let entered = false;const controller = new AbortController();
    const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      await deliverNativeResult({ result: finalText({ text: 'A' }), onEvent });entered = true;await gate.promise;return finalText({ text: 'A' });
    };
    const { node, result } = observation({ items: source({ generate, controller }), controller });let settled = false;void result.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(entered).toBe(true));expect(settled).toBe(false);expect(node.parts[0]).toMatchObject({ completeness: 'partial' });gate.resolve();await result;expect(settled).toBe(true);
  });
});

describe('local operation and child lifetime', () => {
  const generate: LlamaCppBrowserService['generate'] = async ({ onEvent }) => deliverNativeResult({ result: finalText({ text: 'A' }), onEvent });
  it('freezes request content before delayed consumption', async () => {
    const native = vi.fn<LlamaCppBrowserService['generate']>(generate);const controller = new AbortController();const scoped = createScopedGeneration({ scope: { generate: native, signal: controller.signal } });
    const request = chatRequest(); const items = scoped.chat(request);
    const part = request.messages[0]?.parts[0];if (part?.type === 'text') part.text = 'changed';
    await observation({ items, controller }).result;expect(native.mock.calls[0]?.[0].input.messages[0]?.content).toBe('hello');await scoped.close();
  });
  it('rejects an escaped method and iterable after the operation closes', async () => {
    const scoped = createScopedGeneration({ scope: { generate, signal: new AbortController().signal } });const escaped = scoped.chat(chatRequest());await scoped.close();
    expect(() => scoped.chat(chatRequest())).toThrow('closed');expect(() => escaped[Symbol.asyncIterator]()).toThrow('closed');
  });
  it('drains accepted partial content on an owner abort even without a caller signal', async () => {
    const owner = new AbortController();const native: LlamaCppBrowserService['generate'] = async ({ onEvent, signal }) => {
      await onEvent({ event: { type: 'text', text: 'A' } });owner.abort();expect(signal?.aborted).toBe(true);await onEvent({ event: { type: 'text', text: 'B' } });throw new LlamaCppBrowserError({ code: 'aborted' });
    };
    const scoped = createScopedGeneration({ scope: { generate: native, signal: owner.signal } });const { node, result } = observation({ items: scoped.chat(chatRequest()), controller: new AbortController() });
    expect(await result).toEqual({ type: 'interrupted', reason: 'aborted' });expect(node.parts[0]).toMatchObject({ text: 'AB', completeness: 'partial' });await scoped.close();
  });
  it('does not start a queued generation after owner cancellation', async () => {
    const native = vi.fn<LlamaCppBrowserService['generate']>(generate);const scoped = createScopedGeneration({ scope: { generate: native, signal: AbortSignal.abort() } });
    expect(await observation({ items: scoped.chat(chatRequest()), controller: new AbortController() }).result).toEqual({ type: 'interrupted', reason: 'aborted' });expect(native).not.toHaveBeenCalled();await scoped.close();
  });
  it('rejects concurrent generations until all children of the first are read', async () => {
    const native = vi.fn<LlamaCppBrowserService['generate']>(generate);const scoped = createScopedGeneration({ scope: { generate: native, signal: new AbortController().signal } });
    const first = scoped.chat(chatRequest())[Symbol.asyncIterator]();const initial = await first.next();
    const second = scoped.chat(chatRequest())[Symbol.asyncIterator]();await expect(second.next()).rejects.toThrow('already');await second.return?.();
    await first.next();expect((await first.next()).done).toBe(true);
    const third = scoped.chat(chatRequest())[Symbol.asyncIterator]();await expect(third.next()).rejects.toThrow('already');await third.return?.();
    if (initial.done || (initial.value.type !== 'text' && initial.value.type !== 'reasoning')) throw new Error('Expected text');
    let text = '';for await (const value of initial.value.chunks) text += value;expect(text).toBe('A');
    expect((await first.next()).done).toBe(true);
    const { result } = observation({ items: scoped.chat(chatRequest()), controller: new AbortController() });await result;expect(native).toHaveBeenCalledTimes(2);await scoped.close();
  });
  it('closes unread children and waits for the associated producer cleanup without draining the queue', async () => {
    let stopped = false;let generationSignal: AbortSignal | undefined;
    const native: LlamaCppBrowserService['generate'] = async ({ onEvent, signal }) => {
      generationSignal = signal;
      try {
        for (let i = 0; i < 40; i++) await onEvent({ event: { type: 'text', text: 'A' } });return finalText({ text: 'A'.repeat(40) });
      } finally {
        stopped = true;
      }
    };
    const scoped = createScopedGeneration({ scope: { generate: native, signal: new AbortController().signal } });
    const reader = scoped.chat(chatRequest())[Symbol.asyncIterator]();const item = await reader.next();expect(item.done).toBe(false);expect(stopped).toBe(false);
    await scoped.close();expect(stopped).toBe(true);expect(generationSignal?.aborted).toBe(true);
    if (item.done || (item.value.type !== 'text' && item.value.type !== 'reasoning')) throw new Error('Expected text');
    expect(await item.value.completeness).toBe('partial');
  });
  it('retired callback writes cannot alter a subsequent generation', async () => {
    let send: GenerationCallback | undefined;let count = 0;
    const native: LlamaCppBrowserService['generate'] = async ({ onEvent }) => {
      send = onEvent;return deliverNativeResult({ result: finalText({ text: String(++count) }), onEvent });
    };
    const scoped = createScopedGeneration({ scope: { generate: native, signal: new AbortController().signal } });
    await observation({ items: scoped.chat(chatRequest()), controller: new AbortController() }).result;
    const old = send!;await expect(old({ event: { type: 'text', text: 'late' } })).rejects.toThrow();
    const current = observation({ items: scoped.chat(chatRequest()), controller: new AbortController() });await current.result;expect(current.node.parts[0]).toMatchObject({ text: '2' });await scoped.close();
  });
});
