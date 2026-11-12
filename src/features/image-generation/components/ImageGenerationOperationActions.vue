<script setup lang="ts">
import { computed, ref, onScopeDispose } from 'vue';
import { DownloadIcon, LoaderCircleIcon, RotateCcwIcon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import { lazyStrings, ensureStrings } from '@/strings';
import { storageService } from '@/00-storage/service';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import type { ImageGenerationOperation } from '@/01-models/image-generation';
import { idToRaw } from '@/01-models/ids';
import { createImageGenerationResultsArchive } from '@/features/image-generation/session/export';
import { recoverImageGenerationOperation } from '@/features/image-generation/session/operation-recovery';
import { downloadReadableStream } from '@/utils/stream-download';
import { useConfirm } from '@/composables/useConfirm';
const props = defineProps<{ operation: ImageGenerationOperation, store: ImageGenerationStoreAccess | undefined, unfinished: boolean, savedImageCount: number, downloadDisabled: boolean, recoveryDisabled: boolean }>();
const emit = defineEmits<{ updated: [] }>();
const { showConfirm } = useConfirm();
const action = ref<'download' | 'recover'>();
const busy = computed(() => action.value !== undefined);
const capturedImageCount = ref(0);
const resultImageCount = computed(() => {
  const current = action.value;
  switch (current) {
  case 'download': return capturedImageCount.value;
  case 'recover': case undefined: return props.savedImageCount;
  default: {
    const exhaustive: never = current;
    throw new Error(String(exhaustive));
  }
  }
});
const failure = ref('');
let controller: AbortController | undefined;
let disposed = false;
onScopeDispose(() => {
  disposed = true;
  controller?.abort();
});

async function download(): Promise<void> {
  const store = props.store, operation = props.operation;
  if (!store || busy.value || props.downloadDisabled || props.savedImageCount < 1) {
    return;
  }
  action.value = 'download';
  capturedImageCount.value = 0;
  failure.value = '';
  const abort = new AbortController();
  controller = abort;
  try {
    if (!await showConfirm({ title: await ensureStrings.imageComposition__download_results(), message: await ensureStrings.imageComposition__export_notice() }) || disposed || props.downloadDisabled || props.store?.storeId !== store.storeId || props.operation.id !== operation.id) {
      return;
    }
    const snapshot = await storageService.captureImageGenerationResults({ store, sessionId: operation.sessionId, operationId: operation.id });
    abort.signal.throwIfAborted();
    capturedImageCount.value = snapshot.images.length;
    if (!snapshot.images.length) {
      failure.value = await ensureStrings.ImageGenerationOperationActions__no_completed_images();
      emit('updated');
      return;
    }
    const archive = createImageGenerationResultsArchive({ snapshot, exportedAt: Date.now() });
    await downloadReadableStream({ stream: archive.stream, filename: `naidan-results-${idToRaw({ id: operation.id })}.zip`, size: undefined, signal: abort.signal });
    await archive.completed;
  } catch (error) {
    if (!disposed) {
      failure.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    action.value = undefined;
    controller = undefined;
  }
}

async function recover(): Promise<void> {
  const store = props.store, operation = props.operation;
  if (!store || busy.value || props.recoveryDisabled) {
    return;
  }
  action.value = 'recover';
  failure.value = '';
  try {
    if (!await showConfirm({ message: await ensureStrings.imageComposition__recover_notice() }) || disposed || props.recoveryDisabled || props.store?.storeId !== store.storeId || props.operation.id !== operation.id) {
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
    action.value = undefined;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2">
    <div tw-class="flex flex-wrap items-center gap-1.5 text-xs">
      <ActionButton :disabled="busy || downloadDisabled || !store || savedImageCount < 1" appearance="secondary" :icon-tone="undefined" :aria-busy="action === 'download'" @click="download" data-testid="operation-results-zip" tw-class="group min-h-8! gap-1.5! px-2.5! py-1.5!">
        <LoaderCircleIcon v-if="action === 'download'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500 group-disabled:text-gray-400 motion-reduce:animate-none dark:text-blue-400 dark:group-disabled:text-gray-500" />
        <DownloadIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 group-disabled:text-gray-400 dark:text-blue-400 dark:group-disabled:text-gray-500" />
        <span>{{ action === 'download' ? lazyStrings.ImageGenerationOperationActions__saving_results() : lazyStrings.imageComposition__download_results() }}</span>
        <span v-if="resultImageCount > 0" data-testid="operation-results-zip-count" tw-class="ml-0.5 border-l border-gray-200 pl-1.5 text-xs tabular-nums text-gray-500 dark:border-gray-700 dark:text-gray-400">{{ resultImageCount }}</span>
      </ActionButton>
      <ActionButton v-if="unfinished" :disabled="busy || recoveryDisabled || !store" appearance="secondary" :icon-tone="undefined" :aria-label="lazyStrings.imageComposition__recover()" :title="lazyStrings.imageComposition__recover()" @click="recover" data-testid="operation-recover" tw-class="min-h-8! min-w-8 px-2! py-1.5!"><RotateCcwIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /></ActionButton>
    </div>
    <p v-if="savedImageCount < 1" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationOperationActions__no_completed_images() }}</p>
    <p v-if="failure" role="alert" tw-class="text-xs break-words text-red-600 dark:text-red-400">{{ failure }}</p>
  </div>
</template>
