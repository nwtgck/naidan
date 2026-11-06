<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ArrowLeftIcon, FolderOpenIcon, LanguagesIcon, SettingsIcon } from 'lucide-vue-next';
import SidebarHeader from '@/components/SidebarHeader.vue';
import SidebarDebugControls from '@/components/SidebarDebugControls.vue';
import { useLayout } from '@/composables/useLayout';
import { lazyStrings } from '@/strings';
import type { TranslationNavigation } from '@/features/translation/navigation';
defineProps<{ navigation: TranslationNavigation }>();
const route = useRoute(), router = useRouter();
const { isSidebarOpen, toggleSidebar } = useLayout();
const models = computed(() => route.path.replace(/\/+$/, '') === '/translation/models');
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <nav data-testid="translation-sidebar" :aria-label="lazyStrings.translation__translation()" tw-class="flex h-full flex-col bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
    <SidebarHeader :expanded="isSidebarOpen" @toggle="toggleSidebar" />
    <div :tw-class="['flex-1 space-y-1 py-3', isSidebarOpen ? 'px-3' : 'px-1']">
      <button type="button" :aria-current="!models ? 'page' : undefined" :title="lazyStrings.translation__translation()" :aria-label="lazyStrings.translation__translation()" data-testid="translation-nav-workspace" @click="navigation.openWorkspace" :tw-class="['flex min-h-9 w-full items-center gap-2 rounded-xl p-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', !models ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']"><LanguagesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.translation__translation() }}</span></button>
      <button type="button" :aria-current="models ? 'page' : undefined" :title="lazyStrings.translation__translation_models()" :aria-label="lazyStrings.translation__translation_models()" data-testid="translation-nav-models" @click="navigation.openModels" :tw-class="['flex min-h-9 w-full items-center gap-2 rounded-xl p-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', models ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.translation__translation_models() }}</span></button>
    </div>
    <div :tw-class="['space-y-1 border-t border-gray-100 dark:border-gray-800', isSidebarOpen ? 'p-3' : 'p-1']">
      <RouterLink to="/" data-testid="translation-back-to-chats" :title="lazyStrings.translation__back_to_chats()" :aria-label="lazyStrings.translation__back_to_chats()" tw-class="flex min-h-9 items-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800"><ArrowLeftIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.translation__back_to_chats() }}</span></RouterLink>
      <div :tw-class="['flex items-center gap-2', { 'flex-col': !isSidebarOpen }]">
        <button type="button" :title="lazyStrings.Sidebar__settings()" :aria-label="lazyStrings.Sidebar__settings()" @click="router.push({ query: { ...route.query, settings: 'connection' } })" tw-class="flex min-h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"><SettingsIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.Sidebar__settings() }}</span></button>
        <SidebarDebugControls :is-sidebar-open="isSidebarOpen" />
      </div>
    </div>
  </nav>
</template>
