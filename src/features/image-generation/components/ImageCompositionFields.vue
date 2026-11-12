<script setup lang="ts">
import { useId } from 'vue';
import { lazyStrings } from '@/strings';
import type { ImageGenerationInput } from '@/features/image-generation/composition/input';
import { samplerOptions, schedulerOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
const props = defineProps<{ input: ImageGenerationInput, disabled: boolean, shared: Record<string, unknown> }>();
const emit = defineEmits<{ update: [input: ImageGenerationInput] }>();
const id = useId();
type Field = { key: Exclude<keyof ImageGenerationInput, 'prompt'>, kind: 'text' | 'number' | 'boolean' | 'choice' | 'auto-number' | 'seed', options?: readonly string[] };
const fields: Field[] = [
  { key: 'negativePrompt', kind: 'text' }, { key: 'uiModelConfigurationSlot', kind: 'text' },
  { key: 'count', kind: 'number' }, { key: 'width', kind: 'number' }, { key: 'height', kind: 'number' },
  { key: 'steps', kind: 'auto-number' }, { key: 'guidance', kind: 'auto-number' },
  { key: 'seed', kind: 'seed' }, { key: 'sampler', kind: 'choice', options: samplerOptions }, { key: 'scheduler', kind: 'choice', options: schedulerOptions },
  { key: 'distilledGuidance', kind: 'number' }, { key: 'vaeTiling', kind: 'boolean' }, { key: 'vaeTileSize', kind: 'auto-number' },
  { key: 'flashAttention', kind: 'boolean' }, { key: 'bf16WeightType', kind: 'choice', options: ['f32', 'f16', 'bf16'] },
  { key: 'qwenVaePolicy', kind: 'choice', options: ['bounded', 'native'] }, { key: 'conditioningCacheSize', kind: 'number' }, { key: 'modelArguments', kind: 'text' },
];

function change({ key, value }: { key: Field['key'], value: string | number | boolean | null | undefined }): void {
  if (props.disabled) {
    return;
  }
  const input = { ...props.input };
  if (value === undefined) {
    delete input[key];
  } else {
    Object.assign(input, { [key]: value });
  }
  emit('update', input);
}

function inherit({ field, event }: { field: Field, event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  const fallback = (() => {
    const kind = field.kind;
    switch (kind) {
    case 'number': return 1;
    case 'auto-number': return 'auto';
    case 'boolean': return false;
    case 'seed': return null;
    case 'choice': case 'text': return field.options?.[0] ?? '';
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const value = props.shared[field.key] ?? fallback;
  change({ key: field.key, value: event.target.checked ? undefined : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : fallback });
}

function edit({ field, event }: { field: Field, event: Event }): void {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return;
  }
  let value: string | number | boolean = element.value;
  if (field.kind === 'boolean' && element instanceof HTMLInputElement) {
    value = element.checked;
  }
  if (field.kind === 'number' || field.kind === 'auto-number') {
    const number = Number(value);
    if (!String(value).trim() || !Number.isFinite(number)) {
      // Never leave a blank control displaying a different value from the plan.
      element.value = String(props.input[field.key] ?? '');
      return;
    }
    value = number;
  }
  change({ key: field.key, value });
}

function choice({ field, event }: { field: Field, event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  const kind = field.kind;
  switch (kind) {
  case 'seed': change({ key: field.key, value: event.target.checked ? null : '0' });
    break;
  case 'auto-number': change({ key: field.key, value: event.target.checked ? 'auto' : 1 });
    break;
  case 'text': case 'number': case 'boolean': case 'choice': throw new Error('This field has no automatic choice.');
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3">
    <div v-for="field in fields" :key="field.key" tw-class="space-y-1 text-xs" :data-testid="'composition-field-' + field.key">
      <div tw-class="flex flex-wrap items-center justify-between gap-2">
        <label :for="id + field.key" tw-class="font-mono text-gray-700 dark:text-gray-300">{{ field.key }}</label>
        <label tw-class="flex items-center gap-1 text-gray-500 dark:text-gray-400"><input type="checkbox" :disabled="disabled" :checked="input[field.key] === undefined" @change="inherit({ field, event: $event })" />{{ lazyStrings.imageComposition__inherit() }}</label>
      </div>
      <p v-if="input[field.key] === undefined" tw-class="break-words text-gray-500 dark:text-gray-400">{{ field.key === 'uiModelConfigurationSlot' ? lazyStrings.imageComposition__inherit() : field.key === 'seed' && shared.seed === null ? lazyStrings.imageComposition__random() : String(shared[field.key] ?? '') }}</p>
      <template v-else>
        <label v-if="field.kind === 'auto-number' || field.kind === 'seed'" tw-class="flex gap-1"><input type="checkbox" :disabled="disabled" :checked="input[field.key] === (field.kind === 'seed' ? null : 'auto')" @change="choice({ field, event: $event })" />{{ field.kind === 'seed' ? lazyStrings.imageComposition__random() : lazyStrings.imageComposition__auto() }}</label>
        <textarea v-if="field.kind === 'text'" :id="id + field.key" :value="String(input[field.key] ?? '')" :disabled="disabled" rows="2" @input="edit({ field, event: $event })" tw-class="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 outline-none focus:ring-2 focus:ring-blue-500" />
        <select v-else-if="field.kind === 'choice'" :id="id + field.key" :value="input[field.key]" :disabled="disabled" @change="edit({ field, event: $event })" tw-class="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-2"><option v-for="value in field.options" :key="value" :value="value">{{ value }}</option></select>
        <input v-else-if="field.kind === 'boolean'" :id="id + field.key" type="checkbox" :checked="input[field.key] === true" :disabled="disabled" @change="edit({ field, event: $event })" />
        <input v-else-if="input[field.key] !== null && input[field.key] !== 'auto'" :id="id + field.key" :type="field.kind === 'seed' ? 'text' : 'number'" step="any" :value="input[field.key]" :disabled="disabled" @input="edit({ field, event: $event })" tw-class="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 outline-none focus:ring-2 focus:ring-blue-500" />
      </template>
    </div>
  </div>
</template>
