<script setup lang="ts">
import { lazyStrings } from '@/strings';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { ModelSlot } from '@/features/stable-diffusion-cpp-browser/types';
import ImageModelPicker from './ImageModelPicker.vue';

const props = defineProps<{ view: ImageLibraryView, disabled: boolean }>();
const { models, main, components, scanState, showAll, importing, downloading, failure, issues, ready } = props.view;
function label({ slot }: { slot: ModelSlot }): string | undefined {
  switch (slot) {
  case 'model': return lazyStrings.stableDiffusionCppBrowser__model_file();
  case 'diffusion': return lazyStrings.stableDiffusionCppBrowser__diffusion_file();
  case 'vae': return lazyStrings.stableDiffusionCppBrowser__vae_file();
  case 'lm': return lazyStrings.stableDiffusionCppBrowser__lm_file();
  case 'clipL': return lazyStrings.stableDiffusionCppBrowser__clip_l_file();
  case 'clipG': return lazyStrings.stableDiffusionCppBrowser__clip_g_file();
  case 't5': return lazyStrings.stableDiffusionCppBrowser__t5_file();
  default: { const exhaustive: never = slot; throw new Error(String(exhaustive)); }
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>
<template>
  <section tw-class="space-y-4" data-testid="image-model-library">
    <h2 tw-class="font-semibold text-sm">{{ lazyStrings.stableDiffusionCppBrowser__local_library() }}</h2>
    <p v-if="failure" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ failure }}</p>
    <p v-if="scanState === 'scanning'" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.stableDiffusionCppBrowser__scanning_repositories() }}</p>
    <details tw-class="text-xs">
      <summary tw-class="cursor-pointer text-gray-600 dark:text-gray-300">{{ lazyStrings.stableDiffusionCppBrowser__advanced_parameters() }}</summary>
      <label tw-class="flex items-center gap-2 py-2"><input v-model="showAll" :disabled="disabled || importing || downloading" type="checkbox" data-testid="image-show-all" />{{ lazyStrings.stableDiffusionCppBrowser__show_all_weights() }}</label>
    </details>
    <ImageModelPicker :model-value="main" :choices="models" :disabled="disabled || importing || downloading" :required="true" :label="lazyStrings.stableDiffusionCppBrowser__main_image_model()" @update:model-value="view.chooseMain({ id: $event })" data-testid="image-main-model" />
    <div v-if="components.length" tw-class="space-y-3">
      <h3 tw-class="text-sm font-medium">{{ lazyStrings.stableDiffusionCppBrowser__components_detected() }}</h3>
      <ImageModelPicker v-for="component in components" :key="component.slot" :model-value="component.selected" :choices="component.choices" :required="component.required" :label="label({ slot: component.slot })" :disabled="disabled || importing || downloading" @update:model-value="view.chooseComponent({ slot: component.slot, id: $event })" :data-testid="'image-component-' + component.slot" />
    </div>
    <p v-if="main && !ready && !importing" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__incomplete_components() }}</p>
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__component_evidence_help() }}</p>
    <details v-if="issues.length" tw-class="text-xs border border-amber-300 dark:border-amber-800 rounded-lg p-3">
      <summary tw-class="cursor-pointer">{{ lazyStrings.stableDiffusionCppBrowser__inspection_issues() }} ({{ issues.length }})</summary>
      <p v-for="issue in issues" :key="issue" tw-class="mt-2 break-words font-mono">{{ issue }}</p>
    </details>
  </section>
</template>
