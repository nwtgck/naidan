<script setup lang="ts">
import { Hammer, CheckCircle2, AlertCircle, ChevronDown, ChevronUp } from 'lucide-vue-next';
import { ref } from 'vue';
import type { ToolCallRecord } from '../services/tools/types';

defineProps<{
  toolCalls: ToolCallRecord[];
}>();

const expandedIds = ref<Set<string>>(new Set());

const toggleExpand = ({ id }: { id: string }) => {
  if (expandedIds.value.has(id)) {
    expandedIds.value.delete(id);
  } else {
    expandedIds.value.add(id);
  }
};

const formatArgs = ({ args }: { args: unknown }): string => {
  try {
    return JSON.stringify(args, null, 2);
  } catch (e) {
    return String(args);
  }
};


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div v-if="toolCalls.length > 0" class="flex flex-col gap-2 mb-4" data-testid="lm-tool-calls">
    <div
      v-for="tc in toolCalls"
      :key="tc.id"
      class="group/tool border rounded-xl overflow-hidden transition-all duration-300"
      :class="[
        tc.status === 'running' ? 'bg-blue-50/30 border-blue-100 dark:bg-blue-900/10 dark:border-blue-800/30' : '',
        tc.status === 'success' ? 'bg-gray-50/50 border-gray-100 dark:bg-gray-800/20 dark:border-gray-700/50' : '',
        tc.status === 'error' ? 'bg-red-50/30 border-red-100 dark:bg-red-900/10 dark:border-red-800/30' : ''
      ]"
    >
      <!-- Tool Header -->
      <div
        @click="toggleExpand({ id: tc.id })"
        class="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <div class="flex items-center gap-2.5">
          <div class="p-1.5 rounded-lg" :class="[
            tc.status === 'running' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400' : '',
            tc.status === 'success' ? 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400' : '',
            tc.status === 'error' ? 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400' : ''
          ]">
            <Hammer v-if="tc.status === 'running'" class="w-3.5 h-3.5 animate-bounce" />
            <CheckCircle2 v-else-if="tc.status === 'success'" class="w-3.5 h-3.5" />
            <AlertCircle v-else class="w-3.5 h-3.5" />
          </div>

          <div class="flex flex-col">
            <span class="text-[10px] font-bold uppercase tracking-widest" :class="[
              tc.status === 'running' ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'
            ]">
              {{ tc.toolName }}
            </span>
            <span v-if="tc.status === 'running'" class="text-[9px] text-blue-600/70 dark:text-blue-400/70 animate-pulse">
              Executing...
            </span>
          </div>
        </div>

        <button class="p-1 text-gray-400 group-hover/tool:text-gray-600 dark:group-hover/tool:text-gray-300 transition-colors">
          <ChevronUp v-if="expandedIds.has(tc.id)" class="w-4 h-4" />
          <ChevronDown v-else class="w-4 h-4" />
        </button>
      </div>

      <!-- Tool Details (Expandable) -->
      <Transition
        enter-active-class="transition-all duration-300 ease-out"
        leave-active-class="transition-all duration-200 ease-in"
        enter-from-class="max-h-0 opacity-0"
        enter-to-class="max-h-[500px] opacity-100"
        leave-from-class="max-h-[500px] opacity-100"
        leave-to-class="max-h-0 opacity-0"
      >
        <div v-if="expandedIds.has(tc.id)" class="border-t border-inherit overflow-hidden">
          <div class="p-3 flex flex-col gap-3">
            <!-- Arguments -->
            <div>
              <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">Arguments</div>
              <pre class="text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto custom-scrollbar">{{ formatArgs({ args: tc.args }) }}</pre>
            </div>

            <!-- Result -->
            <div v-if="tc.status !== 'running'">
              <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">
                {{ tc.status === 'success' ? 'Result' : 'Error' }}
              </div>
              <div
                class="text-[10px] font-mono p-2 rounded-lg break-words"
                :class="tc.status === 'success' ? 'bg-green-500/5 text-gray-700 dark:text-gray-300' : 'bg-red-500/5 text-red-600 dark:text-red-400'"
              >
                {{ tc.status === 'success' ? tc.result.content : tc.error.message }}
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  height: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.2);
  border-radius: 10px;
}
</style>
