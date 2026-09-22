import { computed, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import type { AssistantMessageNode, Chat, MessageNode } from '@/01-models/types';
import type { ToolCallDraft } from '@/01-models/lm';
import { toChatId, toMessageId, toToolCallId } from '@/01-models/ids';
import { useChatDisplayFlow, type ChatFlowItem } from './useChatDisplayFlow';

function createFlow({ message, processing }: { message: AssistantMessageNode, processing: boolean }) {
  const chat = ref({ id: toChatId({ raw: 'chat' }), root: { items: [message] }, currentLeafId: message.id } as Chat);
  return { ...useChatDisplayFlow({ getToolCallDrafts: undefined, chat: computed(() => chat.value), isProcessing: () => processing }), chat };
}
function assistant({ parts, interruption }: { parts: AssistantMessageNode['parts'], interruption: AssistantMessageNode['interruption'] }): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', parts, interruption, createdAt: 0, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
}
function flatten({ items }: { items: ChatFlowItem[] }): Exclude<ChatFlowItem, { type: 'process_sequence' }>[] {
  return items.flatMap(item => item.type === 'process_sequence' ? flatten({ items: item.items }) : [item]);
}
describe('parts-based display flow', () => {
  it('shows draft-only calls and preserves logical gaps and parallel completion order', () => {
    const message = assistant({ parts: [{ type: 'text', text: 'Later text', completeness: 'partial' }], interruption: undefined });
    const chat = ref({ id: toChatId({ raw: 'draft-chat' }), root: { items: [message] }, currentLeafId: message.id } as Chat);
    const drafts = ref<ToolCallDraft[]>([
      { partId: 'call-7', index: 7, beforePartIndex: 0, name: 'weather', arguments: '{"city":"T' },
      { partId: 'call-3', index: 3, beforePartIndex: 0, name: 'shell_execute', arguments: '{"shell_script":"echo' },
    ]);
    const { chatFlow } = useChatDisplayFlow({
      chat: computed(() => chat.value), isProcessing: () => true,
      getToolCallDrafts: ({ chatId, messageId }) => chatId === chat.value.id && messageId === message.id ? drafts.value : [],
    });
    const initial = chatFlow.value;
    expect(initial.map(item => item.type === 'message' ? item.toolCallDrafts?.[0]?.partId ?? item.partContent : item.type)).toEqual(['call-3', 'call-7', 'Later text']);
    const firstKey = initial[0]?.type === 'message' ? initial[0].key : undefined;
    const bodyKey = initial[2]?.type === 'message' ? initial[2].key : undefined;

    // A later call can finish first. It becomes a real part while the earlier call stays volatile.
    const node = chat.value.root.items[0];
    if (node?.role !== 'assistant') throw new Error('Expected assistant fixture.');
    node.parts.unshift({ type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'complete-7' }), type: 'function', function: { name: 'weather', arguments: '{"city":"Tokyo"}' } } });
    drafts.value = [{ partId: 'call-3', index: 3, beforePartIndex: 0, name: 'shell_execute', arguments: '{"shell_script":"echo hello' }];
    const after = flatten({ items: chatFlow.value });
    expect(after.filter(item => item.type === 'message' && item.toolCallDrafts?.length)).toHaveLength(1);
    expect(after[0]?.type === 'message' && after[0].key).toBe(firstKey);
    const bodyAfter = after.at(-1);
    expect(bodyAfter?.type === 'message' && bodyAfter.key).toBe(bodyKey);
    expect(node.parts).toHaveLength(2);
    expect(node.parts[0]).toMatchObject({ type: 'tool_call', toolCall: { id: 'complete-7' } });
    expect(after.some(item => item.type === 'message' && item.toolCalls?.some(call => call.id === toToolCallId({ raw: 'complete-7' })))).toBe(true);

    // The completed call and its result use the existing flow; no duplicate draft or fake result remains.
    node.parts.unshift({ type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'complete-3' }), type: 'function', function: { name: 'shell_execute', arguments: '{"shell_script":"echo hello"}' } } });
    drafts.value = [];
    expect(flatten({ items: chatFlow.value }).every(item => item.type !== 'message' || !item.toolCallDrafts)).toBe(true);
  });

  it('does not expose drafts on an inactive branch, stopped message, or different chat', () => {
    const message = assistant({ parts: [], interruption: undefined });
    const chat = ref({ id: toChatId({ raw: 'owned' }), root: { items: [message] }, currentLeafId: message.id } as Chat);
    const processing = ref(true);
    const draft: ToolCallDraft = { partId: 'pending', index: 0, beforePartIndex: 0, name: '', arguments: '', };
    const { chatFlow } = useChatDisplayFlow({
      chat: computed(() => chat.value), isProcessing: () => processing.value,
      getToolCallDrafts: ({ chatId }) => chatId === toChatId({ raw: 'owned' }) ? [draft] : [],
    });
    expect(chatFlow.value[0]).toMatchObject({ type: 'message', mode: 'tool_calls', toolCallDrafts: [draft] });
    expect(message.parts).toEqual([]);
    processing.value = false;
    expect(chatFlow.value[0]).toMatchObject({ type: 'message', mode: 'content' });
    processing.value = true;
    chat.value.id = toChatId({ raw: 'different' });
    expect(chatFlow.value[0]).toMatchObject({ type: 'message', mode: 'waiting' });
    chat.value.id = toChatId({ raw: 'owned' });
    const node = chat.value.root.items[0];
    if (node?.role !== 'assistant') throw new Error('Expected assistant fixture.');
    node.interruption = { type: 'cancelled' };
    expect(chatFlow.value[0]).toMatchObject({ type: 'message', mode: 'content' });
    node.interruption = undefined;
    const next: MessageNode = { id: toMessageId({ raw: 'next-user' }), role: 'user', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    node.replies.items = [next];
    chat.value.currentLeafId = next.id;
    expect(chatFlow.value.every(item => item.type !== 'message' || !item.toolCallDrafts)).toBe(true);
  });

  it('preserves repeated text and reasoning segments with unique render keys', () => {
    const parts: AssistantMessageNode['parts'] = [
      { type: 'reasoning', text: 'R1', completeness: 'complete' },
      { type: 'text', text: 'A', completeness: 'complete' },
      { type: 'reasoning', text: 'R2', completeness: 'complete' },
      { type: 'text', text: 'B', completeness: 'complete' },
    ];
    const { chatFlow } = createFlow({ message: assistant({ parts, interruption: undefined }), processing: false });
    const items = flatten({ items: chatFlow.value });
    expect(items.map(p => p.type === 'message' ? [p.mode, p.partContent] : [])).toEqual([
      ['thinking', 'R1'], ['content', 'A'], ['thinking', 'R2'], ['content', 'B'],
    ]);
    expect(new Set(items.map(p => p.type === 'message' ? p.key : p.id)).size).toBe(4);
  });
  it('does not animate stored partial reasoning after stopping', () => {
    const message = assistant({ parts: [{ type: 'reasoning', text: '途中', completeness: 'partial' }], interruption: { type: 'cancelled' } });
    const { chatFlow, isThinkingActive } = createFlow({ message, processing: false });
    expect(isThinkingActive({ item: chatFlow.value[0]! })).toBe(false);
    expect(message.parts[0]).toMatchObject({ completeness: 'partial', text: '途中' });
  });
  it('animates the native partial of the live generation', () => {
    const message = assistant({ parts: [{ type: 'reasoning', text: 'R', completeness: 'partial' }], interruption: undefined });
    const { chatFlow, isThinkingActive } = createFlow({ message, processing: true });
    expect(isThinkingActive({ item: chatFlow.value[0]! })).toBe(true);
  });
  it('keeps a later part key stable when an earlier empty part receives content', () => {
    const { chat, chatFlow } = createFlow({ message: assistant({ parts: [
      { type: 'text', text: '', completeness: 'partial' },
      { type: 'reasoning', text: 'R', completeness: 'partial' },
    ], interruption: undefined }), processing: true });
    const prior = flatten({ items: chatFlow.value }).find(p => p.type === 'message' && p.mode === 'thinking');
    const node = chat.value.root.items[0]!; const first = node.parts[0];
    if (first?.type !== 'text') throw new Error('Missing fixture part.');
    first.text = 'A';
    const later = flatten({ items: chatFlow.value }).find(p => p.type === 'message' && p.mode === 'thinking');
    expect(later?.type === 'message' && later.key).toBe(prior?.type === 'message' && prior.key);
  });
  it('keeps reactive body identity when a late tool call is inserted before it', () => {
    const { chat, chatFlow } = createFlow({ message: assistant({ parts: [
      { type: 'text', text: 'body', completeness: 'partial' },
    ], interruption: undefined }), processing: true });
    const before = flatten({ items: chatFlow.value }).find(item => item.type === 'message' && item.partContent === 'body');
    const node = chat.value.root.items[0];
    if (node?.role !== 'assistant') throw new Error('Expected assistant fixture.');
    node.parts.unshift({ type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'late-call' }), type: 'function', function: { name: 'f', arguments: '{}' } } });
    const text = node.parts[1];
    if (text?.type !== 'text') throw new Error('Expected body part.');
    text.text += ' continued';
    const after = flatten({ items: chatFlow.value }).find(item => item.type === 'message' && item.partContent === 'body continued');
    expect(before?.type).toBe('message');
    expect(after?.type).toBe('message');
    expect(after?.type === 'message' && after.key).toBe(before?.type === 'message' && before.key);
  });
  it('keeps a stopped empty assistant visible without inventing body text', () => {
    const message = assistant({ parts: [], interruption: { type: 'error', message: '通信エラー' } });
    const { chatFlow } = createFlow({ message, processing: false });
    expect(chatFlow.value[0]).toMatchObject({ type: 'message', mode: 'content', partContent: '' });
    expect(message.parts).toEqual([]);
  });
  it('does not associate a stray tool result across a new user turn', () => {
    const callId = toToolCallId({ raw: 'same-id' });
    const a = assistant({ parts: [{ type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'old', arguments: '{}' } } }], interruption: undefined });
    const u: MessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'text', text: 'value' } } }], createdAt: 2, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    a.replies.items = [u]; u.replies.items = [tool];
    const { chat, chatFlow } = createFlow({ message: a, processing: false }); chat.value.currentLeafId = tool.id;
    const items = flatten({ items: chatFlow.value });
    expect(items.some(p => p.type === 'tool_group')).toBe(false);
    expect(items.at(-1)).toMatchObject({ type: 'message', mode: 'content', partContent: '[Tool Results]' });
  });
});
