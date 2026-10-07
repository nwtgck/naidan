<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { StarIcon } from 'lucide-vue-next';
import { idToRaw } from '@/01-models/ids';
import { ensureStrings, lazyStrings } from '@/strings';
import { downloadBlob } from '@/utils/stream-download';
import type { ImageGenerationTile, ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';
import type { ImageDownloadFormat, ImageDownloadResult } from '@/features/image-generation/use-image-generation-types';
import { imageGenerationDownloadBlob } from '@/features/image-generation/history/download';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { jsonToHighlightedHtml } from '@/logic/security/allowedHtml';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
import ImageGenerationCurationActions from './ImageGenerationCurationActions.vue';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import ImageHistoryImage from './ImageHistoryImage.vue';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
const props = defineProps<{ view: ImageGenerationWorkspaceView, active: boolean }>();
const queue = shallowRef<ImageGenerationTile[]>([]), feedback = ref('');
const current = computed(() => props.view.inspectedTile.value);
const requestJson = computed(() => props.view.details.value ? JSON.stringify({ ...props.view.details.value.run.request, actualSeed: current.value?.seed }, undefined, 2) : '');
const requestHtml = computed(() => jsonToHighlightedHtml({ json: requestJson.value, highlight: true, keyStyle: 'raw' }));
const lineageHtml = computed(() => jsonToHighlightedHtml({ json: JSON.stringify(props.view.details.value?.run.sources ?? [], undefined, 2), highlight: true, keyStyle: 'raw' }));

watch(() => props.view.deletedAssetIds.value, deleted => {
  const ids = new Set(deleted);
  queue.value = queue.value.filter(tile => !ids.has(tile.id));
}, { flush: 'sync' });
// Freeze the browsing order for this opening. Removing a favorite from a
// filtered gallery must not replace the image being viewed with its neighbour.
watch(current, tile => {
  feedback.value = '';
  if (!tile) {
    queue.value = []; return;
  }
  if (!queue.value.length) queue.value = [...props.view.tiles.value];
  if (!queue.value.some(value => value.id === tile.id)) queue.value = [...queue.value, tile];
  queue.value = queue.value.map(value => value.id === tile.id ? tile : value);
}, { immediate: true, flush: 'sync' });
watch(() => props.view.tiles.value, tiles => {
  const updated = new Map(tiles.map(tile => [tile.id, tile]));
  queue.value = queue.value.map(tile => updated.get(tile.id) ?? tile);
}, { flush: 'sync' });
watch(() => props.active, active => {
  if (!active) props.view.closeDetails();
});
const index = computed({
  get: () => Math.max(0, queue.value.findIndex(tile => tile.id === current.value?.id)),
  set(value: number) {
    const tile = queue.value[value];
    if (tile && tile.id !== current.value?.id) void props.view.inspect({ tile });
  },
});
const actionDisabled = computed(() => !props.view.details.value || props.view.inspectLoading.value || !props.view.editorReady.value || props.view.editor.formDisabled.value);
async function reuse({ kind }: { kind: 'settings' | 'prompt' | 'initial' | 'reference' }): Promise<void> {
  if (actionDisabled.value) return;
  const id = current.value?.id;
  feedback.value = '';
  try {
    const result = await props.view.reuse({ kind });
    if (current.value?.id !== id) return;
    const error = props.view.failure.value || props.view.editor.historyActions.error.value;
    if (error) {
      feedback.value = error; return;
    }
    switch (result) {
    case 'applied': feedback.value = await ensureStrings.imageGeneration__action_applied(); break;
    case 'unavailable': break;
    default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
    }
  } catch (error) {
    if (current.value?.id === id) feedback.value = error instanceof Error ? error.message : String(error);
  }
}
async function download({ format, includeMetadata }: { format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult> {
  const selected = props.view.details.value;
  if (!selected) return { status: 'cancelled' };
  try {
    const png = await props.view.getImage({ binaryObjectId: selected.asset.result.binaryObjectId });
    if (!png) throw new Error('The saved image is unavailable.');
    const blob = await imageGenerationDownloadBlob({
      png,
      request: { ...selected.run.request, parameters: { ...selected.run.request.parameters, seed: selected.asset.seed } },
      image: { kind: 'final', width: selected.asset.result.width, height: selected.asset.result.height },
      format,
      includeMetadata,
    });
    const extension = (() => {
      switch (format) {
      case 'jpeg': return 'jpg';
      case 'png': case 'webp': return format;
      default: { const exhaustive: never = format; throw new Error(String(exhaustive)); }
      }
    })();
    downloadBlob({ blob, filename: `naidan-${idToRaw({ id: selected.asset.id })}.${extension}` });
    return { status: 'downloaded' };
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { queue, index } }) || {}) });
</script>
<template>
  <ImageGenerationViewer v-if="active && current" v-model:index="index" :count="queue.length" :download-enabled="!!view.details.value" @close="view.closeDetails()">
    <ImageHistoryImage :key="idToRaw({ id: current.id })" :binary-object-id="current.binaryObjectId" :width="current.width" :height="current.height" :alt="view.details.value?.run.request.parameters.prompt || current.seed" :get-image="view.getImage" eager viewer />
    <template #toolbar>
      <button type="button" @click="view.toggleTag({ tile: current, tag: { type: 'system', key: 'favorite' } })" :disabled="view.inspectLoading.value || view.mutation.value || !current.annotations" :aria-label="lazyStrings.imageGeneration__favorite()" :aria-pressed="view.hasTag({ tile: current, tag: { type: 'system', key: 'favorite' } })" data-testid="workspace-viewer-favorite" :tw-class="['min-h-10 min-w-10 p-2 rounded-lg hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40', view.hasTag({ tile: current, tag: { type: 'system', key: 'favorite' } }) ? 'text-amber-400' : 'text-gray-300']"><StarIcon tw-class="w-5 h-5" :fill="view.hasTag({ tile: current, tag: { type: 'system', key: 'favorite' } }) ? 'currentColor' : 'none'" /></button>
    </template>
    <template #download><ImageDownloadMenu :preferences="view.editor.imageDownloadPreferences" :on-preferences-change="view.editor.setImageDownloadPreferences" :active="active" :disabled="!view.details.value" :on-download="download" /></template>
    <template #details>
      <section data-testid="workspace-viewer-details" tw-class="space-y-4">
        <h2 tw-class="text-sm font-semibold">{{ lazyStrings.imageGeneration__inspect() }}</h2>
        <p tw-class="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{{ current.confirmation === 'unconfirmed' ? lazyStrings.ImageGenerationHistory__requested_seed() : lazyStrings.imageGeneration__actual_seed() }}: {{ current.seed }} · {{ current.width }} × {{ current.height }}</p>
        <p v-if="view.inspectLoading.value" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__loading() }}</p>
        <p v-if="view.inspectFailure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ view.inspectFailure.value }}</p>
        <p v-if="view.details.value" tw-class="text-sm whitespace-pre-wrap break-words">{{ view.details.value.run.request.parameters.prompt }}</p>
        <ImageGenerationCopyButton :text="view.details.value?.run.request.parameters.prompt" :label="lazyStrings.imageGeneration__copy_prompt()" show-label data-testid="workspace-copy-prompt" />
        <div v-if="view.details.value?.run.request.parameters.negativePrompt" tw-class="space-y-1"><div tw-class="flex items-center justify-between gap-2"><span tw-class="text-xs font-semibold">{{ lazyStrings.stableDiffusionCppBrowser__negative_prompt() }}</span><ImageGenerationCopyButton :text="view.details.value.run.request.parameters.negativePrompt" :label="lazyStrings.imageGeneration__copy_negative_prompt()" /></div><p tw-class="whitespace-pre-wrap break-words text-xs leading-relaxed">{{ view.details.value.run.request.parameters.negativePrompt }}</p></div>
        <ImageGenerationCurationActions :view="view" :items="[current]" />
        <fieldset tw-class="space-y-2"><legend tw-class="text-xs font-semibold">{{ lazyStrings.imageGeneration__tags() }}</legend>
          <div tw-class="flex flex-wrap gap-2"><button v-for="tag in view.userTags.value" :key="idToRaw({ id: tag.id })" type="button" :disabled="view.inspectLoading.value || view.mutation.value || !current.annotations" @click="view.toggleTag({ tile: current, tag: { type: 'user', tagId: tag.id } })" :aria-label="lazyStrings.imageGeneration__apply_tag() + ': ' + tag.name" :aria-pressed="view.hasTag({ tile: current, tag: { type: 'user', tagId: tag.id } })" :tw-class="['max-w-full break-words rounded-lg border px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40', view.hasTag({ tile: current, tag: { type: 'user', tagId: tag.id } }) ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700']">{{ tag.name }}</button></div>
        </fieldset>
        <div tw-class="flex flex-wrap gap-2">
          <button type="button" @click="reuse({ kind: 'prompt' })" :disabled="actionDisabled" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__reuse_prompt() }}</button>
          <button type="button" @click="reuse({ kind: 'settings' })" :disabled="actionDisabled" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__reuse_settings() }}</button>
          <button type="button" @click="reuse({ kind: 'initial' })" :disabled="actionDisabled" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__initial_image() }}</button>
          <button type="button" @click="reuse({ kind: 'reference' })" :disabled="actionDisabled" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__reference_image() }}</button>
        </div>
        <p v-if="feedback" role="status" tw-class="text-xs text-gray-600 dark:text-gray-300 break-words">{{ feedback }}</p>
        <p v-if="view.failure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ view.failure.value }}</p>
        <ImageSettingsSection v-if="view.details.value" :title="lazyStrings.imageGeneration__parameters()" :summary="undefined" compact>
          <ImageGenerationCopyButton :text="requestJson" :label="lazyStrings.imageGeneration__copy_settings()" show-label />
          <AllowedHtmlView as="pre" :html="requestHtml" data-testid="workspace-request-json" tw-class="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed font-mono text-gray-700 dark:text-gray-300" />
        </ImageSettingsSection>
        <ImageSettingsSection v-if="view.details.value?.run.sources.length" :title="lazyStrings.imageGeneration__lineage()" :summary="undefined" compact><AllowedHtmlView as="pre" :html="lineageHtml" tw-class="overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed font-mono text-gray-700 dark:text-gray-300" /></ImageSettingsSection>
      </section>
    </template>
  </ImageGenerationViewer>
</template>
