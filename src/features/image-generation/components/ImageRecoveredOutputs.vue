<script setup lang="ts">
import { imagePendingRuns } from '@/features/image-generation/session/pending-runs';
import ImageHistoryImage from './ImageHistoryImage.vue';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { lazyStrings, ensureStrings } from '@/strings';
import { downloadBlob } from '@/utils/stream-download';
import { useConfirm } from '@/composables/useConfirm';
import { idToRaw, type ImageGenerationId, type BinaryObjectId } from '@/01-models/ids';
import { imageRecoveryStore } from '@/features/image-generation/execution/recovery';
const entries = shallowRef(imageRecoveryStore.list()), failure = ref(''), saving = ref(false);
const pendingRuns = shallowRef(imagePendingRuns.list());
// A run's recovery uses the run-level save/discard controls. Duplicating those
// controls here made 'discard image' silently discard other outputs in the run.
const unowned = computed(() => entries.value.filter(entry => !pendingRuns.value.some(run =>
  run.state.pending.some(output => output.asset.result.binaryObjectId === entry.record.result.binaryObjectId))));
onScopeDispose(imagePendingRuns.subscribe({
  listener() {
    pendingRuns.value = imagePendingRuns.list();
  },
}));
const { showConfirm } = useConfirm();
const unsubscribe = imageRecoveryStore.subscribe({
  listener() {
    entries.value = imageRecoveryStore.list();
  },
});
onScopeDispose(unsubscribe);

async function getImage({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | undefined> {
  return imageRecoveryStore.list().flatMap(entry => entry.files).find(file => file.binaryObjectId === binaryObjectId)?.blob;
}

function download({ id }: { id: ImageGenerationId }): void {
  const entry = imageRecoveryStore.list().find(item => item.id === id);
  const image = entry?.files.find(file => file.binaryObjectId === entry.record.result.binaryObjectId);
  if (image) downloadBlob({ blob: image.blob, filename: 'naidan-recovered-image.png' });
}

async function retry({ id }: { id: ImageGenerationId }): Promise<void> {
  if (saving.value) return;
  const entry = imageRecoveryStore.list().find(item => item.id === id);
  if (!entry?.retry) return;
  saving.value = true; failure.value = '';
  try {
    await entry.retry();
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

async function discard({ id }: { id: ImageGenerationId }): Promise<void> {
  if (!await showConfirm({ message: await ensureStrings.ImageRecoveredOutputs__discard_warning() })) return;
  try {
    const image = imageRecoveryStore.list().find(entry => entry.id === id);
    if (!image) return;
    const runs = imagePendingRuns.list().filter(entry => entry.state.pending.some(output => output.asset.result.binaryObjectId === image.record.result.binaryObjectId));
    if (saving.value) throw new Error('Wait for the current save to finish.');
    // Ownership can change while the confirmation dialog is open. Never turn
    // one image's stale confirmation into permission to discard an entire run.
    if (runs.length) throw new Error(await ensureStrings.ImageRecoveredOutputs__managed_by_pending_run());
    imageRecoveryStore.remove({ id });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section v-if="unowned.length || failure" data-testid="image-recovered-outputs" tw-class="rounded-xl border border-amber-300 dark:border-amber-800 p-3 space-y-3">
    <h3 tw-class="text-sm font-semibold">{{ lazyStrings.ImageRecoveredOutputs__unconfirmed_images() }}</h3>
    <p tw-class="text-xs text-gray-600 dark:text-gray-400">{{ lazyStrings.ImageRecoveredOutputs__recovery_explanation() }}</p>
    <div v-for="entry in unowned" :key="idToRaw({ id: entry.id })" tw-class="space-y-1 border-t border-gray-200 dark:border-gray-700 pt-2">
      <ImageHistoryImage :binary-object-id="entry.record.result.binaryObjectId" :width="entry.record.result.width" :height="entry.record.result.height" :alt="entry.record.request.parameters.prompt" :get-image="getImage" />
      <p tw-class="text-xs break-words">{{ entry.record.request.parameters.prompt }}</p>
      <p tw-class="text-xs text-gray-500">{{ entry.record.result.width }} × {{ entry.record.result.height }} · {{ entry.record.request.runtime.profile === 'naidan-rpc' ? entry.record.request.runtime.label : entry.record.request.runtime.profile }}</p>
      <div tw-class="flex flex-wrap gap-3">
        <button type="button" @click="download({ id: entry.id })" data-testid="recovered-download" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.ImageRecoveredOutputs__download_image() }}</button>
        <button v-if="entry.retry" type="button" :disabled="saving" @click="retry({ id: entry.id })" data-testid="recovered-retry" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageGeneration__save_retry() }}</button>
        <button type="button" :disabled="saving" @click="discard({ id: entry.id })" data-testid="recovered-discard" tw-class="text-xs text-red-600 disabled:opacity-40">{{ lazyStrings.ImageRecoveredOutputs__discard_image() }}</button>
      </div>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 break-words">{{ failure }}</p>
  </section>
</template>
