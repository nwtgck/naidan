<script setup lang="ts">
import { ref } from 'vue';
import { lazyStrings } from '@/strings';
import type { ImageInputs } from '@/features/stable-diffusion-cpp-browser/types';

const props = defineProps<{ modelValue: ImageInputs, disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: ImageInputs] }>();
const invalid = ref(false);
function choose({ role, event }: { role: 'initial' | 'reference', event: Event }): void {
  if (props.disabled || !(event.target instanceof HTMLInputElement)) return;
  const files = Array.from(event.target.files ?? []); event.target.value = '';
  if (!files.length) return;
  invalid.value = files.some(file => file.size === 0 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
  if (invalid.value) return;
  switch (role) {
  case 'initial': emit('update:modelValue', { ...props.modelValue, initImage: files[0] }); break;
  case 'reference': emit('update:modelValue', { ...props.modelValue, referenceImages: [...props.modelValue.referenceImages, ...files] }); break;
  default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
  }
}
function strength({ event }: { event: Event }): void {
  if (props.disabled || !(event.target instanceof HTMLInputElement)) return;
  emit('update:modelValue', { ...props.modelValue, strength: event.target.valueAsNumber });
}
function remove({ role, index }: { role: 'initial' | 'reference', index: number }): void {
  if (props.disabled) return;
  invalid.value = false;
  switch (role) {
  case 'initial': emit('update:modelValue', { ...props.modelValue, initImage: undefined }); break;
  case 'reference': emit('update:modelValue', { ...props.modelValue, referenceImages: props.modelValue.referenceImages.filter((_file, position) => position !== index) }); break;
  default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <details tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-3" data-testid="image-input-controls">
    <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.ImageInputControls__input_images() }}</summary>
    <fieldset :disabled="disabled" tw-class="space-y-3">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageInputControls__model_support_required() }}</p>
      <label tw-class="block space-y-1 text-sm">
        <span>{{ lazyStrings.ImageInputControls__initial_image() }}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="disabled" @change="choose({ role: 'initial', event: $event })" data-testid="image-input-initial" tw-class="block w-full text-sm" />
      </label>
      <div v-if="modelValue.initImage" tw-class="flex flex-wrap items-center gap-3 text-xs">
        <span tw-class="break-all">{{ modelValue.initImage.name }}</span>
        <button type="button" :disabled="disabled" @click="remove({ role: 'initial', index: 0 })" data-testid="image-input-clear-initial" tw-class="underline disabled:opacity-40">{{ lazyStrings.ImageInputControls__remove() }}</button>
        <label tw-class="inline-flex items-center gap-2"><span>{{ lazyStrings.ImageInputControls__change_strength() }}</span><input type="number" min="0" max="1" step="0.05" required :value="modelValue.strength" :disabled="disabled" @input="strength({ event: $event })" data-testid="image-input-strength" tw-class="w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /></label>
      </div>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageInputControls__initial_image_help() }}</p>
      <label tw-class="block space-y-1 text-sm"><span>{{ lazyStrings.ImageInputControls__reference_images() }}</span><input type="file" multiple accept="image/png,image/jpeg,image/webp" :disabled="disabled" @change="choose({ role: 'reference', event: $event })" data-testid="image-input-references" tw-class="block w-full text-sm" /></label>
      <div v-for="(file, index) in modelValue.referenceImages" :key="index" tw-class="flex items-center gap-3 text-xs"><span tw-class="break-all">{{ index + 1 }}. {{ file.name }}</span><button type="button" :disabled="disabled" @click="remove({ role: 'reference', index })" data-testid="image-input-remove-reference" tw-class="underline disabled:opacity-40">{{ lazyStrings.ImageInputControls__remove() }}</button></div>
      <p v-if="invalid" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ImageInputControls__choose_png_jpeg_or_webp() }}</p>
    </fieldset>
  </details>
</template>
