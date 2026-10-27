<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue';
import { BoxIcon, CheckIcon, ChevronDownIcon, DownloadIcon, ImageIcon, PauseIcon, PlayIcon, RotateCcwIcon, XIcon } from 'lucide-vue-next';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { useDownloads } from '@/composables/useDownloads';
import { downloadTotals, downloadByteLabel } from '@/logic/download-manager/progress';
import type { ManagedDownload, DownloadFile } from '@/01-models/download';
import ModelDownloadFileDetails from './ModelDownloadFileDetails.vue';
import { lazyStrings } from '@/strings';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';
import LlamaCppBrowserLocalFileRecovery from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFileRecovery.vue';
import ImageModelLocalFileRecovery from '@/features/stable-diffusion-cpp-browser/components/ImageModelLocalFileRecovery.vue';

const { jobs, manager } = useDownloads();
const open = ref(false);
const showCompleted = ref(false);
const expandedIds = shallowRef<ReadonlySet<number>>(new Set());
const trigger = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelId = useId();
const popup = useAnchoredPopup({ anchor: trigger, preferredWidth: { unit: 'rem', value: 23 }, maxWidthPx: 440, preferredPlacement: { direction: 'top', minHeightPx: 360 } });
const panelStyle = computed(() => ({ ...popup.placement.value.style, height: `min(34rem, ${popup.placement.value.style.maxHeight})` }));
const pending = computed(() => jobs.value.filter(job => job.status !== 'complete').sort((a, b) => a.id - b.id));
const completed = computed(() => jobs.value.filter(job => job.status === 'complete'));
const activeCount = computed(() => pending.value.filter(job => ['resolving', 'downloading', 'pausing', 'cancelling'].includes(job.status)).length);
const waitingCount = computed(() => pending.value.filter(job => job.status === 'queued').length);
watch(jobs, value => {
  const present = new Set(value.map(job => job.id));
  if ([...expandedIds.value].some(id => !present.has(id))) {
    expandedIds.value = new Set([...expandedIds.value].filter(id => present.has(id)));
  }
});

function toggleDetails({ id }: { id: number }): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedIds.value = next;
}

function detailPanelId({ id }: { id: number }): string {
  return `${panelId}-files-${id}`;
}

function progress({ job }: { job: ManagedDownload }): number | undefined {
  return downloadTotals({ files: job.files }).percent;
}

function amount({ files }: { files: readonly DownloadFile[] }): string | undefined {
  const total = downloadTotals({ files });
  const known = total.size === undefined ? lazyStrings.ModelDownloads__unknown_size() : downloadByteLabel({ bytes: total.size });
  return known === undefined ? undefined : `${downloadByteLabel({ bytes: total.completed })} / ${known}`;
}

function category({ job }: { job: ManagedDownload }): string | undefined {
  switch (job.category) {
  case 'language-model': return lazyStrings.ModelDownloads__language_model();
  case 'image-model': return lazyStrings.ModelDownloads__image_model();
  case 'file': return lazyStrings.ModelDownloads__file();
  default: {
    const exhaustive: never = job.category;
    throw new Error(String(exhaustive));
  }
  }
}

function statusLabel({ job }: { job: ManagedDownload }): string | undefined {
  switch (job.status) {
  case 'queued': return lazyStrings.ModelDownloads__queue_position({ position: manager.position({ id: job.id }) ?? 1 });
  case 'resolving': return lazyStrings.ModelDownloads__preparing();
  case 'downloading': return job.files.some(file => file.state === 'verifying') ? lazyStrings.ModelDownloads__verifying() : lazyStrings.ModelDownloads__downloading();
  case 'pausing': return lazyStrings.ModelDownloads__pausing();
  case 'paused': return lazyStrings.ModelDownloads__paused();
  case 'failed': return lazyStrings.ModelDownloads__failed();
  case 'complete': return lazyStrings.ModelDownloads__complete();
  case 'cancelling': case 'cancelled': return lazyStrings.ModelDownloads__cancelling();
  default: {
    const exhaustive: never = job.status;
    throw new Error(String(exhaustive));
  }
  }
}

function toggleDownload({ job }: { job: ManagedDownload }): void {
  switch (job.status) {
  case 'downloading': case 'resolving': manager.pause({ id: job.id });
    return;
  case 'paused': case 'failed': void manager.resume({ id: job.id });
    return;
  case 'queued': case 'pausing': case 'cancelling': case 'cancelled': case 'complete': return;
  default: {
    const exhaustive: never = job.status;
    throw new Error(String(exhaustive));
  }
  }
}

async function toggle(): Promise<void> {
  if (open.value) {
    close({ restoreFocus: true });
    return;
  }
  popup.refresh();
  open.value = true;
  await nextTick();
  popup.refresh();
  panel.value?.focus({ preventScroll: true });
}

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  open.value = false;
  if (restoreFocus) {
    trigger.value?.focus({ preventScroll: true });
  }
}

useEventTargetListener(document, 'pointerdown', event => {
  if (open.value && event.target instanceof Node && !trigger.value?.contains(event.target) && !panel.value?.contains(event.target)) {
    close({ restoreFocus: false });
  }
});
useEventTargetListener(document, 'focusin', event => {
  if (open.value && event.target instanceof Node && !trigger.value?.contains(event.target) && !panel.value?.contains(event.target)) {
    close({ restoreFocus: false });
  }
});
useEventTargetListener(document, 'keydown', event => {
  if (open.value && event.key === 'Escape') {
    event.preventDefault();
    close({ restoreFocus: true });
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button
    ref="trigger"
    type="button"
    :title="lazyStrings.ModelDownloads__download_status()"
    :aria-label="lazyStrings.ModelDownloads__download_status()"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :aria-controls="open ? panelId : undefined"
    data-testid="model-downloads-trigger"
    @click="toggle"
    :tw-class="['relative flex shrink-0 items-center justify-center rounded-xl border p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40', open ? 'border-gray-200 bg-white text-blue-600 dark:border-gray-700 dark:bg-gray-800 dark:text-blue-400' : 'border-transparent text-gray-500 hover:border-gray-200 hover:bg-white hover:text-blue-600 dark:text-gray-400 dark:hover:border-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200']"
  >
    <DownloadIcon tw-class="h-4 w-4 shrink-0" />
    <span v-if="pending.length" tw-class="absolute -right-1 -top-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-gray-200 bg-gray-100 px-0.5 text-[9px] font-semibold leading-none text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">{{ pending.length }}</span>
  </button>

  <Teleport to="body">
    <section
      v-if="open"
      :id="panelId"
      ref="panel"
      role="dialog"
      :aria-label="lazyStrings.ModelDownloads__download_status()"
      tabindex="-1"
      data-testid="model-downloads-panel"
      :style="panelStyle"
      tw-class="flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white text-gray-800 shadow-2xl outline-none dark:border-gray-700/70 dark:bg-gray-900 dark:text-gray-100"
    >
      <header tw-class="shrink-0 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <div tw-class="flex items-center gap-2">
          <DownloadIcon tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />
          <h2 tw-class="min-w-0 flex-1 text-sm font-semibold">{{ lazyStrings.ModelDownloads__downloads() }}</h2>
          <button type="button" @click="close({ restoreFocus: true })" :aria-label="lazyStrings.ModelDownloads__close()" :title="lazyStrings.ModelDownloads__close()" tw-class="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:hover:bg-gray-800 dark:hover:text-gray-200"><XIcon tw-class="h-4 w-4" /></button>
        </div>
        <p aria-live="polite" tw-class="mt-1 h-4 truncate text-[11px] leading-4 text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelDownloads__activity({ active: activeCount, queued: waitingCount }) }}</p>
      </header>

      <div style="scrollbar-gutter: stable" tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div>
          <div v-if="!pending.length" tw-class="flex flex-col items-center gap-2 px-4 py-10 text-gray-400"><CheckIcon tw-class="h-6 w-6" /><p tw-class="text-xs">{{ lazyStrings.ModelDownloads__no_pending_downloads() }}</p></div>
          <ul tw-class="divide-y divide-gray-100 dark:divide-gray-800/80">
            <li v-for="job in pending" :key="job.id" :data-download-id="job.id" :tw-class="['px-4 py-3.5', job.status === 'downloading' ? 'bg-blue-50/40 dark:bg-blue-500/5' : '']">
              <div tw-class="flex items-start gap-3">
                <div tw-class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-400">
                  <ImageIcon v-if="job.category === 'image-model'" tw-class="h-4 w-4" />
                  <BoxIcon v-else tw-class="h-4 w-4" />
                </div>
                <div tw-class="min-w-0 flex-1">
                  <p :title="job.title" tw-class="truncate text-xs font-medium leading-5">{{ job.title }}</p>
                  <p tw-class="truncate text-[10px] leading-4 text-gray-400 dark:text-gray-500">{{ category({ job }) }}<span tw-class="mx-1.5">·</span>{{ lazyStrings.ModelDownloads__files({ count: job.files.length }) }}<span tw-class="mx-1.5">·</span>{{ job.destination.kind === 'opfs' ? 'OPFS' : lazyStrings.ModelDownloads__linked_folder() }}</p>
                </div>
                <div tw-class="-mr-1 flex shrink-0 items-center gap-0.5">
                  <div tw-class="h-7 w-7">
                    <button v-if="job.status !== 'queued'" :disabled="['pausing', 'cancelling'].includes(job.status)" type="button" @click="toggleDownload({ job })" :aria-label="job.status === 'paused' ? lazyStrings.ModelDownloads__resume() : job.status === 'failed' ? lazyStrings.ModelDownloads__retry() : lazyStrings.ModelDownloads__pause()" :title="job.status === 'paused' ? lazyStrings.ModelDownloads__resume() : job.status === 'failed' ? lazyStrings.ModelDownloads__retry() : lazyStrings.ModelDownloads__pause()" tw-class="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"><PauseIcon v-if="['resolving', 'downloading', 'pausing'].includes(job.status)" tw-class="h-3.5 w-3.5" /><PlayIcon v-else-if="job.status === 'paused'" tw-class="h-3.5 w-3.5" /><RotateCcwIcon v-else tw-class="h-3.5 w-3.5" /></button>
                  </div>
                  <button type="button" @click="manager.remove({ id: job.id })" :disabled="job.status === 'cancelling'" :aria-label="lazyStrings.ModelDownloads__cancel()" :title="lazyStrings.ModelDownloads__cancel()" tw-class="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"><XIcon tw-class="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <div tw-class="ml-11 mt-2">
                <p v-if="job.error" tw-class="mb-2 select-text break-words text-[10px] text-red-500">{{ job.error }}</p>
                <HuggingFaceDownloadFailureHint v-if="job.status === 'failed' && job.key.startsWith('llama:')"><LlamaCppBrowserLocalFileRecovery :disabled="false" :accept-local-input="undefined" /></HuggingFaceDownloadFailureHint>
                <HuggingFaceDownloadFailureHint v-else-if="job.status === 'failed' && job.key.startsWith('image:')"><ImageModelLocalFileRecovery :view="undefined" :disabled="false" /></HuggingFaceDownloadFailureHint>
                <CspMessageHint v-else-if="job.status === 'paused' && (job.key.startsWith('llama:') || job.key.startsWith('image:'))" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" />
                <div tw-class="flex items-center justify-between gap-2 text-[10px] leading-4">
                  <span :tw-class="['min-w-0 flex-1 truncate', job.status === 'downloading' ? 'text-blue-600 dark:text-blue-400' : job.status === 'failed' ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400']">{{ statusLabel({ job }) }}</span>
                  <button type="button" @click="toggleDetails({ id: job.id })" :data-download-detail="job.id" :aria-expanded="expandedIds.has(job.id)" :aria-controls="expandedIds.has(job.id) ? detailPanelId({ id: job.id }) : undefined" :aria-label="`${job.title} · ${lazyStrings.ModelDownloads__details()}`" tw-class="inline-flex shrink-0 items-center gap-1 rounded px-1 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-500 dark:hover:text-gray-300">{{ lazyStrings.ModelDownloads__details() }}<ChevronDownIcon :tw-class="['h-3 w-3 transition-transform duration-200', expandedIds.has(job.id) ? 'rotate-180' : '']" /></button>
                  <span tw-class="w-8 shrink-0 text-right tabular-nums text-gray-500 dark:text-gray-400">{{ progress({ job }) === undefined ? '—' : `${progress({ job })}%` }}</span>
                </div>
                <div role="progressbar" :aria-label="job.title" :aria-valuenow="progress({ job })" :aria-valuemin="0" :aria-valuemax="100" tw-class="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div :style="{ width: progress({ job }) === undefined ? '30%' : `${progress({ job })}%` }" :tw-class="['h-full rounded-full transition-colors', job.status === 'downloading' ? 'bg-blue-500/80 dark:bg-blue-400/80' : 'bg-gray-300 dark:bg-gray-600']" />
                </div>
                <p tw-class="mt-1.5 flex h-4 items-center gap-2 whitespace-nowrap text-[10px] tabular-nums leading-4 text-gray-400 dark:text-gray-500"><span tw-class="shrink-0">{{ amount({ files: job.files }) }}</span></p>
              </div>
              <Transition name="download-detail">
                <div v-if="expandedIds.has(job.id)" :id="detailPanelId({ id: job.id })" class="download-detail-grid"><div tw-class="min-h-0 overflow-hidden"><div tw-class="pt-3"><ModelDownloadFileDetails :job="job" /></div></div></div>
              </Transition>
            </li>
          </ul>
          <div v-if="completed.length" tw-class="border-t border-gray-100 dark:border-gray-800">
            <button type="button" @click="showCompleted = !showCompleted" :aria-expanded="showCompleted" tw-class="flex w-full items-center gap-2 px-4 py-2.5 text-[11px] text-gray-500 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 dark:text-gray-400 dark:hover:bg-gray-800/50"><ChevronDownIcon :tw-class="['h-3 w-3 transition-transform', showCompleted ? 'rotate-180' : '']" /><span>{{ lazyStrings.ModelDownloads__completed_count({ count: completed.length }) }}</span></button>
            <ul v-if="showCompleted" tw-class="divide-y divide-gray-100 dark:divide-gray-800/80">
              <li v-for="job in completed" :key="job.id" tw-class="px-4 py-2.5">
                <div tw-class="flex items-center gap-2 text-[11px]">
                  <CheckIcon tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span :title="job.title" tw-class="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400">{{ job.title }}</span>
                  <button type="button" @click="toggleDetails({ id: job.id })" :data-download-detail="job.id" :aria-expanded="expandedIds.has(job.id)" :aria-controls="expandedIds.has(job.id) ? detailPanelId({ id: job.id }) : undefined" :aria-label="`${job.title} · ${lazyStrings.ModelDownloads__details()}`" tw-class="inline-flex shrink-0 items-center gap-1 rounded px-1 text-[10px] text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-500 dark:hover:text-gray-300">{{ lazyStrings.ModelDownloads__details() }}<ChevronDownIcon :tw-class="['h-3 w-3 transition-transform duration-200', expandedIds.has(job.id) ? 'rotate-180' : '']" /></button>
                  <span tw-class="shrink-0 tabular-nums text-gray-400 dark:text-gray-500">{{ amount({ files: job.files }) }}</span>
                </div>
                <Transition name="download-detail">
                  <div v-if="expandedIds.has(job.id)" :id="detailPanelId({ id: job.id })" class="download-detail-grid"><div tw-class="min-h-0 overflow-hidden"><div tw-class="pt-2"><ModelDownloadFileDetails :job="job" /></div></div></div>
                </Transition>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <footer tw-class="flex shrink-0 items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/70 px-4 py-2 dark:border-gray-800 dark:bg-gray-800/30">
        <span tw-class="min-w-0 truncate text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.ModelDownloads__history_is_session_only() }}</span>
        <button type="button" v-if="completed.length" @click="manager.clearCompleted()" tw-class="shrink-0 rounded px-1 py-0.5 text-[10px] text-gray-500 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-400 dark:hover:text-gray-200">{{ lazyStrings.ModelDownloads__clear_completed() }}</button>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
/* Animate the intrinsic file list height, including multi-file downloads,
   without guessing a max-height and without removing interactive content early. */
.download-detail-grid {
  display: grid;
  grid-template-rows: 1fr;
}
.download-detail-enter-active,
.download-detail-leave-active {
  transition: grid-template-rows 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 190ms ease;
}
.download-detail-enter-from,
.download-detail-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .download-detail-enter-active,
  .download-detail-leave-active {
    transition: none;
  }
}
</style>
