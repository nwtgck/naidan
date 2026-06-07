<script setup lang="ts">
import { computed } from 'vue';
import { BookOpenIcon, CalculatorIcon, InfoIcon } from 'lucide-vue-next';
import { useChatTools } from '@/composables/useChatTools';
import { useToolDependencyActions } from '@/composables/useToolDependencyActions';
import {
  WIKIPEDIA_GET_PAGE_TOOL_NAME,
  WIKIPEDIA_SEARCH_TOOL_NAME,
} from '@/services/tools/wikipedia';
import WeshToolSettings from './WeshToolSettings.vue';

const { isToolEnabled, toggleTool } = useChatTools();
const {
  enableWikipediaToolsForCurrentChat,
  disableWikipediaToolsForCurrentChat,
} = useToolDependencyActions();

const isWikipediaEnabled = computed(() => {
  return isToolEnabled({ name: WIKIPEDIA_SEARCH_TOOL_NAME })
    && isToolEnabled({ name: WIKIPEDIA_GET_PAGE_TOOL_NAME });
});

function toggleWikipedia(_args: Record<never, never>): void {
  if (isWikipediaEnabled.value) {
    disableWikipediaToolsForCurrentChat({});
    return;
  }
  enableWikipediaToolsForCurrentChat({});
}

defineExpose({
  TEST_ONLY: {
    isWikipediaEnabled,
    toggleWikipedia,
  }
});
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <button
        @click="toggleTool({ name: 'calculator' })"
        class="relative flex items-center gap-2.5 p-1.5 rounded-xl transition-all duration-300 text-left border overflow-hidden group active:scale-[0.98]"
        :class="isToolEnabled({ name: 'calculator' })
          ? 'bg-blue-50/50 dark:bg-blue-500/10 border-blue-200/50 dark:border-blue-500/30 shadow-sm'
          : 'bg-transparent border-gray-100 dark:border-gray-700/50 hover:border-gray-200 dark:hover:border-gray-700'"
        data-testid="tool-calculator-toggle"
      >
        <div
          class="p-1.5 rounded-lg transition-all duration-300 shrink-0"
          :class="isToolEnabled({ name: 'calculator' })
            ? 'bg-blue-600 text-white shadow-sm'
            : 'bg-gray-50 dark:bg-gray-900 text-gray-400 opacity-60'"
        >
          <CalculatorIcon class="w-3.5 h-3.5" />
        </div>

        <div class="flex-1 min-w-0" :class="{ 'opacity-80': !isToolEnabled({ name: 'calculator' }) }">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold tracking-tight" :class="isToolEnabled({ name: 'calculator' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300'">Calculator</span>
            <div v-if="isToolEnabled({ name: 'calculator' })" class="w-1 h-1 bg-blue-500 rounded-full"></div>
          </div>
          <div class="text-[10px] font-medium leading-tight truncate mt-0.5" :class="isToolEnabled({ name: 'calculator' }) ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'">
            Solve math expressions
          </div>
        </div>
      </button>

      <button
        @click="toggleWikipedia({})"
        class="relative flex items-center gap-2.5 p-1.5 rounded-xl transition-all duration-300 text-left border overflow-hidden group active:scale-[0.98]"
        :class="isWikipediaEnabled
          ? 'bg-blue-50/50 dark:bg-blue-500/10 border-blue-200/50 dark:border-blue-500/30 shadow-sm'
          : 'bg-transparent border-gray-100 dark:border-gray-700/50 hover:border-gray-200 dark:hover:border-gray-700'"
        data-testid="tool-wikipedia-toggle"
      >
        <div
          class="p-1.5 rounded-lg transition-all duration-300 shrink-0"
          :class="isWikipediaEnabled
            ? 'bg-blue-600 text-white shadow-sm'
            : 'bg-gray-50 dark:bg-gray-900 text-gray-400 opacity-60'"
        >
          <BookOpenIcon class="w-3.5 h-3.5" />
        </div>

        <div class="flex-1 min-w-0" :class="{ 'opacity-80': !isWikipediaEnabled }">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-bold tracking-tight" :class="isWikipediaEnabled ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300'">Wikipedia</span>
            <div v-if="isWikipediaEnabled" class="w-1 h-1 bg-blue-500 rounded-full"></div>
          </div>
          <div class="text-[10px] font-medium leading-tight truncate mt-0.5" :class="isWikipediaEnabled ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'">
            Access global knowledge
          </div>
          <div class="text-[9px] leading-tight truncate mt-1 text-gray-400 dark:text-gray-500">
            Uses sysfs Naidan for page text
          </div>
        </div>
      </button>

      <WeshToolSettings />
    </div>

    <div
      v-if="isWikipediaEnabled"
      class="flex items-start gap-3 px-4 py-2.5 bg-amber-50/50 dark:bg-amber-900/10 border border-amber-100/50 dark:border-amber-900/20 rounded-xl"
      data-testid="tool-wikipedia-note"
    >
      <InfoIcon class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
      <div class="text-[10px] leading-relaxed text-amber-800/80 dark:text-amber-300/80 italic font-medium">
        Wikipedia search keywords are sent to the external service without additional user approval.
      </div>
    </div>
  </div>
</template>
