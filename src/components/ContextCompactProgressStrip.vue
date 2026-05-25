<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Loader2Icon, SquareIcon } from 'lucide-vue-next';
import type { ContextCompactProgress } from '@/services/context-compact';
import { toContextCompactDisplayProgress } from '@/services/context-compact';

const props = defineProps<{
  progress: ContextCompactProgress;
}>();

defineEmits<{
  (e: 'abort'): void;
}>();

const display = computed(() => {
  return toContextCompactDisplayProgress({
    progress: props.progress,
    nowMs: Date.now(),
  });
});

const requestPreview = computed(() => {
  switch (props.progress.phase) {
  case 'building_request':
  case 'requesting_model':
  case 'receiving_compact':
  case 'applying_branch':
  case 'complete':
    return props.progress.requestPreview;
  case 'idle':
  case 'preparing':
  case 'failed':
  case 'aborted':
    return undefined;
  default: {
    const _ex: never = props.progress;
    throw new Error(`Unhandled compact progress preview phase: ${_ex}`);
  }
  }
});

const outputPreview = computed(() => {
  switch (props.progress.phase) {
  case 'receiving_compact':
  case 'applying_branch':
  case 'complete':
    return props.progress.outputPreview;
  case 'idle':
  case 'preparing':
  case 'building_request':
  case 'requesting_model':
  case 'failed':
  case 'aborted':
    return undefined;
  default: {
    const _ex: never = props.progress;
    throw new Error(`Unhandled compact output preview phase: ${_ex}`);
  }
  }
});

const detailsRef = ref<HTMLDetailsElement | null>(null);
const requestPreviewRef = ref<HTMLElement | null>(null);
const outputPreviewRef = ref<HTMLElement | null>(null);
const shouldAutoScrollOutput = ref(true);

function syncOutputAutoScrollState(_args: Record<string, never>) {
  const element = outputPreviewRef.value;
  if (!element) {
    return;
  }

  const thresholdPx = 12;
  shouldAutoScrollOutput.value = element.scrollTop + element.clientHeight >= element.scrollHeight - thresholdPx;
}

function scrollOutputToBottom(_args: Record<string, never>) {
  const element = outputPreviewRef.value;
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function scrollRequestToBottom(_args: Record<string, never>) {
  const element = requestPreviewRef.value;
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function handleDetailsToggle(_args: Record<string, never>) {
  if (!detailsRef.value?.open) {
    return;
  }

  shouldAutoScrollOutput.value = true;
  nextTick(() => {
    scrollRequestToBottom({});
    scrollOutputToBottom({});
  });
}

watch(outputPreview, async () => {
  if (!detailsRef.value?.open || !shouldAutoScrollOutput.value) {
    return;
  }

  await nextTick();
  scrollOutputToBottom({});
});

watch(requestPreview, async () => {
  if (!detailsRef.value?.open) {
    return;
  }

  await nextTick();
  scrollRequestToBottom({});
});

defineExpose({
  TEST_ONLY: {
    display,
    requestPreview,
    outputPreview,
    shouldAutoScrollOutput,
    syncOutputAutoScrollState,
    scrollRequestToBottom,
    scrollOutputToBottom,
  },
});
</script>

<template>
  <div
    v-if="display.isRunning"
    class="border-b border-blue-100 dark:border-blue-900/40 bg-blue-50/70 dark:bg-blue-950/30 px-4 sm:px-6 py-2"
    data-testid="context-compact-progress-strip"
  >
    <div class="flex items-start gap-3">
      <Loader2Icon class="w-3.5 h-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-3">
          <span class="truncate text-[11px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
            {{ display.title }}
          </span>
          <span class="shrink-0 text-[11px] font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {{ display.percent }}%
          </span>
        </div>
        <p class="truncate text-[11px] text-blue-700/80 dark:text-blue-200/80">
          {{ display.detail }}
        </p>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/50">
          <div
            class="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out dark:bg-blue-400"
            :style="{ width: `${display.percent}%` }"
            data-testid="context-compact-progress-bar"
          />
        </div>
        <details
          v-if="requestPreview || outputPreview"
          ref="detailsRef"
          class="mt-2 rounded-lg border border-blue-100 bg-white/80 dark:border-blue-900/40 dark:bg-gray-950/40"
          data-testid="context-compact-details"
          @toggle="handleDetailsToggle({})"
        >
          <summary
            class="cursor-pointer list-none px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300"
            data-testid="context-compact-details-summary"
          >
            Details
          </summary>
          <div class="grid gap-2 border-t border-blue-100 px-2 py-2 dark:border-blue-900/40 lg:grid-cols-2">
            <div
              v-if="requestPreview"
              class="rounded-lg border border-blue-100 bg-white/80 dark:border-blue-900/40 dark:bg-gray-950/40"
              data-testid="context-compact-request-preview"
            >
              <div class="px-2 py-1 border-b border-blue-100 dark:border-blue-900/40 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                Request
              </div>
              <pre
                ref="requestPreviewRef"
                class="max-h-36 overflow-auto whitespace-pre-wrap break-words px-2 py-2 text-[11px] leading-5 text-blue-900/80 dark:text-blue-100/80"
                data-testid="context-compact-request-scroll"
              >{{ requestPreview }}</pre>
            </div>
            <div
              v-if="outputPreview"
              class="rounded-lg border border-blue-100 bg-white/80 dark:border-blue-900/40 dark:bg-gray-950/40"
              data-testid="context-compact-output-preview"
            >
              <div class="px-2 py-1 border-b border-blue-100 dark:border-blue-900/40 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                Output
              </div>
              <pre
                ref="outputPreviewRef"
                class="max-h-36 overflow-auto whitespace-pre-wrap break-words px-2 py-2 text-[11px] leading-5 text-blue-900/80 dark:text-blue-100/80"
                data-testid="context-compact-output-scroll"
                @scroll="syncOutputAutoScrollState({})"
              >{{ outputPreview }}</pre>
            </div>
          </div>
        </details>
      </div>
      <button
        class="p-1.5 rounded-lg text-blue-600 hover:text-red-500 dark:text-blue-400 dark:hover:text-red-400 hover:bg-white/70 dark:hover:bg-gray-900/40 transition-colors"
        title="Abort compact"
        data-testid="abort-context-compact-button"
        @click="$emit('abort')"
      >
        <SquareIcon class="w-3.5 h-3.5" />
      </button>
    </div>
  </div>
</template>
