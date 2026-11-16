<script setup lang="ts">
import { AudioLinesIcon, MicIcon, SlidersHorizontalIcon } from 'lucide-vue-next';
import { useLayout } from '@/composables/useLayout';
import { lazyStrings } from '@/strings';
import type { LiveConversationNavigation } from '@/features/live-conversation/navigation';

defineProps<{ navigation: LiveConversationNavigation }>();
const { isSidebarOpen } = useLayout();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <nav tw-class="flex h-full flex-col select-none bg-white text-gray-900 transition-colors dark:bg-gray-900 dark:text-gray-100" :aria-label="lazyStrings.liveConversation__live_conversation()" data-testid="live-conversation-sidebar">
    <div :tw-class="['min-h-0 flex-1 space-y-1 overflow-y-auto', isSidebarOpen ? 'px-2' : 'px-1']">
      <button type="button" :disabled="navigation.busy.value" @click="navigation.openConversation" :aria-current="navigation.panel.value === 'conversation' ? 'page' : undefined" :title="lazyStrings.liveConversation__conversation()" :aria-label="lazyStrings.liveConversation__conversation()" :tw-class="['flex min-h-11 w-full items-center gap-2.5 rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-45', isSidebarOpen ? 'px-3 py-2.5' : 'justify-center p-2', navigation.panel.value === 'conversation' ? 'border-gray-200/80 bg-gray-100/80 dark:border-gray-700/60 dark:bg-gray-800/80' : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/40']" data-testid="live-sidebar-microphone"><MicIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span v-if="isSidebarOpen" tw-class="min-w-0"><span tw-class="block text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__conversation() }}</span><span tw-class="mt-0.5 block text-[10px] leading-4 text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__conversation_and_responses() }}</span></span></button>
    </div>
    <div :tw-class="['space-y-1 border-t border-gray-100 dark:border-gray-800', isSidebarOpen ? 'p-3' : 'p-1']">
      <p v-if="isSidebarOpen && navigation.modelName.value" tw-class="truncate px-2 pb-2 text-[10px] text-gray-400 dark:text-gray-500" :title="navigation.modelName.value">{{ navigation.modelName.value }}</p>
      <button type="button" @click="navigation.openSettings" :title="lazyStrings.liveConversation__conversation_settings()" :aria-label="lazyStrings.liveConversation__conversation_settings()" tw-class="flex w-full items-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-sidebar-settings"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.liveConversation__conversation_settings() }}</span></button>
      <button type="button" :disabled="navigation.busy.value" @click="navigation.openDiagnostics" :aria-current="navigation.panel.value === 'diagnostics' ? 'page' : undefined" :title="lazyStrings.liveConversation__diagnostics()" :aria-label="lazyStrings.liveConversation__diagnostics()" :tw-class="['flex w-full items-center gap-2 rounded-xl p-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-45', navigation.panel.value === 'diagnostics' ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" data-testid="live-sidebar-diagnostics"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.liveConversation__diagnostics() }}</span></button>
      <p v-if="isSidebarOpen && navigation.panel.value === 'diagnostics' && navigation.fileName.value" :title="navigation.fileName.value" tw-class="truncate px-2 pb-1 text-[10px] text-gray-400 dark:text-gray-500">{{ navigation.fileName.value }}</p>

    </div>
  </nav>
</template>
