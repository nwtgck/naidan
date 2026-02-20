import { ref, computed } from 'vue';
import { useOverlay } from './useOverlay';

const { activeOverlay, openOverlay: _openOverlay, closeOverlay: _closeOverlay, toggleOverlay: _toggleOverlay } = useOverlay();

const isSearchOpen = computed(() => activeOverlay.value === 'search');
const chatGroupIds = ref<string[]>([]);
const chatId = ref<string | undefined>(undefined);

export function useGlobalSearch() {
  const openSearch = ({ groupIds, chatId: cid }: { groupIds?: string[], chatId?: string } = {}) => {
    chatGroupIds.value = groupIds || [];
    chatId.value = cid;
    _openOverlay({ type: 'search' });
  };

  const closeSearch = () => {
    const overlay = activeOverlay.value;
    switch (overlay) {
    case 'search':
      _closeOverlay();
      break;
    case 'recent':
    case 'none':
      break;
    default: {
      const _ex: never = overlay;
      throw new Error(`Unhandled overlay: ${_ex}`);
    }
    }
    chatGroupIds.value = [];
    chatId.value = undefined;
  };

  const toggleSearch = () => {
    _toggleOverlay({ type: 'search' });
    const overlay = activeOverlay.value;
    switch (overlay) {
    case 'search':
      break;
    case 'recent':
    case 'none':
      chatGroupIds.value = [];
      chatId.value = undefined;
      break;
    default: {
      const _ex: never = overlay;
      throw new Error(`Unhandled overlay: ${_ex}`);
    }
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
