<script setup lang="ts">
import { ref } from 'vue';
import { Shapes, ChevronDown, ChevronUp } from 'lucide-vue-next';
import type { CombinedToolCall } from '../models/types';
import ToolCallItem from './ToolCallItem.vue';

defineProps<{
  toolCalls: CombinedToolCall[];
}>();

const isExpanded = ref(true); // Default expanded for new tool execution blocks

const toggleExpand = () => {
  isExpanded.value = !isExpanded.value;
};

defineExpose({
  __testOnly: {
    isExpanded,
    toggleExpand
  }
});
</script>

<template>
  <div v-if="toolCalls.length > 0" class="mb-3 max-w-[95%] mx-auto" data-testid="tool-call-group">
    <div
      class="border rounded-2xl transition-all duration-300 overflow-hidden"
      :class="[
        isExpanded
          ? 'bg-gray-50/50 dark:bg-gray-800/30 border-gray-200/50 dark:border-gray-700/50 shadow-sm'
          : 'bg-white dark:bg-gray-800/50 border-gray-100/50 dark:border-gray-800/30 hover:border-gray-200 dark:hover:border-gray-700'
      ]"
    >
      <!-- Header / Toggle -->
      <div
        @click="toggleExpand"
        class="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors group/tool-group"
      >
        <div class="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest transition-colors"
             :class="isExpanded ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500 group-hover/tool-group:text-blue-600'"
        >
          <div class="p-1 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <Shapes class="w-4 h-4" />
          </div>
          <span>{{ isExpanded ? 'Tool Executions' : `Show Tools (${toolCalls.length})` }}</span>
        </div>
        <div class="p-1 rounded-lg text-gray-400 group-hover/tool-group:bg-gray-100 dark:group-hover/tool-group:bg-gray-700 group-hover/tool-group:text-gray-600 dark:group-hover/tool-group:text-gray-300 transition-all">
          <ChevronUp v-if="isExpanded" class="w-4 h-4" />
          <ChevronDown v-else class="w-4 h-4" />
        </div>
      </div>

      <!-- Content -->
      <Transition
        enter-active-class="transition-all duration-300 ease-out"
        leave-active-class="transition-all duration-200 ease-in"
        enter-from-class="max-h-0 opacity-0"
        enter-to-class="max-h-[2000px] opacity-100"
        leave-from-class="max-h-[2000px] opacity-100"
        leave-to-class="max-h-0 opacity-0"
      >
        <div v-if="isExpanded" class="px-4 pb-4 pt-1 border-t border-gray-100/50 dark:border-gray-700/50">
          <div class="flex flex-col gap-2">
            <ToolCallItem
              v-for="tc in toolCalls"
              :key="tc.nodeId"
              :tool-call="tc"
            />
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>
