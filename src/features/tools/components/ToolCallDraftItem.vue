<script setup lang="ts">
import { ref, watch } from 'vue';
import { Loader2Icon, ChevronDownIcon, ChevronRightIcon } from 'lucide-vue-next';
import type { ToolCallDraft } from '@/01-models/lm';
import { lazyStrings } from '@/strings';
import ShellExecuteToolCall from './ShellExecuteToolCall.vue';

const props = defineProps<{ draft: ToolCallDraft }>();

const expanded = ref(true);
const argumentsContainer = ref<HTMLDivElement>();
const argumentsContent = ref<HTMLDivElement>();
let followState: 'following' | 'paused' = 'following';
let lastScrollTop = 0;
let lastContainer: HTMLDivElement | undefined;

function onArgumentsScroll(): void {
  const container = argumentsContainer.value;
  if (!container) return;
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  const scrollTop = Math.max(0, container.scrollTop);
  if (maximum - scrollTop <= 2) {
    followState = 'following';
  } else if (scrollTop < lastScrollTop) {
    followState = 'paused';
  }
  // Content growth can leave the old offset above the new bottom without a user
  // scroll. Only movement towards earlier content pauses automatic following.
  lastScrollTop = scrollTop;
}

function followArgumentsTail(): void {
  const container = argumentsContainer.value;
  if (!container) return;
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  if (container !== lastContainer) {
    // Reopening a collapsed preview preserves the reader's paused position.
    container.scrollTop = Math.min(lastScrollTop, maximum);
    lastContainer = container;
  } else if (container.scrollTop < Math.min(lastScrollTop, maximum)) {
    // A user scroll may precede its scroll event. Do not undo it when a new
    // argument chunk arrives; browser clamping after shorter text is harmless.
    followState = 'paused';
  }
  switch (followState) {
  case 'following':
    container.scrollTop = maximum;
    break;
  case 'paused':
    break;
  default: {
    const _ex: never = followState;
    throw new Error(`Unhandled scroll follow state: ${_ex}`);
  }
  }
  lastScrollTop = Math.max(0, container.scrollTop);
}

watch(
  [() => props.draft.arguments, () => props.draft.name, argumentsContainer],
  followArgumentsTail,
  { flush: 'post' },
);

watch(argumentsContent, (content, _previous, onCleanup) => {
  if (!content || typeof ResizeObserver === 'undefined') return;
  // Highlighted text may render asynchronously after the draft prop update.
  // Observe the content, since the capped scroll viewport no longer grows.
  let observing = true;
  const observer = new ResizeObserver(() => {
    if (observing && argumentsContent.value === content) followArgumentsTail();
  });
  observer.observe(content);
  onCleanup(() => {
    observing = false;
    observer.disconnect();
  });
}, { flush: 'post' });

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
    <div v-if="expanded && draft.arguments" ref="argumentsContainer" tw-class="px-3 pb-3 max-h-60 overflow-y-auto" data-testid="tool-call-draft-arguments" @scroll="onArgumentsScroll">
      <div ref="argumentsContent" tw-class="space-y-2" data-testid="tool-call-draft-content">
        <ShellExecuteToolCall v-if="draft.name === 'shell_execute'" :args="draft.arguments" :result="undefined" argument-state="partial" />
        <pre v-else tw-class="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-black/5 dark:bg-black/20 p-2 font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ draft.arguments }}</pre>
      </div>
    </div>
  </div>
</template>
