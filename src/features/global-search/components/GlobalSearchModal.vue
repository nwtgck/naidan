<script setup lang="ts">
import { ref, watch, nextTick, computed, onBeforeUnmount, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { SearchIcon, XIcon, Loader2Icon, MessageSquareIcon, CornerDownRightIcon, ClockIcon, GitBranchIcon, FolderIcon, FilterIcon, CheckIcon, EyeIcon } from 'lucide-vue-next';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import { useChatSearch, type SearchResultItem, type SearchRoleFilter, type SearchScope, type ContentMatch } from '@/features/global-search/composables/useChatSearch';
import { useVirtualizedGlobalSearchResults } from '@/features/global-search/composables/useVirtualizedGlobalSearchResults';
import { getSearchResultKey } from '@/features/global-search/logic/result-key';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { idToRaw } from '@/01-models/ids';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { highlightSearchTextAsHtml } from '@/logic/security/allowedHtml';
import type { AllowedHtml } from '@/logic/security/allowedHtml';
import { toChatGroupId, toChatId, toMessageId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import { resolveSearchPreviewContextSize } from '@/features/global-search/logic/preview-context';

const SearchPreview = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./SearchPreview.vue') });
const ChatGroupSearchPreview = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ChatGroupSearchPreview.vue') });

const router = useRouter();
const { isSearchOpen, closeSearch, chatGroupIds, chatId } = useGlobalSearch();
const { openChat, openChatAtMessage, openChatGroup } = useChatNavigation();
const { chatGroups, currentChat, sidebarItems } = useCurrentChatState();
const { query, isSearching, isScanningContent, results, search, stopSearch, disposeSearch } = useChatSearch({ sidebarItems });
const { setActiveFocusArea, activeFocusArea } = useLayout();
const {
  globalSearchScope: searchScope,
  globalSearchRoleFilter: searchRoleFilter,
  searchPreviewMode,
  searchContextSize,
  setGlobalSearchScope,
  setGlobalSearchRoleFilter,
  setSearchPreviewMode,
  setSearchContextSize,
} = useSettings();

const searchInput = ref<HTMLInputElement | null>(null);
const groupPreviewRef = ref<{
  navigate: ({ direction }: { direction: 'up' | 'down' }) => void,
  handleEnter: () => void,
  selectedChatId: string | null,
    } | null>(null);
const selectedIndex = ref(0);
const scrollContainer = ref<HTMLElement | null>(null);
const {
  totalHeight: virtualResultsHeight,
  visibleResults,
  setResultElement,
  scrollResultIntoView,
} = useVirtualizedGlobalSearchResults({
  containerRef: scrollContainer,
  results,
  overscan: 6,
});
const showGroupSelector = ref(false);
const activePane = ref<'results' | 'preview'>('results');
const isExpandedByClick = ref(false);
const isHoveringResults = ref(false);
let previewHoverTimeout: ReturnType<typeof setTimeout> | null = null;

const handlePreviewMouseEnter = () => {
  if (previewHoverTimeout) clearTimeout(previewHoverTimeout);
};

const handlePreviewMouseLeave = () => {
  previewHoverTimeout = setTimeout(() => {
    if (isExpandedByClick.value) {
      isExpandedByClick.value = false;
      // Focus search input when collapsing
      nextTick(() => {
        searchInput.value?.focus();
      });
    }
  }, 100);
};

const isPreviewExpanded = computed(() => {
  return isExpandedByClick.value || activePane.value === 'preview';
});

const shouldLoadPreview = computed(() => {
  const mode = searchPreviewMode.value;
  switch (mode) {
  case 'disabled':
    return false;
  case 'always':
    return true;
  case 'peek':
    return isPreviewExpanded.value;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled search preview mode: ${_ex}`);
  }
  }
});

const isPreviewVisible = computed(() => searchPreviewMode.value !== 'disabled');

const shouldShowRoleFilter = computed(() => {
  const scope = searchScope.value;
  switch (scope) {
  case 'all':
  case 'current_thread':
    return true;
  case 'title_only':
    return false;
  default: {
    const _ex: never = scope;
    throw new Error(`Unhandled scope: ${_ex}`);
  }
  }
});

// Performance Optimization: Defer highlighting to ensure the initial list rendering is near-instant.
// This allows the modal to open and the results to appear immediately, with visual highlights appearing shortly after.
const isHighlightingEnabled = ref(false);
let highlightTimeout: ReturnType<typeof setTimeout> | null = null;

const updateHighlightState = () => {
  isHighlightingEnabled.value = false;
  if (highlightTimeout) clearTimeout(highlightTimeout);
  highlightTimeout = setTimeout(() => {
    isHighlightingEnabled.value = true;
  }, 50);
};

// Reset focus to results when search results change while preserving the selected item.
watch(results, (newResults, oldResults) => {
  const previousEntry = oldResults[selectedIndex.value];
  const previousKey = previousEntry === undefined
    ? undefined
    : getSearchResultKey({ entry: previousEntry });

  if (newResults.length === 0) {
    selectedIndex.value = 0;
  } else if (previousKey !== undefined) {
    const nextIndex = newResults.findIndex(entry => getSearchResultKey({ entry }) === previousKey);
    selectedIndex.value = nextIndex === -1
      ? Math.min(selectedIndex.value, newResults.length - 1)
      : nextIndex;
  } else {
    selectedIndex.value = Math.min(selectedIndex.value, newResults.length - 1);
  }

  activePane.value = 'results';
});

const handleClickOutsideGroupSelector = ({ event }: { event: MouseEvent }) => {
  const target = event.target as HTMLElement;
  if (showGroupSelector.value && !target.closest('.relative.shrink-0')) {
    showGroupSelector.value = false;
  }
};

useEventTargetListener(document, 'mousedown', (event) => handleClickOutsideGroupSelector({ event }));

const selectedGroups = computed(() => {
  return chatGroups.value.filter(g => chatGroupIds.value.includes(idToRaw({ id: g.id })));
});

const targetChatTitle = computed(() => {
  if (!chatId.value) return undefined;
  // If it's the current chat, we can get it from currentChat
  if (currentChat.value && idToRaw({ id: currentChat.value.id }) === chatId.value) return currentChat.value.title || lazyStrings.SHARED__new_chat();
  // Otherwise we'd need to fetch it or rely on a generic name
  return lazyStrings.GlobalSearchModal__filtered_chat();
});


function searchScopeLabel({ scope }: { scope: SearchScope }): string | undefined {
  switch (scope) {
  case 'all': return lazyStrings.GlobalSearchModal__all();
  case 'current_thread': return lazyStrings.GlobalSearchModal__current_thread();
  case 'title_only': return lazyStrings.GlobalSearchModal__title_only();
  default: { const _ex: never = scope; return _ex; }
  }
}

function searchRoleLabel({ role }: { role: SearchRoleFilter }): string | undefined {
  switch (role) {
  case 'all': return lazyStrings.GlobalSearchModal__all();
  case 'user': return lazyStrings.GlobalSearchModal__user();
  case 'assistant': return lazyStrings.GlobalSearchModal__assistant();
  default: { const _ex: never = role; return _ex; }
  }
}

const resolvedSearchContextSize = computed(() => resolveSearchPreviewContextSize({
  size: searchContextSize.value,
}));

const isCustomSearchContextSize = computed(() => {
  const size = resolvedSearchContextSize.value;
  return typeof size === 'number' && ![1, 2, 3, 5].includes(size);
});

function previewModeLabel({ mode }: { mode: 'always' | 'peek' | 'disabled' }): string | undefined {
  switch (mode) {
  case 'always': return lazyStrings.GlobalSearchModal__on();
  case 'peek': return lazyStrings.GlobalSearchModal__peek();
  case 'disabled': return lazyStrings.GlobalSearchModal__off();
  default: { const _ex: never = mode; return _ex; }
  }
}

async function handleSearchScopeChange({ scope }: { scope: SearchScope }): Promise<void> {
  await setGlobalSearchScope({ scope });
}

async function handleSearchRoleFilterChange({ event }: { event: Event }): Promise<void> {
  const roleFilter = (event.target as HTMLSelectElement).value as SearchRoleFilter;
  await setGlobalSearchRoleFilter({ roleFilter });
}

async function handleSearchContextSizeChange({ event }: { event: Event }): Promise<void> {
  const raw = (event.target as HTMLSelectElement).value;
  const size = raw === 'full' ? 'full' : Number(raw);
  await setSearchContextSize({ size });
}

function toggleGroupFilter({ groupId }: { groupId: string }) {
  const index = chatGroupIds.value.indexOf(groupId);
  if (index === -1) {
    chatGroupIds.value.push(groupId);
  } else {
    chatGroupIds.value.splice(index, 1);
  }
}

// Performance Optimization: Cache DateTimeFormat to avoid expensive re-initialization during list rendering.
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

function formatTime({ timestamp }: { timestamp: number }) {
  return timeFormatter.format(new Date(timestamp));
}

// Performance Optimization: Memoize highlighted strings.
// Regex matching and string concatenation are expensive during rapid list navigation.
const highlightCache = new Map<string, AllowedHtml>();

function highlight({ text, query, color }: {
  text: string,
  query: string,
  color: 'indigo' | 'blue',
}): AllowedHtml {
  const cacheKey = `${color}:${query}:${text}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;

  const result = highlightSearchTextAsHtml({ text, query, color });

  // Limit cache size to prevent memory leaks
  if (highlightCache.size > 1000) highlightCache.clear();
  highlightCache.set(cacheKey, result);
  return result;
}

watch(query, () => {
  highlightCache.clear();
  updateHighlightState();
}, { immediate: true });

// Debounce search input
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

const performSearch = ({ val }: { val: string }) => {
  search({
    searchQuery: val,
    options: {
      scope: searchScope.value,
      roleFilter: searchRoleFilter.value,
      chatGroupIds: chatGroupIds.value,
      chatId: chatId.value,
    },
  });
  selectedIndex.value = 0;
};

const handleInput = ({ event }: { event: Event }) => {
  const val = (event.target as HTMLInputElement).value;
  // Performance & Stability Note: Synchronize the query state immediately to prevent
  // the input field from jumping or losing characters during rapid typing.
  query.value = val;

  if (debounceTimeout) clearTimeout(debounceTimeout);

  const delay = (() => {
    const scope = searchScope.value;
    switch (scope) {
    case 'title_only':
      return 100;
    case 'all':
    case 'current_thread':
      return 300;
    default: {
      return 300;
    }
    }
  })();

  debounceTimeout = setTimeout(() => {
    performSearch({ val });
  }, delay);
};

function isEnterForImeComposition({ event }: { event: KeyboardEvent }) {
  return event.key === 'Enter' && (
    event.isComposing ||
    event.keyCode === 229 ||
    event.which === 229
  );
}

watch([searchScope, searchRoleFilter, chatGroupIds, chatId], () => {
  if (isSearchOpen.value) {
    performSearch({ val: query.value });
  }
}, { deep: true });

const handleKeydown = ({ event }: { event: KeyboardEvent }) => {
  if (isEnterForImeComposition({ event })) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const pane = activePane.value;
    switch (pane) {
    case 'preview':
      if (groupPreviewRef.value) {
        groupPreviewRef.value.navigate({ direction: 'down' });
      }
      break;
    case 'results':
      selectedIndex.value = Math.min(selectedIndex.value + 1, totalItems.value - 1);
      scrollToSelected();
      break;
    default: {
      const _ex: never = pane;
      throw new Error(`Unhandled pane: ${_ex}`);
    }
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    const pane = activePane.value;
    switch (pane) {
    case 'preview':
      if (groupPreviewRef.value) {
        groupPreviewRef.value.navigate({ direction: 'up' });
      }
      break;
    case 'results':
      selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
      scrollToSelected();
      break;
    default: {
      const _ex: never = pane;
      throw new Error(`Unhandled pane: ${_ex}`);
    }
    }
  } else if (event.key === 'ArrowRight') {
    // If we are on a result item, focus the preview pane
    if (activePane.value === 'results' && currentSelectedItem.value) {
      event.preventDefault();
      activePane.value = 'preview';
    }
  } else if (event.key === 'ArrowLeft') {
    const pane = activePane.value;
    switch (pane) {
    case 'preview':
      event.preventDefault();
      activePane.value = 'results';
      nextTick(() => {
        searchInput.value?.focus();
      });
      break;
    case 'results':
      // Do nothing
      break;
    default: {
      const _ex: never = pane;
      throw new Error(`Unhandled pane: ${_ex}`);
    }
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (activePane.value === 'preview' && groupPreviewRef.value) {
      groupPreviewRef.value.handleEnter();
    } else {
      selectItem({ index: selectedIndex.value });
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
  }
};

const totalItems = computed(() => results.value.length);

const currentSelectedItem = computed(() => results.value[selectedIndex.value]);

// Performance Optimization: Debounce the preview update during list navigation.
// This prevents expensive preview re-renders (and data fetching) while the user is rapidly
// moving through the result list with arrow keys.
const deferredSelectedItem = ref(currentSelectedItem.value);
let previewDebounceTimeout: ReturnType<typeof setTimeout> | null = null;

function clearModalTimers(): void {
  if (previewHoverTimeout !== null) clearTimeout(previewHoverTimeout);
  if (highlightTimeout !== null) clearTimeout(highlightTimeout);
  if (debounceTimeout !== null) clearTimeout(debounceTimeout);
  if (previewDebounceTimeout !== null) clearTimeout(previewDebounceTimeout);

  previewHoverTimeout = null;
  highlightTimeout = null;
  debounceTimeout = null;
  previewDebounceTimeout = null;
}

watch(currentSelectedItem, (newItem) => {
  if (previewDebounceTimeout) clearTimeout(previewDebounceTimeout);
  previewDebounceTimeout = setTimeout(() => {
    deferredSelectedItem.value = newItem;
  }, 120);
}, { immediate: true });

function scrollToSelected() {
  nextTick(() => {
    scrollResultIntoView({ index: selectedIndex.value });
  });
}

async function selectItem({ index }: { index: number }) {
  const target = results.value[index];
  if (!target) return;

  const type = target.type;
  switch (type) {
  case 'chat': {
    const chatItem = target.item;
    await openChat({ chatId: toChatId({ raw: chatItem.chatId }) });
    router.push(`/chat/${chatItem.chatId}`);
    closeSearch();
    break;
  }
  case 'message': {
    const matchItem = target.item;
    await openChatAtMessage({
      chatId: toChatId({ raw: matchItem.chatId }),
      messageId: toMessageId({ raw: matchItem.messageId }),
    });
    router.push({
      path: `/chat/${matchItem.chatId}`,
      query: { 'message-id': matchItem.messageId },
    });
    closeSearch();
    break;
  }
  case 'chat_group': {
    const groupItem = target.item;
    openChatGroup({ groupId: toChatGroupId({ raw: groupItem.groupId }) });
    closeSearch();
    break;
  }
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled target type: ${_ex}`);
  }
  }
}

const previousFocusArea = ref<import('@/composables/useLayout').FocusArea | undefined>(undefined);

function restorePreviousFocusArea(): void {
  const area = previousFocusArea.value;
  if (area === undefined) return;

  setActiveFocusArea({ area });
  previousFocusArea.value = undefined;
}

watch(isSearchOpen, (isOpen) => {
  if (isOpen) {
    previousFocusArea.value = activeFocusArea.value;
    setActiveFocusArea({ area: 'search' });
    performSearch({ val: query.value });
    nextTick(() => {
      if (searchInput.value) {
        searchInput.value.focus();
        searchInput.value.select();
      }
    });
  } else {
    clearModalTimers();
    stopSearch();
    restorePreviousFocusArea();
  }
}, { immediate: true });

onBeforeUnmount(() => {
  clearModalTimers();
  if (previousFocusArea.value !== undefined) {
    restorePreviousFocusArea();
  }
});

onUnmounted(() => {
  disposeSearch();
});

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <Transition name="fade">
    <div v-if="isSearchOpen" class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4" @click.self="closeSearch">
      <!-- Backdrop (Added click handler for robust outside click closing) -->
      <div class="absolute inset-0 bg-black/20 dark:bg-black/50 backdrop-blur-sm transition-opacity" aria-hidden="true" @click="closeSearch" />

      <!-- Modal Container (Split View) -->
      <div class="relative w-full max-w-5xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 flex flex-col h-[82vh] overflow-hidden transform transition-all scale-100" @click.stop>

        <!-- Search Header -->
        <div class="flex items-center gap-3 p-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <SearchIcon class="w-5 h-5 text-gray-400" />
          <input
            ref="searchInput"
            :value="query"
            @input="handleInput({ event: $event })"
            @keydown="handleKeydown({ event: $event })"
            type="text"
            class="flex-1 bg-transparent border-none outline-none text-lg text-gray-900 dark:text-gray-100 placeholder-gray-400"
            :placeholder="lazyStrings.GlobalSearchModal__search_chats_and_messages()"
            :aria-label="lazyStrings.GlobalSearchModal__search()"
            data-testid="search-input"
          />
          <button @click="closeSearch" class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
            <kbd class="hidden sm:inline-block px-1.5 py-0.5 text-xs font-medium text-gray-500 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 mr-2">ESC</kbd>
            <XIcon class="w-5 h-5 inline-block" />
          </button>
        </div>

        <!-- Search Options -->
        <div class="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800 shrink-0 overflow-visible">
          <div class="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <div class="flex flex-wrap items-center gap-1.5 min-w-0">
              <div class="flex flex-wrap items-center gap-1 shrink-0">
                <button
                  v-for="scope in (['all', 'current_thread', 'title_only'] as SearchScope[])"
                  :key="scope"
                  @click="handleSearchScopeChange({ scope })"
                  class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all"
                  :class="searchScope === scope ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
                  :data-testid="'scope-button-' + scope"
                >
                  {{ searchScopeLabel({ scope }) }}
                </button>
              </div>

              <div class="hidden sm:block h-4 w-px bg-gray-200 dark:bg-gray-700 mx-1 shrink-0"></div>

              <div v-if="shouldShowRoleFilter" class="flex items-center gap-1.5 shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 px-2.5 py-1">
                <span class="text-[8px] font-black uppercase tracking-[0.16em] text-gray-400">{{ lazyStrings.GlobalSearchModal__role() }}</span>
                <select
                  :value="searchRoleFilter"
                  @change="handleSearchRoleFilterChange({ event: $event })"
                  class="w-[4.8rem] bg-transparent border-none outline-none text-[9px] font-black uppercase tracking-[0.12em] text-gray-600 dark:text-gray-300 cursor-pointer pr-1"
                  data-testid="role-filter-select"
                >
                  <option
                    v-for="role in (['all', 'user', 'assistant'] as SearchRoleFilter[])"
                    :key="role"
                    :value="role"
                  >
                    {{ searchRoleLabel({ role }) }}
                  </option>
                </select>
              </div>

              <div v-if="shouldShowRoleFilter" class="hidden sm:block h-4 w-px bg-gray-200 dark:bg-gray-700 mx-1 shrink-0"></div>

              <!-- Group Filter Popover -->
              <div class="relative shrink-0">
                <button
                  @click="showGroupSelector = !showGroupSelector"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all"
                  :class="chatGroupIds.length > 0 ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
                  data-testid="group-filter-button"
                >
                  <FilterIcon class="w-3 h-3" />
                  <span>{{ lazyStrings.GlobalSearchModal__groups() }}</span>
                  <span v-if="chatGroupIds.length > 0" class="ml-1 px-1.5 py-0.5 bg-indigo-600 text-white rounded-full text-[8px]">{{ chatGroupIds.length }}</span>
                </button>

                <Transition name="dropdown">
                  <div
                    v-if="showGroupSelector"
                    class="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-xl z-50 py-1 overflow-hidden"
                    @click.stop
                    data-testid="group-selector-dropdown"
                  >
                    <div class="px-3 py-2 border-b border-gray-50 dark:border-gray-700/50 text-[10px] font-black text-gray-400 uppercase tracking-widest">{{ lazyStrings.GlobalSearchModal__filter_by_group() }}</div>
                    <div class="max-h-64 overflow-y-auto p-1">
                      <button
                        v-for="group in chatGroups"
                        :key="idToRaw({ id: group.id })"
                        @click="toggleGroupFilter({ groupId: idToRaw({ id: group.id }) })"
                        class="w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors"
                        :class="chatGroupIds.includes(idToRaw({ id: group.id })) ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:indigo-text-400' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
                        :data-testid="'group-filter-item-' + idToRaw({ id: group.id })"
                      >
                        <div class="flex items-center gap-2 overflow-hidden">
                          <FolderIcon class="w-3.5 h-3.5 shrink-0 opacity-60" />
                          <span class="truncate">{{ group.name }}</span>
                        </div>
                        <CheckIcon v-if="chatGroupIds.includes(idToRaw({ id: group.id }))" class="w-3.5 h-3.5 shrink-0" />
                      </button>
                      <div v-if="chatGroups.length === 0" class="p-4 text-center text-[10px] text-gray-400 italic">{{ lazyStrings.GlobalSearchModal__no_groups_available() }}</div>
                    </div>
                    <div v-if="chatGroupIds.length > 0" class="p-1 border-t border-gray-50 dark:border-gray-700/50">
                      <button @click="chatGroupIds = []" class="w-full px-3 py-2 text-[10px] font-black text-gray-400 hover:text-red-500 uppercase tracking-widest text-center transition-colors">{{ lazyStrings.GlobalSearchModal__clear_all_filters() }}</button>
                    </div>
                  </div>
                </Transition>
              </div>

              <!-- Active Filters (Groups & Specific Chat) -->
              <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                <!-- Specific Chat Filter -->
                <div
                  v-if="chatId"
                  class="flex items-center gap-1.5 px-2 py-1 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-wider border border-indigo-100 dark:border-indigo-900/30 whitespace-nowrap"
                >
                  <MessageSquareIcon class="w-2.5 h-2.5" />
                  <span>{{ targetChatTitle }}</span>
                  <button @click="chatId = undefined" class="hover:text-indigo-800 dark:hover:text-indigo-300">
                    <XIcon class="w-2.5 h-2.5" />
                  </button>
                </div>

                <div
                  v-for="group in selectedGroups"
                  :key="idToRaw({ id: group.id })"
                  class="flex items-center gap-1.5 px-2 py-1 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-wider border border-indigo-100 dark:border-indigo-900/30 whitespace-nowrap"
                >
                  <span>{{ group.name }}</span>
                  <button @click="toggleGroupFilter({ groupId: idToRaw({ id: group.id }) })" class="hover:text-indigo-800 dark:hover:text-indigo-300">
                    <XIcon class="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-4 text-[10px] font-bold text-gray-400 xl:ml-4 xl:justify-end">
              <div class="flex items-center gap-2">
                <span>{{ lazyStrings.GlobalSearchModal__preview() }}</span>
                <div class="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
                  <button
                    v-for="mode in (['always', 'peek', 'disabled'] as const)"
                    :key="mode"
                    @click="setSearchPreviewMode({ mode })"
                    class="px-2 py-1 rounded-md transition-all uppercase tracking-tighter"
                    :class="searchPreviewMode === mode ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-gray-200 dark:hover:bg-gray-700'"
                    :data-testid="'search-preview-mode-' + mode"
                  >
                    {{ previewModeLabel({ mode }) }}
                  </button>
                </div>
              </div>

              <div v-if="isPreviewVisible" class="flex items-center gap-2">
                <span>{{ lazyStrings.GlobalSearchModal__context() }}</span>
                <select
                  :value="resolvedSearchContextSize"
                  @change="handleSearchContextSizeChange({ event: $event })"
                  class="bg-transparent border-none outline-none text-gray-600 dark:text-gray-300 font-black cursor-pointer"
                  data-testid="search-context-size-select"
                >
                  <option v-if="isCustomSearchContextSize" :value="resolvedSearchContextSize">{{ resolvedSearchContextSize }}</option>
                  <option :value="1">1</option>
                  <option :value="2">2</option>
                  <option :value="3">3</option>
                  <option :value="5">5</option>
                  <option value="full">{{ lazyStrings.GlobalSearchModal__full() }}</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- Main Body (Split View) -->
        <div class="flex-1 flex overflow-hidden min-h-0">
          <!-- Left: Results List -->
          <div
            ref="scrollContainer"
            @mouseenter="isHoveringResults = true"
            @mouseleave="isHoveringResults = false"
            class="overflow-y-auto scrollbar-thin bg-white dark:bg-gray-900 transition-all duration-300 relative"
            :class="[
              isPreviewVisible
                ? (isPreviewExpanded ? 'w-[15%] min-w-[200px]' : (searchPreviewMode === 'peek' ? 'w-full' : 'w-[75%] min-w-[320px]'))
                : 'w-full',
              activePane === 'results' ? 'ring-2 ring-inset ring-blue-500/10' : ''
            ]"
          >
            <div v-if="results.length === 0 && !isSearching" class="p-8 text-center text-gray-500 text-sm">
              {{ lazyStrings.GlobalSearchModal__no_results_for({ query }) }}
            </div>

            <template v-else>
              <div
                class="relative mx-2"
                :style="{ height: `${virtualResultsHeight}px` }"
                data-testid="search-results-virtual-space"
              >
                <div
                  v-for="visibleResult in visibleResults"
                  :key="visibleResult.key"
                  :ref="element => setResultElement({ key: visibleResult.key, element: element as Element | null })"
                  class="absolute left-0 right-0"
                  :style="{ transform: `translateY(${visibleResult.top}px)` }"
                >
                  <div
                    :data-index="visibleResult.index"
                    :data-testid="'search-result-item-' + visibleResult.index"
                    @mouseenter="selectedIndex = visibleResult.index"
                    @click="selectItem({ index: visibleResult.index })"
                    class="group flex flex-col p-2.5 rounded-xl cursor-pointer transition-[background-color,border-color,opacity] duration-200 border border-transparent"
                    :class="selectedIndex === visibleResult.index
                      ? (activePane === 'results' ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800 shadow-sm' : 'bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700 opacity-80')
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'"
                  >
                    <!-- Performance Note: CSS transitions are restricted to specific properties
                     to minimize layout recalculations during rapid list updates. -->

                    <!-- Chat Group Item -->
                    <div v-if="visibleResult.entry.type === 'chat_group'" class="flex items-center justify-between gap-3">
                      <div class="p-2 bg-blue-50 dark:bg-blue-900/30 rounded-lg shrink-0">
                        <FolderIcon class="w-4 h-4 text-blue-600 dark:text-blue-400" />
                      </div>
                      <div class="flex flex-col flex-1 overflow-hidden">
                        <div class="flex items-center justify-between gap-2">
                          <AllowedHtmlView
                            v-if="isHighlightingEnabled"
                            as="span"
                            :html="highlight({ text: visibleResult.entry.item.name, query, color: 'blue' })"
                            class="font-bold text-sm truncate text-gray-900 dark:text-gray-100"
                          />
                          <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100" v-else>{{ visibleResult.entry.item.name }}</span>
                          <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-[9px] px-1.5 py-0.5 bg-blue-100/50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded font-black uppercase tracking-wider">{{ lazyStrings.GlobalSearchModal__chat_count({ count: visibleResult.entry.item.chatCount }) }}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <!-- Chat Header Item -->
                    <div v-else-if="visibleResult.entry.type === 'chat'" class="flex items-center justify-between gap-3">
                      <div class="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg shrink-0">
                        <MessageSquareIcon class="w-4 h-4 text-gray-500 dark:text-gray-400" />
                      </div>
                      <div class="flex flex-col flex-1 overflow-hidden">
                        <div class="flex items-center justify-between gap-2">
                          <div class="flex flex-col overflow-hidden">
                            <AllowedHtmlView
                              v-if="isHighlightingEnabled && visibleResult.entry.item.title"
                              as="span"
                              :html="highlight({ text: visibleResult.entry.item.title, query, color: 'indigo' })"
                              class="font-bold text-sm truncate text-gray-900 dark:text-gray-100"
                            />
                            <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100" v-else>{{ visibleResult.entry.item.title || lazyStrings.SHARED__new_chat() }}</span>
                            <span v-if="visibleResult.entry.item.groupName" class="text-[10px] text-gray-400 truncate flex items-center gap-1">
                              <FolderIcon class="w-2.5 h-2.5 opacity-50 text-blue-500" />
                              <AllowedHtmlView
                                v-if="isHighlightingEnabled"
                                as="span"
                                :html="highlight({ text: visibleResult.entry.item.groupName, query, color: 'blue' })"
                              />
                              <span v-else>{{ visibleResult.entry.item.groupName }}</span>
                            </span>
                          </div>
                          <span class="text-[10px] text-gray-400 shrink-0">{{ formatTime({ timestamp: visibleResult.entry.item.updatedAt }) }}</span>
                        </div>
                        <div class="flex items-center gap-1.5 mt-0.5">
                          <ClockIcon class="w-3 h-3 text-gray-300" />
                          <span class="text-[10px] text-gray-400">{{ lazyStrings.GlobalSearchModal__chat() }}</span>
                        </div>
                      </div>
                    </div>

                    <!-- Message Match Item -->
                    <div v-else-if="visibleResult.entry.type === 'message'" class="flex items-start gap-3 pl-10 opacity-90 relative">
                      <div class="absolute left-4 top-1 h-full w-0.5 bg-gray-100 dark:bg-gray-800"></div>
                      <CornerDownRightIcon class="w-3 h-3 text-gray-300 mt-1 shrink-0" />
                      <div class="flex flex-col overflow-hidden text-sm flex-1">
                        <div class="flex items-center justify-between gap-2 mb-1">
                          <span class="text-[9px] font-black uppercase tracking-wider text-gray-400">{{ visibleResult.entry.item.role }}</span>
                          <span class="text-[9px] text-gray-400">{{ formatTime({ timestamp: visibleResult.entry.item.timestamp }) }}</span>
                        </div>
                        <AllowedHtmlView
                          v-if="isHighlightingEnabled"
                          as="span"
                          :html="highlight({ text: visibleResult.entry.item.excerpt, query, color: 'indigo' })"
                          class="text-gray-600 dark:text-gray-300 line-clamp-2 text-xs leading-relaxed"
                        />
                        <span v-else class="text-gray-600 dark:text-gray-300 line-clamp-2 text-xs leading-relaxed">{{ visibleResult.entry.item.excerpt }}</span>

                        <div v-if="!visibleResult.entry.item.isCurrentThread" class="flex items-center gap-1 mt-1.5 text-[9px] text-amber-600 dark:text-amber-500 font-bold">
                          <GitBranchIcon class="w-2.5 h-2.5" />
                          <span>{{ lazyStrings.GlobalSearchModal__alt_branch() }}</span>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>

              <div v-if="isScanningContent" class="p-4 flex items-center justify-center text-gray-400 gap-2 border-t border-gray-50 dark:border-gray-800/50 mt-2">
                <Loader2Icon class="w-4 h-4 animate-spin" />
                <span class="text-[11px] font-bold">{{ lazyStrings.GlobalSearchModal__scanning_content() }}</span>
              </div>
            </template>
          </div>

          <!-- Right: Preview -->
          <div v-if="isPreviewVisible && !isScanningContent && results.length > 0"
               @mouseenter="handlePreviewMouseEnter"
               @mouseleave="handlePreviewMouseLeave"
               @click.capture="!isPreviewExpanded ? (isExpandedByClick = true, $event.stopPropagation(), $event.preventDefault()) : null"
               data-testid="search-preview-container"
               class="bg-white dark:bg-gray-900 overflow-hidden transition-all duration-300 border-l border-gray-100 dark:border-gray-800 cursor-pointer relative"
               :class="[
                 isPreviewExpanded ? 'w-[85%]' : 'w-[25%]',
                 activePane === 'preview' ? 'ring-2 ring-inset ring-blue-500/20' : ''
               ]">
            <template v-if="shouldLoadPreview">
              <template v-if="deferredSelectedItem?.type === 'chat_group'">
                <ChatGroupSearchPreview
                  ref="groupPreviewRef"
                  :groupId="(deferredSelectedItem.item as Extract<SearchResultItem, { type: 'chat_group' }>).groupId"
                  :groupName="(deferredSelectedItem.item as Extract<SearchResultItem, { type: 'chat_group' }>).name"
                />
              </template>
              <template v-else>
                <SearchPreview
                  :match="deferredSelectedItem?.type === 'message' ? deferredSelectedItem.item as ContentMatch : undefined"
                  :chat="deferredSelectedItem?.type === 'chat' ? deferredSelectedItem.item as Extract<SearchResultItem, { type: 'chat' }> : undefined"
                />
              </template>
            </template>
            <div v-else class="h-full flex items-center justify-center bg-gray-50/50 dark:bg-gray-950/20">
              <div class="flex flex-col items-center gap-2 opacity-20">
                <EyeIcon class="w-8 h-8 text-gray-400" />
                <span class="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500">{{ lazyStrings.GlobalSearchModal__peek() }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="p-2.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950/50 text-[10px] font-bold text-gray-400 flex justify-between px-6 shrink-0">
          <div class="flex gap-6">
            <span class="flex items-center gap-1.5"><kbd class="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-600 dark:text-gray-400 font-sans">↑↓</kbd> {{ lazyStrings.GlobalSearchModal__navigate() }}</span>
            <span class="flex items-center gap-1.5"><kbd class="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-600 dark:text-gray-400 font-sans">↵</kbd> {{ lazyStrings.GlobalSearchModal__select() }}</span>
          </div>
          <div class="flex items-center gap-4">
            <span>{{ lazyStrings.GlobalSearchModal__chats_found({ count: results.length }) }}</span>
            <span v-if="totalItems > 0">{{ lazyStrings.GlobalSearchModal__total_matches({ count: totalItems }) }}</span>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scrollbar-thin::-webkit-scrollbar {
  width: 5px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.2);
  border-radius: 10px;
}
.scrollbar-thin::-webkit-scrollbar-thumb:hover {
  background-color: rgba(156, 163, 175, 0.4);
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(4px);
}

kbd {
  box-shadow: 0 1px 0 rgba(0,0,0,0.1);
}
</style>
