<script setup lang="ts">
import { Hammer, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, FileText } from 'lucide-vue-next';
import { ref } from 'vue';
import type { CombinedToolCall } from '../models/types';

const props = defineProps<{
  toolCall: CombinedToolCall;
}>();

const isExpanded = ref(true);

const toggleExpand = () => {
  isExpanded.value = !isExpanded.value;
};

const formatArgs = ({ args }: { args: string | Record<string, unknown> }): string => {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch (e) {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch (e) {
    return String(args);
  }
};

defineExpose({
  __testOnly: {
    isExpanded,
    toggleExpand
  }
});
</script>

<template>
  <div
    class="group/tool border rounded-xl overflow-hidden transition-all duration-300 shadow-sm mb-2 last:mb-0"
    :class="[
      toolCall.result.status === 'running' ? 'bg-blue-50/20 border-blue-100/30 dark:bg-blue-900/10 dark:border-blue-800/20' : '',
      toolCall.result.status === 'success' ? 'bg-white/50 dark:bg-gray-800/30 border-gray-100/50 dark:border-gray-700/30' : '',
      toolCall.result.status === 'error' ? 'bg-red-50/20 border-red-100/30 dark:bg-red-900/10 dark:border-red-800/20' : ''
    ]"
    data-testid="lm-tool-call"
  >
    <!-- Tool Header -->
    <div
      @click="toggleExpand"
      class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
    >
      <div class="flex items-center gap-2.5">
        <div class="p-1 rounded-lg" :class="[
          toolCall.result.status === 'running' ? 'bg-blue-100/50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : '',
          toolCall.result.status === 'success' ? 'bg-gray-100 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400' : '',
          toolCall.result.status === 'error' ? 'bg-red-100/50 dark:bg-red-900/30 text-red-600 dark:text-red-400' : ''
        ]">
          <Hammer v-if="toolCall.result.status === 'running'" class="w-3 h-3 animate-bounce" />
          <CheckCircle2 v-else-if="toolCall.result.status === 'success'" class="w-3 h-3" />
          <AlertCircle v-else class="w-3 h-3" />
        </div>

        <div class="flex flex-col">
          <span class="text-[10px] font-bold capitalize tracking-wider" :class="[
            toolCall.result.status === 'running' ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'
          ]">
            {{ toolCall.call.function.name }}
          </span>
          <span v-if="toolCall.result.status === 'running'" class="text-[9px] text-blue-600/70 dark:text-blue-400/70 animate-pulse">
            Executing...
          </span>
        </div>
      </div>

      <button class="p-1 text-gray-400 group-hover/tool:text-gray-600 dark:group-hover/tool:text-gray-300 transition-colors">
        <ChevronUp v-if="isExpanded" class="w-3.5 h-3.5" />
        <ChevronDown v-else class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Tool Details (Expandable) -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="max-h-0 opacity-0"
      enter-to-class="max-h-[1500px] opacity-100"
      leave-from-class="max-h-[1500px] opacity-100"
      leave-to-class="max-h-0 opacity-0"
    >
      <div v-if="isExpanded" class="border-t border-inherit overflow-hidden">
        <div class="p-3 flex flex-col gap-3">
          <!-- Arguments -->
          <div>
            <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">Arguments</div>
            <pre class="text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto custom-scrollbar">{{ formatArgs({ args: toolCall.call.function.arguments }) }}</pre>
          </div>

          <!-- Result -->
          <div v-if="toolCall.result.status !== 'running'">
            <div class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">
              {{ toolCall.result.status === 'success' ? 'Result' : 'Error' }}
            </div>
            
            <template v-if="toolCall.result.status === 'success'">
              <div v-if="toolCall.result.content.type === 'text'"
                class="text-[10px] font-mono p-2 rounded-lg break-words bg-green-500/5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap"
              >
                {{ toolCall.result.content.text }}
              </div>
              <div v-else class="flex items-center gap-2 p-2 rounded-lg bg-blue-500/5 text-blue-600 dark:text-blue-400 text-[10px]">
                <FileText class="w-4 h-4" />
                <span>Binary Object: {{ toolCall.result.content.id }}</span>
              </div>
            </template>
            
            <template v-else-if="toolCall.result.status === 'error'">
              <div class="text-[10px] font-mono p-2 rounded-lg break-words bg-red-500/5 text-red-600 dark:text-red-400">
                <div class="font-bold mb-1 uppercase text-[8px] tracking-widest opacity-70">Code: {{ toolCall.result.error.code }}</div>
                <div v-if="toolCall.result.error.message.type === 'text'" class="whitespace-pre-wrap">{{ toolCall.result.error.message.text }}</div>
                <div v-else class="flex items-center gap-2">
                  <FileText class="w-3 h-3" />
                  <span>Binary Error Detail: {{ toolCall.result.error.message.id }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Transition>
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
