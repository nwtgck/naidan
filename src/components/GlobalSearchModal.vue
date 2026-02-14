<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { Search, X, Loader2, MessageSquare, CornerDownRight, Clock, GitBranch, Folder, Filter, Check } from 'lucide-vue-next';
import he from 'he';
import { useGlobalSearch } from '../composables/useGlobalSearch';
import { useChatSearch, type SearchResultItem, type SearchScope, type ContentMatch } from '../composables/useChatSearch';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import SearchPreview from './SearchPreview.vue';

const router = useRouter();
const { isSearchOpen, closeSearch, chatGroupIds, chatId } = useGlobalSearch();
const { query, isSearching, results, search } = useChatSearch();
const { openChat, chatGroups, currentChat } = useChat();
const {
  searchPreviewEnabled,
  searchContextSize,
  setSearchPreviewEnabled,
  setSearchContextSize,
} = useSettings();

const searchInput = ref<HTMLInputElement | null>(null);
const selectedIndex = ref(0);
const scrollContainer = ref<HTMLElement | null>(null);
const searchScope = ref<SearchScope>('all');
const showGroupSelector = ref(false);

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
  if (!chatId.value) return null;
  // If it's the current chat, we can get it from currentChat
  if (currentChat.value?.id === chatId.value) return currentChat.value.title || 'This Chat';
  // Otherwise we'd need to fetch it or rely on a generic name
  return 'Filtered Chat';
});

function toggleGroupFilter(groupId: string) {
  const index = chatGroupIds.value.indexOf(groupId);
  if (index === -1) {
    chatGroupIds.value.push(groupId);
  } else {
    chatGroupIds.value.splice(index, 1);
  }
}

// Debounce search input
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

const performSearch = (val: string) => {
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
  if (debounceTimeout) clearTimeout(debounceTimeout);

  debounceTimeout = setTimeout(() => {
    performSearch(val);
  }, 300);
};

watch([searchScope, chatGroupIds, chatId], () => {
  if (isSearchOpen.value && query.value) {
    performSearch(query.value);
  }
}, { deep: true });

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, totalItems.value - 1);
    scrollToSelected();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
    scrollToSelected();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectItem(selectedIndex.value);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
};

const totalItems = computed(() => flatList.value.length);

function flattenResults(items: SearchResultItem[]) {
  const flat: { type: 'chat' | 'message'; item: SearchResultItem | ContentMatch; parentChat?: SearchResultItem }[] = [];

  for (const item of items) {
    flat.push({ type: 'chat', item });
    for (const match of item.contentMatches) {
      flat.push({ type: 'message', item: match, parentChat: item });
    }
  }
  return flat;
}

const flatList = computed(() => flattenResults(results.value));

const currentSelectedItem = computed(() => flatList.value[selectedIndex.value]);

function scrollToSelected() {
  nextTick(() => {
    if (!scrollContainer.value) return;
    const el = scrollContainer.value.querySelector(`[data-index="${selectedIndex.value}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

async function selectItem(index: number) {
  const target = flatList.value[index];
  if (!target) return;

  const type = target.type;
  switch (type) {
  case 'chat': {
    const chatItem = target.item as SearchResultItem;
    await openChat(chatItem.chatId);
    router.push(`/chat/${chatItem.chatId}`);
    break;
  }
  case 'message': {
    const matchItem = target.item as ContentMatch;
    const parentChat = target.parentChat!;
    await openChat(parentChat.chatId, matchItem.targetLeafId);
    router.push({
      path: `/chat/${parentChat.chatId}`,
      query: { leaf: matchItem.targetLeafId }
    });
    break;
  }
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled target type: ${_ex}`);
  }
  }
  closeSearch();
}

watch(isSearchOpen, (isOpen) => {
  if (isOpen) {
    // Clear old results immediately to avoid flicker
    results.value = [];
    nextTick(() => {
      searchInput.value?.focus();
      if (query.value) {
        performSearch(query.value);
      }
    });
  }
});

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(text: string, query: string) {
  if (!query) return he.encode(text);

  const keywords = query.toLowerCase().split(/[\s\u3000]+/).filter(k => k.length > 0);
  if (keywords.length === 0) return he.encode(text);

  const pattern = keywords.map(k => escapeRegExp(k)).join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');

  const parts = text.split(regex);
  return parts.map(part => {
    const isMatch = keywords.some(k => part.toLowerCase() === k);
    if (isMatch) {
      return `<span class="bg-indigo-200 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-100 font-bold rounded px-0.5">${he.encode(part)}</span>`;
    }
    return he.encode(part);
  }).join('');
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition name="fade">
    <div v-if="isSearchOpen" class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4" @click.self="closeSearch">
      <!-- Backdrop -->
      <div class="absolute inset-0 bg-black/20 dark:bg-black/50 backdrop-blur-sm transition-opacity" aria-hidden="true" />

      <!-- Modal Container (Split View) -->
      <div class="relative w-full max-w-5xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 flex flex-col h-[70vh] overflow-hidden transform transition-all scale-100">

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
                      @click="toggleGroupFilter(group.id)"
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
                <button @click="toggleGroupFilter(group.id)" class="hover:text-indigo-800 dark:hover:text-indigo-300">
                  <X class="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-4 text-[10px] font-bold text-gray-400 ml-4">
            <div class="flex items-center gap-2">
              <span>PREVIEW</span>
              <button
                @click="setSearchPreviewEnabled(!searchPreviewEnabled)"
                class="w-8 h-4 rounded-full transition-colors relative"
                :class="searchPreviewEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'"
              >
                <div
                  class="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform"
                  :class="searchPreviewEnabled ? 'translate-x-4' : 'translate-x-0'"
                ></div>
              </button>
            </div>

            <div v-if="searchPreviewEnabled" class="flex items-center gap-2">
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
            class="overflow-y-auto scrollbar-thin p-2 space-y-1 border-r border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 transition-all duration-300"
            :class="searchPreviewEnabled ? 'w-1/3 min-w-[320px]' : 'w-full'"
          >
            <div v-if="!query && !isSearching" class="p-8 text-center text-gray-400 text-sm">
              Type to search...
            </div>

            <div v-else-if="results.length === 0 && !isSearching" class="p-8 text-center text-gray-500 text-sm">
              No results found for "{{ query }}"
            </div>

            <template v-else>
              <div
                v-for="(entry, index) in flatList"
                :key="index"
                :data-index="index"
                :data-testid="'search-result-item-' + index"
                @mouseenter="selectedIndex = index"
                @click="selectItem(index)"
                class="group flex flex-col p-2.5 rounded-xl cursor-pointer transition-all border border-transparent"
                :class="selectedIndex === index ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800 shadow-sm' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'"
              >
                <!-- Chat Header Item -->
                <div v-if="entry.type === 'chat'" class="flex items-center justify-between gap-3">
                  <div class="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg shrink-0">
                    <MessageSquare class="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  </div>
                  <div class="flex flex-col flex-1 overflow-hidden">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100" v-html="highlight((entry.item as SearchResultItem).title || 'Untitled Chat', query)"></span>
                      <span class="text-[10px] text-gray-400 shrink-0">{{ formatTime((entry.item as SearchResultItem).updatedAt) }}</span>
                    </div>
                    <div class="flex items-center gap-1.5 mt-0.5">
                      <Clock class="w-3 h-3 text-gray-300" />
                      <span class="text-[10px] text-gray-400">Chat</span>
                    </div>
                  </div>
                </div>

                <!-- Message Match Item -->
                <div v-else class="flex items-start gap-3 pl-10 opacity-90 relative">
                  <div class="absolute left-4 top-1 h-full w-0.5 bg-gray-100 dark:bg-gray-800"></div>
                  <CornerDownRight class="w-3 h-3 text-gray-300 mt-1 shrink-0" />
                  <div class="flex flex-col overflow-hidden text-sm flex-1">
                    <div class="flex items-center justify-between gap-2 mb-1">
                      <span class="text-[9px] font-black uppercase tracking-wider text-gray-400">{{ (entry.item as ContentMatch).role }}</span>
                      <span class="text-[9px] text-gray-400">{{ formatTime((entry.item as ContentMatch).timestamp) }}</span>
                    </div>
                    <span class="text-gray-600 dark:text-gray-300 line-clamp-2 text-xs leading-relaxed" v-html="highlight((entry.item as ContentMatch).excerpt, query)"></span>

                    <div v-if="!(entry.item as ContentMatch).isCurrentThread" class="flex items-center gap-1 mt-1.5 text-[9px] text-amber-600 dark:text-amber-500 font-bold">
                      <GitBranch class="w-2.5 h-2.5" />
                      <span>ALT BRANCH</span>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="isSearching" class="p-4 flex items-center justify-center text-gray-400 gap-2 border-t border-gray-50 dark:border-gray-800/50 mt-2">
                <Loader2 class="w-4 h-4 animate-spin" />
                <span class="text-[11px] font-bold">SCANNING CONTENT...</span>
              </div>
            </template>
          </div>

          <!-- Right: Preview -->
          <div v-if="searchPreviewEnabled" class="flex-1 bg-white dark:bg-gray-900 overflow-hidden">
            <SearchPreview
              :match="currentSelectedItem?.type === 'message' ? currentSelectedItem.item as ContentMatch : undefined"
              :chat="currentSelectedItem?.type === 'chat' ? currentSelectedItem.item as SearchResultItem : undefined"
            />
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
