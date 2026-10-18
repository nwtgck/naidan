<script setup lang="ts">
import { computed } from 'vue';
import {
  GlobeIcon, DatabaseIcon, Settings2Icon, BookmarkPlusIcon,
  CpuIcon, InfoIcon, ChefHatIcon, DownloadIcon, BrainCircuitIcon,
  FolderIcon, FileIcon, WrenchIcon,
} from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { PortableAppDownloadTarget } from '@/features/file-protocol-standalone/logic/portable-app-download';
import ThemeToggle from '@/features/theme/components/ThemeToggle.vue';
import LanguageSelector from './LanguageSelector.vue';
import type { SettingsNavigationTab } from './settings-navigation';

const props = defineProps<{
  activeTab: SettingsNavigationTab;
  isVolumesFeatureEnabled: boolean;
  isRpcEnabled: boolean;
  isHostedMode: boolean;
  portableAppDownload: PortableAppDownloadTarget;
}>();

const emit = defineEmits<{
  (e: 'select', tab: SettingsNavigationTab): void;
}>();

// Resolve labels in the reactive boundary so language changes update every row.
const navigationGroups = computed(() => [
  [
    { tab: 'connection', label: lazyStrings.SettingsModal__connection(), icon: GlobeIcon, testId: 'tab-connection' },
    { tab: 'tools', label: lazyStrings.SettingsModal__tools(), icon: WrenchIcon, testId: 'tab-tools' },
    { tab: 'profiles', label: lazyStrings.SettingsModal__provider_profiles(), icon: BookmarkPlusIcon, testId: 'tab-profiles' },
  ],
  [
    { tab: 'llama_cpp_browser', label: lazyStrings.SettingsModal__llama_cpp_browser(), icon: BrainCircuitIcon, testId: 'tab-llama-cpp-browser' },
    { tab: 'transformers_js', label: lazyStrings.SettingsModal__transformers_js(), icon: BrainCircuitIcon, testId: 'tab-transformers-js' },
    { tab: 'recipes', label: lazyStrings.SettingsModal__recipes(), icon: ChefHatIcon, testId: 'tab-recipes' },
  ],
  [
    { tab: 'storage', label: lazyStrings.SettingsModal__storage(), icon: DatabaseIcon, testId: 'tab-storage' },
    { tab: 'binary_objects', label: lazyStrings.SettingsModal__files(), icon: FileIcon, testId: 'tab-files' },
    ...(props.isVolumesFeatureEnabled ? [{ tab: 'volumes', label: lazyStrings.SettingsModal__folders(), icon: FolderIcon, testId: 'tab-volumes' }] as const : []),
  ],
  [
    ...(props.isRpcEnabled ? [{ tab: 'naidan_rpc', label: lazyStrings.naidanRpc__title(), icon: CpuIcon, testId: 'tab-naidan-rpc' }] as const : []),
    { tab: 'developer', label: lazyStrings.SettingsModal__developer(), icon: CpuIcon, testId: 'tab-developer' },
    { tab: 'about', label: lazyStrings.SettingsModal__about(), icon: InfoIcon, testId: 'tab-about' },
  ],
] as const);


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <aside data-testid="settings-navigation" tw-class="flex min-h-0 w-full shrink-0 flex-col border-b border-gray-100 bg-gray-50/50 transition-colors md:w-72 md:border-b-0 md:border-r dark:border-gray-800/70 dark:bg-gray-950/30">
    <div data-testid="settings-navigation-header" tw-class="flex h-[60px] shrink-0 items-center gap-2 border-b border-gray-200/60 pl-4 pr-14 md:pr-4 dark:border-gray-800/70">
      <div tw-class="flex min-w-0 items-center gap-2">
        <Settings2Icon aria-hidden="true" tw-class="h-[18px] w-[18px] shrink-0 text-blue-600 dark:text-blue-400" />
        <h2 tw-class="truncate text-base font-semibold tracking-tight text-gray-900 dark:text-gray-100">{{ lazyStrings.SettingsModal__settings() }}</h2>
      </div>
      <div tw-class="ml-auto shrink-0">
        <LanguageSelector />
      </div>
      <slot name="close" />
    </div>

    <nav class="no-scrollbar" :aria-label="lazyStrings.SettingsModal__settings()" tw-class="flex min-h-0 flex-1 gap-3 overflow-x-auto overscroll-contain px-3 py-3 md:flex-col md:gap-0 md:overflow-y-auto md:py-2">
      <div
        v-for="(entries, index) in navigationGroups"
        :key="index"
        :tw-class="['flex shrink-0 gap-1 md:flex-col md:gap-0.5', index === 0 ? '' : 'border-l border-gray-200/70 pl-3 md:mt-2 md:border-l-0 md:border-t md:pt-2 md:pl-0 dark:border-gray-800/80']"
      >
        <button
          v-for="entry in entries"
          :key="entry.tab"
          type="button"
          :aria-current="activeTab === entry.tab ? 'page' : undefined"
          :title="entry.label"
          :data-testid="entry.testId"
          :tw-class="['flex h-10 min-w-0 shrink-0 items-center gap-3 whitespace-nowrap rounded-lg border px-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 focus-visible:ring-inset', activeTab === entry.tab ? 'border-gray-200 bg-white text-gray-950 dark:border-gray-700/80 dark:bg-gray-800/70 dark:text-gray-50' : 'border-transparent text-gray-600 hover:bg-gray-200/50 hover:text-gray-950 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-200']"
          @click="emit('select', entry.tab)"
        >
          <component :is="entry.icon" aria-hidden="true" :tw-class="['h-5 w-5 shrink-0', activeTab === entry.tab ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400']" />
          <span tw-class="min-w-0 truncate">{{ entry.label }}</span>
        </button>
      </div>
    </nav>

    <div tw-class="flex shrink-0 items-center gap-2 border-t border-gray-200/60 px-3 py-3 dark:border-gray-800/70">
      <div tw-class="w-28 shrink-0">
        <ThemeToggle />
      </div>
      <a
        v-if="isHostedMode"
        :href="portableAppDownload.href"
        :download="portableAppDownload.fileName"
        data-testid="sidebar-download-button"
        tw-class="group flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 no-underline transition-colors hover:bg-green-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400/50 dark:border-green-900/30 dark:bg-green-900/10 dark:hover:bg-green-900/20"
      >
        <DownloadIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-green-600 transition-transform group-hover:scale-110 dark:text-green-400" />
        <span tw-class="truncate text-[10px] font-bold text-green-800 md:text-xs dark:text-green-300">{{ lazyStrings.SettingsModal__standalone() }}</span>
      </a>
    </div>
  </aside>
</template>

<style scoped>
.no-scrollbar {
  scrollbar-width: none;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}

</style>
