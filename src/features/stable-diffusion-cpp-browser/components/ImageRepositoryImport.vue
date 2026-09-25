<script setup lang="ts">
import { ref, useId } from 'vue';
import { FolderOpenIcon, RefreshCwIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
const props = defineProps<{ view: ImageLibraryView, disabled: boolean }>();
const { importing, downloading, importProgress, scanState } = props.view;
const input = ref<HTMLInputElement>(), dragDepth = ref(0), id = useId();
function enter({ event }: { event: DragEvent }): void {
  if (!props.disabled && !importing.value && !downloading.value && event.dataTransfer?.types.includes('Files')) dragDepth.value++;
}
function over({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = props.disabled || importing.value || downloading.value ? 'none' : 'copy';
}
async function drop({ event }: { event: DragEvent }): Promise<void> {
  dragDepth.value = 0; if (!props.disabled && !importing.value && !downloading.value) await props.view.dropDirectory({ event });
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="image-repository-drop" @dragenter.prevent.stop="enter({ event: $event })" @dragover.prevent.stop="over({ event: $event })" @dragleave.prevent.stop="dragDepth = Math.max(0, dragDepth - 1)" @drop.prevent.stop="drop({ event: $event })" :tw-class="['rounded-xl border-2 border-dashed p-4 space-y-3', dragDepth ? 'border-purple-500 bg-purple-50 dark:bg-purple-950' : 'border-gray-300 dark:border-gray-700']">
    <p tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.stableDiffusionCppBrowser__import_repository_help() }}</p>
    <input ref="input" :id="id" type="file" webkitdirectory multiple :disabled="disabled || importing || downloading" :aria-label="lazyStrings.stableDiffusionCppBrowser__choose_repository_folder()" tw-class="sr-only" @change="view.importDirectory({ event: $event })" />
    <div tw-class="flex flex-wrap gap-2">
      <button type="button" :disabled="disabled || importing || downloading" @click="input?.click()" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs font-semibold text-purple-700 dark:text-purple-300 disabled:opacity-50"><FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.stableDiffusionCppBrowser__choose_repository_folder() }}</button>
      <button type="button" :disabled="disabled || importing || downloading || scanState === 'scanning'" @click="view.refresh()" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs disabled:opacity-50"><RefreshCwIcon tw-class="w-4 h-4" />{{ lazyStrings.stableDiffusionCppBrowser__refresh_repositories() }}</button>
      <button v-if="importing" type="button" :disabled="disabled" @click="view.cancelImport()" tw-class="rounded-lg border border-red-300 px-3 py-2 text-xs text-red-700 dark:text-red-300">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <div v-if="importing" role="status" aria-live="polite" tw-class="text-xs space-y-1">
      <p>{{ lazyStrings.stableDiffusionCppBrowser__importing_repository() }}</p>
      <progress v-if="importProgress?.total" :value="importProgress.completed" :max="importProgress.total" tw-class="w-full" />
      <p v-if="importProgress">{{ (importProgress.completed / 1024 ** 3).toFixed(2) }} / {{ (importProgress.total / 1024 ** 3).toFixed(2) }} GiB</p>
    </div>
  </div>
</template>
