<script setup lang="ts">
import ModelFileDropZone from '@/components/ModelFileDropZone.vue';
import LinkedModelDirectories from '@/components/LinkedModelDirectories.vue';
import TemporaryModelFolders from '@/components/TemporaryModelFolders.vue';
import { computed, ref, useId } from 'vue';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
import { FileUpIcon, FolderOpenIcon, RefreshCwIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
const props = defineProps<{ view: ImageLibraryView, disabled: boolean }>();
const { importing, downloading, importProgress, scanState } = props.view;
const progress = computed(() => importProgress.value?.total ? { ...importProgress.value, processed: importProgress.value.completed, phase: 'transferring' as const } : undefined);
const mode = ref<'opfs' | 'host' | 'temp'>('opfs');
const { supported: linkSupported, busy: linkBusy } = props.view.hostDirectories;
const filesInput = ref<HTMLInputElement>();
const input = ref<HTMLInputElement>(), dragDepth = ref(0), id = useId();

function enter({ event }: { event: DragEvent }): void {
  if (!props.disabled && !importing.value && !downloading.value && event.dataTransfer?.types.includes('Files')) {
    dragDepth.value++;
  }
}

function over({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = mode.value === 'host' || props.disabled || importing.value || downloading.value ? 'none' : 'copy';
  }
}

async function drop({ event }: { event: DragEvent }): Promise<void> {
  dragDepth.value = 0;
  if (mode.value !== 'host' && !props.disabled && !importing.value && !downloading.value) {
    await props.view.dropDirectory({ event, storage: mode.value });
  }
}

async function choose({ event, files }: { event: Event, files: boolean }): Promise<void> {
  const storage = mode.value;
  switch (storage) {
  case 'host': return;
  case 'opfs': case 'temp': break;
  default: {
    const exhaustive: never = storage;
    throw new Error(String(exhaustive));
  }
  }
  if (files) {
    await props.view.importFiles({ event, storage });
  } else {
    await props.view.importDirectory({ event, storage });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="image-repository-drop" @dragenter.prevent.stop="enter({ event: $event })" @dragover.prevent.stop="over({ event: $event })" @dragleave.prevent.stop="dragDepth = Math.max(0, dragDepth - 1)" @drop.prevent.stop="drop({ event: $event })" :tw-class="['min-w-0 rounded-2xl border border-gray-200/70 bg-white/60 p-4 space-y-4 dark:border-gray-700/60 dark:bg-gray-900/20', dragDepth ? 'border-blue-300 dark:border-blue-500/40' : '']">
    <h3 tw-class="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100"><FolderOpenIcon tw-class="w-4 h-4 text-blue-500" />{{ lazyStrings.stableDiffusionCppBrowser__import_models() }}</h3>
    <div role="group" :aria-label="lazyStrings.SHARED__model_import_how_to_use_files()" tw-class="grid grid-cols-1 sm:grid-cols-3 gap-1 rounded-xl bg-gray-100 dark:bg-gray-800 p-1">
      <button v-for="option in ['opfs', 'host', 'temp'] as const" :key="option" type="button" :disabled="importing || linkBusy" :aria-pressed="mode === option" :data-testid="'image-import-mode-' + option" @click="mode = option; dragDepth = 0" :tw-class="['rounded-lg px-3 py-2 text-xs font-medium focus-visible:ring-2 focus-visible:ring-blue-500', mode === option ? 'bg-white dark:bg-gray-700 text-blue-700 dark:text-blue-300 shadow-sm' : 'text-gray-600 dark:text-gray-300', option === 'host' && !linkSupported ? 'opacity-50' : 'opacity-100']">
        {{ option === 'opfs' ? lazyStrings.SHARED__model_import_save_in_browser() : option === 'temp' ? lazyStrings.SHARED__model_import_use_temporarily() : lazyStrings.SHARED__model_import_link_folder() }}
      </button>
    </div>
    <LinkedModelDirectories v-if="mode === 'host'" :view="view.hostDirectories" :disabled="disabled || importing" :reconnect-disabled="downloading" />
    <template v-else>
      <ModelFileDropZone :disabled="disabled || importing || downloading" :active="dragDepth > 0" layout="compact" :title="lazyStrings.ImageRepositoryImport__drop_help()" :description="mode === 'temp' ? lazyStrings.SHARED__model_import_temporary_until_reload() : lazyStrings.SHARED__model_import_save_for_after_reload()">
        <input ref="input" :id="id" type="file" tabindex="-1" webkitdirectory multiple :disabled="disabled || importing || downloading" :aria-label="lazyStrings.stableDiffusionCppBrowser__choose_repository_folder()" tw-class="sr-only" @change="choose({ event: $event, files: false })" />
        <input ref="filesInput" type="file" tabindex="-1" accept=".gguf,.safetensors,.sft" multiple :disabled="disabled || importing || downloading" :aria-label="lazyStrings.ImageRepositoryImport__choose_files()" tw-class="sr-only" @change="choose({ event: $event, files: true })" />
        <div tw-class="flex flex-wrap items-center justify-center gap-2">
          <button type="button" :disabled="disabled || importing || downloading" @click="input?.click()" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 transition-colors hover:border-blue-200 hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-blue-500/30 dark:hover:bg-gray-700/70"><FolderOpenIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.stableDiffusionCppBrowser__choose_repository_folder() }}</button>
          <button type="button" :disabled="disabled || importing || downloading" data-testid="image-choose-files" @click="filesInput?.click()" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 transition-colors hover:border-blue-200 hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-blue-500/30 dark:hover:bg-gray-700/70"><FileUpIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.ImageRepositoryImport__choose_files() }}</button>
        </div>
      </ModelFileDropZone>
      <div tw-class="flex flex-wrap items-center justify-end gap-2">
        <button type="button" :disabled="disabled || importing || downloading || scanState === 'scanning'" @click="view.refresh()" tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"><RefreshCwIcon tw-class="w-4 h-4" />{{ lazyStrings.stableDiffusionCppBrowser__refresh_repositories() }}</button>
        <button v-if="importing" type="button" data-testid="image-cancel-import" @click="view.cancelImport()" tw-class="rounded-xl border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300 transition-colors hover:bg-red-100 dark:hover:bg-red-900/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50">{{ lazyStrings.SHARED__cancel() }}</button>
      </div>
    </template>
    <TemporaryModelFolders v-if="mode === 'temp'" :disabled="disabled || importing" />
    <div v-if="importing" role="status" aria-live="polite" tw-class="text-xs space-y-1">
      <p>{{ lazyStrings.stableDiffusionCppBrowser__importing_repository() }}</p>
      <LlamaCppBrowserDownloadProgress appearance="manager" :progress="progress" />
    </div>
  </section>
</template>
