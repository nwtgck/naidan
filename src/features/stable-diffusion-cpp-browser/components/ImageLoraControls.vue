<script setup lang="ts">
import { ref } from 'vue';
import { lazyStrings } from '@/strings';
import type { ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';

const props = defineProps<{ modelValue: ImageLoraSelection[], disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: ImageLoraSelection[]] }>();
const invalidFiles = ref(false);

function add({ event }: { event: Event }): void {
  if (props.disabled || !(event.target instanceof HTMLInputElement)) return;
  const files = Array.from(event.target.files ?? []);
  event.target.value = '';
  if (!files.length) return;
  invalidFiles.value = props.modelValue.length + files.length > 16 || files.some(file => !/\.(gguf|safetensors)$/i.test(file.name) || file.size < 8);
  if (invalidFiles.value) return;
  emit('update:modelValue', [...props.modelValue, ...files.map(file => ({ file, strength: 1, enabled: true }))]);
}
function change({ index, event, field }: { index: number, event: Event, field: 'enabled' | 'strength' }): void {
  if (props.disabled || !(event.target instanceof HTMLInputElement)) return;
  const input = event.target;
  emit('update:modelValue', props.modelValue.map((selection, position) => {
    if (index !== position) return selection;
    switch (field) {
    case 'enabled': return { ...selection, enabled: input.checked };
    case 'strength': return { ...selection, strength: input.valueAsNumber };
    default: { const exhaustive: never = field; throw new Error(String(exhaustive)); }
    }
  }));
}
function remove({ index }: { index: number }): void {
  if (props.disabled) return;
  invalidFiles.value = false;
  emit('update:modelValue', props.modelValue.filter((_selection, position) => index !== position));
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
  <fieldset :disabled="disabled" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-3" data-testid="image-lora-controls">
    <legend tw-class="px-1 text-sm font-medium">{{ lazyStrings.ImageLoraControls__lora_adapters() }}</legend>
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageLoraControls__choose_adapters_for_selected_model() }}</p>
    <label tw-class="block space-y-1 text-sm">
      <span>{{ lazyStrings.ImageLoraControls__choose_files() }}</span>
      <input type="file" multiple accept=".gguf,.safetensors" :disabled="disabled" @change="add({ event: $event })" data-testid="image-lora-files" tw-class="block w-full text-sm" />
    </label>
    <p v-if="invalidFiles" role="alert" data-testid="image-lora-file-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ImageLoraControls__choose_up_to_16_gguf_or_safetensors_files() }}</p>
    <div v-for="(selection, index) in modelValue" :key="index" data-testid="image-lora-row" tw-class="flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
      <label tw-class="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <input type="checkbox" :checked="selection.enabled" :disabled="disabled" :aria-label="lazyStrings.ImageLoraControls__enabled()" @change="change({ index, event: $event, field: 'enabled' })" data-testid="image-lora-enabled" />
        <span tw-class="break-all">{{ selection.path ?? selection.file.name }}</span>
      </label>
      <label tw-class="flex items-center gap-2 text-xs">
        <span>{{ lazyStrings.ImageLoraControls__strength() }}</span>
        <input type="number" :value="selection.strength" min="-10" max="10" step="0.05" required :disabled="disabled || !selection.enabled" @input="change({ index, event: $event, field: 'strength' })" data-testid="image-lora-strength" tw-class="w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 disabled:opacity-40" />
      </label>
      <button type="button" :disabled="disabled" @click="remove({ index })" data-testid="image-lora-remove" tw-class="text-xs underline disabled:opacity-40">{{ lazyStrings.ImageLoraControls__remove() }}</button>
    </div>
  </fieldset>
</template>
