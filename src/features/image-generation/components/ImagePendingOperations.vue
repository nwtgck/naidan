<script setup lang="ts">
import { ref, shallowRef, onScopeDispose } from 'vue';
import { imagePendingOperations } from '@/features/image-generation/session/pending-operations';
import { idToRaw, type ImageGenerationOperationId } from '@/01-models/ids';
import { lazyStrings, ensureStrings } from '@/strings';
import { useConfirm } from '@/composables/useConfirm';
const entries = shallowRef(imagePendingOperations.list()), failure = ref('');
const { showConfirm } = useConfirm();
onScopeDispose(imagePendingOperations.subscribe({
  listener() {
    entries.value = imagePendingOperations.list();
  },
}));

async function retry({ id }: { id: ImageGenerationOperationId }): Promise<void> {
  try {
    await imagePendingOperations.retry({ id });
    failure.value = '';
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  }
}

async function discard({ id }: { id: ImageGenerationOperationId }): Promise<void> {
  if (!await showConfirm({ message: await ensureStrings.ImagePendingRuns__discard_warning() })) {
    return;
  }
  try {
    imagePendingOperations.discard({ id });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section v-if="entries.length" tw-class="rounded-xl border border-amber-300 dark:border-amber-800 p-3 space-y-3" data-testid="image-pending-operations">
    <h3 tw-class="text-sm font-semibold">{{ lazyStrings.imageComposition__pending_metadata() }}</h3>
    <p tw-class="text-xs">{{ lazyStrings.imageComposition__save_only() }}</p>
    <div v-for="entry in entries" :key="idToRaw({ id: entry.operation.id })" tw-class="space-y-2 text-xs">
      <p>{{ entry.operation.id }} · {{ entry.operation.runIds.length }}</p><p role="status" tw-class="break-words">{{ entry.message }}</p>
      <div tw-class="flex gap-3"><button type="button" :disabled="entry.saving" @click="retry({ id: entry.operation.id })" tw-class="text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageGeneration__save_retry() }}</button><button type="button" :disabled="entry.saving" @click="discard({ id: entry.operation.id })" tw-class="text-red-600 dark:text-red-400 disabled:opacity-40">{{ lazyStrings.ImagePendingRuns__discard_pending_save() }}</button></div>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ failure }}</p>
  </section>
</template>
