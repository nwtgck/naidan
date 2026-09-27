<script setup lang="ts">
import { lazyStrings } from '@/strings';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import { componentLabel } from '@/features/stable-diffusion-cpp-browser/component-label';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageModelPicker from './ImageModelPicker.vue';
const props = defineProps<{ view: ImageLibraryView, disabled: boolean, active: boolean }>();
const { components, showAll, importing, downloading, issues } = props.view;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="min-w-0 max-w-full space-y-4">
    <div v-if="components.length" tw-class="min-w-0 space-y-3">
      <h3 tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__components_detected() }}</h3>
      <ImageModelPicker :active="active" v-for="component in components" :key="component.slot" :model-value="component.selected" :choices="component.choices" :required="component.required" :label="componentLabel({ slot: component.slot })" :disabled="disabled || importing || downloading || view.scanState.value === 'scanning'" @update:model-value="view.chooseComponent({ slot: component.slot, id: $event })" :data-testid="'image-component-' + component.slot" />
    </div>
    <p v-if="view.main.value && !view.ready.value && !importing && view.scanState.value !== 'scanning'" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__incomplete_components() }}</p>
    <ImageSettingsSection embedded :title="lazyStrings.llamaCppBrowserDownloads__details()" :summary="undefined">
      <label tw-class="min-h-10 cursor-pointer flex items-center gap-2 py-2 text-xs font-medium text-gray-700 dark:text-gray-300">
        <span tw-class="relative inline-flex shrink-0 items-center">
          <input v-model="showAll" :disabled="disabled || importing || downloading || view.scanState.value === 'scanning'" type="checkbox" role="switch" data-testid="image-show-all" tw-class="sr-only peer" />
          <span aria-hidden="true" tw-class="w-10 h-6 bg-gray-200 rounded-full dark:bg-gray-700 peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white dark:border-gray-600"></span>
        </span>
        <span tw-class="min-w-0 [overflow-wrap:anywhere]">{{ lazyStrings.stableDiffusionCppBrowser__show_all_weights() }}</span>
      </label>
    </ImageSettingsSection>
    <p v-if="showAll" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__component_evidence_help() }}</p>
    <ImageSettingsSection v-if="issues.length" :title="lazyStrings.stableDiffusionCppBrowser__inspection_issues()" :summary="issues.length.toString()" tw-class="border-amber-300 dark:border-amber-800">
      <p v-for="issue in issues" :key="issue" tw-class="mt-2 [overflow-wrap:anywhere] font-mono">{{ issue }}</p>
    </ImageSettingsSection>
  </div>
</template>
