<script setup lang="ts">
import { computed } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, CpuIcon, HardDriveIcon, MonitorIcon, ShieldCheckIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { BrowserModelShowcaseItem, BrowserModelShowcasePosition } from './browser-model-presentation';

const props = defineProps<{
  card: BrowserModelShowcaseItem,
  interaction: 'blocked' | 'ready',
  startStatus: 'idle' | 'starting',
}>();
const emit = defineEmits<{
  activate: [request: { position: BrowserModelShowcasePosition }],
}>();

const previewPositions = ['previous', 'next'] as const;
const actionLabel = computed(() => {
  const name = props.card.model.name;
  if (name === undefined) {
    return undefined;
  }
  const position = props.card.position;
  switch (position) {
  case 'selected': return lazyStrings.BrowserModelWelcome__run_model_in_your_browser({ name });
  case 'previous': case 'next': case 'hidden': return lazyStrings.BrowserModelWelcome__select_model({ name });
  default: {
    const exhaustive: never = position;
    throw new Error(`Unhandled model card position: ${exhaustive}`);
  }
  }
});

function activate(): void {
  if (props.interaction !== 'ready' || props.card.position === 'hidden') {
    return;
  }
  emit('activate', { position: props.card.position });
}

function modelSize({ bytes }: { bytes: number }): string | undefined {
  return lazyStrings.llamaCppBrowser__approximately_gb({ size: (bytes / 1e9).toFixed(1) });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <button
    type="button"
    class="model-deck-card"
    :class="{ 'model-deck-card-selected': card.position === 'selected', 'model-deck-card-previous': card.position === 'previous', 'model-deck-card-next': card.position === 'next', 'model-deck-card-hidden': card.position === 'hidden' }"
    :style="{ '--model-offset': card.offset }"
    :data-testid="card.position === 'selected' ? 'start-model' : card.position === 'hidden' ? undefined : `peek-${card.position}`"
    :aria-label="actionLabel"
    :aria-hidden="card.position === 'hidden' ? true : undefined"
    :aria-busy="card.position === 'selected' && startStatus === 'starting'"
    :disabled="interaction !== 'ready' || card.position === 'hidden'"
    :tabindex="card.position === 'hidden' ? -1 : 0"
    tw-class="group overflow-hidden rounded-2xl border border-gray-200/70 dark:border-gray-700/60 bg-white/50 dark:bg-gray-800/40 text-left hover:border-blue-400 dark:hover:border-blue-500 hover:bg-white dark:hover:bg-gray-800 focus-visible:bg-white dark:focus-visible:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-default"
    @click="activate"
  >
    <!-- All contents stay fixed inside their card. Entering the center shows
         the primary face immediately; only the outward handoff uses a fade. -->
    <div class="model-card-face model-card-face-primary" data-model-face="primary" aria-hidden="true">
      <div class="model-deck-content" tw-class="flex min-h-0 flex-col justify-center gap-3 px-3 py-3">
        <div class="model-deck-identity" tw-class="flex items-center">
          <div class="model-deck-cpu">
            <div class="model-cpu-accent" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 text-gray-400 dark:text-gray-500 group-hover:border-sky-200/80 dark:group-hover:border-sky-400/25 group-hover:bg-sky-50 dark:group-hover:bg-sky-400/10 group-hover:text-sky-600 dark:group-hover:text-sky-300 group-focus-visible:border-sky-200/80 dark:group-focus-visible:border-sky-400/25 group-focus-visible:bg-sky-50 dark:group-focus-visible:bg-sky-400/10 group-focus-visible:text-sky-600 dark:group-focus-visible:text-sky-300">
              <MonitorIcon v-if="card.kind === 'browser-provided'" class="model-cpu-symbol" /><CpuIcon v-else class="model-cpu-symbol" />
            </div>
          </div>
          <div tw-class="min-w-0">
            <p tw-class="whitespace-nowrap text-[12px] text-gray-500 dark:text-gray-400">{{ card.model.developer }}</p>
            <h3 class="model-deck-name" tw-class="font-semibold text-gray-600 dark:text-gray-400 tracking-tight leading-snug [overflow-wrap:anywhere] group-hover:text-gray-800 dark:group-hover:text-gray-100 group-focus-visible:text-gray-800 dark:group-focus-visible:text-gray-100 transition-colors duration-300 motion-reduce:transition-none">{{ card.model.name }}</h3>
          </div>
        </div>
        <div v-if="card.kind === 'gguf'" class="model-deck-metadata" tw-class="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-400 group-focus-visible:text-gray-600 dark:group-focus-visible:text-gray-400 transition-colors duration-300 motion-reduce:transition-none">
          <span tw-class="inline-flex items-center gap-1 whitespace-nowrap"><HardDriveIcon tw-class="h-3.5 w-3.5 shrink-0" />{{ modelSize({ bytes: card.hint.approximateModelBytes }) }}</span>
          <span tw-class="whitespace-nowrap">{{ lazyStrings.llamaCppBrowser__memory_estimate_gib({ memory: String(card.hint.suggestedMemoryGiB) }) }}</span>
        </div>
        <div v-else class="model-deck-metadata" tw-class="space-y-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
          <span tw-class="flex items-center gap-1.5"><ShieldCheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.BrowserModelWelcome__processed_on_this_device() }}</span>
          <span v-if="card.availability !== 'available'">{{ card.availability === 'downloading' ? lazyStrings.BrowserModelWelcome__the_browser_is_preparing_the_model() : lazyStrings.BrowserModelWelcome__the_browser_handles_initial_preparation() }}</span>
        </div>
      </div>
      <span class="model-deck-start" tw-class="flex items-center justify-between gap-2 border-t border-gray-200/60 dark:border-gray-700/50 bg-gray-50/60 dark:bg-gray-900/15 px-3 py-3 text-[13px] font-bold leading-snug text-gray-600 dark:text-gray-400 group-hover:border-blue-100/60 dark:group-hover:border-blue-500/10 group-hover:bg-blue-50/70 dark:group-hover:bg-blue-500/10 group-hover:text-blue-600 dark:group-hover:text-blue-400 group-focus-visible:border-blue-100/60 dark:group-focus-visible:border-blue-500/10 group-focus-visible:bg-blue-50/70 dark:group-focus-visible:bg-blue-500/10 group-focus-visible:text-blue-600 dark:group-focus-visible:text-blue-400 transition-colors duration-300 motion-reduce:transition-none">
        <span tw-class="min-w-0 text-balance">{{ lazyStrings.SHARED__run_in_your_browser() }}</span><ArrowRightIcon tw-class="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none" />
      </span>
    </div>
    <div v-for="position in previewPositions" :key="position" class="model-card-face" :class="{ 'model-card-face-preview-previous': position === 'previous', 'model-card-face-preview-next': position === 'next' }" :data-model-face="`preview-${position}`" aria-hidden="true">
      <div class="model-card-preview-identity">
        <p tw-class="whitespace-nowrap text-[12px] text-gray-500 dark:text-gray-400">{{ card.model.developer }}</p>
        <h3 class="model-deck-name" tw-class="font-semibold text-gray-600 dark:text-gray-400 tracking-tight leading-snug group-hover:text-gray-800 dark:group-hover:text-gray-100 group-focus-visible:text-gray-800 dark:group-focus-visible:text-gray-100 transition-colors duration-300 motion-reduce:transition-none">{{ card.model.name }}</h3>
      </div>
      <span class="model-card-preview-action" tw-class="flex items-center justify-center gap-1 text-[11px] text-gray-400 dark:text-gray-500"><ArrowRightIcon v-if="position === 'previous'" tw-class="h-3 w-3" />{{ lazyStrings.BrowserModelWelcome__select() }}<ArrowLeftIcon v-if="position === 'next'" tw-class="h-3 w-3" /></span>
    </div>
  </button>
</template>

<style scoped>
.model-deck-card {
  display: grid;
  grid-area: 1 / 1;
  grid-template-rows: minmax(0, 1fr);
  position: relative;
  min-height: 8.5rem;
  left: 50%;
  /* Neighboring cards retain their full width beyond the outer gradient. */
  width: var(--model-card-width);
  touch-action: pan-y pinch-zoom;
  transform: translateX(calc(-50% + var(--model-offset) * (var(--model-card-width) + 0.5rem) + var(--model-drag, 0px)));
  opacity: 0.9;
  z-index: 1;
  transition: transform 520ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease, border-color 180ms ease, background-color 300ms ease, box-shadow 300ms ease;
}
.model-deck-card-selected {
  opacity: 1;
  z-index: 2;
}
.model-deck-card-selected:hover, .model-deck-card-selected:focus-visible {
  box-shadow: 0 3px 12px rgb(0 0 0 / 0.04);
}
.model-deck-card-previous:hover, .model-deck-card-next:hover, .model-deck-card-previous:focus-visible, .model-deck-card-next:focus-visible {
  opacity: 1;
}
.model-deck-card-hidden {
  opacity: 0;
  pointer-events: none;
  z-index: 0;
}
.model-card-face {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: none;
  /* Keep finger gestures targeted at the stable, full-card button. */
  pointer-events: none;
}
.model-card-face-primary {
  /* Keep even off-screen primary content in the shared height calculation. */
  position: relative;
  inset: auto;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  transition: opacity 120ms ease-in;
}
.model-deck-card-selected .model-card-face-primary {
  /* Show the contents before the incoming card moves, without an enter fade. */
  opacity: 1;
  transition: none;
}
.model-deck-card-previous .model-card-face-preview-previous,
.model-deck-card-next .model-card-face-preview-next {
  opacity: 1;
  transition: opacity 800ms ease-out;
  /* The outgoing primary face finishes fading before the edge name appears.
     Returning to the center clears both this delay and the preview instantly. */
  transition-delay: 120ms;
}
.model-deck-content {
  gap: 0.5rem;
  padding-block: 0.5rem;
}
.model-deck-start {
  padding-block: 0.5rem;
}
.model-deck-identity {
  /* Resolve type size against the stage before containing only this row.
     Keep the edge previews outside this container so their cqw geometry stays stable. */
  font-size: clamp(16px, 2.8cqw, 20px);
  container: model-card-identity / inline-size;
}
.model-deck-identity .model-deck-name {
  font-size: inherit;
}
.model-deck-cpu {
  display: none;
  flex-shrink: 0;
}
.model-cpu-accent {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  transition: box-shadow 650ms ease, color 650ms ease, background-color 650ms ease, border-color 650ms ease;
}
.model-cpu-symbol {
  width: 1rem;
  height: 1rem;
}
.model-deck-card-selected:hover .model-cpu-accent, .model-deck-card-selected:focus-visible .model-cpu-accent {
  box-shadow: 0 0 26px rgb(56 189 248 / 0.26), 0 0 10px rgb(59 130 246 / 0.14);
  transition-duration: 950ms;
}
.model-deck-name {
  font-size: clamp(16px, 2.8cqw, 20px);
}
.model-card-preview-identity {
  position: absolute;
  inset-block-start: 0;
  inset-block-end: 3rem;
  inset-inline-start: 0.75rem;
  width: calc(var(--model-visible-peek) - 0.75rem);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.25rem;
  padding-block-end: 1.5rem;
  overflow: hidden;
}
.model-card-preview-identity .model-deck-name {
  white-space: nowrap;
}
.model-card-face-preview-previous .model-card-preview-identity {
  inset-inline-start: auto;
  inset-inline-end: 0;
  width: var(--model-visible-peek);
  padding-inline-start: calc(var(--model-edge-fade) * 0.45);
  padding-inline-end: 0.75rem;
}
.model-card-preview-action {
  position: absolute;
  inset-block-end: 1rem;
  inset-inline-start: 0;
  width: var(--model-visible-peek);
}
.model-card-face-preview-previous .model-card-preview-action {
  inset-inline-start: auto;
  inset-inline-end: 0;
}
@container model-card-identity (min-width: 12rem) {
  .model-deck-cpu {
    display: block;
    width: 2.5rem;
  }
}
@container model-card-identity (min-width: 18rem) {
  .model-deck-cpu {
    width: 3.75rem;
  }
  .model-cpu-accent {
    width: 3rem;
    height: 3rem;
  }
  .model-cpu-symbol {
    width: 1.25rem;
    height: 1.25rem;
  }
}
@container browser-model-welcome (min-width: 36rem) {
  .model-deck-card {
    min-height: 11rem;
  }
  .model-deck-content {
    gap: 0.75rem;
  }
  .model-deck-content, .model-deck-start {
    padding-inline: 1rem;
    padding-block: 0.75rem;
  }
  .model-deck-metadata {
    flex-direction: row;
    flex-wrap: wrap;
    column-gap: 1rem;
    font-size: 12px;
  }
  .model-deck-start {
    font-size: 14px;
  }
}
@container browser-model-welcome (max-width: 30rem) {
  .model-card-preview-action {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .model-deck-card, .model-cpu-accent, .model-deck-card .model-card-face {
    transition: none;
    transition-delay: 0s;
  }
}
</style>
