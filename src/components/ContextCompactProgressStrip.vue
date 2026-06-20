<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { SquareIcon, SparklesIcon, ChevronDownIcon, ChevronUpIcon, CheckCircle2Icon, XCircleIcon } from 'lucide-vue-next';
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

const visibleDisplay = ref(display.value);
const shouldRender = ref(display.value.isRunning);
const animatedPercent = ref(0);
const hideTimerId = ref<number | undefined>(undefined);
const animationFrameId = ref<number | undefined>(undefined);

function clearHideTimer() {
  if (hideTimerId.value !== undefined) {
    window.clearTimeout(hideTimerId.value);
    hideTimerId.value = undefined;
  }
}

function clearPercentAnimationFrame() {
  if (animationFrameId.value !== undefined) {
    window.cancelAnimationFrame(animationFrameId.value);
    animationFrameId.value = undefined;
  }
}

function animatePercentTo({
  percent,
}: {
  percent: number;
}) {
  clearPercentAnimationFrame();
  animationFrameId.value = window.requestAnimationFrame(() => {
    animatedPercent.value = percent;
    animationFrameId.value = undefined;
  });
}

watch(display, async (nextDisplay) => {
  clearHideTimer();
  visibleDisplay.value = nextDisplay;

  if (nextDisplay.isRunning) {
    shouldRender.value = true;
    await nextTick();
    animatePercentTo({ percent: nextDisplay.percent });
    return;
  }

  switch (props.progress.phase) {
  case 'complete':
  case 'failed':
  case 'aborted':
    shouldRender.value = true;
    await nextTick();
    animatePercentTo({ percent: nextDisplay.percent });
    hideTimerId.value = window.setTimeout(() => {
      shouldRender.value = false;
      hideTimerId.value = undefined;
    }, 300);
    return;
  case 'idle':
    shouldRender.value = false;
    animatedPercent.value = 0;
    return;
  case 'preparing':
  case 'building_request':
  case 'requesting_model':
  case 'receiving_compact':
  case 'applying_branch':
    shouldRender.value = true;
    return;
  default: {
    const _ex: never = props.progress;
    throw new Error(`Unhandled compact progress visibility phase: ${_ex}`);
  }
  }
}, { immediate: true });

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

const showRequestPreview = ref(false);
const requestPreviewRef = ref<HTMLElement | null>(null);
const outputPreviewRef = ref<HTMLElement | null>(null);
const shouldAutoScrollOutput = ref(true);

function syncOutputAutoScrollState() {
  const element = outputPreviewRef.value;
  if (!element) {
    return;
  }

  const thresholdPx = 12;
  shouldAutoScrollOutput.value = element.scrollTop + element.clientHeight >= element.scrollHeight - thresholdPx;
}

function scrollOutputToBottom() {
  const element = outputPreviewRef.value;
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function scrollRequestToBottom() {
  const element = requestPreviewRef.value;
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

watch(showRequestPreview, async (val) => {
  if (val) {
    await nextTick();
    scrollRequestToBottom();
  }
});

watch(outputPreview, async () => {
  if (!shouldAutoScrollOutput.value) {
    return;
  }

  await nextTick();
  scrollOutputToBottom();
});

watch(requestPreview, async () => {
  if (!showRequestPreview.value) {
    return;
  }

  await nextTick();
  scrollRequestToBottom();
});

onBeforeUnmount(() => {
  clearHideTimer();
  clearPercentAnimationFrame();
});

defineExpose({
  TEST_ONLY: {
    display,
    visibleDisplay,
    shouldRender,
    animatedPercent,
    requestPreview,
    outputPreview,
    shouldAutoScrollOutput,
    syncOutputAutoScrollState,
    scrollRequestToBottom,
    scrollOutputToBottom,
    showRequestPreview,
  },
});
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="transform -translate-y-4 opacity-0"
    enter-to-class="transform translate-y-0 opacity-100"
    leave-active-class="transition duration-200 ease-in"
    leave-from-class="transform translate-y-0 opacity-100"
    leave-to-class="transform -translate-y-4 opacity-0"
  >
    <div
      v-if="shouldRender"
      class="border-b border-indigo-100/50 dark:border-indigo-900/40 bg-white/70 dark:bg-gray-950/60 backdrop-blur-md px-4 sm:px-6 py-3 shadow-sm"
      :class="{
        'border-emerald-500/30 bg-emerald-50/20 dark:bg-emerald-950/10': progress.phase === 'complete',
        'border-rose-500/20 bg-rose-50/10 dark:bg-rose-950/10': progress.phase === 'failed',
        'border-amber-500/20 bg-amber-50/10 dark:bg-amber-950/10': progress.phase === 'aborted'
      }"
      data-testid="context-compact-progress-strip"
    >
      <div class="flex items-start gap-4">
        <!-- Status Icon with Glow -->
        <div class="relative shrink-0 pt-1">
          <CheckCircle2Icon v-if="progress.phase === 'complete'" class="w-4 h-4 text-emerald-500 dark:text-emerald-400 animate-in zoom-in duration-300" />
          <XCircleIcon v-else-if="progress.phase === 'failed'" class="w-4 h-4 text-rose-500 dark:text-rose-400" />
          <XCircleIcon v-else-if="progress.phase === 'aborted'" class="w-4 h-4 text-amber-500 dark:text-amber-400" />
          <SparklesIcon v-else class="w-4 h-4 text-indigo-500 dark:text-indigo-400 animate-pulse-glow" />
        </div>

        <div class="min-w-0 flex-1 space-y-2">
          <!-- Header: Title & Percentage -->
          <div class="flex items-center justify-between gap-3">
            <span
              class="truncate text-[10px] font-black uppercase tracking-[0.2em] animate-text-scan bg-gradient-to-r bg-[length:200%_auto] bg-clip-text text-transparent"
              :class="{
                'from-emerald-600 via-teal-500 to-emerald-600 dark:from-emerald-400 dark:via-teal-300 dark:to-emerald-400': progress.phase === 'complete',
                'from-rose-600 via-pink-500 to-rose-600 dark:from-rose-400 dark:via-pink-300 dark:to-rose-400': progress.phase === 'failed',
                'from-amber-600 via-yellow-500 to-amber-600 dark:from-amber-400 dark:via-yellow-300 dark:to-amber-400': progress.phase === 'aborted',
                'from-indigo-600 via-violet-500 to-indigo-600 dark:from-indigo-400 dark:via-violet-300 dark:to-indigo-400': progress.phase !== 'complete' && progress.phase !== 'failed' && progress.phase !== 'aborted'
              }"
            >
              {{ visibleDisplay.title }}
            </span>
            <span
              class="shrink-0 text-[10px] font-black tabular-nums transition-colors duration-500"
              :class="{
                'text-emerald-500 dark:text-emerald-400': progress.phase === 'complete',
                'text-rose-500 dark:text-rose-400': progress.phase === 'failed',
                'text-amber-500 dark:text-amber-400': progress.phase === 'aborted',
                'text-indigo-500/80 dark:text-indigo-400/80': progress.phase !== 'complete' && progress.phase !== 'failed' && progress.phase !== 'aborted'
              }"
            >
              {{ animatedPercent }}%
            </span>
          </div>

          <!-- Progress Bar Container -->
          <div class="relative">
            <!-- Glow background -->
            <div
              class="absolute inset-0 rounded-full blur-[2px] transition-all duration-500 ease-out"
              :class="{
                'bg-emerald-500/20 dark:bg-emerald-400/10': progress.phase === 'complete',
                'bg-indigo-500/10 dark:bg-indigo-400/5': progress.phase !== 'complete'
              }"
              :style="{ width: `${animatedPercent}%` }"
            />

            <div
              class="h-1.5 overflow-hidden rounded-full transition-colors duration-500 ring-1 ring-inset"
              :class="[
                progress.phase === 'complete' ? 'bg-emerald-100/50 dark:bg-emerald-950/40 ring-emerald-500/10' : 'bg-indigo-100 dark:bg-gray-800 ring-indigo-500/10 dark:ring-indigo-400/10'
              ]"
            >
              <!-- Animated Gradient Bar -->
              <div
                class="h-full rounded-full transition-all duration-500 ease-out animate-shimmer bg-[length:200%_auto]"
                :class="{
                  'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]': progress.phase === 'complete',
                  'bg-rose-500': progress.phase === 'failed',
                  'bg-amber-500': progress.phase === 'aborted',
                  'bg-gradient-to-r from-blue-500 via-violet-500 to-cyan-500': progress.phase !== 'complete' && progress.phase !== 'failed' && progress.phase !== 'aborted'
                }"
                :style="{ width: `${animatedPercent}%` }"
                data-testid="context-compact-progress-bar"
              />
            </div>
          </div>

          <!-- Detail Text -->
          <p
            class="truncate text-[11px] font-medium transition-colors duration-500"
            :class="{
              'text-emerald-700/80 dark:text-emerald-300/70': progress.phase === 'complete',
              'text-rose-700/80 dark:text-rose-300/70': progress.phase === 'failed',
              'text-amber-700/80 dark:text-amber-300/70': progress.phase === 'aborted',
              'text-indigo-700/70 dark:text-indigo-200/60': progress.phase !== 'complete' && progress.phase !== 'failed' && progress.phase !== 'aborted'
            }"
          >
            {{ visibleDisplay.detail }}
          </p>

          <!-- Previews Area -->
          <div v-if="requestPreview || outputPreview" class="pt-1 space-y-2">
            <!-- Request Toggle (Hidden by default) -->
            <div v-if="requestPreview" data-testid="context-compact-request-preview">
              <button
                class="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-500/70 hover:text-indigo-600 dark:text-indigo-400/60 dark:hover:text-indigo-300 transition-colors"
                data-testid="context-compact-request-toggle"
                @click="showRequestPreview = !showRequestPreview"
              >
                <component :is="showRequestPreview ? ChevronUpIcon : ChevronDownIcon" class="w-3 h-3" />
                {{ showRequestPreview ? 'Hide Request' : 'Show Request' }}
              </button>

              <div v-if="showRequestPreview" class="mt-1.5 rounded-lg border border-indigo-100/50 bg-indigo-50/30 dark:border-indigo-900/40 dark:bg-gray-900/40 overflow-hidden">
                <pre
                  ref="requestPreviewRef"
                  class="max-h-32 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-[10px] leading-relaxed font-mono text-indigo-900/80 dark:text-indigo-100/70"
                  data-testid="context-compact-request-scroll"
                >{{ requestPreview }}</pre>
              </div>
            </div>

            <!-- Output Preview (Visible by default) -->
            <div v-if="outputPreview" class="rounded-lg border border-violet-200/40 bg-violet-50/30 dark:border-violet-800/20 dark:bg-gray-900/60 overflow-hidden shadow-inner ring-1 ring-violet-500/5" data-testid="context-compact-output-preview">
              <div class="flex items-center gap-2 px-3 py-1.5 border-b border-violet-100/30 dark:border-violet-800/20 bg-violet-100/20 dark:bg-violet-900/10">
                <div class="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                <span class="text-[9px] font-bold uppercase tracking-widest text-violet-600/80 dark:text-violet-300/60">Live Output</span>
              </div>
              <pre
                ref="outputPreviewRef"
                class="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-3 text-[11px] leading-relaxed font-mono text-violet-950 dark:text-violet-100/90 selection:bg-violet-200/50 dark:selection:bg-violet-500/30"
                data-testid="context-compact-output-scroll"
                @scroll="syncOutputAutoScrollState()"
              >{{ outputPreview }}</pre>
            </div>
          </div>
        </div>

        <!-- Abort Button -->
        <button
          class="shrink-0 p-2 rounded-xl text-indigo-400 hover:text-rose-500 dark:text-indigo-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-all duration-200"
          title="Abort compact"
          data-testid="abort-context-compact-button"
          @click="$emit('abort')"
        >
          <SquareIcon class="w-4 h-4 fill-current opacity-70" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@keyframes pulse-glow {
  0%, 100% { opacity: 0.5; transform: scale(1); filter: blur(0px); }
  50% { opacity: 1; transform: scale(1.1); filter: blur(1px); }
}

@keyframes text-scan {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

.animate-shimmer {
  animation: shimmer 3s linear infinite;
}

.animate-pulse-glow {
  animation: pulse-glow 2s ease-in-out infinite;
}

.animate-text-scan {
  animation: text-scan 4s linear infinite;
}
</style>
