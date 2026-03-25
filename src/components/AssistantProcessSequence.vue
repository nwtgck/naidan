<script setup lang="ts">
import { ref, computed, provide, nextTick } from 'vue';
import { Loader2, Eye, EyeOff, Bird } from 'lucide-vue-next';
import type { ChatFlowItem, FlowMetadata, SequenceStats } from '@/composables/useChatDisplayFlow';

const props = withDefaults(defineProps<{
  items: ChatFlowItem[];
  isProcessing: boolean;
  flow?: FlowMetadata;
  summary?: string;
  stats?: SequenceStats;
  isFirstInTurn?: boolean;
}>(), {
  flow: () => ({ position: 'standalone', nesting: 'none' }),
  summary: '',
  stats: () => ({
    thinkingSteps: 0,
    toolCallCount: 0,
    toolNames: [],
    isCurrentlyThinking: false,
    isCurrentlyToolRunning: false,
    isWaiting: false
  }),
  isFirstInTurn: false
});

const isExpanded = ref(false);
const toggleRef = ref<HTMLElement | null>(null);

provide('inSequence', true);

async function toggle() {
  const wasExpanded = isExpanded.value;
  isExpanded.value = !wasExpanded;
  // When collapsing, scroll the toggle back into view so the user
  // doesn't end up at the bottom of the now-hidden content.
  if (wasExpanded) {
    await nextTick();
    toggleRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

const displaySummary = computed(() => {
  return props.summary || 'Process Details';
});

const modelId = computed(() => {
  const first = props.items[0];
  if (!first) return undefined;
  const type = first.type;
  switch (type) {
  case 'message':
    return first.node.modelId;
  case 'tool_group':
    return first.node.modelId;
  case 'process_sequence':
    return undefined;
  default: {
    const _ex: never = type;
    return _ex;
  }
  }
});

defineExpose({
  __testOnly: {
    isExpanded,
    toggle
  }
});
</script>

<template>
  <div
    class="assistant-process-sequence flex flex-col transition-all duration-300 bg-gray-50/30 dark:bg-gray-800/20"
    :class="[
      (flow.position === 'standalone' || flow.position === 'start') ? 'border-t border-gray-100 dark:border-gray-800/50 pt-1.5' : 'pt-0',
      (flow.position === 'standalone' || flow.position === 'end') ? 'border-b border-gray-100 dark:border-gray-800/50' : ''
    ]"
  >
    <!-- Turn Header (Icon + Model ID) -->
    <div v-if="isFirstInTurn" class="flex items-center gap-3 mb-1 px-5 pt-3">
      <div class="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
        <Bird class="w-4 h-4 text-blue-600 dark:text-blue-400" />
      </div>
      <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 flex items-center gap-2">
        <span>{{ modelId || 'Assistant' }}</span>
      </div>
    </div>

    <!-- Compact Show/Less Toggle -->
    <div ref="toggleRef" class="px-5 py-1" :class="isExpanded ? 'sticky top-0 z-10 bg-gray-50/80 dark:bg-gray-800/80 backdrop-blur-sm' : ''">
      <div
        @click="toggle"
        class="inline-flex items-center gap-2 px-2.5 py-1 transition-all duration-200 group/seq cursor-pointer rounded-lg border shadow-sm select-none"
        :class="[
          isExpanded
            ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200/60 dark:border-blue-800/60 text-blue-700 dark:text-blue-300'
            : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:border-blue-300 dark:hover:border-blue-700 hover:text-blue-600'
        ]"
        data-testid="assistant-process-toggle"
      >
        <!-- Status/Action Icon -->
        <div class="flex-shrink-0">
          <Loader2 v-if="isProcessing && (stats.isCurrentlyThinking || stats.isCurrentlyToolRunning || stats.isWaiting)" class="w-3 h-3 animate-spin text-blue-500/70" data-testid="icon-loader" />
          <component :is="isExpanded ? EyeOff : Eye" v-else class="w-3 h-3 transition-transform duration-300" :class="{ 'opacity-60': !isExpanded }" />
        </div>

        <!-- Summary Text -->
        <div class="text-[10px] font-bold tracking-tight truncate max-w-[200px] sm:max-w-md">
          {{ displaySummary }}
        </div>

        <!-- Action Label -->
        <div class="text-[8px] uppercase font-black tracking-tighter opacity-0 group-hover/seq:opacity-100 transition-opacity pl-1 border-l border-current/10 ml-0.5">
          {{ isExpanded ? 'Less' : 'Show' }}
        </div>
      </div>
    </div>

    <!-- Peek Slot (During processing) -->
    <div
      v-if="!isExpanded && isProcessing && (stats.isCurrentlyThinking || stats.isWaiting)"
      class="px-5 pb-2 pt-0.5 animate-in fade-in slide-in-from-top-1 duration-300"
    >
      <div class="bg-white/40 dark:bg-gray-800/40 rounded-lg border border-blue-100/30 dark:border-blue-900/20 p-0.5">
        <slot name="peek" />
      </div>
    </div>

    <!-- Expanded Content -->
    <div
      class="grid transition-[grid-template-rows] duration-500 ease-in-out"
      :class="isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
    >
      <div class="min-h-0 overflow-hidden">
        <div class="pb-3 pt-1 animate-in fade-in duration-500">
          <slot :is-expanded="isExpanded" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.min-h-0 {
  min-height: 0;
}
</style>

<style scoped>
/* Ensure content doesn't flicker during height change */
.min-h-0 {
  min-height: 0;
}
</style>
