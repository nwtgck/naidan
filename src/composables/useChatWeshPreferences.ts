import { ref } from 'vue';
import type { NaidanSysfsMountSelection } from '@/services/wesh/types';

const naidanSysfsMountSelectionByChat = ref<Map<string, NaidanSysfsMountSelection>>(new Map());

export function useChatWeshPreferences() {
  const getNaidanSysfsMountSelection = ({ chatId }: { chatId: string | undefined }): NaidanSysfsMountSelection => {
    if (chatId === undefined) {
      return 'none';
    }
    return naidanSysfsMountSelectionByChat.value.get(chatId) ?? 'none';
  };

  const setNaidanSysfsMountSelection = ({
    chatId,
    selection,
  }: {
    chatId: string | undefined;
    selection: NaidanSysfsMountSelection;
  }) => {
    if (chatId === undefined) return;
    const next = new Map(naidanSysfsMountSelectionByChat.value);
    next.set(chatId, selection);
    naidanSysfsMountSelectionByChat.value = next;
  };

  return {
    getNaidanSysfsMountSelection,
    setNaidanSysfsMountSelection,
    TEST_ONLY: {
      naidanSysfsMountSelectionByChat,
    },
  };
}
