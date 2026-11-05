<script setup lang="ts">
import { lazyStrings } from '@/strings';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import { translationModelRepositories } from '@/features/translation/profiles';
const props = defineProps<{ suspended: boolean, disabled: boolean, modelId: string | undefined }>();
const emit = defineEmits<{ select: [modelId: string], changed: [] }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="translation-models" tw-class="space-y-6">
    <p tw-class="max-w-3xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__supported_models_help() }}</p>
    <LlamaCppBrowserManager presentation="settings" suggestions="none" :suspended="props.suspended" :disabled="props.disabled" @model-selected="emit('select', $event)" @models-changed="emit('changed')">
      <template #catalog="{ disabled, inspect }">
        <div tw-class="space-y-3 pb-5">
          <h2 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.translation__find_translation_models() }}</h2>
          <div tw-class="flex flex-wrap gap-2">
            <LlamaCppBrowserModelActionButton v-for="repository in translationModelRepositories" :key="repository" :disabled="disabled || props.disabled" @click="inspect({ input: repository })">{{ repository }}</LlamaCppBrowserModelActionButton>
          </div>
        </div>
      </template>
      <template #model-actions="{ model, disabled }">
        <LlamaCppBrowserModelActionButton :disabled="disabled || props.disabled || props.suspended" :aria-pressed="model.modelId === props.modelId" :data-testid="`translation-select-${model.modelId}`" @click="emit('select', model.modelId)">{{ model.modelId === props.modelId ? lazyStrings.translation__selected_model() : lazyStrings.translation__use_for_translation() }}</LlamaCppBrowserModelActionButton>
      </template>
      <template #selection-hint><p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__model_selection_help() }}</p></template>
    </LlamaCppBrowserManager>
  </section>
</template>
