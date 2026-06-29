import { computed, type ComputedRef } from 'vue';
import type { ChatSummary } from '@/01-models/types';
import type { Settings } from '@/01-models/types';
import { useSettings } from '@/composables/useSettings';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import { currentChatRef, rootItems } from '@/composables/chat/global/chat-core-singletons';

export type ChatListDataAdapter = {
  chats: ComputedRef<ChatSummary[]>,

  TEST_ONLY: Record<never, never>,
};

export function useChatListData(): ChatListDataAdapter {
  const { settings } = useSettings();
  const chatDerivedState = createChatDerivedState({
    currentChatRef,
    rootItems,
    getSettings: () => settings.value as Settings,
  });

  return {
    chats: computed(() => chatDerivedState.chats.value),
    TEST_ONLY: {},
  };
}
