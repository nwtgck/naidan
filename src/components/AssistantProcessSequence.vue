<script setup lang="ts">
import { ref, computed } from 'vue';
import { Brain, Shapes, Activity, Loader2, ChevronDown, ChevronUp } from 'lucide-vue-next';
import type { ChatFlowItem, FlowMetadata, SequenceStats } from '../composables/useChatDisplayFlow';

const props = withDefaults(defineProps<{
  items: ChatFlowItem[];
  isProcessing: boolean;
  flow?: FlowMetadata;
  summary?: string;
  stats?: SequenceStats;
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
  })
});

const isExpanded = ref(false);

function toggle() {
  isExpanded.value = !isExpanded.value;
}

const displaySummary = computed(() => {
  return props.summary || 'Process Details';
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
      (flow.position === 'standalone' || flow.position === 'start') ? 'border-t border-gray-100 dark:border-gray-800/50 pt-2' : 'pt-0',
      (flow.position === 'standalone' || flow.position === 'end') ? 'border-b border-gray-100 dark:border-gray-800/50' : ''
    ]"
  >
    <!-- Integrated Container (Pill) -->
    <div class="px-5 py-2">
      <div 
        @click="toggle"
        class="flex flex-col transition-all group/seq shadow-sm overflow-hidden"
        :class="[
          isExpanded 
            ? 'bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100/30 dark:border-blue-800/20 rounded-2xl' 
            : 'bg-white dark:bg-gray-800/50 border border-blue-100/50 dark:border-blue-800/30 hover:border-blue-200 dark:hover:border-blue-800 rounded-xl cursor-pointer'
        ]"
        data-testid="assistant-process-toggle"
      >
        <!-- Header row inside the pill -->
        <div 
          class="flex items-center gap-3 px-3 py-1.5 transition-colors"
          :class="{ 'border-b border-blue-100/30 dark:border-blue-800/20': isExpanded }"
        >
          <div class="flex items-center -space-x-1">
            <Brain v-if="stats.thinkingSteps > 0" class="w-3.5 h-3.5" :class="stats.isCurrentlyThinking ? 'text-blue-600 dark:text-blue-400' : 'text-blue-500/60'" />
            <Shapes v-if="stats.toolCallCount > 0" class="w-3.5 h-3.5" :class="stats.isCurrentlyToolRunning ? 'text-purple-600 dark:text-purple-400' : 'text-purple-500/60'" />
            <Activity v-if="stats.thinkingSteps === 0 && stats.toolCallCount === 0" class="w-3.5 h-3.5 text-gray-400/60" />
          </div>
          <div class="text-[10px] font-bold text-gray-500 dark:text-gray-400 group-hover/seq:text-blue-600 tracking-wider flex-1 truncate">
            {{ displaySummary }}
          </div>
          <Loader2 v-if="isProcessing && (stats.isCurrentlyThinking || stats.isCurrentlyToolRunning || stats.isWaiting)" class="w-3 h-3 animate-spin text-blue-500/70" />
          <ChevronUp v-if="isExpanded" class="w-3.5 h-3.5 text-gray-400" />
          <ChevronDown v-else class="w-3.5 h-3.5 text-gray-400 group-hover/seq:text-blue-500" />
        </div>

        <!-- Peek Slot -->
        <div 
          v-if="!isExpanded && isProcessing && (stats.isCurrentlyThinking || stats.isWaiting)" 
          class="px-3 pb-3 pt-1 animate-in fade-in slide-in-from-top-1 duration-200"
        >
           <slot name="peek" />
        </div>
      </div>
    </div>
    
    <!-- Expanded Content Area -->
    <div v-if="isExpanded" class="animate-in fade-in slide-in-from-top-1 duration-200">
       <slot :is-expanded="isExpanded" />
    </div>
  </div>
</template>
