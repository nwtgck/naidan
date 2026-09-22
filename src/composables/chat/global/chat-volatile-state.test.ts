import { describe, expect, it } from 'vitest';
import { toChatId, toMessageId } from '@/01-models/ids';
import type { Chat, AssistantMessageNode } from '@/01-models/types';
import { createChatVolatileState } from './chat-volatile-state';

function fixture(): { chat: Chat, node: AssistantMessageNode } {
  const node: AssistantMessageNode = { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 1, parts: [], modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
  const chat: Chat = { id: toChatId({ raw: 'chat' }), title: null, root: { items: [node] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
  return { chat, node };
}
describe('volatile assistant diagnostics', () => {
  it('retains UI errors without writing them into a reloaded message or interruption', () => {
    const state = createChatVolatileState(); const { chat, node } = fixture(); const before = JSON.stringify(chat);
    state.setVolatileAssistantError({ chatId: chat.id, messageId: node.id, error: '保存できませんでした' });
    state.pruneVolatileAssistantErrorsForChat({ chat });
    expect(state.getVolatileAssistantError({ chatId: chat.id, messageId: node.id })).toBe('保存できませんでした');
    expect(JSON.stringify(chat)).toBe(before); expect(Object.hasOwn(node, 'error')).toBe(false);
  });
  it('removes diagnostics for deleted messages and explicitly cleared errors', () => {
    const state = createChatVolatileState(); const { chat, node } = fixture();
    state.setVolatileAssistantError({ chatId: chat.id, messageId: node.id, error: 'old' });
    state.clearVolatileAssistantError({ chatId: chat.id, messageId: node.id });
    expect(state.getVolatileAssistantError({ chatId: chat.id, messageId: node.id })).toBeUndefined();
    state.setVolatileAssistantError({ chatId: chat.id, messageId: node.id, error: 'old' });
    chat.root.items = []; state.pruneVolatileAssistantErrorsForChat({ chat });
    expect(state.getVolatileAssistantError({ chatId: chat.id, messageId: node.id })).toBeUndefined();
  });
});
