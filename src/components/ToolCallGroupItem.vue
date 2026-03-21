<script setup lang="ts">
import { ref, computed } from 'vue';
import { Shapes, Bird } from 'lucide-vue-next';
import type { CombinedToolCall } from '@/models/types';
import type { FlowMetadata } from '@/composables/useChatDisplayFlow';
import ToolCallItem from './ToolCallItem.vue';

const props = withDefaults(defineProps<{
  toolCalls: CombinedToolCall[];
  flow?: FlowMetadata;
  isFirstInTurn?: boolean;
}>(), {
  flow: () => ({ position: 'standalone', nesting: 'none' }),
  isFirstInTurn: false
});

const isExpanded = ref(false); // Default collapsed for tool execution blocks

const toggleExpand = () => {
  isExpanded.value = !isExpanded.value;
};

const toolNamesDisplay = computed(() => {
  const names = props.toolCalls.map(tc => tc.call.function.name);
  const limit = 3;
  const displayedNames = names.slice(0, limit);
  const remaining = names.length - limit;

  let base = `Used ${displayedNames.join(', ')}`;
  if (remaining > 0) {
    base += ` and ${remaining} more`;
  }
  return base;
});

const isNested = computed(() => props.flow.nesting === 'inside-group');

defineExpose({
  __testOnly: {
    isExpanded,
    toggleExpand
  }
});
</script>

<template>
  <div
    v-if="toolCalls.length > 0"
    class="flex flex-col transition-colors"
    :class="[
      !isNested ? 'bg-gray-50/30 dark:bg-gray-800/20' : '',
      (!isNested && (flow.position === 'standalone' || flow.position === 'start')) ? 'border-t border-gray-100 dark:border-gray-800/50 pt-4' : 'pt-2',
      (!isNested && (flow.position === 'standalone' || flow.position === 'end')) ? 'border-b border-gray-100 dark:border-gray-800/50' : '',
      isNested ? 'pb-2' : ''
    ]"
    data-testid="tool-call-group"
  >
    <!-- Turn Header (Icon + Model ID) -->
    <div v-if="isFirstInTurn && !isNested" class="flex items-center gap-3 mb-1 px-5 pt-1 pb-2">
      <div class="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
        <Bird class="w-4 h-4 text-blue-600 dark:text-blue-400" />
      </div>
      <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 flex items-center gap-2">
        <span>Assistant</span>
      </div>
    </div>

    <div class="px-5" :class="(!isNested && (flow.position === 'standalone' || flow.position === 'end')) ? 'pb-3' : 'pb-2'">      <div
      @click="toggleExpand"
      class="transition-all duration-500 ease-in-out relative group/tool-group w-full cursor-pointer overflow-hidden border shadow-sm"
      :class="[
        /* Shape & Background */
        isExpanded
          ? 'p-5 rounded-2xl bg-gradient-to-br from-blue-50/50 to-sky-50/50 dark:from-blue-950/20 dark:to-sky-950/20 border-blue-100/50 dark:border-blue-800/30 shadow-inner'
          : 'px-3 py-1.5 rounded-xl bg-white dark:bg-gray-800/50 border-blue-100/50 dark:border-blue-800/30 hover:border-blue-200 dark:hover:border-blue-800'
      ]"
    >
      <!-- Header -->
      <div
        class="flex items-center gap-2 text-[10px] font-bold transition-colors tracking-wider relative z-20"
        data-testid="tool-call-group-header"
        :class="[
          isExpanded
            ? 'mb-2 text-blue-600 dark:text-blue-400'
            : 'text-gray-500 dark:text-gray-400 group-hover/tool-group:text-blue-600'
        ]"
      >
        <Shapes class="w-3.5 h-3.5" />
        <span>{{ isExpanded ? 'Hide Tool Executions' : toolNamesDisplay }}</span>
      </div>

      <!-- Content -->
      <Transition
        enter-active-class="transition-all duration-300 ease-out"
        leave-active-class="transition-all duration-200 ease-in"
        enter-from-class="opacity-0 translate-y-[-10px]"
        enter-to-class="opacity-100 translate-y-0"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 translate-y-[-10px]"
      >
        <div v-if="isExpanded" class="mt-1 animate-in fade-in slide-in-from-top-1 duration-200">
          <div class="flex flex-col gap-3">
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
  </div>
</template>
