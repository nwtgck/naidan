import { computed, ref } from 'vue';
import type { ExportExclusions } from '@/services/import-export/types';

type ChatExclusion = 'none' | 'chat' | 'chat_history';

export function useExportExclusions() {
  const chatExclusion = ref<ChatExclusion>('none');
  const excludeAttachments = ref(false);

  const excludeChats = computed({
    get: () => chatExclusion.value === 'chat',
    set: (value: boolean) => {
      if (value) {
        chatExclusion.value = 'chat';
        return;
      }
      switch (chatExclusion.value) {
      case 'chat':
        chatExclusion.value = 'none';
        break;
      case 'none':
      case 'chat_history':
        break;
      default: {
        const _ex: never = chatExclusion.value;
        throw new Error(`Unhandled chat exclusion: ${_ex}`);
      }
      }
    },
  });

  const excludeChatHistoryDisabled = computed(
    () => chatExclusion.value === 'chat',
  );

  const excludeChatHistory = computed({
    get: () => chatExclusion.value === 'chat_history',
    set: (value: boolean) => {
      if (value) {
        if (!excludeChatHistoryDisabled.value) {
          chatExclusion.value = 'chat_history';
        }
        return;
      }
      switch (chatExclusion.value) {
      case 'chat_history':
        chatExclusion.value = 'none';
        break;
      case 'none':
      case 'chat':
        break;
      default: {
        const _ex: never = chatExclusion.value;
        throw new Error(`Unhandled chat exclusion: ${_ex}`);
      }
      }
    },
  });

  function buildExcludeList(): ExportExclusions {
    switch (chatExclusion.value) {
    case 'none':
      return excludeAttachments.value ? ['binary_object'] : [];
    case 'chat':
      return excludeAttachments.value ? ['chat', 'binary_object'] : ['chat'];
    case 'chat_history':
      return excludeAttachments.value ? ['chat_history', 'binary_object'] : ['chat_history'];
    default: {
      const _ex: never = chatExclusion.value;
      throw new Error(`Unhandled chat exclusion: ${_ex}`);
    }
    }
  }

  function reset() {
    chatExclusion.value = 'none';
    excludeAttachments.value = false;
  }

  return {
    excludeChats,
    excludeChatHistory,
    excludeAttachments,
    excludeChatHistoryDisabled,
    buildExcludeList,
    reset,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for useXxx return objects.
    },
  };
}
