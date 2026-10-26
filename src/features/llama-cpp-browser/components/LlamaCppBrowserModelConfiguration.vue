<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { computed, useId } from 'vue';
import SettingsSelect from '@/components/SettingsSelect.vue';
import { lazyStrings } from '@/strings';
import { projectorChoices } from '@/features/llama-cpp-browser/hugging-face/presentation';
import type { RepositoryFile } from '@/features/llama-cpp-browser/hugging-face/types';

// Selection presentation only. Owners retain metadata, defaults and actions.
const props = defineProps<{ choices: readonly { primaryRelativePath: string, displayLabel: string, size: number }[], projectors: RepositoryFile[], disabled: boolean, multimodalDescriptionId: string | undefined }>();
const quantization = defineModel<string>('quantization', { required: true });
const multimodal = defineModel<'on' | 'off'>('multimodal', { required: true });
const projector = defineModel<string>('projector', { required: true });
const id = useId();
const quantizationOptions = computed(() => [
  ...(!props.choices.some(choice => choice.primaryRelativePath === quantization.value) ? [{ value: '', label: lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_model_files(), disabled: true }] : []),
  ...props.choices.map(choice => ({ value: choice.primaryRelativePath, label: choice.displayLabel, detail: size({ bytes: choice.size }) })),
]);
const projectorOptions = computed(() => projectorChoices({ files: props.projectors }));
const companionOptions = computed(() => [
  ...(!projectorOptions.value.some(option => option.file.path === projector.value) ? [{ value: '', label: lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_companion_file(), disabled: true }] : []),
  ...projectorOptions.value.map(option => ({ value: option.file.path, label: option.label, detail: size({ bytes: option.file.size }) })),
]);

function toggleMultimodal(): void {
  if (props.disabled) {
    return;
  }
  switch (multimodal.value) {
  case 'on': multimodal.value = 'off';
    break;
  case 'off': multimodal.value = 'on';
    break;
  default: {
    const exhaustive: never = multimodal.value;
    throw new Error(String(exhaustive));
  }
  }
}

function size({ bytes }: { bytes: number }): string {
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <fieldset :disabled="disabled" tw-class="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3 disabled:opacity-50">
    <div tw-class="flex max-w-full items-center gap-2">
      <label :for="`${id}-quantization`" :tw-class="['shrink-0 font-medium text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-sm' : 'text-[11px]']">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__quantization() }}</label>
      <div tw-class="w-32 min-w-0 max-w-full">
        <SettingsSelect :tw-class="[isSettingsTypography && '[&_.settings-select-value]:text-sm [&_.settings-select-value]:leading-5 dark:[&_.settings-select-value]:text-gray-300']" :id="`${id}-quantization`" v-model="quantization" data-testid="llama-model-quantization" :options="quantizationOptions" :label="lazyStrings.LlamaCppBrowserHuggingFaceManager__quantization()" :disabled="disabled" size="compact" presentation="toolbar" :menu-width-rem="15">
          <template #option="{ option }"><span :tw-class="['min-w-0 flex-1 break-words font-medium', isSettingsTypography ? 'text-sm leading-5' : 'text-xs leading-4']">{{ option.label }}</span><span :tw-class="['shrink-0 tabular-nums text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-xs' : 'text-[11px]']">{{ option.detail }}</span></template>
        </SettingsSelect>
      </div>
    </div>
    <div v-if="projectors.length" tw-class="flex items-center gap-2.5">
      <span :id="`${id}-multimodal-label`" :tw-class="['font-medium text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-xs' : 'text-[11px]']">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__multimodal_support() }}</span>
      <button type="button" role="switch" data-testid="llama-model-multimodal" :aria-checked="multimodal === 'on'" :aria-labelledby="`${id}-multimodal-label`" :aria-describedby="multimodalDescriptionId" :tw-class="['relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none', multimodal === 'on' ? 'bg-blue-500 dark:bg-blue-500' : 'bg-gray-200 dark:bg-gray-700']" @click="toggleMultimodal"><span aria-hidden="true" :tw-class="['h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none', multimodal === 'on' ? 'translate-x-[18px]' : 'translate-x-[3px]']" /></button>
    </div>
    <div v-if="projectors.length && multimodal === 'on'" tw-class="flex max-w-full items-center gap-2">
      <label :for="`${id}-companion`" :tw-class="['shrink-0 font-medium text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-sm' : 'text-[11px]']">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__multimodal_quantization() }}</label>
      <div tw-class="w-28 min-w-0 max-w-full">
        <SettingsSelect :tw-class="[isSettingsTypography && '[&_.settings-select-value]:text-sm [&_.settings-select-value]:leading-5 dark:[&_.settings-select-value]:text-gray-300']" :id="`${id}-companion`" v-model="projector" data-testid="llama-model-companion" :options="companionOptions" :label="lazyStrings.LlamaCppBrowserHuggingFaceManager__multimodal_quantization()" :disabled="disabled" size="compact" presentation="toolbar" :menu-width-rem="14">
          <template #option="{ option }"><span :tw-class="['min-w-0 flex-1 break-words font-medium', isSettingsTypography ? 'text-sm leading-5' : 'text-xs leading-4']">{{ option.label }}</span><span :tw-class="['shrink-0 tabular-nums text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-xs' : 'text-[11px]']">{{ option.detail }}</span></template>
        </SettingsSelect>
      </div>
    </div>
  </fieldset>
</template>
