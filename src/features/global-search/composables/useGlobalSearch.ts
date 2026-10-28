import { ref, computed, readonly } from 'vue';
import { useOverlay } from '@/composables/useOverlay';
import { createSearchQueryMemory, type SearchQueryMemoryContext } from '@/features/global-search/logic/query-memory';

const { activeOverlay, openOverlay: _openOverlay, closeOverlay: _closeOverlay } = useOverlay();

const isSearchOpen = computed(() => activeOverlay.value === 'search');
const chatGroupIds = ref<string[]>([]);
const chatId = ref<string | undefined>(undefined);
const searchRequestId = ref(0);
const queryMemory = createSearchQueryMemory({ targetLimit: 100 });
let queryContext: SearchQueryMemoryContext = { type: 'global' };
const currentQuery = ref('');
const query = computed({
  get: () => currentQuery.value,
  set: (value: string) => {
    currentQuery.value = value;
    // Remember input before the debounced search, including the last keystroke before closing.
    queryMemory.rememberQuery({ context: queryContext, query: value });
  },
});

function resolveQueryContext({ chatId, chatGroupIds }: {
  chatId: string | undefined,
  chatGroupIds: string[],
}): SearchQueryMemoryContext {
  if (chatId !== undefined) {
    return { type: 'chat', chatId };
  }
  const [chatGroupId] = chatGroupIds;
  if (chatGroupIds.length === 1 && chatGroupId !== undefined) {
    return { type: 'chat_group', chatGroupId };
  }
  return { type: 'global' };
}

export function useGlobalSearch() {
  const openSearch = ({ groupIds, chatId: cid }: { groupIds?: string[], chatId?: string }) => {
    const initialChatGroupIds = groupIds === undefined ? [] : [...groupIds];
    // Keep this context fixed while the user changes filters within the modal.
    queryContext = resolveQueryContext({ chatId: cid, chatGroupIds: initialChatGroupIds });
    currentQuery.value = queryMemory.restoreQuery({ context: queryContext });
    chatGroupIds.value = initialChatGroupIds;
    chatId.value = cid;
    searchRequestId.value++;
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
    const overlay = activeOverlay.value;
    switch (overlay) {
    case 'search':
      closeSearch();
      break;
    case 'recent':
    case 'none':
      openSearch({});
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
    query,
    searchRequestId: readonly(searchRequestId),
    openSearch,
    closeSearch,
    toggleSearch,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
