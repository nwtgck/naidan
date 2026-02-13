import { ref } from 'vue';

const isSearchOpen = ref(false);
const chatGroupIds = ref<string[]>([]);
const chatId = ref<string | undefined>(undefined);

export function useGlobalSearch() {
  const openSearch = ({ groupIds, chatId: cid }: { groupIds?: string[], chatId?: string } = {}) => {
    chatGroupIds.value = groupIds || [];
    chatId.value = cid;
    isSearchOpen.value = true;
  };

  const closeSearch = () => {
    isSearchOpen.value = false;
    chatGroupIds.value = [];
    chatId.value = undefined;
  };

  const toggleSearch = () => {
    isSearchOpen.value = !isSearchOpen.value;
    if (!isSearchOpen.value) {
      chatGroupIds.value = [];
      chatId.value = undefined;
    }
  };

  return {
    isSearchOpen,
    chatGroupIds,
    chatId,
    openSearch,
    closeSearch,
    toggleSearch,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
