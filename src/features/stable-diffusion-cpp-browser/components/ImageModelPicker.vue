<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageModelChoice } from '@/features/stable-diffusion-cpp-browser/library-view';
const props = defineProps<{ label: string | undefined, modelValue: string, choices: ImageModelChoice[], disabled: boolean, required: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId(), search = ref('');
const visible = computed(() => {
  const term = search.value.trim().toLocaleLowerCase();
  return props.choices.filter(choice => choice.id === props.modelValue || `${choice.label} ${choice.detail}`.toLocaleLowerCase().includes(term));
});
const selected = computed(() => props.choices.find(choice => choice.id === props.modelValue));
function status({ choice }: { choice: ImageModelChoice }): string | undefined {
  switch (choice.status) {
  case 'matching': return lazyStrings.stableDiffusionCppBrowser__structural_match();
  case 'unverified': return lazyStrings.stableDiffusionCppBrowser__unverified_candidate();
  case 'incompatible': return lazyStrings.stableDiffusionCppBrowser__incompatible_candidate();
  default: { const exhaustive: never = choice.status; throw new Error(String(exhaustive)); }
  }
}
function optionLabel({ choice }: { choice: ImageModelChoice }): string {
  // Full paths only disambiguate identical filenames in the open menu. The
  // closed control uses the filename, matching llama.cpp's selected-file UI.
  return props.choices.some(other => other.id !== choice.id && other.label === choice.label) ? `${choice.label} — ${choice.detail}` : choice.label;
}
function change({ event }: { event: Event }): void {
  if (props.disabled || !(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  if (!value || props.choices.some(choice => choice.id === value && choice.status !== 'incompatible')) emit('update:modelValue', value);
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <fieldset :disabled="disabled" tw-class="min-w-0 space-y-2">
    <legend :id="id + '-label'" tw-class="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-200">{{ label }} <span v-if="required" tw-class="font-normal text-gray-400 dark:text-gray-500">· {{ lazyStrings.stableDiffusionCppBrowser__component_required() }}</span></legend>
    <input v-if="choices.length > 6" v-model="search" type="search" :aria-label="lazyStrings.stableDiffusionCppBrowser__filter_components()" :placeholder="lazyStrings.stableDiffusionCppBrowser__filter_components()" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs" />
    <div tw-class="relative min-w-0">
      <select :id="id" :value="modelValue" :title="selected?.detail" :aria-labelledby="id + '-label'" @change="change({ event: $event })" tw-class="block w-full min-w-0 appearance-none rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-2.5 pl-3 pr-9 text-sm text-gray-800 dark:text-gray-100 outline-none focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50">
        <option value="">{{ lazyStrings.stableDiffusionCppBrowser__select_component() }}</option>
        <option v-for="choice in visible" :key="choice.id" :value="choice.id" :disabled="choice.status === 'incompatible'">{{ optionLabel({ choice }) }}</option>
      </select>
      <span v-if="selected" aria-hidden="true" tw-class="pointer-events-none absolute inset-px flex min-w-0 items-center rounded-xl bg-white dark:bg-gray-900 pl-3 pr-9 text-sm text-gray-800 dark:text-gray-100"><span tw-class="truncate">{{ selected.label }}</span></span>
      <ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute inset-y-0 right-3 my-auto w-4 h-4 text-gray-400" />
    </div>
    <p v-if="selected && selected.status !== 'matching'" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ status({ choice: selected }) }}</p>
    <p v-if="selected?.issue" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ selected.issue }}</p>
    <details v-if="selected" data-testid="image-component-details" tw-class="text-[11px] text-gray-500 dark:text-gray-400">
      <summary tw-class="w-fit cursor-pointer rounded-sm hover:text-purple-600 dark:hover:text-purple-400">{{ lazyStrings.llamaCppBrowserDownloads__details() }}</summary>
      <div tw-class="mt-2 space-y-1 break-words">
        <p tw-class="break-all font-mono">{{ selected.detail }}</p>
        <p>{{ status({ choice: selected }) }}</p>
        <p v-for="reason in selected.evidence" :key="reason">{{ reason }}</p>
      </div>
    </details>
  </fieldset>
</template>
