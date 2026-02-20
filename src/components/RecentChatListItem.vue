<script setup lang="ts">
import { computed } from 'vue';
import { Folder, MessageSquare } from 'lucide-vue-next';
import { UNTITLED_CHAT_TITLE } from '../models/constants';
import RelativeTime from './RelativeTime.vue';
import type { ChatSummary } from '../models/types';

const props = defineProps<{
  chat: ChatSummary & { accessedAt: number };
  groupName?: string;
  isSelected: boolean;
  activePane: 'results' | 'preview';
}>();

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit'
});

function formatTime({ timestamp }: { timestamp: number }) {
  return timeFormatter.format(new Date(timestamp));
}

// Optimization: Pre-calculate classes to avoid complex logic in template
const containerClasses = computed(() => {
  const base = 'group flex flex-col p-2.5 rounded-xl cursor-pointer transition-[background-color,border-color,opacity] duration-150 border border-transparent';
  if (!props.isSelected) return `${base} hover:bg-gray-50 dark:hover:bg-gray-800/50`;

  const pane = props.activePane;
  switch (pane) {
  case 'results':
    return `${base} bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800 shadow-sm`;
  case 'preview':
    return `${base} bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700 opacity-80`;
  default: {
    const _ex: never = pane;
    throw new Error(`Unhandled pane: ${_ex}`);
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
  <div :class="containerClasses">
    <div class="flex items-center justify-between gap-3">
      <div class="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg shrink-0">
        <MessageSquare class="w-4 h-4" :class="isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'" />
      </div>
      <div class="flex flex-col flex-1 overflow-hidden">
        <div class="flex items-center justify-between gap-2">
          <div class="flex flex-col overflow-hidden">
            <span class="font-bold text-sm truncate text-gray-900 dark:text-gray-100">{{ chat.title || UNTITLED_CHAT_TITLE }}</span>
            <span v-if="groupName" class="text-[10px] text-gray-400 truncate flex items-center gap-1">
              <Folder class="w-2.5 h-2.5 opacity-50 text-blue-500" />
              <span>{{ groupName }}</span>
            </span>
            <span class="text-[10px] text-gray-400 truncate opacity-60">
              <RelativeTime :timestamp="chat.accessedAt" prefix="Accessed " />
            </span>
          </div>
          <span class="text-[10px] text-gray-400 shrink-0">{{ formatTime({ timestamp: chat.accessedAt }) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
