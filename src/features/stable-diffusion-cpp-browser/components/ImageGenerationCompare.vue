<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import { loadImageGenerationAsset, loadImageGenerationRun } from '@/00-storage/service/image-generation';
import { promiseAllKeyed } from '@/utils/promise';
import type { ImageGenerationWorkspaceView } from '@/features/stable-diffusion-cpp-browser/composables/use-image-generation-workspace';
import { compareImageGenerationImages, type ImageGenerationComparisonImage } from '@/features/stable-diffusion-cpp-browser/session/comparison';
import ImageHistoryImage from './ImageHistoryImage.vue';
const props = defineProps<{ view: ImageGenerationWorkspaceView }>();
const values = shallowRef<ImageGenerationComparisonImage[]>([]), failure = ref(''), loading = ref(false), identical = ref(false);
watch(() => [props.view.store.value, props.view.selection.value] as const, async ([store, selection], _previous, onCleanup) => {
  let active = true; onCleanup(() => {
    active = false;
  }); values.value = []; failure.value = ''; loading.value = false;
  if (!store || selection.length !== 2) return;
  loading.value = true;
  try {
    const loaded = await Promise.all(selection.map(async tile => {
      const result = await promiseAllKeyed({ asset: loadImageGenerationAsset({ store, sessionId: tile.sessionId, assetId: tile.id }), run: loadImageGenerationRun({ store, sessionId: tile.sessionId, runId: tile.runId }) });
      if (!result.asset || !result.run) throw new Error('A selected image record is unavailable.');
      return { asset: result.asset, run: result.run };
    }));
    if (active) values.value = loaded;
  } catch (error) {
    if (active) failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (active) loading.value = false;
  }
}, { immediate: true });
const rows = computed(() => {
  const [left, right] = values.value;
  return left && right ? compareImageGenerationImages({ left, right }).filter(row => identical.value || !row.same) : [];
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-3" data-testid="workspace-compare">
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__compare_help() }}</p>
    <p v-if="loading" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.imageGeneration__loading() }}</p>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ failure }}</p>
    <div tw-class="grid grid-cols-2 gap-3"><div v-for="image in values" :key="idToRaw({ id: image.asset.id })" tw-class="min-w-0 space-y-2"><ImageHistoryImage :binary-object-id="image.asset.result.binaryObjectId" :width="image.asset.result.width" :height="image.asset.result.height" :alt="image.run.request.parameters.prompt" :get-image="view.getImage" eager /><p tw-class="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{{ image.asset.seed }}</p></div></div>
    <label v-if="values.length === 2" tw-class="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><input v-model="identical" type="checkbox" tw-class="accent-blue-600" />{{ lazyStrings.imageGeneration__compare_equal() }}</label>
    <div v-if="values.length === 2" tw-class="overflow-auto rounded-xl border border-gray-200 dark:border-gray-700"><table tw-class="w-full table-fixed text-xs"><tbody><tr v-for="row in rows" :key="row.key" :tw-class="['border-b border-gray-100 dark:border-gray-800', row.same ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200']"><th scope="row" tw-class="w-28 text-left p-2 align-top font-medium break-words">{{ row.key }}</th><td tw-class="p-2 align-top whitespace-pre-wrap break-all">{{ row.left }}</td><td tw-class="p-2 align-top whitespace-pre-wrap break-all">{{ row.right }}</td></tr></tbody></table></div>
    <p tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__compare_notice() }}</p>
  </section>
</template>
