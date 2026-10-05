<script setup lang="ts">
import { FolderOpenIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageModelPicker from './ImageModelPicker.vue';
const props = defineProps<{ view: ImageLibraryView, disabled: boolean, active: boolean, manualName?: string }>();
const emit = defineEmits<{ prepare: [] }>();
const { models, main, scanState, scanProgress, importing, failure, ready } = props.view;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-2" data-testid="image-model-library">
    <div tw-class="flex items-end gap-2">
      <ImageModelPicker :active="active" :empty-label="manualName || lazyStrings.ImageModelPicker__choose_a_model()" :model-value="main" :choices="models" :disabled="disabled || importing || scanState === 'scanning'" :required="true" :label="lazyStrings.stableDiffusionCppBrowser__main_image_model()" compact @update:model-value="view.chooseMain({ id: $event })" data-testid="image-main-model" tw-class="flex-1 min-w-0" />
      <button type="button" @click="emit('prepare')" :disabled="view.downloadsDisabled.value" data-testid="image-manage-models" :tw-class="['shrink-0 min-h-11 inline-flex items-center justify-center gap-2 rounded-xl md:rounded-2xl px-4 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed motion-reduce:transition-none motion-reduce:transform-none', main && ready ? 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-gray-700' : 'bg-blue-600 text-white font-bold shadow-lg shadow-blue-500/30 hover:bg-blue-700 active:scale-95']"><FolderOpenIcon aria-hidden="true" tw-class="w-4 h-4" />{{ lazyStrings.ImageGenerationEditor__prepare_model() }}</button>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ failure }}</p>
    <div v-if="scanState === 'scanning'" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="image-inventory-progress">
      <p role="status" :title="scanProgress?.path" tw-class="min-w-0 truncate flex-1">{{ scanProgress?.phase === 'listing' ? lazyStrings.stableDiffusionCppBrowser__listing_repositories() : lazyStrings.stableDiffusionCppBrowser__scanning_repositories() }} <span v-if="scanProgress?.total">{{ scanProgress.completed }} / {{ scanProgress.total }}</span><span v-if="scanProgress?.path" tw-class="sr-only">{{ scanProgress.path }}</span></p>
      <button type="button" @click="view.cancelScan()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg px-2 py-1 text-xs font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" data-testid="image-cancel-scan">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <p v-else-if="main && !ready && !importing" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__incomplete_components() }}</p>
    <p v-else-if="!main && !manualName" tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="image-prepare-model-help">{{ lazyStrings.ImageGenerationEditor__choose_model_to_begin() }}</p>
  </section>
</template>
