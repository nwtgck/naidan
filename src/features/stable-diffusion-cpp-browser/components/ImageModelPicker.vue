<script setup lang="ts">
import { computed, ref, useId } from 'vue';
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
function change({ event }: { event: Event }): void {
  if (props.disabled || !(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  if (!value || props.choices.some(choice => choice.id === value && choice.status !== 'incompatible')) emit('update:modelValue', value);
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
  <fieldset :disabled="disabled" tw-class="min-w-0 space-y-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3">
    <legend tw-class="px-1 text-sm font-semibold">{{ label }} <span v-if="required" tw-class="text-xs font-normal text-gray-500">· {{ lazyStrings.stableDiffusionCppBrowser__component_required() }}</span></legend>
    <input v-if="choices.length > 6" v-model="search" type="search" :aria-label="lazyStrings.stableDiffusionCppBrowser__filter_components()" :placeholder="lazyStrings.stableDiffusionCppBrowser__filter_components()" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm" />
    <select :id="id" :value="modelValue" :aria-label="label" :aria-describedby="selected ? id + '-detail' : undefined" @change="change({ event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-sm focus:ring-2 focus:ring-purple-500 disabled:opacity-50">
      <option value="">{{ lazyStrings.stableDiffusionCppBrowser__select_component() }}</option>
      <option v-for="choice in visible" :key="choice.id" :value="choice.id" :disabled="choice.status === 'incompatible'">{{ choice.label }} — {{ choice.detail }} · {{ status({ choice }) }}</option>
    </select>
    <div v-if="selected" :id="id + '-detail'" tw-class="space-y-1 text-xs break-words">
      <p tw-class="font-mono text-gray-500 dark:text-gray-400">{{ selected.detail }}</p>
      <p :tw-class="selected.status === 'matching' ? 'text-purple-700 dark:text-purple-300' : 'text-amber-700 dark:text-amber-300'">{{ status({ choice: selected }) }}</p>
      <p v-for="reason in selected.evidence" :key="reason" tw-class="text-gray-500 dark:text-gray-400">{{ reason }}</p>
      <p v-if="selected.issue" role="alert" tw-class="text-red-600 dark:text-red-400">{{ selected.issue }}</p>
    </div>
  </fieldset>
</template>
