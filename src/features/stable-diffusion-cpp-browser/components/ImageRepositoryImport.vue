<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
import { FolderOpenIcon, RefreshCwIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
const props = defineProps<{ view: ImageLibraryView, disabled: boolean }>();
const { importing, downloading, importProgress, scanState } = props.view;
const progress = computed(() => importProgress.value?.total ? { ...importProgress.value, processed: importProgress.value.completed, phase: 'transferring' as const } : undefined);
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
  <section data-testid="image-repository-drop" @dragenter.prevent.stop="enter({ event: $event })" @dragover.prevent.stop="over({ event: $event })" @dragleave.prevent.stop="dragDepth = Math.max(0, dragDepth - 1)" @drop.prevent.stop="drop({ event: $event })" :tw-class="['min-w-0 rounded-2xl border border-gray-100 dark:border-gray-800 p-4 space-y-3', dragDepth ? 'bg-purple-50 dark:bg-purple-900/20' : 'bg-gray-50/50 dark:bg-gray-800/20']">
    <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-gray-100"><FolderOpenIcon tw-class="w-4 h-4 text-purple-500" />{{ lazyStrings.stableDiffusionCppBrowser__import_models() }}</h3>
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__import_repository_help() }}</p>
    <input ref="input" :id="id" type="file" webkitdirectory multiple :disabled="disabled || importing || downloading" :aria-label="lazyStrings.stableDiffusionCppBrowser__choose_repository_folder()" tw-class="sr-only" @change="view.importDirectory({ event: $event })" />
    <div tw-class="flex flex-wrap items-center gap-2">
      <button type="button" :disabled="disabled || importing || downloading" @click="input?.click()" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-semibold text-purple-700 dark:text-purple-300 disabled:opacity-50"><FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.stableDiffusionCppBrowser__choose_repository_folder() }}</button>
      <button type="button" :disabled="disabled || importing || downloading || scanState === 'scanning'" @click="view.refresh()" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs disabled:opacity-50"><RefreshCwIcon tw-class="w-4 h-4" />{{ lazyStrings.stableDiffusionCppBrowser__refresh_repositories() }}</button>
      <button v-if="importing" type="button" :disabled="disabled" @click="view.cancelImport()" tw-class="rounded-lg border border-red-300 px-3 py-2 text-xs text-red-700 dark:text-red-300">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <div v-if="importing" role="status" aria-live="polite" tw-class="text-xs space-y-1">
      <p>{{ lazyStrings.stableDiffusionCppBrowser__importing_repository() }}</p>
      <LlamaCppBrowserDownloadProgress :progress="progress" />
    </div>
  </section>
</template>
