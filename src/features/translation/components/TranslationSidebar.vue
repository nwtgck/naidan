<script setup lang="ts">
import { FolderOpenIcon, LanguagesIcon } from 'lucide-vue-next';
import { useLayout } from '@/composables/useLayout';
import { lazyStrings } from '@/strings';
import type { TranslationNavigation } from '@/features/translation/navigation';
defineProps<{ navigation: TranslationNavigation }>();
const { isSidebarOpen } = useLayout();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <nav data-testid="translation-sidebar" :aria-label="lazyStrings.translation__translation()" tw-class="flex h-full min-h-0 flex-col overflow-y-auto bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
    <div :tw-class="['flex-1 space-y-1 py-3', isSidebarOpen ? 'px-3' : 'px-1']">
      <button type="button" aria-current="page" :title="lazyStrings.translation__translation()" :aria-label="lazyStrings.translation__translation()" data-testid="translation-nav-workspace" @click="navigation.openWorkspace" tw-class="flex min-h-9 w-full items-center gap-2 rounded-xl bg-gray-100 p-2 text-xs font-medium text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-gray-800 dark:text-white"><LanguagesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.translation__translation() }}</span></button>
      <button type="button" aria-haspopup="dialog" :title="lazyStrings.translation__translation_models()" :aria-label="lazyStrings.translation__translation_models()" data-testid="translation-nav-models" @click="navigation.openModels" tw-class="flex min-h-9 w-full items-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.translation__translation_models() }}</span></button>
    </div>
  </nav>
</template>
