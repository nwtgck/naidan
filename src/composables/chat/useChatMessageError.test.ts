import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { AssistantMessageNode } from '@/01-models/types';
import { toChatId, toMessageId } from '@/01-models/ids';
import { useChatMessageError } from './useChatMessageError';
import { chatVolatileState } from './global/chat-core-singletons';
vi.mock('./global/chat-core-singletons', async () => {
  const { createChatVolatileState } = await import('./global/chat-volatile-state');
  return { chatVolatileState: createChatVolatileState() };
});

describe('message error display state', () => {
  it('uses transient diagnostics without changing the persisted interruption', () => {
    const chatId = ref(toChatId({ raw: 'c' }));
    const message = ref<AssistantMessageNode>({ id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 1, parts: [], modelId: undefined, lmParameters: undefined, replies: { items: [] }, interruption: { type: 'error', message: '保存済みの日本語' } });
    const before = JSON.stringify(message.value);
    const error = useChatMessageError({ chatId, message: computed(() => message.value) });
    expect(error.value).toBe('保存済みの日本語');
    chatVolatileState.setVolatileAssistantError({ chatId: chatId.value, messageId: message.value.id, error: 'Storage currently unavailable' });
    expect(error.value).toBe('Storage currently unavailable');
    expect(JSON.stringify(message.value)).toBe(before);
    chatVolatileState.clearVolatileAssistantError({ chatId: chatId.value, messageId: message.value.id });
    expect(error.value).toBe('保存済みの日本語');
  });
});
