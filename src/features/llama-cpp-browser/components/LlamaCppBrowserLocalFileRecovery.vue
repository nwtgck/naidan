<script setup lang="ts">
import { computed, defineAsyncComponent, onErrorCaptured, onScopeDispose, ref } from 'vue';
import { captureDroppedLocalModels, localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import { lazyStrings } from '@/strings';
import LlamaCppBrowserModelFileInput from './LlamaCppBrowserModelFileInput.vue';
import LlamaCppBrowserModelImportModes from './LlamaCppBrowserModelImportModes.vue';

const ModelImport = defineAsyncComponent(() => import('./LlamaCppBrowserModelImport.vue'));
const LinkedFolders = defineAsyncComponent(() => import('./LlamaCppBrowserModelImportLinkedFolders.vue'));

// Use only for failed HF downloads of GGUF chat models. CSP is optional copy;
// local actions use the existing owner and never depend on policy diagnostics.
const props = defineProps<{
  disabled: boolean,
  acceptLocalInput: (({ directories, controller }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController }) => void | Promise<void>) | undefined,
}>();
const mode = ref<'temp' | 'host'>('temp');
const accepting = ref(false);
const linkBusy = ref(false);
const inputFailed = ref(false);
const viewFailed = ref(false);
const linkSupported = missingHostModelDirectoryApis().length === 0;
const modes = computed(() => [
  { mode: 'temp' as const, label: lazyStrings.SHARED__model_import_use_temporarily(), availability: 'available' as const },
  { mode: 'host' as const, label: lazyStrings.SHARED__model_import_link_folder(), availability: linkSupported ? 'available' as const : 'unavailable' as const },
]);
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
onErrorCaptured(() => {
  // An unavailable file view must not remove the original download error or
  // make optional CSP diagnostics a prerequisite for local recovery.
  viewFailed.value = true;
  return false;
});

function selectMode({ value }: { value: 'opfs' | 'temp' | 'host' }): void {
  if (props.disabled || accepting.value || linkBusy.value) {
    return;
  }
  switch (value) {
  case 'temp': case 'host': mode.value = value;
    inputFailed.value = false;
    return;
  case 'opfs': return;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

async function handOff({ directories, controller }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController }): Promise<void> {
  void directories.catch(() => {});
  const accept = props.acceptLocalInput;
  if (disposed || props.disabled || accepting.value || linkBusy.value || accept === undefined) {
    controller.abort();
    return;
  }
  accepting.value = true;
  inputFailed.value = false;
  try {
    // Invoke synchronously so the existing owner reserves the action before
    // enumeration or lazy imports yield. It owns cancellation after this point.
    await accept({ directories, controller });
  } catch {
    if (!disposed) {
      inputFailed.value = true;
    }
  } finally {
    if (!disposed) {
      accepting.value = false;
    }
  }
}

function chooseFiles({ event, selection }: { event: Event, selection: 'files' | 'directory' }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(event.target.files ?? []);
  event.target.value = '';
  if (files.length === 0) {
    return;
  }
  const controller = new AbortController();
  void handOff({ directories: Promise.resolve().then(() => localModelDirectoriesFromFiles({ files, selection })), controller });
}

function dropFiles({ event }: { event: DragEvent }): void {
  if (disposed || props.disabled || accepting.value || linkBusy.value || !event.dataTransfer?.types.includes('Files')) {
    return;
  }
  const controller = new AbortController();
  try {
    // The browser's drag data store is readable only during this dispatch.
    const directories = captureDroppedLocalModels({ transfer: event.dataTransfer, signal: controller.signal });
    void handOff({ directories, controller });
  } catch {
    controller.abort();
    inputFailed.value = true;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section data-testid="gguf-local-recovery" tw-class="min-w-0 space-y-3 rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
    <h4 tw-class="text-xs font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserLocalFileRecovery__use_local_model_files() }}</h4>
    <p>{{ lazyStrings.LlamaCppBrowserLocalFileRecovery__use_downloaded_gguf_files_or_link_a_model_folder() }}</p>
    <template v-if="!viewFailed">
      <ModelImport v-if="acceptLocalInput === undefined" :disabled="disabled" />
      <template v-else>
        <LlamaCppBrowserModelImportModes :model-value="mode" :modes="modes" :disabled="disabled || accepting || linkBusy" @update:model-value="selectMode({ value: $event })" />
        <LlamaCppBrowserModelFileInput v-if="mode === 'temp'" :disabled="disabled || accepting || linkBusy" mode="temp" layout="compact" :description="undefined" @files="chooseFiles({ event: $event, selection: 'files' })" @directory="chooseFiles({ event: $event, selection: 'directory' })" @drop-files="dropFiles({ event: $event })" />
        <LinkedFolders v-else :disabled="disabled || accepting" @busy="linkBusy = $event" />
      </template>
      <p v-if="acceptLocalInput === undefined || mode === 'host'" tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserLocalFileRecovery__choose_the_added_model_from_the_model_list() }}</p>
    </template>
    <p v-if="inputFailed || viewFailed" role="alert" data-testid="gguf-local-recovery-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserLocalFileRecovery__could_not_open_local_model_files() }}</p>
  </section>
</template>
