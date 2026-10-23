<script setup lang="ts">
import ModelFileDropZone from '@/components/ModelFileDropZone.vue';
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
    <ModelFileDropZone data-testid="llama-cpp-browser-drop-zone" :disabled="disabled" :active="dragDepth > 0" :layout="layout" :title="lazyStrings.llamaCppBrowser__drop_model_folders_or_gguf_files_here()" :description="description ?? lazyStrings.llamaCppBrowser__or_choose_files_from_your_device()" :description-id="`${id}-file-help`" @dragenter.prevent.stop="dragEnter({ event: $event })" @dragover.prevent.stop="dragOver({ event: $event })" @dragleave.prevent.stop="dragLeave" @drop.prevent.stop="dropFiles({ event: $event })">
      <input ref="fileInput" :disabled="disabled" type="file" accept=".gguf" multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_gguf_files()" :aria-describedby="`${id}-file-help`" data-testid="llama-cpp-browser-file" tw-class="sr-only" @change="emit('files', $event)" />
      <input ref="directoryInput" :disabled="disabled" type="file" webkitdirectory multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_model_folder()" data-testid="llama-cpp-browser-directory" tw-class="sr-only" @change="emit('directory', $event)" />
      <div tw-class="flex flex-wrap items-center justify-center gap-2">
        <button type="button" :disabled="disabled" data-testid="llama-cpp-browser-choose-directory" tw-class="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50" @click="directoryInput?.click()"><FolderOpenIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400" />{{ lazyStrings.llamaCppBrowser__choose_model_folder() }}</button>
        <button type="button" :disabled="disabled" data-testid="llama-cpp-browser-choose-files" tw-class="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50" @click="fileInput?.click()"><FileUpIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400" />{{ lazyStrings.llamaCppBrowser__choose_gguf_files() }}</button>
      </div>
    </ModelFileDropZone>
  </div>
</template>

<style scoped>
.model-file-input-fill {
  height: 100%;
}
</style>
