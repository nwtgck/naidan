<script setup lang="ts">
import { onScopeDispose, shallowRef, ref, computed } from 'vue';
import { idToRaw, type ImageGenerationId, type BinaryObjectId } from '@/01-models/ids';
import { imagePendingRuns } from '@/features/image-generation/session/pending-runs';
import { ensureStrings, lazyStrings } from '@/strings';
import { downloadBlob } from '@/utils/stream-download';
import { useConfirm } from '@/composables/useConfirm';
import ImageHistoryImage from './ImageHistoryImage.vue';

const entries = shallowRef(imagePendingRuns.list()), failure = ref('');
const failed = computed(() => entries.value.filter(entry => entry.state.needsRetry));
const { showConfirm } = useConfirm();
const unsubscribe = imagePendingRuns.subscribe({
  listener() {
    entries.value = imagePendingRuns.list();
  },
});
onScopeDispose(unsubscribe);
async function getImage({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | undefined> {
  return imagePendingRuns.list().flatMap(entry => entry.state.pending).flatMap(output => output.files).find(file => file.binaryObjectId === binaryObjectId)?.blob;
}
async function download({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
  const blob = await getImage({ binaryObjectId });
  if (blob) downloadBlob({ blob, filename: 'naidan-pending-image.png' });
}
async function retry({ id }: { id: ImageGenerationId }): Promise<void> {
  failure.value = '';
  try {
    await imagePendingRuns.retry({ id });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  }
}
async function discard({ id }: { id: ImageGenerationId }): Promise<void> {
  if (!await showConfirm({ message: await ensureStrings.ImagePendingRuns__discard_warning() })) return;
  try {
    imagePendingRuns.discard({ id });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section v-if="failed.length" data-testid="image-pending-runs" tw-class="rounded-xl border border-amber-300 dark:border-amber-800 p-3 space-y-3">
    <h3 tw-class="text-sm font-semibold">{{ lazyStrings.ImagePendingRuns__unsaved_runs() }}</h3>
    <p tw-class="text-xs text-gray-600 dark:text-gray-400">{{ lazyStrings.ImagePendingRuns__save_without_generating_again() }}</p>
    <div v-for="entry in failed" :key="idToRaw({ id: entry.id })" tw-class="border-t border-gray-200 dark:border-gray-700 pt-2 space-y-2">
      <p tw-class="text-xs break-words">{{ entry.state.run?.request.parameters.prompt }}</p>
      <p role="status" tw-class="text-xs break-words text-amber-800 dark:text-amber-300">{{ entry.state.failure }}</p>
      <p v-if="!entry.state.pending.length" tw-class="text-xs">{{ lazyStrings.ImagePendingRuns__run_information_pending() }}</p>
      <div v-for="output in entry.state.pending" :key="idToRaw({ id: output.asset.id })" tw-class="space-y-1">
        <p v-if="output.asset.result.confirmation === 'unconfirmed'" data-testid="pending-unconfirmed" tw-class="text-xs text-amber-800 dark:text-amber-300">{{ lazyStrings.ImagePendingRuns__completion_unconfirmed() }}</p>
        <ImageHistoryImage :binary-object-id="output.asset.result.binaryObjectId" :width="output.asset.result.width" :height="output.asset.result.height" :alt="entry.state.run?.request.parameters.prompt || ''" :get-image="getImage" />
        <button type="button" @click="download({ binaryObjectId: output.asset.result.binaryObjectId })" data-testid="pending-download" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.ImagePendingRuns__download_image() }}</button>
      </div>
      <div tw-class="flex flex-wrap gap-3">
        <button type="button" :disabled="entry.phase !== 'retired' || entry.state.saving" @click="retry({ id: entry.id })" data-testid="pending-retry" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageGeneration__save_retry() }}</button>
        <button type="button" :disabled="entry.phase !== 'retired' || entry.state.saving" @click="discard({ id: entry.id })" data-testid="pending-discard" tw-class="text-xs text-red-600 disabled:opacity-40">{{ lazyStrings.ImagePendingRuns__discard_pending_save() }}</button>
      </div>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 break-words">{{ failure }}</p>
  </section>
</template>
