import { computed, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import type { AssistantMessageNode, Chat, MessageNode } from '@/01-models/types';
import { toChatId, toMessageId, toToolCallId } from '@/01-models/ids';
import { useChatDisplayFlow, type ChatFlowItem } from './useChatDisplayFlow';

function createFlow({ message, processing }: { message: AssistantMessageNode, processing: boolean }) {
  const chat = ref({ id: toChatId({ raw: 'chat' }), root: { items: [message] }, currentLeafId: message.id } as Chat);
  return { ...useChatDisplayFlow({ chat: computed(() => chat.value), isProcessing: () => processing }), chat };
}
function assistant({ parts, interruption }: { parts: AssistantMessageNode['parts'], interruption: AssistantMessageNode['interruption'] }): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', parts, interruption, createdAt: 0, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
}
function flatten({ items }: { items: ChatFlowItem[] }): Exclude<ChatFlowItem, { type: 'process_sequence' }>[] {
  return items.flatMap(item => item.type === 'process_sequence' ? flatten({ items: item.items }) : [item]);
}
describe('parts-based display flow', () => {
  it('preserves repeated text and reasoning segments with unique render keys', () => {
    const parts: AssistantMessageNode['parts'] = [
      { id: 'r1', type: 'reasoning', text: 'R1', completeness: 'complete' },
      { id: 't1', type: 'text', text: 'A', completeness: 'complete' },
      { id: 'r2', type: 'reasoning', text: 'R2', completeness: 'complete' },
      { id: 't2', type: 'text', text: 'B', completeness: 'complete' },
    ];
    const { chatFlow } = createFlow({ message: assistant({ parts, interruption: undefined }), processing: false });
    const items = flatten({ items: chatFlow.value });
    expect(items.map(p => p.type === 'message' ? [p.mode, p.partContent] : [])).toEqual([
      ['thinking', 'R1'], ['content', 'A'], ['thinking', 'R2'], ['content', 'B'],
    ]);
    expect(new Set(items.map(p => p.type === 'message' ? p.key : p.id)).size).toBe(4);
  });
  it('does not animate stored partial reasoning after stopping', () => {
    const message = assistant({ parts: [{ id: 'r', type: 'reasoning', text: '途中', completeness: 'partial' }], interruption: { type: 'cancelled' } });
    const { chatFlow, isThinkingActive } = createFlow({ message, processing: false });
    expect(isThinkingActive({ item: chatFlow.value[0]! })).toBe(false);
    expect(message.parts[0]).toMatchObject({ completeness: 'partial', text: '途中' });
  });
  it('animates the native partial of the live generation', () => {
    const message = assistant({ parts: [{ id: 'r', type: 'reasoning', text: 'R', completeness: 'partial' }], interruption: undefined });
    const { chatFlow, isThinkingActive } = createFlow({ message, processing: true });
    expect(isThinkingActive({ item: chatFlow.value[0]! })).toBe(true);
  });
  it('keeps a later part key stable when an earlier empty part receives content', () => {
    const { chat, chatFlow } = createFlow({ message: assistant({ parts: [
      { id: 't', type: 'text', text: '', completeness: 'partial' },
      { id: 'r', type: 'reasoning', text: 'R', completeness: 'partial' },
    ], interruption: undefined }), processing: true });
    const prior = flatten({ items: chatFlow.value }).find(p => p.type === 'message' && p.mode === 'thinking');
    const node = chat.value.root.items[0]!; const first = node.parts[0];
    if (first?.type !== 'text') throw new Error('Missing fixture part.');
    first.text = 'A';
    const later = flatten({ items: chatFlow.value }).find(p => p.type === 'message' && p.mode === 'thinking');
    expect(later?.type === 'message' && later.key).toBe(prior?.type === 'message' && prior.key);
  });
  it('keeps a stopped empty assistant visible without inventing body text', () => {
    const message = assistant({ parts: [], interruption: { type: 'error', message: '通信エラー' } });
    const { chatFlow } = createFlow({ message, processing: false });
    expect(chatFlow.value[0]).toMatchObject({ type: 'message', mode: 'content', partContent: '' });
    expect(message.parts).toEqual([]);
  });
  it('does not associate a stray tool result across a new user turn', () => {
    const callId = toToolCallId({ raw: 'same-id' });
    const a = assistant({ parts: [{ id: 'c', type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'old', arguments: '{}' } } }], interruption: undefined });
    const u: MessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', parts: [{ id: 'result', type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'text', text: 'value' } } }], createdAt: 2, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    a.replies.items = [u]; u.replies.items = [tool];
    const { chat, chatFlow } = createFlow({ message: a, processing: false }); chat.value.currentLeafId = tool.id;
    const items = flatten({ items: chatFlow.value });
    expect(items.some(p => p.type === 'tool_group')).toBe(false);
    expect(items.at(-1)).toMatchObject({ type: 'message', mode: 'content', partContent: '[Tool Results]' });
  });
});
