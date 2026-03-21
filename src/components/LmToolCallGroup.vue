<script setup lang="ts">
import { ref } from 'vue';
import { Shapes, ChevronDown, ChevronUp } from 'lucide-vue-next';
import type { ToolCallRecord } from '@/services/tools/types';
import LmToolCall from './LmToolCall.vue';

defineProps<{
  toolCalls: ToolCallRecord[];
}>();

const isExpanded = ref(false); // Default collapsed

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
  <div v-if="toolCalls.length > 0" class="mb-3" data-testid="lm-tool-call-group">
    <div
      class="border rounded-xl transition-all duration-300 overflow-hidden"
      :class="[
        isExpanded
          ? 'bg-gray-50/30 dark:bg-gray-800/20 border-gray-100 dark:border-gray-800/50'
          : 'bg-white dark:bg-gray-800/50 border-gray-100/50 dark:border-gray-800/30 hover:border-gray-200 dark:hover:border-gray-700'
      ]"
    >
      <!-- Header / Toggle -->
      <div
        @click="toggleExpand"
        class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors group/tool-group"
      >
        <div class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider transition-colors"
             :class="isExpanded ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500 group-hover/tool-group:text-blue-600'"
        >
          <Shapes class="w-3.5 h-3.5" :class="isExpanded ? 'text-blue-600 dark:text-blue-400' : ''" />
          <span>{{ isExpanded ? 'Tool Executions' : `Show Tools (${toolCalls.length})` }}</span>
        </div>        <div class="p-0.5 text-gray-400 group-hover/tool-group:text-gray-600 dark:group-hover/tool-group:text-gray-300 transition-colors">
          <ChevronUp v-if="isExpanded" class="w-3.5 h-3.5" />
          <ChevronDown v-else class="w-3.5 h-3.5" />
        </div>
      </div>

      <!-- Content -->
      <div v-if="isExpanded" class="px-3 pb-3 border-t border-inherit pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
        <div class="flex flex-col">
          <LmToolCall
            v-for="tc in toolCalls"
            :key="tc.id"
            :tool-call="tc"
          />
        </div>
      </div>
    </div>
  </div>
</template>
