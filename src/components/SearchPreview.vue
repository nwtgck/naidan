<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { ContentMatch, SearchResultItem } from '../composables/useChatSearch';
import { Clock, GitBranch, Loader2, MessageSquare } from 'lucide-vue-next';
import { storageService } from '../services/storage';
import { getChatBranch } from '../utils/chat-tree';
import type { MessageNode, Chat } from '../models/types';
import { useSettings } from '../composables/useSettings';
import MessageItem from './MessageItem.vue';

const props = defineProps<{
  match?: ContentMatch;
  chat?: SearchResultItem;
}>();

const { searchContextSize } = useSettings();
const isLoading = ref(false);
const branchMessages = ref<MessageNode[]>([]);
const matchedIndex = ref(-1);

const CONTEXT_SIZE = computed(() => searchContextSize.value);

async function loadContext() {
  if (!props.match) {
    branchMessages.value = [];
    matchedIndex.value = -1;
    return;
  }

  isLoading.value = true;
  try {
    const fullChat = await storageService.loadChat(props.match.chatId);
    if (fullChat) {
      // We want the branch that leads to the targetLeafId of the match
      const virtualChat: Chat = {
        ...fullChat,
        currentLeafId: props.match.targetLeafId
      };
      const branch = getChatBranch(virtualChat);
      branchMessages.value = branch;
      matchedIndex.value = branch.findIndex(m => m.id === props.match?.messageId);
    }
  } catch (e) {
    console.error('Failed to load context for search preview:', e);
  } finally {
    isLoading.value = false;
  }
}

watch(() => props.match?.messageId, loadContext, { immediate: true });

const visibleMessages = computed(() => {
  if (matchedIndex.value === -1) return [];
  const start = Math.max(0, matchedIndex.value - CONTEXT_SIZE.value);
  const end = Math.min(branchMessages.value.length, matchedIndex.value + CONTEXT_SIZE.value + 1);
  return branchMessages.value.slice(start, end);
});

const formatDate = (ts: number) => {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
};

// Dummy handlers for MessageItem
const handleDummy = () => {};


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="h-full flex flex-col bg-gray-50/50 dark:bg-gray-900/50 border-l border-gray-100 dark:border-gray-800">
    <div v-if="!match && !chat" class="flex-1 flex items-center justify-center text-gray-400 p-8 text-center">
      <div class="flex flex-col items-center gap-4">
        <div class="p-4 bg-gray-100 dark:bg-gray-800 rounded-2xl">
          <MessageSquare class="w-8 h-8 opacity-20" />
        </div>
        <span class="text-sm font-bold uppercase tracking-widest opacity-50">Select an item to preview</span>
      </div>
    </div>

    <!-- Loading State -->
    <div v-else-if="isLoading" class="flex-1 flex items-center justify-center text-gray-400">
      <Loader2 class="w-6 h-6 animate-spin" />
    </div>

    <!-- Chat Preview (When a chat header is selected) -->
    <div v-else-if="chat && !match" class="flex-1 p-8 space-y-6 overflow-y-auto">
      <div class="space-y-2">
        <h3 class="text-2xl font-black text-gray-900 dark:text-gray-100 leading-tight">{{ chat.title || 'Untitled Chat' }}</h3>
        <div class="flex items-center gap-3 text-[11px] font-bold text-gray-400 uppercase tracking-widest">
          <Clock class="w-3.5 h-3.5" />
          <span>Last updated: {{ formatDate(chat.updatedAt) }}</span>
        </div>
      </div>

      <div class="p-4 bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 text-blue-700 dark:text-blue-300 rounded-2xl text-xs font-bold flex items-center gap-3">
        <div class="p-2 bg-blue-100 dark:bg-blue-900/50 rounded-xl">
          <MessageSquare class="w-4 h-4" />
        </div>
        <span>TITLE MATCH FOUND IN THIS CHAT</span>
      </div>
    </div>

    <!-- Message Match Preview (With Context) -->
    <div v-else-if="match" class="flex-1 flex flex-col overflow-hidden">
      <div class="p-4 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 flex justify-between items-center shrink-0">
        <div class="text-[11px] font-black text-gray-400 uppercase tracking-widest flex items-center gap-2">
          <span>Conversation Context</span>
          <span class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px]">{{ visibleMessages.length }} messages</span>
        </div>

        <div v-if="!match.isCurrentThread" class="flex items-center gap-1.5 text-[10px] font-bold bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 px-3 py-1 rounded-full border border-amber-100 dark:border-amber-800/50">
          <GitBranch class="w-3.5 h-3.5" />
          <span>ALTERNATIVE BRANCH</span>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto bg-white dark:bg-gray-900/50">
        <div v-if="matchedIndex > CONTEXT_SIZE" class="p-4 text-center">
          <span class="text-[10px] font-bold text-gray-300 uppercase tracking-[0.2em]">... previous messages ...</span>
        </div>

        <div v-for="msg in visibleMessages" :key="msg.id" class="relative">
          <div v-if="msg.id === match.messageId" class="absolute inset-0 bg-yellow-50/30 dark:bg-yellow-900/5 border-y-2 border-yellow-200/50 dark:border-yellow-900/20 pointer-events-none z-0"></div>
          <MessageItem
            :message="msg"
            class="relative z-10"
            :class="{ 'opacity-50 grayscale-[0.5]': msg.id !== match.messageId }"
            @fork="handleDummy"
            @edit="handleDummy"
            @switch-version="handleDummy"
            @regenerate="handleDummy"
          />
        </div>

        <div v-if="matchedIndex + CONTEXT_SIZE < branchMessages.length - 1" class="p-4 text-center">
          <span class="text-[10px] font-bold text-gray-300 uppercase tracking-[0.2em]">... following messages ...</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../style.css";

/* Ensure the preview area looks distinct but matches the main chat style */
:deep(.group) {
  @apply !border-none;
}
</style>
