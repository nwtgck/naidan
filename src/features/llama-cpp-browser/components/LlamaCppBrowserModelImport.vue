<script setup lang="ts">
import { onUnmounted, ref, useId } from 'vue';
import { AlertCircleIcon, FileUpIcon, FolderOpenIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, type ErrorCode, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { directoryFromFiles, droppedModels } from '@/features/llama-cpp-browser/runtime/directory-input';
import LlamaCppBrowserLoadingIndicator from './LlamaCppBrowserLoadingIndicator.vue';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean], changed: [] }>();
const id = useId();
const active = ref<AbortController>();
const localError = ref<ErrorCode>();
const dragDepth = ref(0);
const fileInput = ref<HTMLInputElement>();
const directoryInput = ref<HTMLInputElement>();
let disposed = false;
type ImportInput = { files: File[], directories: ModelDirectoryInput[] };
async function importFiles({ collect }: { collect: () => ImportInput | Promise<ImportInput> }): Promise<void> {
  // Returning focus from a native drag or file picker starts a read-only list
  // refresh. That refresh must not disable imports or silently discard the input.
  if (disposed || props.disabled || active.value !== undefined) return;
  localError.value = undefined;
  // Reserve the operation before asynchronous entry traversal, not just before
  // writing files. Cancellation/unmount must prevent late writes, and a second
  // drop, download, or deletion must not take over while an entry callback is pending.
  const controller = new AbortController(); active.value = controller; emit('busy', true);
  let needsRefresh = false;
  try {
    // Invoke collect during dispatch, before the first await: DataTransfer entries
    // must be captured while the browser still exposes the drop's data store.
    const { files, directories } = await collect();
    if (disposed || controller.signal.aborted) return;
    if (files.some(file => !file.name.toLowerCase().endsWith('.gguf'))) {
      localError.value = 'invalid-gguf'; return;
    }
    for (const directory of directories) {
      if (controller.signal.aborted) break;
      needsRefresh = true;
      await llamaCppBrowserService.importDirectory({ directory, signal: controller.signal });
    }
    for (const file of files) {
      if (controller.signal.aborted) break;
      needsRefresh = true;
      await llamaCppBrowserService.importModel({ file, signal: controller.signal });
    }
  } catch (error) {
    if (!disposed && !controller.signal.aborted) localError.value = errorCode({ error });
  } finally {
    if (!disposed && needsRefresh) emit('changed');
    active.value = undefined; emit('busy', false);
  }
}
async function importFile({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const files = Array.from(input.files ?? []); input.value = '';
  if (!files.length) return;
  await importFiles({ collect: () => ({ files, directories: [] }) });
}
async function importDirectory({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const files = Array.from(input.files ?? []); input.value = '';
  if (!files.length) return;
  await importFiles({ collect: () => ({ files: [], directories: [directoryFromFiles({ files })] }) });
}
function dragEnter({ event }: { event: DragEvent }): void {
  if (props.disabled || active.value !== undefined || !event.dataTransfer?.types.includes('Files')) return;
  dragDepth.value++;
}
function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = props.disabled || active.value !== undefined ? 'none' : 'copy';
}
async function dropFiles({ event }: { event: DragEvent }): Promise<void> {
  dragDepth.value = 0;
  const transfer = event.dataTransfer;
  if (!transfer) return;
  await importFiles({ collect: () => droppedModels({ transfer }) });
}

function cancel(): void {
  active.value?.abort();
}
onUnmounted(() => {
  disposed = true; active.value?.abort();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="llama-cpp-browser-import" tw-class="space-y-3">
    <fieldset :disabled="disabled || active !== undefined" tw-class="space-y-3 disabled:opacity-50">
      <legend tw-class="w-full flex items-center gap-2 pb-2 mb-3 border-b border-gray-100 dark:border-gray-800">
        <FileUpIcon tw-class="w-5 h-5 text-purple-500" />
        <span tw-class="text-sm font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.llamaCppBrowser__gguf_model_files() }}</span>
      </legend>
      <div
        data-testid="llama-cpp-browser-drop-zone"
        :tw-class="['rounded-2xl border-2 border-dashed p-4 text-center transition-colors', dragDepth > 0 ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30']"
        @dragenter.prevent.stop="dragEnter({ event: $event })"
        @dragover.prevent.stop="dragOver({ event: $event })"
        @dragleave.prevent.stop="dragDepth = Math.max(0, dragDepth - 1)"
        @drop.prevent.stop="dropFiles({ event: $event })"
      >
        <div tw-class="w-8 h-8 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center mx-auto mb-2"><FileUpIcon tw-class="w-4 h-4" /></div>
        <p tw-class="text-sm font-bold text-gray-800 dark:text-white">{{ lazyStrings.llamaCppBrowser__drop_model_folders_or_gguf_files_here() }}</p>
        <p :id="`${id}-file-help`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400 mt-1 mb-3">{{ lazyStrings.llamaCppBrowser__or_choose_files_from_your_device() }}</p>
        <input ref="fileInput" type="file" accept=".gguf" multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_gguf_files()" :aria-describedby="`${id}-file-help`" data-testid="llama-cpp-browser-file" tw-class="sr-only" @change="importFile({ event: $event })" />
        <input ref="directoryInput" type="file" webkitdirectory multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_model_folder()" data-testid="llama-cpp-browser-directory" tw-class="sr-only" @change="importDirectory({ event: $event })" />
        <button type="button" data-testid="llama-cpp-browser-choose-directory" tw-class="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-purple-600 dark:text-purple-400 border border-gray-200 dark:border-gray-700 shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" @click="directoryInput?.click()"><FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__choose_model_folder() }}</button>
        <button type="button" data-testid="llama-cpp-browser-choose-files" tw-class="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-purple-600 dark:text-purple-400 border border-gray-200 dark:border-gray-700 shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" @click="fileInput?.click()">
          <FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__choose_gguf_files() }}
        </button>
      </div>
    </fieldset>
    <div v-if="active" tw-class="rounded-2xl border border-purple-100 dark:border-purple-900/30 p-4 space-y-3">
      <LlamaCppBrowserLoadingIndicator scope="import" />
      <div tw-class="flex justify-end"><button type="button" data-testid="llama-cpp-browser-cancel" tw-class="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" @click="cancel">{{ lazyStrings.SHARED__cancel() }}</button></div>
    </div>
    <div v-if="localError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ localError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ localError }}</code></div>
    </div>
  </section>
</template>
