import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from './openai';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { toMessageId } from '@/01-models/ids';
import type { AssistantMessageNode } from '@/01-models/types';
import type { LmProvider, ToolCallDraft } from '@/01-models/lm';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { z } from 'zod';
import { runProviderConversationForTest } from './provider-test-support';
import type { LmFetch } from './fetch';

function node(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}
async function run({ payload, onChange }: { payload: string, onChange: (node: AssistantMessageNode) => void }) {
  const fetcher = vi.fn(async () => new Response(payload));
  const provider: LmProvider = new OpenAIProvider({ endpoint: 'https://example.invalid/v1', fetcher });
  const controller = new AbortController(); const message = node();
  const result = await consumeChatGeneration({ onToolCallDraftsChange: undefined, node: message, items: provider.chat({ debug: undefined, messages: [], model: 'm', parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: controller.signal }), abortController: controller, onChange: () => onChange(message) });
  return { message, result, fetcher };
}
describe('OpenAI structured generation contract', () => {
  beforeEach(() => useGlobalEvents().clearEvents());
  it('executes only the completed call and sends only completed history on the tool follow-up', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, content: 'sunny' }));
    const fetcher = vi.fn<LmFetch>()
      .mockResolvedValueOnce(new Response(`\
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"weather-call","function":{"name":"weather","arguments":"{\\"city\\":\\""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Tokyo\\"}"}}]},"finish_reason":"tool_calls"}]}

`))
      .mockResolvedValueOnce(new Response(`\
data: {"choices":[{"delta":{"content":"It is sunny."},"finish_reason":"stop"}]}

`));
    const provider = new OpenAIProvider({ endpoint: 'https://example.invalid/v1', fetcher });
    const history = await runProviderConversationForTest({ provider, messages: [{ role: 'user', content: 'Weather?' }], model: 'm', onChunk: () => {},
      tools: [{ name: 'weather', description: 'Weather', parametersSchema: z.object({ city: z.string() }), execute }],
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ args: { city: 'Tokyo' } }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    const request = fetcher.mock.calls[1]?.[1];
    if (typeof request?.body !== 'string') throw new Error('Expected a serialized API request');
    expect(JSON.parse(request.body).messages).toEqual([
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', tool_calls: [{ id: 'weather-call', type: 'function', function: { name: 'weather', arguments: '{"city":"Tokyo"}' } }] },
      { role: 'tool', tool_call_id: 'weather-call', content: 'sunny' },
    ]);
    expect(JSON.stringify(history)).not.toContain('tool_call_draft');
  });
  it('publishes argument deltas before the terminal event without persisting an incomplete call', async () => {
    const message = node();
    const snapshots: (readonly ToolCallDraft[])[] = [];
    const onChange = vi.fn();
    const payload = `\
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"sh","arguments":"{\\"script\\":\\""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ell","arguments":"echo hi"}}]}}]}

data: {"choices":[{"finish_reason":"length"}]}

`;
    const provider = new OpenAIProvider({ endpoint: 'https://example.invalid/v1', fetcher: async () => new Response(payload) });
    const result = await consumeChatGeneration({ node: message, abortController: new AbortController(), onChange,
      onToolCallDraftsChange: ({ drafts }) => {
        snapshots.push(drafts);
      },
      items: provider.chat({ messages: [], model: 'm', parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined }),
    });
    expect(snapshots.map(drafts => drafts.map(({ name, arguments: text }) => ({ name, text })))).toEqual([
      [{ name: 'sh', text: '{"script":"' }],
      [{ name: 'shell', text: '{"script":"echo hi' }],
      [],
    ]);
    expect(message.parts).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(result).toEqual({ type: 'interrupted', reason: 'limit' });
  });
  it('streams reasoning without synthetic tags and publishes only one assistant', async () => {
    const { message, result, fetcher } = await run({ payload: `\
data: {"choices":[{"delta":{"reasoning_content":"  R\\n","content":"<think>literal</think>"}}]}

data: {"choices":[{"finish_reason":"stop","delta":{}}]}

`, onChange: () => {} });
    expect(message.parts.map(part => part.type)).toEqual(['reasoning', 'text']);
    expect(message.parts).toMatchObject([{ text: '  R\n', completeness: 'complete' }, { text: '<think>literal</think>', completeness: 'complete' }]);
    expect(result).toEqual({ type: 'finished', next: 'user' }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps the final line without newline and supports multiline SSE data events', async () => {
    const { message } = await run({ payload: `\
data: {"choices":
data: [{"delta":{"content":"🙂"},"finish_reason":"stop"}]}`, onChange: () => {} });
    expect(message.parts[0]).toMatchObject({ text: '🙂', completeness: 'complete' });
  });
  it('does not persist or execute a call truncated by the token limit', async () => {
    const { message, result } = await run({ payload: `\
data: {"choices":[{"delta":{"content":"prefix"}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"length"}]}

`, onChange: () => {} });
    expect(message.parts.map(part => part.type)).toEqual(['text']); expect(result).toEqual({ type: 'interrupted', reason: 'limit' });
  });
  it('preserves completed calls for caller execution without a provider-internal second request', async () => {
    const { message, result, fetcher } = await run({ payload: `\
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"  {} "}}]},"finish_reason":"tool_calls"}]}

`, onChange: () => {} });
    expect(message.parts[0]).toMatchObject({ type: 'tool_call', toolCall: { function: { arguments: '  {} ' } } });
    expect(result).toEqual({ type: 'finished', next: 'tool_results' }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not call EOF a successful completion and keeps received content partial', async () => {
    const { message, result } = await run({ payload: 'data: {"choices":[{"delta":{"content":"A"}}]}\n\n', onChange: () => {} });
    expect(message.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' }); expect(result).toEqual({ type: 'interrupted', reason: 'unknown' });
  });
  it('keeps accepted text and surfaces an invalid later event', async () => {
    const { message, result } = await run({ payload: `\
data: {"choices":[{"delta":{"content":"A"}}]}

data: {broken}

`, onChange: () => {} });
    expect(message.parts[0]).toMatchObject({ text: 'A', completeness: 'partial' }); expect(result.type).toBe('error');
  });
  it('rejects conflicting reasoning aliases instead of throwing one away', async () => {
    const { message, result } = await run({ payload: 'data: {"choices":[{"delta":{"reasoning":"A","reasoning_content":"B"}}]}\n\n', onChange: () => {} });
    expect(message.parts).toEqual([]); expect(result.type).toBe('error');
  });
});
