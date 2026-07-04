<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { HammerIcon, CheckCircle2Icon, AlertCircleIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-vue-next';
import { ref } from 'vue';
import type { ToolCallRecord } from '@/01-models/tool';

const props = defineProps<{
  toolCall: ToolCallRecord,
}>();

const isExpanded = ref(true);

const toggleExpand = () => {
  isExpanded.value = !isExpanded.value;
};

const formatArgs = ({ args }: { args: unknown }): string => {
  try {
    return JSON.stringify(args, null, 2);
  } catch (e) {
    return String(args);
  }
};

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      isExpanded,
      toggleExpand,
    },
  }) || {}),
});
</script>

<template>
  <div
    :tw-class="['group/tool border rounded-xl overflow-hidden transition-all duration-300 shadow-sm mb-2 last:mb-0',
                toolCall.status === 'executing' ? 'bg-blue-50/20 border-blue-100/30 dark:bg-blue-900/10 dark:border-blue-800/20' : '',
                toolCall.status === 'success' ? 'bg-white/50 dark:bg-gray-800/30 border-gray-100/50 dark:border-gray-700/30' : '',
                toolCall.status === 'error' ? 'bg-red-50/20 border-red-100/30 dark:bg-red-900/10 dark:border-red-800/20' : ''
    ]"
    data-testid="lm-tool-call"
  >
    <!-- Tool Header -->
    <div
      @click="toggleExpand"
      tw-class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
    >
      <div tw-class="flex items-center gap-2.5">
        <div :tw-class="['p-1 rounded-lg',
                         toolCall.status === 'executing' ? 'bg-blue-100/50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : '',
                         toolCall.status === 'success' ? 'bg-gray-100 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400' : '',
                         toolCall.status === 'error' ? 'bg-red-100/50 dark:bg-red-900/30 text-red-600 dark:text-red-400' : ''
        ]">
          <HammerIcon v-if="toolCall.status === 'executing'" tw-class="w-3 h-3 animate-bounce" />
          <CheckCircle2Icon v-else-if="toolCall.status === 'success'" tw-class="w-3 h-3" />
          <AlertCircleIcon v-else tw-class="w-3 h-3" />
        </div>

        <div tw-class="flex flex-col">
          <span :tw-class="['text-[10px] font-bold capitalize tracking-wider',
                            toolCall.status === 'executing' ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'
          ]">
            {{ toolCall.toolName }}
          </span>
          <span v-if="toolCall.status === 'executing'" tw-class="text-[9px] text-blue-600/70 dark:text-blue-400/70 animate-pulse">
            {{ lazyStrings.toolCall__executing() }}
          </span>
        </div>
      </div>

      <button tw-class="p-1 text-gray-400 group-hover/tool:text-gray-600 dark:group-hover/tool:text-gray-300 transition-colors">
        <ChevronUpIcon v-if="isExpanded" tw-class="w-3.5 h-3.5" />
        <ChevronDownIcon v-else tw-class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Tool Details (Expandable) -->
    <Transition
      tw-enter-active-class="transition-all duration-300 ease-out"
      tw-leave-active-class="transition-all duration-200 ease-in"
      tw-enter-from-class="max-h-0 opacity-0"
      tw-enter-to-class="max-h-[500px] opacity-100"
      tw-leave-from-class="max-h-[500px] opacity-100"
      tw-leave-to-class="max-h-0 opacity-0"
    >
      <div v-if="isExpanded" tw-class="border-t border-inherit overflow-hidden">
        <div tw-class="p-3 flex flex-col gap-3">
          <!-- Arguments -->
          <div>
            <div tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">{{ lazyStrings.toolCall__arguments() }}</div>
            <pre class="custom-scrollbar" tw-class="text-[10px] font-mono p-2 bg-black/5 dark:bg-black/20 rounded-lg overflow-x-auto">{{ formatArgs({ args: toolCall.args }) }}</pre>
          </div>

          <!-- Result -->
          <div v-if="toolCall.status !== 'executing'">
            <div tw-class="text-[9px] font-bold text-gray-400 uppercase tracking-tight mb-1">
              {{ toolCall.status === 'success' ? lazyStrings.toolCall__result() : lazyStrings.toolCall__error() }}
            </div>
            <div
              :tw-class="['text-[10px] font-mono p-2 rounded-lg break-words', toolCall.status === 'success' ? 'bg-green-500/5 text-gray-700 dark:text-gray-300' : 'bg-red-500/5 text-red-600 dark:text-red-400']"
            >
              {{ toolCall.status === 'success' ? toolCall.result.content : toolCall.error.message }}
            </div>
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
