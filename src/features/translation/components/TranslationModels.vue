<script setup lang="ts">
import { lazyStrings } from '@/strings';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import { translationModelSuggestions } from '@/features/translation/model-catalog';
const props = defineProps<{ suspended: boolean, disabled: boolean, modelId: string | undefined }>();
const emit = defineEmits<{ select: [modelId: string], changed: [] }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="translation-models" tw-class="space-y-6">
    <p tw-class="max-w-3xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__supported_models_help() }}</p>
    <LlamaCppBrowserManager presentation="settings" :model-suggestions="translationModelSuggestions" :catalog-first="true" selection-action="select" :suspended="props.suspended" :disabled="props.disabled" @model-selected="emit('select', $event)" @models-changed="emit('changed')">
      <template #model-actions="{ model, disabled }">
        <LlamaCppBrowserModelActionButton :disabled="disabled || props.disabled || props.suspended" :aria-pressed="model.modelId === props.modelId" :data-testid="`translation-select-${model.modelId}`" @click="emit('select', model.modelId)">{{ model.modelId === props.modelId ? lazyStrings.translation__selected_model() : lazyStrings.translation__use_for_translation() }}</LlamaCppBrowserModelActionButton>
      </template>
      <template #selection-hint><p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__model_selection_help() }}</p></template>
    </LlamaCppBrowserManager>
  </section>
</template>
