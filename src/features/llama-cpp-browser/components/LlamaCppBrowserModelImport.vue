<script setup lang="ts">
import TemporaryModelFolders from '@/components/TemporaryModelFolders.vue';
import { computed, defineAsyncComponent, onUnmounted, ref, useId, watch } from 'vue';
import { AlertCircleIcon, FileUpIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { errorCode, type ErrorCode, type ModelDirectoryInput, type Progress } from '@/features/llama-cpp-browser/types';
import { directoryFromFiles, droppedModels } from '@/features/llama-cpp-browser/runtime/directory-input';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import LlamaCppBrowserModelFileInput from './LlamaCppBrowserModelFileInput.vue';

const LlamaCppBrowserModelImportLinkedFolders = defineAsyncComponent(() => import('./LlamaCppBrowserModelImportLinkedFolders.vue'));

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean], changed: [] }>();
const id = useId();
const active = ref<AbortController>();
const importProgress = ref<Progress>();
const percentage = computed(() => importProgress.value && importProgress.value.total > 0
  ? Math.min(100, Math.max(0, Math.round(importProgress.value.completed / importProgress.value.total * 100))) : undefined);
const localError = ref<ErrorCode>();
let disposed = false;
const mode = ref<'opfs' | 'host' | 'temp'>('opfs');
const linkSupported = missingHostModelDirectoryApis().length === 0;
const linkBusy = ref(false);
// Switching modes is a local presentation choice, not a persisted preference.
// In particular an unsupported link option stays keyboard/click selectable:
// only actual file operations honor the parent's disabled state, so explanations
// remain discoverable even when inference itself is unavailable.
watch(mode, () => {
  localError.value = undefined;
});
type ImportInput = { files: File[], directories: ModelDirectoryInput[] };

async function importFiles({ collect }: { collect: () => ImportInput | Promise<ImportInput> }): Promise<void> {
  // Returning focus from a native drag or file picker starts a read-only list
  // refresh. That refresh must not disable imports or silently discard the input.
  if (disposed || props.disabled || active.value !== undefined || mode.value === 'host' || linkBusy.value) {
    return;
  }
  localError.value = undefined;
  const storage = mode.value;
  const importOptions = ((): { storage?: 'temp' } => {
    switch (storage) {
    case 'opfs': return {};
    case 'temp': return { storage };
    default: {
      const exhaustive: never = storage;
      throw new Error(String(exhaustive));
    }
    }
  })();
  // Reserve the operation before asynchronous entry traversal, not just before
  // writing files. Cancellation/unmount must prevent late writes, and a second
  // drop, download, or deletion must not take over while an entry callback is pending.
  const controller = new AbortController();
  active.value = controller;
  importProgress.value = undefined;
  function onProgress({ progress }: { progress: Progress }): void {
    if (!disposed && active.value === controller && !controller.signal.aborted) {
      importProgress.value = progress;
    }
  }
  emit('busy', true);
  let needsRefresh = false;
  try {
    // Invoke collect during dispatch, before the first await: DataTransfer entries
    // must be captured while the browser still exposes the drop's data store.
    const { files, directories } = await collect();
    if (disposed || controller.signal.aborted) {
      return;
    }
    if (files.some(file => !file.name.toLowerCase().endsWith('.gguf'))) {
      localError.value = 'invalid-gguf';
      return;
    }
    for (const directory of directories) {
      if (controller.signal.aborted) {
        break;
      }
      needsRefresh = true;
      importProgress.value = undefined;
      await llamaCppBrowserModelFiles.importDirectory({ directory, signal: controller.signal, onProgress, ...importOptions });
    }
    for (const file of files) {
      if (controller.signal.aborted) {
        break;
      }
      needsRefresh = true;
      importProgress.value = undefined;
      await llamaCppBrowserModelFiles.importModel({ file, signal: controller.signal, onProgress, ...importOptions });
    }
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      localError.value = errorCode({ error });
    }
  } finally {
    if (!disposed && needsRefresh) {
      emit('changed');
    }
    active.value = undefined;
    emit('busy', false);
  }
}

async function importFile({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) {
    return;
  }
  await importFiles({ collect: () => ({ files, directories: [] }) });
}

async function importDirectory({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) {
    return;
  }
  await importFiles({ collect: () => ({ files: [], directories: [directoryFromFiles({ files })] }) });
}

async function dropFiles({ event }: { event: DragEvent }): Promise<void> {
  const transfer = event.dataTransfer;
  if (!transfer) {
    return;
  }
  await importFiles({ collect: () => droppedModels({ transfer, signal: active.value?.signal }) });
}

function cancel(): void {
  active.value?.abort();
}

onUnmounted(() => {
  disposed = true;
  active.value?.abort();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="llama-cpp-browser-import" tw-class="space-y-3">
    <fieldset :disabled="active !== undefined || linkBusy" tw-class="space-y-3 disabled:opacity-50">
      <legend tw-class="w-full flex items-center gap-2 pb-2 mb-3 border-b border-gray-100 dark:border-gray-800">
        <FileUpIcon tw-class="w-5 h-5 text-blue-500" />
        <span tw-class="text-sm font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.llamaCppBrowser__gguf_model_files() }}</span>
      </legend>
      <div role="group" :aria-label="lazyStrings.SHARED__model_import_how_to_use_files()" tw-class="grid grid-cols-1 sm:grid-cols-3 gap-1 rounded-xl bg-gray-100 dark:bg-gray-800 p-1">
        <button type="button" :aria-pressed="mode === 'opfs'" data-testid="llama-import-mode-opfs" :tw-class="['rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', mode === 'opfs' ? 'bg-white dark:bg-gray-700 text-blue-700 dark:text-blue-300 shadow-sm' : 'text-gray-600 dark:text-gray-300']" @click="mode = 'opfs'">{{ lazyStrings.SHARED__model_import_save_in_browser() }}</button>
        <button type="button" :aria-pressed="mode === 'host'" :aria-describedby="!linkSupported ? `${id}-link-unavailable` : undefined" data-testid="llama-import-mode-host" :tw-class="['rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', mode === 'host' ? 'bg-white dark:bg-gray-700 text-blue-700 dark:text-blue-300 shadow-sm' : 'text-gray-600 dark:text-gray-300', !linkSupported ? 'opacity-50' : 'opacity-100']" @click="mode = 'host'">{{ lazyStrings.SHARED__model_import_link_folder() }}<span v-if="!linkSupported" :id="`${id}-link-unavailable`" tw-class="block text-[10px] font-normal">{{ lazyStrings.SHARED__model_import_unavailable() }}</span></button>
        <button type="button" :aria-pressed="mode === 'temp'" data-testid="llama-import-mode-temp" :tw-class="['rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', mode === 'temp' ? 'bg-white dark:bg-gray-700 text-blue-700 dark:text-blue-300 shadow-sm' : 'text-gray-600 dark:text-gray-300']" @click="mode = 'temp'">{{ lazyStrings.SHARED__model_import_use_temporarily() }}</button>
      </div>
      <LlamaCppBrowserModelImportLinkedFolders v-if="mode === 'host'" :disabled="disabled || active !== undefined" @busy="linkBusy = $event; emit('busy', $event)" @changed="emit('changed')" />
      <LlamaCppBrowserModelFileInput v-if="mode !== 'host'" :disabled="disabled || active !== undefined" :mode="mode" layout="compact" @files="importFile({ event: $event })" @directory="importDirectory({ event: $event })" @drop-files="dropFiles({ event: $event })" />
    </fieldset>
    <TemporaryModelFolders v-if="mode === 'temp'" :disabled="disabled || active !== undefined" />
    <div v-if="active" tw-class="rounded-2xl border border-blue-100 dark:border-blue-900/30 p-4 space-y-3">
      <div tw-class="flex items-center justify-between gap-3">
        <p role="status" data-testid="llama-cpp-browser-import-status" tw-class="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"><Loader2Icon aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />{{ lazyStrings.llamaCppBrowser__importing() }}</p>
        <span v-if="percentage !== undefined" tw-class="text-xs tabular-nums text-gray-500 dark:text-gray-400">{{ percentage }}%</span>
      </div>
      <template v-if="percentage !== undefined">
        <div role="progressbar" :aria-label="lazyStrings.llamaCppBrowser__importing()" :aria-valuenow="percentage" :aria-valuemin="0" :aria-valuemax="100" tw-class="h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"><div tw-class="h-full rounded-full bg-blue-500/80 dark:bg-blue-400/80 transition-[width] duration-300 ease-out motion-reduce:transition-none" :style="{ width: `${percentage}%` }"></div></div>
      </template>
      <div tw-class="flex justify-end"><button type="button" data-testid="llama-cpp-browser-cancel" tw-class="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" @click="cancel">{{ lazyStrings.SHARED__cancel() }}</button></div>
    </div>
    <div v-if="localError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ localError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ localError }}</code></div>
    </div>
  </section>
</template>
