<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { FileUpIcon, FolderOpenIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

// Presentation only: the owner decides whether a selection is imported, saved,
// or previewed. Drop events are forwarded synchronously so owners can capture
// file-system entries while the browser still exposes the drag data store.
const props = defineProps<{ disabled: boolean, mode: 'opfs' | 'temp', layout: 'compact' | 'expanded' | 'fill', description?: string }>();
const emit = defineEmits<{
  files: [event: Event],
  directory: [event: Event],
  'drop-files': [event: DragEvent],
  'drag-active': [state: 'active' | 'idle'],
}>();
const id = useId();
const fileInput = ref<HTMLInputElement>();
const directoryInput = ref<HTMLInputElement>();
const dragDepth = ref(0);

function dragEnter({ event }: { event: DragEvent }): void {
  if (!event.dataTransfer?.types.includes('Files')) {
    return;
  }
  if (props.disabled) {
    emit('drag-active', 'idle');
    return;
  }
  dragDepth.value++;
  emit('drag-active', 'active');
}

function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = props.disabled ? 'none' : 'copy';
    if (event.dataTransfer.types.includes('Files')) {
      emit('drag-active', props.disabled ? 'idle' : 'active');
    }
  }
}

function dragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
  if (dragDepth.value === 0) {
    emit('drag-active', 'idle');
  }
}

function dropFiles({ event }: { event: DragEvent }): void {
  dragDepth.value = 0;
  emit('drag-active', 'idle');
  if (!props.disabled) {
    emit('drop-files', event);
  }
}

watch(() => props.mode, () => {
  dragDepth.value = 0;
  emit('drag-active', 'idle');
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div :class="{ 'model-file-input-fill': layout === 'fill' }" tw-class="space-y-3 text-left">
    <p v-if="description === undefined" data-testid="llama-import-mode-description" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ mode === 'temp' ? lazyStrings.SHARED__model_import_temporary_until_reload() : lazyStrings.SHARED__model_import_save_for_after_reload() }}</p>
    <div data-testid="llama-cpp-browser-drop-zone" :aria-disabled="disabled" :tw-class="['flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-colors duration-200 motion-reduce:transition-none', layout === 'expanded' ? 'min-h-[clamp(240px,34dvh,360px)] px-5 py-8 sm:px-10' : layout === 'fill' ? 'min-h-56 h-full px-5 py-8 sm:px-10' : 'min-h-44 px-4 py-5', dragDepth > 0 ? 'border-blue-400 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-500/10' : 'border-gray-200 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800/30']" @dragenter.prevent.stop="dragEnter({ event: $event })" @dragover.prevent.stop="dragOver({ event: $event })" @dragleave.prevent.stop="dragLeave" @drop.prevent.stop="dropFiles({ event: $event })">
      <div class="model-file-input-accent" tw-class="mb-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"><FileUpIcon aria-hidden="true" tw-class="h-4 w-4" /></div>
      <p :tw-class="['max-w-lg font-medium leading-relaxed tracking-tight text-gray-700 dark:text-gray-200', layout !== 'compact' ? 'text-sm sm:text-base' : 'text-sm']">{{ lazyStrings.llamaCppBrowser__drop_model_folders_or_gguf_files_here() }}</p>
      <p :id="`${id}-file-help`" tw-class="mb-4 mt-1 max-w-md text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ description ?? lazyStrings.llamaCppBrowser__or_choose_files_from_your_device() }}</p>
      <input ref="fileInput" :disabled="disabled" type="file" accept=".gguf" multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_gguf_files()" :aria-describedby="`${id}-file-help`" data-testid="llama-cpp-browser-file" tw-class="sr-only" @change="emit('files', $event)" />
      <input ref="directoryInput" :disabled="disabled" type="file" webkitdirectory multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_model_folder()" data-testid="llama-cpp-browser-directory" tw-class="sr-only" @change="emit('directory', $event)" />
      <div tw-class="flex flex-wrap items-center justify-center gap-2">
        <button type="button" :disabled="disabled" data-testid="llama-cpp-browser-choose-directory" tw-class="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50" @click="directoryInput?.click()"><FolderOpenIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400" />{{ lazyStrings.llamaCppBrowser__choose_model_folder() }}</button>
        <button type="button" :disabled="disabled" data-testid="llama-cpp-browser-choose-files" tw-class="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50" @click="fileInput?.click()"><FileUpIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400" />{{ lazyStrings.llamaCppBrowser__choose_gguf_files() }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-file-input-fill {
  height: 100%;
}
.model-file-input-accent {
  box-shadow: 0 0 20px rgb(59 130 246 / 0.14);
}
</style>
