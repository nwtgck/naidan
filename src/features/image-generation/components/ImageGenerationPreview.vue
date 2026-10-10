<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
import { lazyStrings } from '@/strings';
import { previewDisplaySize } from '@/features/image-generation/preview-presentation';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
const props = defineProps<{ view: ImageGenerationView, active: boolean, livePlacement: 'result' | 'panel' }>();
const { preview, keepPreviews, maxPreviews, previewError, livePreview, previewSnapshots, busy, supported } = props.view;
// Commit only once editing ends; intermediate digits must not release frames.
// The draft also survives renders while new preview frames arrive.
const previewLimitDraft = ref(String(maxPreviews.value));
watch(maxPreviews, value => {
  previewLimitDraft.value = String(value);
});

function editPreviewLimit({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) previewLimitDraft.value = event.target.value;
}

function commitPreviewLimit({ event }: { event: Event }): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (Number.isFinite(input.valueAsNumber)) maxPreviews.value = Math.min(100, Math.max(1, Math.trunc(input.valueAsNumber)));
  previewLimitDraft.value = String(maxPreviews.value);
  input.value = previewLimitDraft.value;
}

const viewerIndex = ref<number>();
const previewSettingsOpen = ref(false);
const previewSettingsId = useId();
watch(() => props.active, active => {
  if (!active) viewerIndex.value = undefined;
});
watch(() => props.view.historySaving.supported.value, () => {
  viewerIndex.value = undefined;
});
watch(previewSnapshots, (current, previous) => {
  if (viewerIndex.value === undefined) return;
  const selected = previous[viewerIndex.value];
  const nextIndex = current.findIndex(item => item.id === selected?.id);
  viewerIndex.value = nextIndex < 0 ? undefined : nextIndex;
});

function formatElapsed({ elapsedMs }: { elapsedMs: number }): string {
  return `${(elapsedMs / 1000).toFixed(elapsedMs >= 10000 ? 0 : 1)} s`;
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 px-3" data-testid="image-preview-panel">
    <div tw-class="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5">
      <label tw-class="inline-flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium leading-tight">
        <input v-model="preview.enabled" type="checkbox" role="switch" :disabled="!supported" data-testid="image-preview-enabled" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />
        <span>{{ lazyStrings.stableDiffusionCppBrowser__preview_enabled() }}</span>
      </label>
      <div tw-class="flex flex-wrap items-center self-center gap-2">
        <button type="button" :aria-expanded="previewSettingsOpen" :aria-controls="previewSettingsId" data-testid="image-preview-settings-toggle" @click="previewSettingsOpen = !previewSettingsOpen" tw-class="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-xs font-medium leading-tight text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          {{ lazyStrings.llamaCppBrowserDownloads__details() }}
          <ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 transition-transform motion-reduce:transition-none', previewSettingsOpen ? 'rotate-180' : '']" />
        </button>
        <button v-if="livePreview || previewSnapshots.length" type="button" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 text-xs font-bold text-red-600 dark:text-red-400 rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 hover:border-red-200 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors min-h-10" @click="view.clearPreviews()">{{ lazyStrings.stableDiffusionCppBrowser__clear_previews() }}</button>
      </div>
    </div>
    <div v-show="previewSettingsOpen || previewError || (preview.enabled && busy && !livePreview) || (livePreview && livePlacement === 'panel') || previewSnapshots.length" tw-class="space-y-3 px-1 pt-2 pb-3">
      <div :id="previewSettingsId" v-show="previewSettingsOpen" :inert="previewSettingsOpen ? undefined : true" data-testid="image-preview-settings" tw-class="space-y-3 border-t border-gray-200 dark:border-gray-700 pt-3 pb-2 text-xs">
        <div tw-class="grid sm:grid-cols-2 gap-3">
          <label tw-class="space-y-1 min-w-0"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_mode() }}</span>
            <span tw-class="relative block"><select v-model="preview.mode" :disabled="busy || !supported" data-testid="image-preview-mode" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-800 dark:text-gray-100 shadow-sm disabled:opacity-50">
              <option value="projection">{{ lazyStrings.stableDiffusionCppBrowser__preview_projection() }}</option>
              <option value="vae">{{ lazyStrings.stableDiffusionCppBrowser__preview_vae() }}</option>
            </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
          </label>
          <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_start_step() }}</span>
            <input v-model.number="preview.startStep" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-preview-start-step" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-800 dark:text-gray-100 shadow-sm" />
          </label>
          <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_interval() }}</span>
            <input v-model.number="preview.interval" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-preview-interval" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-800 dark:text-gray-100 shadow-sm" />
          </label>
          <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_max_edge() }}</span>
            <span tw-class="relative block"><select v-model.number="preview.maxEdge" :disabled="!supported" data-testid="image-preview-size" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-800 dark:text-gray-100 shadow-sm">
              <option :value="128">128 px</option><option :value="256">256 px</option><option :value="512">512 px</option><option :value="1024">1024 px</option>
              <option :value="0">{{ lazyStrings.stableDiffusionCppBrowser__preview_original() }}</option>
            </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
          </label>
        </div>
        <div tw-class="flex flex-wrap items-center gap-3">
          <label tw-class="min-h-10 cursor-pointer inline-flex gap-2 items-center"><input v-model="keepPreviews" type="checkbox" role="switch" :disabled="!supported" data-testid="image-keep-previews" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />{{ lazyStrings.stableDiffusionCppBrowser__keep_previews() }}</label>
          <label tw-class="inline-flex gap-2 items-center text-xs"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_limit() }}</span><input :value="previewLimitDraft" @input="editPreviewLimit({ event: $event })" @change="commitPreviewLimit({ event: $event })" data-testid="image-preview-limit" type="number" min="1" max="100" step="1" :disabled="!supported" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 w-20 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-800 dark:text-gray-100 shadow-sm" /></label>
        </div>
        <p v-if="busy" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_mode_locked() }}</p>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_help() }}</p>
      </div>
      <p v-if="previewError" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__check_inputs() }}</p>
      <p v-if="preview.enabled && busy && !livePreview" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_empty() }}</p>
      <figure v-if="livePreview && livePlacement === 'panel'" tw-class="space-y-2" data-testid="image-live-preview">
        <img :src="livePreview.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" v-bind="previewDisplaySize({ frame: livePreview, maxEdge: preview.maxEdge })" :style="{ maxWidth: `min(100%, ${livePreview.width}px)` }" tw-class="h-auto rounded-xl border border-gray-200 dark:border-gray-800" />
        <figcaption tw-class="space-y-1 text-xs text-gray-500 dark:text-gray-400">
          <p v-if="view.latestRun.value?.status === 'failed'">{{ lazyStrings.ImageGenerationPreview__preview_from_failed_generation() }}</p>
          <p v-else-if="view.latestRun.value?.status === 'cancelled'">{{ lazyStrings.ImageGenerationPreview__preview_from_cancelled_generation() }}</p>
          <p>{{ lazyStrings.stableDiffusionCppBrowser__steps() }} {{ livePreview.step }} / {{ livePreview.steps }} · {{ livePreview.width }} × {{ livePreview.height }} · {{ lazyStrings.stableDiffusionCppBrowser__generation_time() }} {{ formatElapsed({ elapsedMs: livePreview.elapsedMs }) }}</p>
        </figcaption>
      </figure>
      <div v-if="previewSnapshots.length" tw-class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
        <article v-for="(frame, index) in previewSnapshots" :key="frame.id" tw-class="min-w-0 space-y-1" data-testid="image-preview-snapshot">
          <button type="button" @click="viewerIndex = index" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 block w-full">
            <img :src="frame.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" v-bind="previewDisplaySize({ frame, maxEdge: preview.maxEdge })" :style="{ maxWidth: `min(100%, ${frame.width}px)` }" loading="lazy" tw-class="h-auto rounded-lg border border-gray-200 dark:border-gray-800" />
          </button>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">#{{ frame.runId }} · {{ frame.step }} / {{ frame.steps }} · {{ formatElapsed({ elapsedMs: frame.elapsedMs }) }}</p>
          <div tw-class="flex flex-wrap gap-3 text-xs">
            <!-- Exporting retained pixels does not depend on the selected inference profile. -->
            <ImageDownloadMenu :preferences="view.imageDownloadPreferences" :on-preferences-change="view.setImageDownloadPreferences" :active="active" :disabled="false" :on-download="options => view.downloadPreview({ previewId: frame.id, ...options })" />
            <button type="button" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 text-red-600 dark:text-red-400 font-bold rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 hover:border-red-200 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors min-h-10" @click="view.removePreview({ previewId: frame.id })">{{ lazyStrings.stableDiffusionCppBrowser__remove() }}</button>
          </div>
        </article>
      </div>
    </div>
    <ImageGenerationViewer :download-enabled="true" v-if="viewerIndex !== undefined" v-model:index="viewerIndex" :count="previewSnapshots.length" @close="viewerIndex = undefined">
      <template #download><ImageDownloadMenu :preferences="view.imageDownloadPreferences" :on-preferences-change="view.setImageDownloadPreferences" v-if="previewSnapshots[viewerIndex]" :key="previewSnapshots[viewerIndex]!.id" :active="active" :disabled="false" :on-download="options => view.downloadPreview({ previewId: previewSnapshots[viewerIndex!]!.id, ...options })" /></template>
      <img v-if="previewSnapshots[viewerIndex]" :src="previewSnapshots[viewerIndex]!.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" tw-class="max-w-full max-h-[85vh] object-contain" />
    </ImageGenerationViewer>
  </section>
</template>
