<script setup lang="ts">
import { onScopeDispose, shallowRef, ref } from 'vue';
import { idToRaw, type BinaryObjectId, type ImageGenerationId } from '@/01-models/ids';
import { pendingImageHistory } from '@/features/image-generation/history/pending-saves';
import { ensureStrings, lazyStrings } from '@/strings';
import { downloadBlob } from '@/utils/stream-download';
import { useConfirm } from '@/composables/useConfirm';
import ImageHistoryImage from './ImageHistoryImage.vue';

const entries = shallowRef(pendingImageHistory.list()), failure = ref('');
const { showConfirm } = useConfirm();
const unsubscribe = pendingImageHistory.subscribe({
  listener() {
  entries.value = pendingImageHistory.list();
},
});
onScopeDispose(unsubscribe);
async function getImage({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | undefined> {
  return pendingImageHistory.list().flatMap(entry => entry.files).find(file => file.binaryObjectId === binaryObjectId)?.blob;
}
async function download({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
  const blob = await getImage({ binaryObjectId });
  if (blob) downloadBlob({ blob, filename: 'naidan-unsaved-image.png' });
}
async function retry({ id }: { id: ImageGenerationId }): Promise<void> {
  failure.value = '';
  try {
    await pendingImageHistory.retry({ id });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  }
}
async function discard({ id }: { id: ImageGenerationId }): Promise<void> {
  if (!await showConfirm({ message: await ensureStrings.ImagePendingHistory__discard_warning() })) return;
  try {
    pendingImageHistory.discard({ id });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section v-if="entries.length" data-testid="image-pending-history" tw-class="rounded-xl border border-amber-300 dark:border-amber-800 p-3 space-y-3">
    <h3 tw-class="text-sm font-semibold">{{ lazyStrings.ImagePendingHistory__unsaved_images() }}</h3>
    <p tw-class="text-xs text-gray-600 dark:text-gray-400">{{ lazyStrings.ImagePendingHistory__save_without_generating_again() }}</p>
    <div v-for="entry in entries" :key="idToRaw({ id: entry.record.id })" tw-class="border-t border-gray-200 dark:border-gray-700 pt-2 space-y-2">
      <p tw-class="text-xs break-words">{{ entry.record.request.parameters.prompt }}</p>
      <p v-if="entry.failure" role="status" tw-class="text-xs break-words text-amber-800 dark:text-amber-300">{{ entry.failure }}</p>
      <ImageHistoryImage :binary-object-id="entry.record.result.binaryObjectId" :width="entry.record.result.width" :height="entry.record.result.height" :alt="entry.record.request.parameters.prompt" :get-image="getImage" />
      <div tw-class="flex flex-wrap gap-3">
        <button type="button" @click="download({ binaryObjectId: entry.record.result.binaryObjectId })" data-testid="pending-history-download" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.ImagePendingHistory__download_image() }}</button>
        <button type="button" :disabled="entry.phase === 'saving'" @click="retry({ id: entry.record.id })" data-testid="pending-history-retry" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageGeneration__save_retry() }}</button>
        <button type="button" :disabled="entry.phase === 'saving'" @click="discard({ id: entry.record.id })" data-testid="pending-history-discard" tw-class="text-xs text-red-600 disabled:opacity-40">{{ lazyStrings.ImagePendingHistory__discard() }}</button>
      </div>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 break-words">{{ failure }}</p>
  </section>
</template>
