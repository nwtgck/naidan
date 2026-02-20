<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import { useRouter } from 'vue-router';
import { X, Eye, Search } from 'lucide-vue-next';
import { useRecentChats } from '../composables/useRecentChats';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { useLayout } from '../composables/useLayout';
import { UNTITLED_CHAT_TITLE } from '../models/constants';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
import RecentChatListItem from './RecentChatListItem.vue';

const SearchPreview = defineAsyncComponentAndLoadOnMounted(() => import('./SearchPreview.vue'));

const router = useRouter();
const { isRecentOpen, closeRecent, recentChats } = useRecentChats();
const { openChat, chatGroups } = useChat();
const { setActiveFocusArea, activeFocusArea } = useLayout();
const {
  searchPreviewMode,
  setSearchPreviewMode,
} = useSettings();

const filterQuery = ref('');
const selectedIndex = ref(0);
const scrollContainer = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const activePane = ref<'results' | 'preview'>('results');
const isExpandedByClick = ref(false);
const isHoveringResults = ref(false);
let previewHoverTimeout: ReturnType<typeof setTimeout> | null = null;

// Optimization: Pre-map group names to avoid repeated lookups in the loop
const groupNameMap = computed(() => {
  const map = new Map<string, string>();
  for (const group of chatGroups.value) {
    map.set(group.id, group.name);
  }
  return map;
});

const filteredRecentChats = computed(() => {
  const q = filterQuery.value.trim().toLowerCase();
  if (!q) return recentChats.value;
  return recentChats.value.filter(chat =>
    (chat.title || UNTITLED_CHAT_TITLE).toLowerCase().includes(q)
  );
});

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

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, totalItems.value - 1);
    scrollToSelected();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
    scrollToSelected();
  } else if (e.key === 'ArrowRight') {
    const pane = activePane.value;
    switch (pane) {
    case 'results':
      if (currentSelectedItem.value) {
        e.preventDefault();
        activePane.value = 'preview';
      }
      break;
    case 'preview':
      break;
    default: {
      const _ex: never = pane;
      throw new Error(`Unhandled pane: ${_ex}`);
    }
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
      break;
    default: {
      const _ex: never = pane;
      throw new Error(`Unhandled pane: ${_ex}`);
    }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectItem({ index: selectedIndex.value });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeRecent();
  }
};

const totalItems = computed(() => filteredRecentChats.value.length);
const currentSelectedItem = computed(() => filteredRecentChats.value[selectedIndex.value]);

// Performance Optimization: Debounce the preview update during list navigation.
// Increased delay to 250ms for even snappier navigation.
const deferredSelectedItem = ref(currentSelectedItem.value);
let previewDebounceTimeout: ReturnType<typeof setTimeout> | null = null;

watch(currentSelectedItem, (newItem) => {
  if (previewDebounceTimeout) clearTimeout(previewDebounceTimeout);
  previewDebounceTimeout = setTimeout(() => {
    deferredSelectedItem.value = newItem;
  }, 250);
}, { immediate: true });

function scrollToSelected() {
  nextTick(() => {
    if (!scrollContainer.value) return;
    const el = scrollContainer.value.querySelector(`[data-index="${selectedIndex.value}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  });
}

async function selectItem({ index }: { index: number }) {
  const target = filteredRecentChats.value[index];
  if (!target) return;

  await openChat(target.id);
  router.push(`/chat/${target.id}`);
  closeRecent();
}

const previousFocusArea = ref<import('../composables/useLayout').FocusArea | undefined>(undefined);

watch(isRecentOpen, (isOpen) => {
  if (isOpen) {
    previousFocusArea.value = activeFocusArea.value;
    setActiveFocusArea('search');
    selectedIndex.value = 0;
    activePane.value = 'results';
    filterQuery.value = '';
    nextTick(() => {
      searchInput.value?.focus();
    });
  } else {
    if (previousFocusArea.value) {
      setActiveFocusArea(previousFocusArea.value);
      previousFocusArea.value = undefined;
    } else {
      setActiveFocusArea('chat');
    }
  }
});

const mappedDeferredItem = computed(() => {
  if (!deferredSelectedItem.value) return undefined;
  return {
    type: 'chat' as const,
    chatId: deferredSelectedItem.value.id,
    title: deferredSelectedItem.value.title,
    groupId: deferredSelectedItem.value.groupId,
    updatedAt: deferredSelectedItem.value.updatedAt,
    matchType: 'title' as const,
    contentMatches: [],
  };
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition name="fade">
    <div v-if="isRecentOpen" class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4" @click.self="closeRecent">
      <div class="absolute inset-0 bg-black/20 dark:bg-black/50 backdrop-blur-sm transition-opacity" aria-hidden="true" @click="closeRecent" />

      <div class="relative w-full max-w-5xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 flex flex-col h-[70vh] overflow-hidden transform transition-all scale-100 outline-none" @click.stop @keydown="handleKeydown" tabindex="-1">

        <div class="flex items-center gap-3 p-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <Search class="w-5 h-5 text-gray-400" />
          <input
            ref="searchInput"
            v-model="filterQuery"
            @keydown="handleKeydown"
            type="text"
            class="flex-1 bg-transparent border-none outline-none text-lg text-gray-900 dark:text-gray-100 placeholder-gray-400"
            placeholder="Filter recent chats..."
            aria-label="Filter"
            data-testid="recent-filter-input"
          />
          <button @click="closeRecent" class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
            <kbd class="hidden sm:inline-block px-1.5 py-0.5 text-xs font-medium text-gray-500 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 mr-2">ESC</kbd>
            <X class="w-5 h-5 inline-block" />
          </button>
        </div>

        <div class="flex-1 flex overflow-hidden min-h-0">
          <div
            ref="scrollContainer"
            tabindex="-1"
            @mouseenter="isHoveringResults = true"
            @mouseleave="isHoveringResults = false"
            class="overflow-y-auto scrollbar-thin p-2 space-y-1 bg-white dark:bg-gray-900 transition-all duration-300 relative outline-none"
            :class="[
              isPreviewVisible
                ? (isPreviewExpanded ? 'w-[15%] min-w-[200px]' : (searchPreviewMode === 'peek' ? 'w-full' : 'w-[75%] min-w-[320px]'))
                : 'w-full',
              activePane === 'results' ? 'ring-2 ring-inset ring-blue-500/10' : ''
            ]"
          >
            <div v-if="filteredRecentChats.length === 0" class="p-8 text-center text-gray-500 text-sm">
              {{ filterQuery ? 'No chats match your filter.' : 'No recent chats.' }}
            </div>

            <template v-else>
              <RecentChatListItem
                v-for="(chat, index) in filteredRecentChats"
                :key="chat.id"
                v-memo="[chat.id, selectedIndex === index, activePane]"
                :data-index="index"
                :chat="chat"
                :group-name="groupNameMap.get(chat.groupId || '')"
                :is-selected="selectedIndex === index"
                :active-pane="activePane"
                @mouseenter="selectedIndex = index"
                @click="selectItem({ index })"
              />
            </template>
          </div>

          <div v-if="isPreviewVisible && recentChats.length > 0"
               @mouseenter="handlePreviewMouseEnter"
               @mouseleave="handlePreviewMouseLeave"
               @click.capture="!isPreviewExpanded ? (isExpandedByClick = true, $event.stopPropagation(), $event.preventDefault()) : null"
               class="bg-white dark:bg-gray-900 overflow-hidden transition-all duration-300 border-l border-gray-100 dark:border-gray-800 cursor-pointer relative"
               :class="[
                 isPreviewExpanded ? 'w-[85%]' : 'w-[25%]',
                 activePane === 'preview' ? 'ring-2 ring-inset ring-blue-500/20' : ''
               ]">
            <template v-if="shouldLoadPreview">
              <SearchPreview
                :chat="mappedDeferredItem"
              />
            </template>
            <div v-else class="h-full flex items-center justify-center bg-gray-50/50 dark:bg-gray-950/20">
              <div class="flex flex-col items-center gap-2 opacity-20">
                <Eye class="w-8 h-8 text-gray-400" />
                <span class="text-[10px] font-black uppercase tracking-[0.3em] text-gray-500">Peek</span>
              </div>
            </div>
          </div>
        </div>

        <div class="p-2.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950/50 text-[10px] font-bold text-gray-400 flex justify-between px-6 shrink-0">
          <div class="flex gap-6">
            <span class="flex items-center gap-1.5"><kbd class="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-600 dark:text-gray-400 font-sans">↑↓</kbd> NAVIGATE</span>
            <span class="flex items-center gap-1.5"><kbd class="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-600 dark:text-gray-400 font-sans">↵</kbd> SELECT</span>
            <span class="flex items-center gap-1.5"><kbd class="px-1.5 py-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-600 dark:text-gray-400 font-sans">→</kbd> PREVIEW</span>
          </div>
          <div class="flex items-center gap-4">
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

kbd {
  box-shadow: 0 1px 0 rgba(0,0,0,0.1);
}
</style>
