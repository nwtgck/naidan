import { computed } from 'vue';
import { idToRaw } from '@/01-models/ids';
import { useRecentChats } from '@/composables/useRecentChats';

export function useChatReturn() {
  const { mostRecentChat } = useRecentChats();
  // Every "back to chats" entry intentionally follows the same conversation.
  const chatReturnPath = computed(() => mostRecentChat.value === undefined ? '/' : `/chat/${idToRaw({ id: mostRecentChat.value.id })}`);
  return {
    chatReturnPath,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
