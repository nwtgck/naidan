<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { Search, X, Loader2, MessageSquare, CornerDownRight, Clock, GitBranch, Folder, Filter, Check, Eye } from 'lucide-vue-next';
import he from 'he';
import { useGlobalSearch } from '../composables/useGlobalSearch';
import { useChatSearch, type SearchResultItem, type SearchScope, type ContentMatch } from '../composables/useChatSearch';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { useLayout } from '../composables/useLayout';
import { UNTITLED_CHAT_TITLE } from '../models/constants';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';

const SearchPreview = defineAsyncComponentAndLoadOnMounted(() => import('./SearchPreview.vue'));
const GroupSearchPreview = defineAsyncComponentAndLoadOnMounted(() => import('./GroupSearchPreview.vue'));

const router = useRouter();
const { isSearchOpen, closeSearch, chatGroupIds, chatId } = useGlobalSearch();
const { query, isSearching, isScanningContent, results, search, stopSearch } = useChatSearch();
const { openChat, openChatGroup, chatGroups, currentChat } = useChat();
const { setActiveFocusArea, activeFocusArea } = useLayout();
const {
  searchPreviewMode,
  searchContextSize,
  setSearchPreviewMode,
  setSearchContextSize,
} = useSettings();

const searchInput = ref<HTMLInputElement | null>(null);
const groupPreviewRef = ref<{
  navigate: (direction: 'up' | 'down') => void;
  handleEnter: () => void;
  selectedChatId: string | null;
    } | null>(null);
const selectedIndex = ref(0);
const scrollContainer = ref<HTMLElement | null>(null);
const searchScope = ref<SearchScope>('title_only');
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

// Reset focus to results when search result changes
watch(results, () => {
  activePane.value = 'results';
  updateHighlightState();
});

watch(query, () => {
  updateHighlightState();
}, { immediate: true });

const handleClickOutsideGroupSelector = (event: MouseEvent) => {
  const target = event.target as HTMLElement;
  if (showGroupSelector.value && !target.closest('.relative.shrink-0')) {
    showGroupSelector.value = false;
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutsideGroupSelector);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutsideGroupSelector);
});

const selectedGroups = computed(() => {
  return chatGroups.value.filter(g => chatGroupIds.value.includes(g.id));
});

const targetChatTitle = computed(() => {
  if (!chatId.value) return undefined;
  // If it's the current chat, we can get it from currentChat
  if (currentChat.value?.id === chatId.value) return currentChat.value.title || UNTITLED_CHAT_TITLE;
  // Otherwise we'd need to fetch it or rely on a generic name
  return 'Filtered Chat';
});

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
  hour: '2-digit', minute: '2-digit'
});

function formatTime({ timestamp }: { timestamp: number }) {
  return timeFormatter.format(new Date(timestamp));
}

function escapeRegExp({ string }: { string: string }) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Performance Optimization: Memoize highlighted strings.
// Regex matching and string concatenation are expensive during rapid list navigation.
const highlightCache = new Map<string, string>();

function highlight({ text, query, color }: {
  text: string,
  query: string,
  color: 'indigo' | 'blue',
}) {
  if (!query) return he.encode(text);

  const cacheKey = `${color}:${query}:${text}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;

  const keywords = query.toLowerCase().split(/[\s\u3000]+/).filter(k => k.length > 0);
  if (keywords.length === 0) return he.encode(text);

  const pattern = keywords.map(k => escapeRegExp({ string: k })).join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');

  const parts = text.split(regex);
  const colorClasses = (() => {
    switch (color) {
    case 'blue':
      return 'bg-blue-200 dark:bg-blue-900/50 text-blue-800 dark:text-blue-100';
    case 'indigo':
      return 'bg-indigo-200 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-100';
    default: {
      const _ex: never = color;
      throw new Error(`Unhandled color: ${_ex}`);
    }
    }
  })();

  const result = parts.map(part => {
    const isMatch = keywords.some(k => part.toLowerCase() === k);
    if (isMatch) {
      return `<span class="${colorClasses} font-bold rounded px-0.5">${he.encode(part)}</span>`;
    }
    return he.encode(part);
  }).join('');

  // Limit cache size to prevent memory leaks
  if (highlightCache.size > 1000) highlightCache.clear();
  highlightCache.set(cacheKey, result);
  return result;
}

// Clear highlight cache when results change
watch(results, () => {
  highlightCache.clear();
});

// Debounce search input
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

const performSearch = ({ val }: { val: string }) => {
  search({
    searchQuery: val,
    options: {
      scope: searchScope.value,
      chatGroupIds: chatGroupIds.value,
      chatId: chatId.value
    }
  });
  selectedIndex.value = 0;
};

const handleInput = (e: Event) => {
  const val = (e.target as HTMLInputElement).value;
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

watch([searchScope, chatGroupIds, chatId], () => {
  if (isSearchOpen.value && (query.value || searchScope.value === 'title_only')) {
    performSearch({ val: query.value });
  }
}, { deep: true });

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const pane = activePane.value;
    switch (pane) {
    case 'preview':
      if (groupPreviewRef.value) {
        groupPreviewRef.value.navigate('down');
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
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const pane = activePane.value;
    switch (pane) {
    case 'preview':
      if (groupPreviewRef.value) {
        groupPreviewRef.value.navigate('up');
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
  } else if (e.key === 'ArrowRight') {
    // If we are on a result item, focus the preview pane
    if (activePane.value === 'results' && currentSelectedItem.value) {
      e.preventDefault();
      activePane.value = 'preview';
    }
  } else if (e.key === 'ArrowLeft') {
    const pane = activePane.value;
    switch (pane) {
    case 'preview':
      e.preventDefault();
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
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activePane.value === 'preview' && groupPreviewRef.value) {
      groupPreviewRef.value.handleEnter();
    } else {
      selectItem({ index: selectedIndex.value });
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
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

watch(currentSelectedItem, (newItem) => {
  if (previewDebounceTimeout) clearTimeout(previewDebounceTimeout);
  previewDebounceTimeout = setTimeout(() => {
    deferredSelectedItem.value = newItem;
  }, 120);
}, { immediate: true });

function scrollToSelected() {
  nextTick(() => {
    if (!scrollContainer.value) return;
    const el = scrollContainer.value.querySelector(`[data-index="${selectedIndex.value}"]`);
    if (el) {
      // Performance Optimization: Use 'instant' behavior to avoid layout thrashing
      // during rapid navigation.
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  });
}

async function selectItem({ index }: { index: number }) {
  const target = results.value[index];
  if (!target) return;

  const type = target.type;
  switch (type) {
  case 'chat': {
    const chatItem = target.item;
    await openChat(chatItem.chatId);
    router.push(`/chat/${chatItem.chatId}`);
    closeSearch();
    break;
  }
  case 'message': {
    const matchItem = target.item;
    const parentChat = target.parentChat;
    await openChat(parentChat.chatId, matchItem.targetLeafId);
    router.push({
      path: `/chat/${parentChat.chatId}`,
      query: { leaf: matchItem.targetLeafId }
    });
    closeSearch();
    break;
  }
  case 'chat_group': {
    const groupItem = target.item;
    openChatGroup(groupItem.groupId);
    closeSearch();
    break;
  }
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled target type: ${_ex}`);
  }
  }
}

const previousFocusArea = ref<import('../composables/useLayout').FocusArea | undefined>(undefined);

watch(isSearchOpen, (isOpen) => {
  if (isOpen) {
    previousFocusArea.value = activeFocusArea.value;
    setActiveFocusArea('search');
    nextTick(() => {
      if (searchInput.value) {
        searchInput.value.focus();
        searchInput.value.select();
      }
      if (query.value || searchScope.value === 'title_only') {
        performSearch({ val: query.value });
      }
    });
  } else {
    stopSearch();
    if (previousFocusArea.value) {
      setActiveFocusArea(previousFocusArea.value);
      previousFocusArea.value = undefined;
    } else {
      setActiveFocusArea('chat');
    }
  }
});

defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition name="fade">
    <div v-if="isSearchOpen" class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4" @click.self="closeSearch">
      <!-- Backdrop (Added click handler for robust outside click closing) -->
      <div class="absolute inset-0 bg-black/20 dark:bg-black/50 backdrop-blur-sm transition-opacity" aria-hidden="true" @click="closeSearch" />

      <!-- Modal Container (Split View) -->
      <div class="relative w-full max-w-5xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 flex flex-col h-[70vh] overflow-hidden transform transition-all scale-100" @click.stop>

        <!-- Search Header -->
        <div class="flex items-center gap-3 p-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <Search class="w-5 h-5 text-gray-400" />
          <input
            ref="searchInput"
            :value="query"
            @input="handleInput"
            @keydown="handleKeydown"
            type="text"
            class="flex-1 bg-transparent border-none outline-none text-lg text-gray-900 dark:text-gray-100 placeholder-gray-400"
            placeholder="Search chats and messages..."
            aria-label="Search"
            data-testid="search-input"
          />
          <button @click="closeSearch" class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
            <kbd class="hidden sm:inline-block px-1.5 py-0.5 text-xs font-medium text-gray-500 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 mr-2">ESC</kbd>
            <X class="w-5 h-5 inline-block" />
          </button>
        </div>

        <!-- Search Options -->
        <div class="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between shrink-0 overflow-visible">
          <div class="flex items-center gap-1.5 min-w-0">
            <div class="flex items-center gap-1 shrink-0">
              <button
                v-for="scope in (['all', 'current_thread', 'title_only'] as SearchScope[])"
                :key="scope"
                @click="searchScope = scope"
                class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all"
                :class="searchScope === scope ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
              >
                {{ scope.replace('_', ' ') }}
              </button>
            </div>

            <div class="h-4 w-px bg-gray-200 dark:bg-gray-700 mx-1 shrink-0"></div>

            <!-- Group Filter Popover -->
            <div class="relative shrink-0">
              <button
                @click="showGroupSelector = !showGroupSelector"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all"
                :class="chatGroupIds.length > 0 ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
                data-testid="group-filter-button"
              >
                <Filter class="w-3 h-3" />
                <span>Groups</span>
                <span v-if="chatGroupIds.length > 0" class="ml-1 px-1.5 py-0.5 bg-indigo-600 text-white rounded-full text-[8px]">{{ chatGroupIds.length }}</span>
              </button>

              <Transition name="dropdown">
                <div
                  v-if="showGroupSelector"
                  class="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-xl z-50 py-1 overflow-hidden"
                  @click.stop
                  data-testid="group-selector-dropdown"
                >
                  <div class="px-3 py-2 border-b border-gray-50 dark:border-gray-700/50 text-[10px] font-black text-gray-400 uppercase tracking-widest">Filter by Group</div>
                  <div class="max-h-64 overflow-y-auto p-1">
                    <button
                      v-for="group in chatGroups"
                      :key="group.id"
                      @click="toggleGroupFilter({ groupId: group.id })"
                      class="w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors"
                      :class="chatGroupIds.includes(group.id) ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:indigo-text-400' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
                      :data-testid="'group-filter-item-' + group.id"
                    >
                      <div class="flex items-center gap-2 overflow-hidden">
                        <Folder class="w-3.5 h-3.5 shrink-0 opacity-60" />
                        <span class="truncate">{{ group.name }}</span>
                      </div>
                      <Check v-if="chatGroupIds.includes(group.id)" class="w-3.5 h-3.5 shrink-0" />
                    </button>
                    <div v-if="chatGroups.length === 0" class="p-4 text-center text-[10px] text-gray-400 italic">No groups available</div>
                  </div>
                  <div v-if="chatGroupIds.length > 0" class="p-1 border-t border-gray-50 dark:border-gray-700/50">
                    <button @click="chatGroupIds = []" class="w-full px-3 py-2 text-[10px] font-black text-gray-400 hover:text-red-500 uppercase tracking-widest text-center transition-colors">Clear All Filters</button>
                  </div>
                </div>
              </Transition>
            </div>

            <!-- Active Filters (Groups & Specific Chat) -->
            <div class="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
              <!-- Specific Chat Filter -->
              <div
                v-if="chatId"
                class="flex items-center gap-1.5 px-2 py-1 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-wider border border-indigo-100 dark:border-indigo-900/30 whitespace-nowrap"
              >
                <MessageSquare class="w-2.5 h-2.5" />
                <span>{{ targetChatTitle }}</span>
                <button @click="chatId = undefined" class="hover:text-indigo-800 dark:hover:text-indigo-300">
                  <X class="w-2.5 h-2.5" />
                </button>
              </div>

              <div
                v-for="group in selectedGroups"
                :key="group.id"
                class="flex items-center gap-1.5 px-2 py-1 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-wider border border-indigo-100 dark:border-indigo-900/30 whitespace-nowrap"
              >
                <span>{{ group.name }}</span>
                <button @click="toggleGroupFilter({ groupId: group.id })" class="hover:text-indigo-800 dark:hover:text-indigo-300">
                  <X class="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-4 text-[10px] font-bold text-gray-400 ml-4">
            <div class="flex items-center gap-2">
              <span>PREVIEW</span>
              <div class="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
                <button
                  v-for="mode in (['always', 'peek', 'disabled'] as const)"
                  :key="mode"
                  @click="setSearchPreviewMode({ mode })"
                  class="px-2 py-1 rounded-md transition-all uppercase tracking-tighter"
                  :class="searchPreviewMode === mode ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-gray-200 dark:hover:bg-gray-700'"
                >
                  {{ mode === 'always' ? 'on' : mode === 'disabled' ? 'off' : mode }}
                </button>
              </div>
            </div>

            <div v-if="isPreviewVisible" class="flex items-center gap-2">
              <span>CONTEXT</span>
              <select
                :value="searchContextSize === Infinity ? 'max' : searchContextSize"
                @change="e => setSearchContextSize((e.target as HTMLSelectElement).value === 'max' ? Infinity : parseInt((e.target as HTMLSelectElement).value))"
                class="bg-transparent border-none outline-none text-gray-600 dark:text-gray-300 font-black cursor-pointer"
              >
                <option :value="1">1</option>
                <option :value="2">2</option>
                <option :value="3">3</option>
                <option :value="5">5</option>
                <option value="max">FULL</option>
              </select>
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
            class="overflow-y-auto scrollbar-thin p-2 space-y-1 bg-white dark:bg-gray-900 transition-all duration-300 relative"
            :class="[
              isPreviewVisible
                ? (isPreviewExpanded ? 'w-[15%] min-w-[200px]' : (searchPreviewMode === 'peek' ? 'w-full' : 'w-[75%] min-w-[320px]'))
                : 'w-full',
              activePane === 'results' ? 'ring-2 ring-inset ring-blue-500/10' : ''
            ]"
          >
            <div v-if="!query && !isSearching && searchScope !== 'title_only'" class="p-8 text-center text-gray-400 text-sm">
              Type to search...
            </div>

            <div v-else-if="results.length === 0 && !isSearching" class="p-8 text-center text-gray-500 text-sm">
              No results found for "{{ query }}"
            </div>

            <template v-else>
              <div
                v-for="(entry, index) in results"
                :key="index"
                :data-index="index"
                :data-testid="'search-result-item-' + index"
                @mouseenter="selectedIndex = index"
                @click="selectItem({ index })"
                class="group flex flex-col p-2.5 rounded-xl cursor-pointer transition-[background-color,border-color,opacity] duration-200 border border-transparent"
                :class="selectedIndex === index
                  ? (activePane === 'results' ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800 shadow-sm' : 'bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700 opacity-80')
                  : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'"
              >
                <!-- Performance Note: CSS transitions are restricted to specific properties
                     to minimize layout recalculations during rapid list updates. -->

                <!-- Chat Group Item -->
                <div v-if="entry.type === 'chat_group'" class="flex items-center justify-between gap-3">
                  <div class="p-2 bg-blue-50 dark:bg-blue-900/30 rounded-lg shrink-0">
                    <Folder class="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div class="flex flex-col flex-1 overflow-hidden">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100" v-if="isHighlightingEnabled" v-html="highlight({ text: entry.item.name, query, color: 'blue' })"></span>
                      <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100" v-else>{{ entry.item.name }}</span>
                      <div class="flex items-center gap-1.5 shrink-0">
                        <span class="text-[9px] px-1.5 py-0.5 bg-blue-100/50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded font-black uppercase tracking-wider">{{ entry.item.chatCount }} chats</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Chat Header Item -->
                <div v-else-if="entry.type === 'chat'" class="flex items-center justify-between gap-3">
                  <div class="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg shrink-0">
                    <MessageSquare class="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  </div>
                  <div class="flex flex-col flex-1 overflow-hidden">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex flex-col overflow-hidden">
                        <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100" v-if="isHighlightingEnabled" v-html="highlight({ text: entry.item.title || UNTITLED_CHAT_TITLE, query, color: 'indigo' })"></span>
                        <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100" v-else>{{ entry.item.title || UNTITLED_CHAT_TITLE }}</span>
                        <span v-if="entry.item.groupName" class="text-[10px] text-gray-400 truncate flex items-center gap-1">
                          <Folder class="w-2.5 h-2.5 opacity-50 text-blue-500" />
                          <span v-if="isHighlightingEnabled" v-html="highlight({ text: entry.item.groupName, query, color: 'blue' })"></span>
                          <span v-else>{{ entry.item.groupName }}</span>
                        </span>
                      </div>
                      <span class="text-[10px] text-gray-400 shrink-0">{{ formatTime({ timestamp: entry.item.updatedAt }) }}</span>
                    </div>
                    <div class="flex items-center gap-1.5 mt-0.5">
                      <Clock class="w-3 h-3 text-gray-300" />
                      <span class="text-[10px] text-gray-400">Chat</span>
                    </div>
                  </div>
                </div>

                <!-- Message Match Item -->
                <div v-else-if="entry.type === 'message'" class="flex items-start gap-3 pl-10 opacity-90 relative">
                  <div class="absolute left-4 top-1 h-full w-0.5 bg-gray-100 dark:bg-gray-800"></div>
                  <CornerDownRight class="w-3 h-3 text-gray-300 mt-1 shrink-0" />
                  <div class="flex flex-col overflow-hidden text-sm flex-1">
                    <div class="flex items-center justify-between gap-2 mb-1">
                      <span class="text-[9px] font-black uppercase tracking-wider text-gray-400">{{ entry.item.role }}</span>
                      <span class="text-[9px] text-gray-400">{{ formatTime({ timestamp: entry.item.timestamp }) }}</span>
                    </div>
                    <span v-if="isHighlightingEnabled" class="text-gray-600 dark:text-gray-300 line-clamp-2 text-xs leading-relaxed" v-html="highlight({ text: entry.item.excerpt, query, color: 'indigo' })"></span>
                    <span v-else class="text-gray-600 dark:text-gray-300 line-clamp-2 text-xs leading-relaxed">{{ entry.item.excerpt }}</span>

                    <div v-if="!entry.item.isCurrentThread" class="flex items-center gap-1 mt-1.5 text-[9px] text-amber-600 dark:text-amber-500 font-bold">
                      <GitBranch class="w-2.5 h-2.5" />
                      <span>ALT BRANCH</span>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="isScanningContent" class="p-4 flex items-center justify-center text-gray-400 gap-2 border-t border-gray-50 dark:border-gray-800/50 mt-2">
                <Loader2 class="w-4 h-4 animate-spin" />
                <span class="text-[11px] font-bold">SCANNING CONTENT...</span>
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
                <GroupSearchPreview
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
                <Eye class="w-8 h-8 text-gray-400" />
                <span class="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500">Peek</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="p-2.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950/50 text-[10px] font-bold text-gray-400 flex justify-between px-6 shrink-0">
          <div class="flex gap-6">
            <span class="flex items-center gap-1.5"><kbd class="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-600 dark:text-gray-400 font-sans">↑↓</kbd> NAVIGATE</span>
            <span class="flex items-center gap-1.5"><kbd class="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-600 dark:text-gray-400 font-sans">↵</kbd> SELECT</span>
          </div>
          <div class="flex items-center gap-4">
            <span>{{ results.length }} CHATS FOUND</span>
            <span v-if="totalItems > 0">{{ totalItems }} TOTAL MATCHES</span>
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
