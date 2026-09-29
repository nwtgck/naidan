<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { previewDisplaySize } from '@/features/stable-diffusion-cpp-browser/preview-presentation';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
const props = defineProps<{ view: ImageGenerationView }>();
const { preview, keepPreviews, maxPreviews, previewError, livePreview, previewSnapshots, busy, supported } = props.view;
function formatElapsed({ elapsedMs }: { elapsedMs: number }): string {
  return `${(elapsedMs / 1000).toFixed(elapsedMs >= 10000 ? 0 : 1)} s`;
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section tw-class="rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-4 space-y-3" data-testid="image-preview-panel">
    <div tw-class="flex flex-wrap items-center justify-between gap-3">
      <label tw-class="inline-flex items-center gap-2 text-sm font-medium">
        <input v-model="preview.enabled" type="checkbox" :disabled="!supported" data-testid="image-preview-enabled" />
        {{ lazyStrings.stableDiffusionCppBrowser__preview_enabled() }}
      </label>
      <button v-if="livePreview || previewSnapshots.length" type="button" tw-class="text-xs text-gray-500 dark:text-gray-400 underline" @click="view.clearPreviews()">{{ lazyStrings.stableDiffusionCppBrowser__clear_previews() }}</button>
    </div>
    <details tw-class="text-sm space-y-3" data-testid="image-preview-settings">
      <summary tw-class="cursor-pointer text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__details() }}</summary>
      <div tw-class="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <label tw-class="space-y-1 min-w-0"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_mode() }}</span>
          <select v-model="preview.mode" :disabled="busy || !supported" data-testid="image-preview-mode" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 disabled:opacity-50">
            <option value="projection">{{ lazyStrings.stableDiffusionCppBrowser__preview_projection() }}</option>
            <option value="vae">{{ lazyStrings.stableDiffusionCppBrowser__preview_vae() }}</option>
          </select>
        </label>
        <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_interval() }}</span>
          <input v-model.number="preview.interval" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-preview-interval" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" />
        </label>
        <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_start_step() }}</span>
          <input v-model.number="preview.startStep" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-preview-start-step" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" />
        </label>
        <label tw-class="space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_max_edge() }}</span>
          <select v-model.number="preview.maxEdge" :disabled="!supported" data-testid="image-preview-size" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2">
            <option :value="128">128 px</option><option :value="256">256 px</option><option :value="512">512 px</option><option :value="1024">1024 px</option>
            <option :value="0">{{ lazyStrings.stableDiffusionCppBrowser__preview_original() }}</option>
          </select>
        </label>
      </div>
      <div tw-class="flex flex-wrap items-center gap-3">
        <label tw-class="inline-flex gap-2 items-center"><input v-model="keepPreviews" type="checkbox" :disabled="!supported" data-testid="image-keep-previews" />{{ lazyStrings.stableDiffusionCppBrowser__keep_previews() }}</label>
        <label tw-class="inline-flex gap-2 items-center text-xs"><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_limit() }}</span><input v-model.number="maxPreviews" type="number" min="1" max="100" step="1" :disabled="!supported" tw-class="w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
      </div>
      <p v-if="busy" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_mode_locked() }}</p>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_help() }}</p>
    </details>
    <p v-if="previewError" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__check_inputs() }}</p>
    <p v-if="preview.enabled && busy && !livePreview" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preview_empty() }}</p>
    <figure v-if="livePreview" tw-class="space-y-2" data-testid="image-live-preview">
      <img :src="livePreview.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" v-bind="previewDisplaySize({ frame: livePreview, maxEdge: preview.maxEdge })" tw-class="max-w-full h-auto rounded-xl border border-gray-200 dark:border-gray-800" />
      <figcaption tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__steps() }} {{ livePreview.step }} / {{ livePreview.steps }} · {{ livePreview.width }} × {{ livePreview.height }} · {{ lazyStrings.stableDiffusionCppBrowser__generation_time() }} {{ formatElapsed({ elapsedMs: livePreview.elapsedMs }) }}</figcaption>
    </figure>
    <div v-if="previewSnapshots.length" tw-class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <article v-for="frame in previewSnapshots" :key="frame.id" tw-class="min-w-0 space-y-1" data-testid="image-preview-snapshot">
        <img :src="frame.url" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" v-bind="previewDisplaySize({ frame, maxEdge: preview.maxEdge })" loading="lazy" tw-class="max-w-full h-auto rounded-lg border border-gray-200 dark:border-gray-800" />
        <p tw-class="text-[11px] text-gray-500 dark:text-gray-400">#{{ frame.runId }} · {{ frame.step }} / {{ frame.steps }} · {{ formatElapsed({ elapsedMs: frame.elapsedMs }) }}</p>
        <div tw-class="flex flex-wrap gap-3 text-xs">
          <a :href="frame.url" :download="`naidan-preview-${frame.runId}-${frame.step}.png`" tw-class="text-purple-600 dark:text-purple-400 underline">{{ lazyStrings.stableDiffusionCppBrowser__download_png() }}</a>
          <button type="button" tw-class="text-gray-500 underline" @click="view.removePreview({ previewId: frame.id })">{{ lazyStrings.stableDiffusionCppBrowser__remove() }}</button>
        </div>
      </article>
    </div>
  </section>
</template>
