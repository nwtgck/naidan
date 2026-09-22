<script setup lang="ts">
import { ref } from 'vue';
import { Loader2Icon, ChevronDownIcon, ChevronRightIcon } from 'lucide-vue-next';
import type { ToolCallDraft } from '@/01-models/lm';
import { lazyStrings } from '@/strings';
import ShellExecuteToolCall from './ShellExecuteToolCall.vue';

defineProps<{ draft: ToolCallDraft }>();

const expanded = ref(true);

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <div tw-class="mb-2 last:mb-0 overflow-hidden rounded-xl border border-blue-100/50 dark:border-blue-800/30 bg-white/50 dark:bg-gray-800/30" data-testid="tool-call-draft">
    <button
      tw-class="flex w-full items-center gap-2 px-3 py-2 text-left text-[10px] text-gray-500 dark:text-gray-400"
      :aria-expanded="expanded"
      data-testid="tool-call-draft-toggle"
      @click="expanded = !expanded"
    >
      <Loader2Icon tw-class="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500 dark:text-blue-400" />
      <span tw-class="min-w-0 flex-1">
        <span tw-class="block font-semibold text-gray-700 dark:text-gray-200">{{ draft.name || lazyStrings.ToolCallDraftItem__generating_tool_call() }}</span>
        <span v-if="draft.name" tw-class="block text-[9px]">{{ lazyStrings.ToolCallDraftItem__generating_tool_call() }}</span>
      </span>
      <component :is="expanded ? ChevronDownIcon : ChevronRightIcon" tw-class="h-3 w-3 shrink-0" />
    </button>
    <div v-if="expanded && draft.arguments" tw-class="space-y-2 px-3 pb-3 max-h-60 overflow-y-auto" data-testid="tool-call-draft-arguments">
      <ShellExecuteToolCall v-if="draft.name === 'shell_execute'" :args="draft.arguments" :result="undefined" argument-state="partial" />
      <pre v-else tw-class="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-black/5 dark:bg-black/20 p-2 font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ draft.arguments }}</pre>
    </div>
  </div>
</template>
