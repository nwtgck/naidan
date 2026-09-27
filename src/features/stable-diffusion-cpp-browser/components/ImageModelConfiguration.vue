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
  <div tw-class="space-y-4">
    <div v-if="components.length" tw-class="space-y-3">
      <h3 tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__components_detected() }}</h3>
      <ImageModelPicker :active="active" v-for="component in components" :key="component.slot" :model-value="component.selected" :choices="component.choices" :required="component.required" :label="componentLabel({ slot: component.slot })" :disabled="disabled || importing || downloading || view.scanState.value === 'scanning'" @update:model-value="view.chooseComponent({ slot: component.slot, id: $event })" :data-testid="'image-component-' + component.slot" />
    </div>
    <p v-if="view.main.value && !view.ready.value && !importing && view.scanState.value !== 'scanning'" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__incomplete_components() }}</p>
    <ImageSettingsSection embedded :title="lazyStrings.llamaCppBrowserDownloads__details()" :summary="undefined">
      <label tw-class="min-h-10 cursor-pointer flex items-center gap-2 py-2"><input v-model="showAll" :disabled="disabled || importing || downloading || view.scanState.value === 'scanning'" type="checkbox" role="switch" data-testid="image-show-all" tw-class="relative appearance-none h-5 w-9 shrink-0 cursor-pointer rounded-full bg-gray-300 dark:bg-gray-600 checked:bg-purple-600 dark:checked:bg-purple-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform checked:after:translate-x-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed" />{{ lazyStrings.stableDiffusionCppBrowser__show_all_weights() }}</label>
    </ImageSettingsSection>
    <p v-if="showAll" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__component_evidence_help() }}</p>
    <ImageSettingsSection v-if="issues.length" :title="lazyStrings.stableDiffusionCppBrowser__inspection_issues()" :summary="issues.length.toString()" tw-class="border-amber-300 dark:border-amber-800">
      <p v-for="issue in issues" :key="issue" tw-class="mt-2 break-words font-mono">{{ issue }}</p>
    </ImageSettingsSection>
  </div>
</template>
