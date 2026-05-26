import { computed, type ComputedRef } from 'vue';
import type { ChatSummary } from '@/models/types';
import { useChat } from '@/composables/useChat';

export type ChatListDataAdapter = {
  chats: ComputedRef<ChatSummary[]>;

  TEST_ONLY: Record<string, never>;
};

export function useChatListData(): ChatListDataAdapter {
  const chatStore = useChat();

  return {
    chats: computed(() => chatStore.chats.value),
    TEST_ONLY: {},
  };
}
