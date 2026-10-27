<script setup lang="ts">
import { computed, defineAsyncComponent, onErrorCaptured, onScopeDispose, ref } from 'vue';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import { lazyStrings } from '@/strings';
import LlamaCppBrowserLocalFiles from './LlamaCppBrowserLocalFiles.vue';
import LlamaCppBrowserModelImportModes from './LlamaCppBrowserModelImportModes.vue';

const ModelImport = defineAsyncComponent(() => import('./LlamaCppBrowserModelImport.vue'));
const LinkedFolders = defineAsyncComponent(() => import('./LlamaCppBrowserModelImportLinkedFolders.vue'));

// Use only for failed HF downloads of GGUF chat models. CSP is optional copy;
// local actions use the existing owner and never depend on policy diagnostics.
const props = defineProps<{
  disabled: boolean,
  acceptLocalInput: (({ directories, controller, save, repositoryLayout }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController, save?: 'browser' | 'later', repositoryLayout?: 'confirmed' }) => void | Promise<void>) | undefined,
}>();
const mode = ref<'temp' | 'host'>('temp');
const accepting = ref(false);
const linkBusy = ref(false);
const inputFailed = ref(false);
const viewFailed = ref(false);
const linkSupported = missingHostModelDirectoryApis().length === 0;
const modes = computed(() => [
  { mode: 'temp' as const, label: lazyStrings.ChatLocalModelInput__load_model(), availability: 'available' as const },
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

async function handOff({ directories, controller, save, repositoryLayout }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController, save: 'browser' | 'later', repositoryLayout: 'confirmed' }): Promise<void> {
  void directories.catch(() => {});
  const accept = props.acceptLocalInput;
  if (disposed || props.disabled || accepting.value || linkBusy.value || accept === undefined) {
    controller.abort();
    return;
  }
  accepting.value = true;
  inputFailed.value = false;
  try {
    // Replacing the failed operation removes this recovery view. Keep its
    // repository confirmation mounted until the shared input is ready.
    await directories;
    if (disposed || props.disabled || controller.signal.aborted) {
      controller.abort();
      return;
    }
    await accept({ directories, controller, save, repositoryLayout });
  } catch {
    if (!disposed && !controller.signal.aborted) {
      inputFailed.value = true;
    }
  } finally {
    if (!disposed) {
      accepting.value = false;
    }
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
        <LlamaCppBrowserLocalFiles v-if="mode === 'temp'" :disabled="disabled || accepting || linkBusy" layout="compact" @accept="handOff($event)" />
        <LinkedFolders v-else :disabled="disabled || accepting" @busy="linkBusy = $event" />
      </template>
      <p v-if="acceptLocalInput === undefined || mode === 'host'" tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserLocalFileRecovery__choose_the_added_model_from_the_model_list() }}</p>
    </template>
    <p v-if="inputFailed || viewFailed" role="alert" data-testid="gguf-local-recovery-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserLocalFileRecovery__could_not_open_local_model_files() }}</p>
  </section>
</template>
