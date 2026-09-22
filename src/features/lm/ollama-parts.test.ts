import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OllamaProvider } from './ollama';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { AssistantMessageNode, ChatMessage } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import { useGlobalEvents } from '@/composables/useGlobalEvents';

async function run({ records, messages }: { records: readonly unknown[], messages: readonly ChatMessage[] }) {
  const payload = records.map(record => JSON.stringify(record)).join('\n');
  const fetcher = vi.fn(async () => new Response(payload));
  const provider: LmProvider = new OllamaProvider({ endpoint: 'https://example.invalid', fetcher });
  const controller = new AbortController();
  const node: AssistantMessageNode = { id: toMessageId({ raw: 'a' }), role: 'assistant', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
  const result = await consumeChatGeneration({ onToolCallDraftsChange: undefined, node, items: provider.chat({ debug: undefined, messages, model: 'm', parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: controller.signal }), abortController: controller, onChange: () => {} });
  return { node, result, fetcher };
}

describe('Ollama structured generation contract', () => {
  beforeEach(() => useGlobalEvents().clearEvents());
  it('separates structured thinking but leaves literal text tags unchanged', async () => {
    const { node, result } = await run({ messages: [], records: [
      { message: { thinking: '  理由\n', content: '<think>literal</think>' } },
      { done: true, done_reason: 'stop', message: { content: '\n回答' } },
    ] });
    expect(node.parts).toMatchObject([{ type: 'reasoning', text: '  理由\n', completeness: 'complete' }, { type: 'text', text: `\
<think>literal</think>
回答`, completeness: 'complete' }]);
    expect(result).toEqual({ type: 'finished', next: 'user' });
  });
  it('does not deduplicate identical consecutive thinking or text deltas', async () => {
    const { node } = await run({ messages: [], records: [{ message: { thinking: ' ' } }, { message: { thinking: ' ' } }, { message: { content: 'A' } }, { message: { content: 'A' }, done: true }] });
    expect(node.parts).toMatchObject([{ text: '  ' }, { text: 'AA' }]);
  });
  it('gives completed calls without server IDs distinct stable IDs and makes one request', async () => {
    const { node, result, fetcher } = await run({ messages: [], records: [{ message: { tool_calls: [{ function: { name: 'f', arguments: { n: 1 } } }, { function: { name: 'g', arguments: ' {"n": 2} ' } }] }, done: true }] });
    const calls = node.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
    expect(calls).toHaveLength(2); expect(calls[0]!.id).not.toBe(calls[1]!.id);
    expect(calls.map(call => call.function.arguments)).toEqual(['{"n":1}', ' {"n": 2} ']);
    expect(result).toEqual({ type: 'finished', next: 'tool_results' }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('preserves an already completed call even when a later line fails', async () => {
    const { node, result } = await run({ messages: [], records: [{ message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: {} } }] } }, { message: { content: 1 } }] });
    expect(node.parts[0]).toMatchObject({ type: 'tool_call', toolCall: { id: 'c' } }); expect(result.type).toBe('error');
  });
  it('treats a token limit as partial without appending a notice', async () => {
    const { node, result } = await run({ messages: [], records: [{ message: { content: 'unfinished' }, done: true, done_reason: 'length' }] });
    expect(node.parts[0]).toMatchObject({ text: 'unfinished', completeness: 'partial' }); expect(result).toEqual({ type: 'interrupted', reason: 'limit' });
  });
  it('does not declare EOF or an unrelated record a normal generation end', async () => {
    const eof = await run({ messages: [], records: [{ message: { content: 'A' } }] });
    expect(eof.result).toEqual({ type: 'interrupted', reason: 'unknown' }); expect(eof.node.parts[0]).toMatchObject({ completeness: 'partial' });
    const invalid = await run({ messages: [], records: [{ message: { content: 'A' } }, { unrelated: true }] });
    expect(invalid.result.type).toBe('error'); expect(invalid.node.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' });
  });
  it('copies reasoning and tool names into the next request without changing the history', async () => {
    const messages: ChatMessage[] = [
      { id: toMessageId({ raw: 'a' }), role: 'assistant', parts: [{ type: 'reasoning', text: '  R\n', completeness: 'complete' }, { type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: ' {"n": 1} ' } } }] },
      { id: toMessageId({ raw: 't' }), role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'success', content: { type: 'text', text: 'result' } } }] },
    ];
    const before = structuredClone(messages);
    let request: unknown;
    const provider: LmProvider = new OllamaProvider({ endpoint: 'https://example.invalid', fetcher: async (_url, init) => {
      request = JSON.parse(String(init?.body)); return new Response('{"message":{"content":"A"},"done":true}');
    } });
    const node: AssistantMessageNode = { id: toMessageId({ raw: 'new' }), role: 'assistant', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
    await consumeChatGeneration({ onToolCallDraftsChange: undefined, node, items: provider.chat({ debug: undefined, messages, model: 'm', parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined }), abortController: new AbortController(), onChange: () => {} });
    expect(request).toMatchObject({ messages: [{ thinking: '  R\n', tool_calls: [{ function: { arguments: { n: 1 } } }] }, { role: 'tool', content: 'result', tool_name: 'f', tool_call_id: 'c' }] });
    expect(messages).toEqual(before);
  });
});
