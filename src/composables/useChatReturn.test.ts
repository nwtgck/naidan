import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { toChatId } from '@/01-models/ids';
import type { RecentChatWithAccess } from './useRecentChats';
import { useChatReturn } from './useChatReturn';

const mostRecentChat = ref<RecentChatWithAccess>();
const { createNewChat } = vi.hoisted(() => ({ createNewChat: vi.fn() }));
vi.mock('./useRecentChats', () => ({ useRecentChats: () => ({ mostRecentChat }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createNewChat }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mostRecentChat.value = undefined;
});

describe('the shared return to chats destination', () => {
  it('returns to the most recent chat without creating a conversation', () => {
    mostRecentChat.value = { id: toChatId({ raw: 'previous-chat' }), title: 'Previous chat', updatedAt: 10, accessedAt: 20 };
    expect(useChatReturn().chatReturnPath.value).toBe('/chat/previous-chat');
    expect(createNewChat).not.toHaveBeenCalled();
  });

  it('returns Home when no recent chat exists without creating one', () => {
    expect(useChatReturn().chatReturnPath.value).toBe('/');
    expect(createNewChat).not.toHaveBeenCalled();
  });

  it('updates all consumers as the most recent valid chat changes or disappears', () => {
    const first = useChatReturn();
    const second = useChatReturn();
    mostRecentChat.value = { id: toChatId({ raw: 'first' }), title: 'First', updatedAt: 10, accessedAt: 20 };
    expect(first.chatReturnPath.value).toBe('/chat/first');
    expect(second.chatReturnPath.value).toBe('/chat/first');
    mostRecentChat.value = { id: toChatId({ raw: 'second' }), title: 'Second', updatedAt: 30, accessedAt: 40 };
    expect(first.chatReturnPath.value).toBe('/chat/second');
    expect(second.chatReturnPath.value).toBe('/chat/second');
    mostRecentChat.value = undefined;
    expect(first.chatReturnPath.value).toBe('/');
    expect(second.chatReturnPath.value).toBe('/');
    expect(createNewChat).not.toHaveBeenCalled();
  });
});
