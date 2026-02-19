<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import { Folder, MessageSquare, Loader2, ChevronRight } from 'lucide-vue-next';
import { storageService, type ChatSummary } from '../services/storage';
import { UNTITLED_CHAT_TITLE } from '../models/constants';
import type { SearchResultItem } from '../composables/useChatSearch';
import { useChat } from '../composables/useChat';
import { useGlobalSearch } from '../composables/useGlobalSearch';
import { useRouter } from 'vue-router';
import SearchPreview from './SearchPreview.vue';

const props = defineProps<{
  groupId: string;
  groupName: string;
}>();

const router = useRouter();
const { openChat } = useChat();
const { closeSearch } = useGlobalSearch();

const chats = ref<ChatSummary[]>([]);
const isLoading = ref(false);
const selectedChatId = ref<string | null>(null);

const selectedChat = computed(() => chats.value.find(c => c.id === selectedChatId.value) || null);

async function selectAndNavigate(chatId: string) {
  await openChat(chatId);
  router.push(`/chat/${chatId}`);
  closeSearch();
}

function navigate(direction: 'up' | 'down') {
  if (chats.value.length === 0) return;
  const currentIndex = chats.value.findIndex(c => c.id === selectedChatId.value);
  let nextIndex = currentIndex;

  switch (direction) {
  case 'up':
    nextIndex = Math.max(0, currentIndex - 1);
    break;
  case 'down':
    nextIndex = Math.min(chats.value.length - 1, currentIndex + 1);
    break;
  default: {
    const _ex: never = direction;
    throw new Error(`Unhandled direction: ${_ex}`);
  }
  }

  const nextChat = chats.value[nextIndex];
  if (nextChat) {
    selectedChatId.value = nextChat.id;
    // Ensure the selected item is visible
    nextTick(() => {
      const el = document.querySelector(`[data-group-chat-id="${nextChat.id}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

function handleEnter() {
  if (selectedChatId.value) {
    selectAndNavigate(selectedChatId.value);
  }
}

defineExpose({
  navigate,
  handleEnter,
  selectedChatId,
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});

const selectedSearchResultItem = computed<Extract<SearchResultItem, { type: 'chat' }> | undefined>(() => {
  if (!selectedChat.value) return undefined;
  return {
    type: 'chat',
    chatId: selectedChat.value.id,
    title: selectedChat.value.title,
    updatedAt: selectedChat.value.updatedAt,
    matchType: 'title',
    contentMatches: []
  };
});

async function loadChats() {
  isLoading.value = true;
  try {
    const allChats = await storageService.listChats();
    const groupChats = allChats
      .filter(c => c.groupId === props.groupId)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    chats.value = groupChats;
    if (groupChats.length > 0 && groupChats[0]) {
      selectedChatId.value = groupChats[0].id;
    } else {
      selectedChatId.value = null;
    }
  } catch (e) {
    console.error('Failed to load chats for group preview:', e);
  } finally {
    isLoading.value = false;
  }
}

watch(() => props.groupId, loadChats, { immediate: true });

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric'
  });
}
</script>

<template>
  <div class="h-full flex flex-col bg-white dark:bg-gray-900">
    <!-- Group Info Bar (Top) -->
    <div class="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between bg-gray-50/50 dark:bg-gray-900/50 shrink-0">
      <div class="flex items-center gap-3">
        <div class="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-xl text-blue-600 dark:text-blue-400">
          <Folder class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-sm font-black text-gray-900 dark:text-gray-100 tracking-wider">{{ groupName }}</h3>
          <p class="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em]">Group Preview</p>
        </div>
      </div>
      <div class="text-[10px] font-black text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-lg">
        {{ chats.length }} CHATS
      </div>
    </div>

    <!-- Main Content Area -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Left: Chat List inside Group -->
      <div class="w-64 border-r border-gray-100 dark:border-gray-800 flex flex-col overflow-hidden bg-gray-50/30 dark:bg-gray-950/20 shrink-0">
        <div v-if="isLoading" class="flex-1 flex items-center justify-center">
          <Loader2 class="w-5 h-5 animate-spin text-gray-300" />
        </div>
        <div v-else-if="chats.length === 0" class="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <MessageSquare class="w-8 h-8 text-gray-200 dark:text-gray-800 mb-2" />
          <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Empty Group</p>
        </div>
        <div v-else class="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-hide">
          <div
            v-for="chat in chats"
            :key="chat.id"
            @click="selectedChatId = chat.id"
            :data-group-chat-id="chat.id"
            class="w-full h-12 flex items-center gap-3 px-3 rounded-xl transition-all cursor-pointer group relative overflow-hidden shrink-0"
            :class="selectedChatId === chat.id
              ? 'bg-blue-50 dark:bg-blue-900/20 shadow-sm border border-blue-100/50 dark:border-blue-800/50'
              : 'hover:bg-gray-100 dark:hover:bg-gray-800/50 border border-transparent'"
          >
            <div class="shrink-0 p-1.5 rounded-lg bg-white/50 dark:bg-gray-900/50">
              <MessageSquare class="w-3.5 h-3.5 text-gray-400" />
            </div>

            <div class="flex-1 min-w-0 flex flex-col justify-center">
              <span class="text-[11px] font-bold truncate" :class="selectedChatId === chat.id ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'">
                {{ chat.title || UNTITLED_CHAT_TITLE }}
              </span>
              <span class="text-[8px] text-gray-400 font-medium truncate">{{ formatTime(chat.updatedAt) }}</span>
            </div>

            <!-- Action Button (Doesn't change layout height) -->
            <button
              @click.stop="selectAndNavigate(chat.id)"
              class="shrink-0 p-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 shadow-sm hover:text-blue-600 dark:hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Open Chat"
            >
              <ChevronRight class="w-3.5 h-3.5" />
            </button>

            <!-- Selection Indicator -->
            <div v-if="selectedChatId === chat.id" class="absolute left-0 top-0 bottom-0 w-1 bg-blue-600 dark:bg-blue-500"></div>
          </div>
        </div>
      </div>

      <!-- Right: Detailed Chat Preview -->
      <div class="flex-1 overflow-hidden relative bg-white dark:bg-gray-900">
        <SearchPreview
          v-if="selectedSearchResultItem"
          :chat="selectedSearchResultItem"
          class="!border-l-0"
        />
        <div v-else class="h-full flex items-center justify-center text-gray-300 p-8 text-center uppercase text-[10px] font-black tracking-[0.2em]">
          Select a chat to preview
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
