<script setup lang="ts">
import { ref, watch } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
import { lazyStrings } from '@/strings';
import { previewDisplaySize } from '@/features/stable-diffusion-cpp-browser/preview-presentation';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
const props = defineProps<{ view: ImageGenerationView, active: boolean }>();
const { preview, keepPreviews, maxPreviews, previewError, livePreview, previewSnapshots, busy, supported } = props.view;
const viewerIndex = ref<number>();
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
  <section tw-class="rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-4 space-y-3" data-testid="image-preview-panel">
    <div tw-class="flex flex-wrap items-center justify-between gap-3">
      <label tw-class="min-h-10 cursor-pointer inline-flex items-center gap-2 text-sm font-medium">
        <input v-model="preview.enabled" type="checkbox" role="switch" :disabled="!supported" data-testid="image-preview-enabled" tw-class="relative appearance-none h-5 w-9 shrink-0 cursor-pointer rounded-full bg-gray-300 dark:bg-gray-600 checked:bg-purple-600 dark:checked:bg-purple-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform checked:after:translate-x-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed" />
        {{ lazyStrings.stableDiffusionCppBrowser__preview_enabled() }}
      </label>
      <button v-if="livePreview || previewSnapshots.length" type="button" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 text-xs text-gray-500 dark:text-gray-400 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10" @click="view.clearPreviews()">{{ lazyStrings.stableDiffusionCppBrowser__clear_previews() }}</button>
    </div>
    <ImageSettingsSection :title="lazyStrings.llamaCppBrowserDownloads__details()" :summary="preview.mode + ' · ' + preview.interval" data-testid="image-preview-settings">
      <div tw-class="grid sm:grid-cols-2 gap-3">
        <label tw-class="space-y-1 min-w-0"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_mode() }}</span>
          <span tw-class="relative block"><select v-model="preview.mode" :disabled="busy || !supported" data-testid="image-preview-mode" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50 block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 disabled:opacity-50">
            <option value="projection">{{ lazyStrings.stableDiffusionCppBrowser__preview_projection() }}</option>
            <option value="vae">{{ lazyStrings.stableDiffusionCppBrowser__preview_vae() }}</option>
          </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
        </label>
        <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_interval() }}</span>
          <input v-model.number="preview.interval" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-preview-interval" tw-class="outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50 block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" />
        </label>
        <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_start_step() }}</span>
          <input v-model.number="preview.startStep" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-preview-start-step" tw-class="outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50 block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" />
        </label>
        <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_max_edge() }}</span>
          <span tw-class="relative block"><select v-model.number="preview.maxEdge" :disabled="!supported" data-testid="image-preview-size" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50 block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2">
            <option :value="128">128 px</option><option :value="256">256 px</option><option :value="512">512 px</option><option :value="1024">1024 px</option>
            <option :value="0">{{ lazyStrings.stableDiffusionCppBrowser__preview_original() }}</option>
          </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
        </label>
      </div>
      <div tw-class="flex flex-wrap items-center gap-3">
        <label tw-class="min-h-10 cursor-pointer inline-flex gap-2 items-center"><input v-model="keepPreviews" type="checkbox" role="switch" :disabled="!supported" data-testid="image-keep-previews" tw-class="relative appearance-none h-5 w-9 shrink-0 cursor-pointer rounded-full bg-gray-300 dark:bg-gray-600 checked:bg-purple-600 dark:checked:bg-purple-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform checked:after:translate-x-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed" />{{ lazyStrings.stableDiffusionCppBrowser__keep_previews() }}</label>
        <label tw-class="inline-flex gap-2 items-center text-xs"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_limit() }}</span><input v-model.number="maxPreviews" type="number" min="1" max="100" step="1" :disabled="!supported" tw-class="outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50 w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
      </div>
      <p v-if="busy" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_mode_locked() }}</p>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_help() }}</p>
    </ImageSettingsSection>
    <p v-if="previewError" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__check_inputs() }}</p>
    <p v-if="preview.enabled && busy && !livePreview" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_empty() }}</p>
    <figure v-if="livePreview" tw-class="space-y-2" data-testid="image-live-preview">
      <img :src="livePreview.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" v-bind="previewDisplaySize({ frame: livePreview, maxEdge: preview.maxEdge })" tw-class="max-w-full h-auto rounded-xl border border-gray-200 dark:border-gray-800" />
      <figcaption tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__steps() }} {{ livePreview.step }} / {{ livePreview.steps }} · {{ livePreview.width }} × {{ livePreview.height }} · {{ lazyStrings.stableDiffusionCppBrowser__generation_time() }} {{ formatElapsed({ elapsedMs: livePreview.elapsedMs }) }}</figcaption>
    </figure>
    <div v-if="previewSnapshots.length" tw-class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <article v-for="(frame, index) in previewSnapshots" :key="frame.id" tw-class="min-w-0 space-y-1" data-testid="image-preview-snapshot">
        <button type="button" @click="viewerIndex = index" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 block w-full">
          <img :src="frame.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" v-bind="previewDisplaySize({ frame, maxEdge: preview.maxEdge })" loading="lazy" tw-class="max-w-full h-auto rounded-lg border border-gray-200 dark:border-gray-800" />
        </button>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">#{{ frame.runId }} · {{ frame.step }} / {{ frame.steps }} · {{ formatElapsed({ elapsedMs: frame.elapsedMs }) }}</p>
        <div tw-class="flex flex-wrap gap-3 text-xs">
          <ImageDownloadMenu :active="active" :disabled="!supported" :on-download="options => view.downloadPreview({ previewId: frame.id, ...options })" />
          <button type="button" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 text-gray-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10" @click="view.removePreview({ previewId: frame.id })">{{ lazyStrings.stableDiffusionCppBrowser__remove() }}</button>
        </div>
      </article>
    </div>
    <ImageGenerationViewer :download-enabled="true" v-if="viewerIndex !== undefined" v-model:index="viewerIndex" :count="previewSnapshots.length" @close="viewerIndex = undefined">
      <template #download><ImageDownloadMenu v-if="previewSnapshots[viewerIndex]" :key="previewSnapshots[viewerIndex]!.id" :active="active" :disabled="!supported" :on-download="options => view.downloadPreview({ previewId: previewSnapshots[viewerIndex!]!.id, ...options })" /></template>
      <img v-if="previewSnapshots[viewerIndex]" :src="previewSnapshots[viewerIndex]!.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" tw-class="max-w-full max-h-[85vh] object-contain" />
    </ImageGenerationViewer>
  </section>
</template>
