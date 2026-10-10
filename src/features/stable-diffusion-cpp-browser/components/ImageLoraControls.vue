<script setup lang="ts">
import { computed, ref } from 'vue';
import ImageModelPicker from './ImageModelPicker.vue';
import ImageSettingsSection from '@/features/image-generation/components/ImageSettingsSection.vue';
import { lazyStrings } from '@/strings';
import type { ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';
import type { SavedImageLoraChoice } from '@/features/stable-diffusion-cpp-browser/library-view';

const props = defineProps<{ modelValue: ImageLoraSelection[], saved: readonly SavedImageLoraChoice[], disabled: boolean, active: boolean, embedded?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: ImageLoraSelection[]] }>();
const open = defineModel<boolean>('open', { default: false });
const invalidFiles = ref(false);
const savedId = ref('');
const choices = computed(() => props.saved.map(candidate => ({ id: candidate.id, label: candidate.label, detail: candidate.detail, evidence: [], status: 'unverified' as const, issue: undefined })));


function addSaved(): void {
  if (props.disabled) return;
  const candidate = props.saved.find(candidate => candidate.id === savedId.value);
  if (!candidate) return;
  invalidFiles.value = props.modelValue.length >= 16;
  if (invalidFiles.value) return;
  emit('update:modelValue', [...props.modelValue, { file: candidate.file, path: candidate.path, sourceLabel: candidate.detail, strength: 1, enabled: true }]);
  savedId.value = '';
}

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
  <component :is="embedded ? 'div' : ImageSettingsSection" v-bind="embedded ? {} : { open, title: lazyStrings.ImageLoraControls__lora_adapters(), summary: lazyStrings.ImageLoraControls__selected_adapters({ count: modelValue.filter(item => item.enabled).length }) }" @update:open="open = $event" data-testid="image-lora-controls">
    <div v-if="embedded" tw-class="flex items-center justify-between gap-2">
      <h3 tw-class="text-sm font-medium">{{ lazyStrings.ImageLoraControls__lora_adapters() }}</h3>
      <span tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageLoraControls__selected_adapters({ count: modelValue.filter(item => item.enabled).length }) }}</span>
    </div>
    <fieldset :disabled="disabled" tw-class="min-w-0 space-y-4">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageLoraControls__choose_adapters_for_selected_model() }}</p>
      <ImageModelPicker :active="active" v-model="savedId" :choices="choices" :disabled="disabled || !saved.length" :required="false" :label="lazyStrings.ImageLoraControls__saved_adapters()" :empty-label="lazyStrings.ImageLoraControls__choose_saved_adapter()" compact data-testid="image-lora-saved" />
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageLoraControls__saved_adapter_compatibility_unverified() }}</p>
      <button type="button" :disabled="disabled || !saved.some(candidate => candidate.id === savedId)" @click="addSaved()" data-testid="image-lora-add-saved" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageLoraControls__add_adapter() }}</button>
      <label tw-class="block space-y-1 text-sm">
        <span>{{ lazyStrings.ImageLoraControls__choose_files() }}</span>
        <input type="file" multiple accept=".gguf,.safetensors" :disabled="disabled" @change="add({ event: $event })" data-testid="image-lora-files" tw-class="file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 dark:file:bg-blue-950/40 dark:file:text-blue-300 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full text-sm" />
      </label>
      <p v-if="invalidFiles" role="alert" data-testid="image-lora-file-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ImageLoraControls__choose_up_to_16_gguf_or_safetensors_files() }}</p>
      <div v-for="(selection, index) in modelValue" :key="index" data-testid="image-lora-row" tw-class="flex flex-wrap items-center gap-3 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 shadow-sm">
        <label tw-class="min-h-10 cursor-pointer flex min-w-0 flex-1 items-center gap-2 text-sm">
          <input type="checkbox" role="switch" :checked="selection.enabled" :disabled="disabled" :aria-label="lazyStrings.ImageLoraControls__enabled()" @change="change({ index, event: $event, field: 'enabled' })" data-testid="image-lora-enabled" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />
          <span tw-class="break-all">{{ selection.sourceLabel ?? selection.path ?? selection.file.name }}</span>
        </label>
        <label tw-class="flex items-center gap-2 text-xs">
          <span>{{ lazyStrings.ImageLoraControls__strength() }}</span>
          <input type="number" :value="selection.strength" min="-10" max="10" step="0.05" required :disabled="disabled || !selection.enabled" @input="change({ index, event: $event, field: 'strength' })" data-testid="image-lora-strength" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 w-20 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-gray-800 dark:text-gray-100 shadow-sm disabled:opacity-40" />
        </label>
        <button type="button" :disabled="disabled" @click="remove({ index })" data-testid="image-lora-remove" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 text-xs font-bold rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 text-red-600 dark:text-red-400 hover:border-red-200 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors min-h-10 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageLoraControls__remove() }}</button>
      </div>
    </fieldset>
  </component>
</template>
