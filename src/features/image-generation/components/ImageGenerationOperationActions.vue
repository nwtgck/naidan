<script setup lang="ts">
import { ref, onScopeDispose } from 'vue';
import { lazyStrings, ensureStrings } from '@/strings';
import { storageService } from '@/00-storage/service';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import type { ImageGenerationOperation } from '@/01-models/image-generation';
import { idToRaw } from '@/01-models/ids';
import { createImageGenerationResultsArchive } from '@/features/image-generation/session/export';
import { recoverImageGenerationOperation } from '@/features/image-generation/session/operation-recovery';
import { downloadReadableStream } from '@/utils/stream-download';
import { useConfirm } from '@/composables/useConfirm';
const props = defineProps<{ operation: ImageGenerationOperation, store: ImageGenerationStoreAccess | undefined, unfinished: boolean, disabled: boolean }>();
const emit = defineEmits<{ updated: [] }>();
const { showConfirm } = useConfirm();
const busy = ref(false), failure = ref('');
let controller: AbortController | undefined;
let disposed = false;
onScopeDispose(() => {
  disposed = true;
  controller?.abort();
});

async function download(): Promise<void> {
  const store = props.store, operation = props.operation;
  if (!store || busy.value || props.disabled) {
    return;
  }
  busy.value = true;
  failure.value = '';
  const abort = new AbortController();
  controller = abort;
  try {
    if (!await showConfirm({ title: await ensureStrings.imageComposition__download_results(), message: await ensureStrings.imageComposition__export_notice() }) || disposed) {
      return;
    }
    const snapshot = await storageService.captureImageGenerationResults({ store, sessionId: operation.sessionId, operationId: operation.id });
    abort.signal.throwIfAborted();
    const archive = createImageGenerationResultsArchive({ snapshot, exportedAt: Date.now() });
    await downloadReadableStream({ stream: archive.stream, filename: `naidan-results-${idToRaw({ id: operation.id })}.zip`, size: undefined, signal: abort.signal });
    await archive.completed;
  } catch (error) {
    if (!disposed) {
      failure.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    busy.value = false;
    controller = undefined;
  }
}

async function recover(): Promise<void> {
  const store = props.store, operation = props.operation;
  if (!store || busy.value || props.disabled) {
    return;
  }
  busy.value = true;
  failure.value = '';
  try {
    if (!await showConfirm({ message: await ensureStrings.imageComposition__recover_notice() }) || disposed) {
      return;
    }
    await recoverImageGenerationOperation({ store, sessionId: operation.sessionId, operationId: operation.id });
    if (!disposed) {
      emit('updated');
    }
  } catch (error) {
    if (!disposed) {
      failure.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    busy.value = false;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2">
    <div tw-class="flex flex-wrap items-center gap-2 text-xs">
      <span v-if="operation.runIds.length > 1" tw-class="mr-auto font-medium">{{ lazyStrings.imageComposition__operation() }} · {{ operation.runIds.length }}</span>
      <button type="button" :disabled="busy || disabled || !store" @click="download" data-testid="operation-results-zip" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageComposition__download_results() }}</button>
      <button v-if="unfinished" type="button" :disabled="busy || disabled || !store" @click="recover" data-testid="operation-recover" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-gray-600 dark:text-gray-400 disabled:opacity-40">{{ lazyStrings.imageComposition__recover() }}</button>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs break-words text-red-600 dark:text-red-400">{{ failure }}</p>
  </div>
</template>
