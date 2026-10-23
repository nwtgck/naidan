<script setup lang="ts">
import { ChevronRightIcon, ListIcon } from 'lucide-vue-next';
import { useAppEntry } from '@/composables/useAppEntry';
import { lazyStrings } from '@/strings';

import WelcomeScreen from './WelcomeScreen.vue';
const entry = useAppEntry();

function chooseModel(): void {
  entry.openModelSelection({ target: { kind: 'home' }, selection: entry.homeSelection.value, opener: document.activeElement instanceof HTMLElement ? document.activeElement : undefined });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="home-welcome" :inert="entry.interaction.value === 'blocked' || undefined" :aria-busy="entry.interaction.value === 'blocked'" tw-class="relative h-full min-h-0 overflow-auto bg-[#fcfcfd] dark:bg-gray-900">
    <WelcomeScreen layout="standalone" suggestions-visibility="hidden">
      <template #model-selection>
        <button type="button" data-testid="open-model-welcome" aria-haspopup="dialog" tw-class="group inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-lg border border-gray-200/80 bg-white/70 px-4 py-2 text-sm font-medium text-gray-600 transition-colors duration-200 hover:border-blue-200/80 hover:bg-blue-50/60 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-300 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10 dark:hover:text-gray-100 motion-reduce:transition-none" @click="chooseModel"><ListIcon aria-hidden="true" tw-class="h-4 w-4 text-gray-400 dark:text-gray-500" /><span>{{ lazyStrings.BrowserModelWelcome__choose_a_model() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 transition-transform group-hover:translate-x-0.5 dark:text-gray-500 motion-reduce:transition-none" /></button>
      </template>
    </WelcomeScreen>
  </div>
</template>
