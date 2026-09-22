import { describe, expect, it, vi } from 'vitest';
import type { ChatGenerationItem, ToolCallDraft } from '@/01-models/lm';
import type { AssistantMessageNode, ToolCall } from '@/01-models/types';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { consumeChatGeneration } from './consume-chat-generation';
import { createChatGenerationStream } from './create-chat-generation-stream';

function message(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'assistant' }), role: 'assistant', createdAt: 1, parts: [], modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}

function call(): ToolCall {
  return { id: toToolCallId({ raw: 'completed-call' }), type: 'function', function: { name: 'shell', arguments: ' {"script":"echo hello"} ' } };
}

async function* sequence({ items }: { items: ChatGenerationItem[] }): AsyncIterable<ChatGenerationItem> {
  yield* items;
}

describe('transient tool call drafts', () => {
  it('keeps progress outside history and atomically replaces it with the exact completed call', async () => {
    const node = message();
    const snapshots: (readonly ToolCallDraft[])[] = [];
    const persisted: AssistantMessageNode['parts'][] = [];
    const completed = call();
    await consumeChatGeneration({ node, abortController: new AbortController(),
      onChange: () => {
        expect(snapshots.at(-1)).toEqual([]);
        persisted.push(structuredClone(node.parts));
      },
      onToolCallDraftsChange: ({ drafts }) => {
        if (drafts.length !== 0) expect(node.parts).toEqual([]);
        else expect(node.parts).toEqual([{ type: 'tool_call', toolCall: completed }]);
        snapshots.push(drafts);
      },
      items: createChatGenerationStream({ signal: undefined, run: async ({ writer }) => {
        await writer.callDraft({ key: 0, name: undefined, arguments: undefined });
        await writer.callDraft({ key: 0, name: 'shell', arguments: { offset: 0, text: '{"script":"echo' } });
        await writer.callDraft({ key: 0, name: undefined, arguments: { offset: 15, text: ' hello' } });
        await writer.call({ key: 0, toolCall: completed });
        return { type: 'finished', next: 'tool_results' };
      } }),
    });
    expect(snapshots[0]).toEqual([{ partId: 'part_0', index: 0, name: '', arguments: '', beforePartIndex: 0 }]);
    expect(snapshots[2]?.[0]?.arguments).toBe('{"script":"echo hello');
    expect(persisted).toEqual([[{ type: 'tool_call', toolCall: completed }]]);
  });

  it('supports revised partial JSON, explicit truncation, and unchanged fields', async () => {
    const snapshots: string[] = [];
    const onChange = vi.fn();
    await consumeChatGeneration({ node: message(), abortController: new AbortController(), onChange,
      onToolCallDraftsChange: ({ drafts }) => {
        if (drafts[0]) snapshots.push(drafts[0].arguments);
      },
      items: sequence({ items: [
        { type: 'tool_call_draft', partId: 'd', index: 0, name: 'shell', arguments: { offset: 0, text: '{"script":"echo"}' } },
        { type: 'tool_call_draft', partId: 'd', index: 0, name: undefined, arguments: { offset: 15, text: ' hi"}' } },
        { type: 'tool_call_draft', partId: 'd', index: 0, name: undefined, arguments: undefined },
        { type: 'tool_call_draft', partId: 'd', index: 0, name: undefined, arguments: { offset: 10, text: '' } },
        { type: 'result', result: { type: 'interrupted', reason: 'limit' } },
      ] }),
    });
    expect(snapshots).toEqual(['{"script":"echo"}', '{"script":"echo hi"}', '{"script":"echo hi"}', '{"script":']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('places parallel drafts around materialized parts using logical order, including late completion', async () => {
    const node = message();
    const observed: { partId: string, beforePartIndex: number }[][] = [];
    await consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {},
      onToolCallDraftsChange: ({ drafts }) => observed.push(drafts.map(({ partId, beforePartIndex }) => ({ partId, beforePartIndex }))),
      items: createChatGenerationStream({ signal: undefined, run: async ({ writer }) => {
        await writer.callDraft({ key: 0, name: 'first', arguments: undefined });
        await writer.text({ type: 'text', text: 'between' });
        await writer.callDraft({ key: 1, name: 'second', arguments: undefined });
        await writer.call({ key: 0, toolCall: call() });
        return { type: 'interrupted', reason: 'limit' };
      } }),
    });
    expect(observed).toContainEqual([{ partId: 'part_0', beforePartIndex: 0 }, { partId: 'part_2', beforePartIndex: 1 }]);
    expect(observed).toContainEqual([{ partId: 'part_2', beforePartIndex: 2 }]);
    expect(node.parts.map(part => part.type)).toEqual(['tool_call', 'text']);
    expect(observed.at(-1)).toEqual([]);
  });

  it.each([-1, 1, 0.5, Number.NaN])('rejects an invalid argument suffix offset %s and clears the preview', async offset => {
    const snapshots: (readonly ToolCallDraft[])[] = [];
    const node = message();
    await expect(consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {},
      onToolCallDraftsChange: ({ drafts }) => {
        snapshots.push(drafts);
      },
      items: sequence({ items: [
        { type: 'tool_call_draft', partId: 'd', index: 0, name: 'shell', arguments: undefined },
        { type: 'tool_call_draft', partId: 'd', index: 0, name: undefined, arguments: { offset, text: 'x' } },
      ] }),
    })).rejects.toThrow('Invalid tool call draft argument offset');
    expect(snapshots.at(-1)).toEqual([]);
    expect(node.parts).toEqual([]);
  });

  it('rejects a draft that collides with another logical position', async () => {
    await expect(consumeChatGeneration({ node: message(), abortController: new AbortController(), onChange: () => {}, onToolCallDraftsChange: undefined,
      items: sequence({ items: [
        { type: 'tool_call_draft', partId: 'a', index: 0, name: undefined, arguments: undefined },
        { type: 'tool_call_draft', partId: 'b', index: 0, name: undefined, arguments: undefined },
      ] }),
    })).rejects.toThrow('duplicate generated part position');
  });

  it('does not accept a successful result with an unfinished draft', async () => {
    await expect(consumeChatGeneration({ node: message(), abortController: new AbortController(), onChange: () => {}, onToolCallDraftsChange: undefined,
      items: sequence({ items: [
        { type: 'tool_call_draft', partId: 'a', index: 0, name: undefined, arguments: undefined },
        { type: 'result', result: { type: 'finished', next: 'user' } },
      ] }),
    })).rejects.toThrow('unfinished tool call draft');
  });

  it('clears immediately on abort and does not redisplay already queued draft updates', async () => {
    const controller = new AbortController();
    const node = message();
    const snapshots: (readonly ToolCallDraft[])[] = [];
    await consumeChatGeneration({ node, abortController: controller, onChange: () => {},
      onToolCallDraftsChange: ({ drafts }) => {
        snapshots.push(drafts);
        if (drafts.length !== 0) controller.abort();
      },
      items: sequence({ items: [
        { type: 'tool_call_draft', partId: 'a', index: 0, name: 'shell', arguments: undefined },
        { type: 'tool_call_draft', partId: 'a', index: 0, name: undefined, arguments: { offset: 0, text: 'queued' } },
        { type: 'result', result: { type: 'interrupted', reason: 'aborted' } },
      ] }),
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toEqual([]);
    expect(node.parts).toEqual([]);
  });

  it.each(['error-result', 'missing-result', 'iterator-error'] as const)('clears an unfinished preview on %s without saving it', async ending => {
    const fault = new Error('Disconnected');
    const snapshots: (readonly ToolCallDraft[])[] = [];
    const onChange = vi.fn();
    const node = message();
    const items = (async function* (): AsyncGenerator<ChatGenerationItem> {
      yield { type: 'tool_call_draft', partId: 'd', index: 0, name: 'shell', arguments: { offset: 0, text: '{' } };
      switch (ending) {
      case 'error-result': yield { type: 'result', result: { type: 'error', error: fault } }; return;
      case 'missing-result': return;
      case 'iterator-error': throw fault;
      default: { const _ex: never = ending; throw new Error(`Unhandled ending: ${_ex}`); }
      }
    })();
    const pending = consumeChatGeneration({ node, items, abortController: new AbortController(), onChange,
      onToolCallDraftsChange: ({ drafts }) => {
        snapshots.push(drafts);
      },
    });
    switch (ending) {
    case 'error-result': await expect(pending).resolves.toEqual({ type: 'error', error: fault }); break;
    case 'missing-result': await expect(pending).rejects.toThrow('without a result'); break;
    case 'iterator-error': await expect(pending).rejects.toBe(fault); break;
    default: { const _ex: never = ending; throw new Error(`Unhandled ending: ${_ex}`); }
    }
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toEqual([]);
    expect(node.parts).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('bounds a large patch and abandons its blocked producer without leaking a pending write', async () => {
    const cancelled = vi.fn();
    const stream = createChatGenerationStream({ signal: undefined, run: async ({ writer, signal }) => {
      signal.addEventListener('abort', cancelled);
      await writer.callDraft({ key: 0, name: 'shell', arguments: { offset: 0, text: 'x'.repeat(1024 * 1024) } });
      return { type: 'interrupted', reason: 'limit' };
    } });
    const iterator = stream[Symbol.asyncIterator]();
    for (let index = 0; index < 2; index++) {
      const item = (await iterator.next()).value;
      expect(item).toMatchObject({ type: 'tool_call_draft', arguments: { offset: index * 8192 } });
      if (item?.type !== 'tool_call_draft') throw new Error('Expected draft');
      expect(item.arguments?.text).toHaveLength(8192);
    }
    await iterator.return?.();
    expect(cancelled).toHaveBeenCalledOnce();
    expect((await iterator.next()).done).toBe(true);
  });
});
