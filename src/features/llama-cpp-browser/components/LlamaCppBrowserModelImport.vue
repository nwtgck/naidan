<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import LlamaCppBrowserLocalRepositorySaves from './LlamaCppBrowserLocalRepositorySaves.vue';
import TemporaryModelFolders from '@/components/TemporaryModelFolders.vue';
import { computed, defineAsyncComponent, onUnmounted, ref, watch } from 'vue';
import { AlertCircleIcon, FileUpIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { errorCode, type ErrorCode, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import LlamaCppBrowserLocalFiles from './LlamaCppBrowserLocalFiles.vue';
import LlamaCppBrowserModelImportModes from './LlamaCppBrowserModelImportModes.vue';

const LlamaCppBrowserModelImportLinkedFolders = defineAsyncComponent(() => import('./LlamaCppBrowserModelImportLinkedFolders.vue'));

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean], changed: [] }>();
const active = ref<AbortController>();
const localError = ref<ErrorCode>();
let disposed = false;
const mode = ref<'opfs' | 'host' | 'temp'>('temp');
const linkSupported = missingHostModelDirectoryApis().length === 0;
const linkBusy = ref(false);
const modes = computed(() => [
  { mode: 'temp' as const, label: lazyStrings.ChatLocalModelInput__load_model(), availability: 'available' as const },
  { mode: 'host' as const, label: lazyStrings.SHARED__model_import_link_folder(), availability: linkSupported ? 'available' as const : 'unavailable' as const },
]);
// Switching modes is a local presentation choice, not a persisted preference.
// In particular an unsupported link option stays keyboard/click selectable:
// only actual file operations honor the parent's disabled state, so explanations
// remain discoverable even when inference itself is unavailable.
watch(mode, () => {
  localError.value = undefined;
});

async function importFiles({ directories, controller, save }: {
  directories: Promise<ModelDirectoryInput[]>, controller: AbortController, save: 'browser' | 'later',
}): Promise<void> {
  void directories.catch(() => {});
  if (disposed || props.disabled || active.value !== undefined || mode.value === 'host' || linkBusy.value) {
    controller.abort();
    return;
  }
  active.value = controller;
  localError.value = undefined;
  emit('busy', true);
  try {
    for (const directory of await directories) {
      controller.signal.throwIfAborted();
      await llamaCppBrowserModelFiles.importLocalDirectory({ directory, save, signal: controller.signal });
    }
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      localError.value = errorCode({ error });
    }
  } finally {
    if (!disposed) {
      emit('changed');
    }
    active.value = undefined;
    emit('busy', false);
  }
}

function cancel(): void {
  active.value?.abort();
}

onUnmounted(() => {
  disposed = true;
  active.value?.abort();
});
const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="llama-cpp-browser-import" tw-class="space-y-3">
    <fieldset :disabled="linkBusy" tw-class="space-y-3 disabled:opacity-50">
      <legend tw-class="w-full flex items-center gap-2 pb-2 mb-3 border-b border-gray-100 dark:border-gray-800">
        <FileUpIcon tw-class="w-5 h-5 text-blue-500" />
        <span :tw-class="['text-sm font-bold text-gray-800 tracking-tight', isSettingsTypography ? 'dark:text-gray-300' : 'dark:text-white']">{{ lazyStrings.llamaCppBrowser__gguf_model_files() }}</span>
      </legend>
      <LlamaCppBrowserModelImportModes v-model="mode" :modes="modes" :disabled="active !== undefined || linkBusy" />
      <LlamaCppBrowserModelImportLinkedFolders v-if="mode === 'host'" :disabled="disabled || active !== undefined" @busy="linkBusy = $event; emit('busy', $event)" @changed="emit('changed')" />
      <LlamaCppBrowserLocalFiles v-if="mode !== 'host'" :disabled="disabled || active !== undefined" layout="compact" @accept="importFiles($event)" />
    </fieldset>
    <LlamaCppBrowserLocalRepositorySaves offered-visibility="visible" />
    <TemporaryModelFolders v-if="mode !== 'host'" :disabled="disabled || active !== undefined" />
    <div v-if="active" tw-class="flex items-center justify-between gap-3 px-1">
      <p role="status" data-testid="llama-cpp-browser-import-status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />{{ lazyStrings.llamaCppBrowser__checking_model_files() }}</p>
      <button type="button" data-testid="llama-cpp-browser-cancel" :tw-class="['shrink-0 rounded-lg px-3 py-1.5 font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200 focus-visible:outline-2 focus-visible:outline-blue-500', isSettingsTypography ? 'text-sm' : 'text-xs']" @click="cancel">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <div v-if="localError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ localError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ localError }}</code></div>
    </div>
  </section>
</template>
