<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ArrowLeftIcon, AudioLinesIcon, MicIcon, SettingsIcon, SlidersHorizontalIcon, SquarePenIcon } from 'lucide-vue-next';
import SidebarHeader from '@/components/SidebarHeader.vue';
import SidebarDebugControls from '@/components/SidebarDebugControls.vue';
import { useLayout } from '@/composables/useLayout';
import { lazyStrings } from '@/strings';
import type { LiveConversationNavigation } from '@/features/live-conversation/navigation';

defineProps<{ navigation: LiveConversationNavigation }>();
const { isSidebarOpen, toggleSidebar } = useLayout();
const route = useRoute(), router = useRouter();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <nav tw-class="flex h-full flex-col select-none bg-white text-gray-900 transition-colors dark:bg-gray-900 dark:text-gray-100" :aria-label="lazyStrings.liveConversation__live_conversation()" data-testid="live-conversation-sidebar">
    <SidebarHeader :expanded="isSidebarOpen" @toggle="toggleSidebar" />
    <div :tw-class="['py-2', isSidebarOpen ? 'px-4' : 'px-1']">
      <button type="button" :disabled="!navigation.canReset.value" @click="navigation.newConversation" :title="lazyStrings.liveConversation__new_conversation()" :aria-label="lazyStrings.liveConversation__new_conversation()" :tw-class="['flex min-h-9 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-gray-50/70 font-medium text-gray-700 transition-colors hover:border-blue-200 hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-200 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10', isSidebarOpen ? 'w-full px-3 py-2.5 text-xs' : 'h-9 w-9']" data-testid="live-sidebar-new"><SquarePenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span v-if="isSidebarOpen" tw-class="truncate">{{ lazyStrings.liveConversation__new_conversation() }}</span></button>
    </div>
    <div :tw-class="['min-h-0 flex-1 space-y-1 overflow-y-auto', isSidebarOpen ? 'px-2' : 'px-1']">
      <button type="button" :disabled="navigation.busy.value" @click="navigation.openConversation" :aria-current="navigation.panel.value === 'conversation' ? 'page' : undefined" :title="lazyStrings.liveConversation__conversation()" :tw-class="['flex min-h-11 w-full items-center gap-2.5 rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-45', isSidebarOpen ? 'px-3 py-2.5' : 'justify-center p-2', navigation.panel.value === 'conversation' ? 'border-gray-200/80 bg-gray-100/80 dark:border-gray-700/60 dark:bg-gray-800/80' : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/40']" data-testid="live-sidebar-microphone"><MicIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span v-if="isSidebarOpen" tw-class="min-w-0"><span tw-class="block text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__conversation() }}</span><span tw-class="mt-0.5 block text-[10px] leading-4 text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__conversation_and_responses() }}</span></span></button>
    </div>
    <div :tw-class="['space-y-1 border-t border-gray-100 dark:border-gray-800', isSidebarOpen ? 'p-3' : 'p-1']">
      <p v-if="isSidebarOpen && navigation.modelName.value" tw-class="truncate px-2 pb-2 text-[10px] text-gray-400 dark:text-gray-500" :title="navigation.modelName.value">{{ navigation.modelName.value }}</p>
      <button type="button" @click="navigation.openSettings" :title="lazyStrings.liveConversation__conversation_settings()" tw-class="flex w-full items-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-sidebar-settings"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.liveConversation__conversation_settings() }}</span></button>
      <button type="button" :disabled="navigation.busy.value" @click="navigation.openDiagnostics" :aria-current="navigation.panel.value === 'diagnostics' ? 'page' : undefined" :title="lazyStrings.liveConversation__diagnostics()" :tw-class="['flex w-full items-center gap-2 rounded-xl p-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-45', navigation.panel.value === 'diagnostics' ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" data-testid="live-sidebar-diagnostics"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.liveConversation__diagnostics() }}</span></button>
      <p v-if="isSidebarOpen && navigation.panel.value === 'diagnostics' && navigation.fileName.value" :title="navigation.fileName.value" tw-class="truncate px-2 pb-1 text-[10px] text-gray-400 dark:text-gray-500">{{ navigation.fileName.value }}</p>
      <RouterLink to="/" :title="lazyStrings.liveConversation__back_to_chats()" tw-class="flex items-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-sidebar-back"><ArrowLeftIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.liveConversation__back_to_chats() }}</span></RouterLink>
      <div :tw-class="['flex items-center gap-2', { 'flex-col items-center': !isSidebarOpen }]"><button type="button" @click="router.push({ query: { ...route.query, settings: 'connection' } })" :title="lazyStrings.Sidebar__settings()" :tw-class="['flex items-center justify-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800', isSidebarOpen ? 'min-w-0 flex-1' : 'h-8 w-8']"><SettingsIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.Sidebar__settings() }}</span></button><SidebarDebugControls :is-sidebar-open="isSidebarOpen" /></div>
    </div>
  </nav>
</template>
