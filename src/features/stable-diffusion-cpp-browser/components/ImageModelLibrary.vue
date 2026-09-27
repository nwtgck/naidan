<script setup lang="ts">
import { lazyStrings } from '@/strings';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageModelPicker from './ImageModelPicker.vue';
const props = defineProps<{ view: ImageLibraryView, disabled: boolean, active: boolean, manualName?: string }>();
const emit = defineEmits<{ prepare: [] }>();
const { models, main, scanState, scanProgress, importing, downloading, failure, ready } = props.view;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-2" data-testid="image-model-library">
    <div tw-class="flex items-end gap-2">
      <ImageModelPicker :active="active" :empty-label="manualName || lazyStrings.ImageModelPicker__choose_a_model()" :model-value="main" :choices="models" :disabled="disabled || importing || downloading || scanState === 'scanning'" :required="true" :label="lazyStrings.stableDiffusionCppBrowser__main_image_model()" compact @update:model-value="view.chooseMain({ id: $event })" data-testid="image-main-model" tw-class="flex-1 min-w-0" />
      <button type="button" @click="emit('prepare')" :disabled="disabled" data-testid="image-manage-models" :tw-class="['shrink-0 min-h-11 rounded-lg px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-40', main ? 'border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800' : 'bg-purple-600 text-white hover:bg-purple-700']">{{ lazyStrings.ImageGenerationEditor__prepare_model() }}</button>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ failure }}</p>
    <div v-if="scanState === 'scanning'" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="image-inventory-progress">
      <p role="status" :title="scanProgress?.path" tw-class="min-w-0 truncate flex-1">{{ scanProgress?.phase === 'listing' ? lazyStrings.stableDiffusionCppBrowser__listing_repositories() : lazyStrings.stableDiffusionCppBrowser__scanning_repositories() }} <span v-if="scanProgress?.total">{{ scanProgress.completed }} / {{ scanProgress.total }}</span><span v-if="scanProgress?.path" tw-class="sr-only">{{ scanProgress.path }}</span></p>
      <button type="button" @click="view.cancelScan()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 px-2 py-1 underline" data-testid="image-cancel-scan">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <p v-else-if="main && !ready && !importing" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__incomplete_components() }}</p>
    <p v-else-if="!main && !manualName" tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="image-prepare-model-help">{{ lazyStrings.ImageGenerationEditor__choose_model_to_begin() }}</p>
  </section>
</template>
