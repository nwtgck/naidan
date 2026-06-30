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
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {},
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
