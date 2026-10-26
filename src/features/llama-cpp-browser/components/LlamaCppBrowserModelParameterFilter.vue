<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { computed, useId } from 'vue';
import { createSearchParameterFilter } from '@/features/llama-cpp-browser/hugging-face/parameter-filter';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  minimumBillions: string,
  maximumBillions: string,
  disabled: boolean,
  invalid: boolean | undefined,
  errorDescribedBy: string | undefined,
}>();
const emit = defineEmits<{ 'update:minimumBillions': [value: string], 'update:maximumBillions': [value: string] }>();
const id = useId();
const minimum = computed({
  get: () => props.minimumBillions,
  set: (value: string) => emit('update:minimumBillions', value),
});
const maximum = computed({
  get: () => props.maximumBillions,
  set: (value: string) => emit('update:maximumBillions', value),
});
const draftNumParameters = computed(() => {
  try {
    return createSearchParameterFilter({ minimumBillions: props.minimumBillions, maximumBillions: props.maximumBillions });
  } catch {
    return undefined;
  }
});
const parameterPresets = computed(() => [
  { minimumBillions: '', maximumBillions: '1', label: lazyStrings.LlamaCppBrowserModelParameterFilter__up_to_parameters({ count: '1' }) },
  { minimumBillions: '1', maximumBillions: '4', label: lazyStrings.LlamaCppBrowserModelParameterFilter__parameters_between({ minimum: '1', maximum: '4' }) },
  { minimumBillions: '4', maximumBillions: '8', label: lazyStrings.LlamaCppBrowserModelParameterFilter__parameters_between({ minimum: '4', maximum: '8' }) },
  { minimumBillions: '8', maximumBillions: '16', label: lazyStrings.LlamaCppBrowserModelParameterFilter__parameters_between({ minimum: '8', maximum: '16' }) },
  { minimumBillions: '16', maximumBillions: '32', label: lazyStrings.LlamaCppBrowserModelParameterFilter__parameters_between({ minimum: '16', maximum: '32' }) },
  { minimumBillions: '32', maximumBillions: '70', label: lazyStrings.LlamaCppBrowserModelParameterFilter__parameters_between({ minimum: '32', maximum: '70' }) },
  { minimumBillions: '70', maximumBillions: '128', label: lazyStrings.LlamaCppBrowserModelParameterFilter__parameters_between({ minimum: '70', maximum: '128' }) },
  { minimumBillions: '128', maximumBillions: '', label: lazyStrings.LlamaCppBrowserModelParameterFilter__at_least_parameters({ count: '128' }) },
]);

function setParameterPreset({ minimumBillions, maximumBillions }: { minimumBillions: string, maximumBillions: string }): void {
  emit('update:minimumBillions', minimumBillions);
  emit('update:maximumBillions', maximumBillions);
}

const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <fieldset :disabled="disabled" tw-class="min-w-0 space-y-2">
    <legend :tw-class="['mb-1 font-medium text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-sm' : 'text-[10px]']">{{ lazyStrings.LlamaCppBrowserModelParameterFilter__parameter_count_in_billions() }}</legend>
    <div tw-class="flex min-w-0 items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 focus-within:ring-2 focus-within:ring-blue-500/40">
      <div tw-class="min-w-0 flex-1"><label :for="`${id}-minimum`" :tw-class="['block text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-sm' : 'text-[10px]']">{{ lazyStrings.LlamaCppBrowserModelParameterFilter__at_least() }}</label><input :id="`${id}-minimum`" v-model="minimum" type="text" inputmode="decimal" :disabled="disabled" :aria-label="lazyStrings.LlamaCppBrowserModelParameterFilter__minimum_parameters_in_billions()" :aria-invalid="invalid" :aria-describedby="errorDescribedBy" :placeholder="lazyStrings.LlamaCppBrowserModelParameterFilter__no_minimum()" data-testid="llama-hf-search-minimum" :tw-class="['w-full min-w-0 bg-transparent py-1 text-gray-800 outline-none disabled:opacity-50', isSettingsTypography ? 'text-sm dark:text-gray-300' : 'text-xs dark:text-gray-100']" /></div>
      <span aria-hidden="true" tw-class="shrink-0 text-xs text-gray-400">–</span>
      <div tw-class="min-w-0 flex-1"><label :for="`${id}-maximum`" :tw-class="['block text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-sm' : 'text-[10px]']">{{ lazyStrings.LlamaCppBrowserModelParameterFilter__at_most() }}</label><input :id="`${id}-maximum`" v-model="maximum" type="text" inputmode="decimal" :disabled="disabled" :aria-label="lazyStrings.LlamaCppBrowserModelParameterFilter__maximum_parameters_in_billions()" :aria-invalid="invalid" :aria-describedby="errorDescribedBy" :placeholder="lazyStrings.LlamaCppBrowserModelParameterFilter__no_maximum()" data-testid="llama-hf-search-maximum" :tw-class="['w-full min-w-0 bg-transparent py-1 text-gray-800 outline-none disabled:opacity-50', isSettingsTypography ? 'text-sm dark:text-gray-300' : 'text-xs dark:text-gray-100']" /></div>
    </div>
    <div tw-class="flex flex-wrap gap-1.5">
      <button v-for="preset in parameterPresets" :key="`${preset.minimumBillions}:${preset.maximumBillions}`" type="button" data-testid="llama-hf-search-preset" :disabled="disabled" :aria-pressed="draftNumParameters === createSearchParameterFilter({ minimumBillions: preset.minimumBillions, maximumBillions: preset.maximumBillions })" :tw-class="[['rounded-full px-2 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50', isSettingsTypography ? 'text-xs' : 'text-[10px]'], draftNumParameters === createSearchParameterFilter({ minimumBillions: preset.minimumBillions, maximumBillions: preset.maximumBillions }) ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400']" @click="setParameterPreset({ minimumBillions: preset.minimumBillions, maximumBillions: preset.maximumBillions })">{{ preset.label }}</button>
      <button type="button" data-testid="llama-hf-search-clear-parameters" :disabled="disabled" :aria-pressed="minimumBillions.trim() === '' && maximumBillions.trim() === ''" :tw-class="[['rounded-full px-2 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50', isSettingsTypography ? 'text-xs' : 'text-[10px]'], minimumBillions.trim() === '' && maximumBillions.trim() === '' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400']" @click="setParameterPreset({ minimumBillions: '', maximumBillions: '' })">{{ lazyStrings.LlamaCppBrowserModelParameterFilter__no_parameter_limit() }}</button>
    </div>
  </fieldset>
</template>
