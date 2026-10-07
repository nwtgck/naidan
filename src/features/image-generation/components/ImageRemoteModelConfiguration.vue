<script setup lang="ts">
import { ref } from 'vue';
import { lazyStrings } from '@/strings';
import { componentLabel } from '@/features/stable-diffusion-cpp-browser/component-label';
import ImageModelPicker from '@/features/stable-diffusion-cpp-browser/components/ImageModelPicker.vue';
import type { ImageInferenceLocationView } from '@/features/image-generation/composables/use-image-inference-location';

const props = defineProps<{ inferenceLocation: ImageInferenceLocationView, disabled: boolean, active: boolean }>();
const lora = ref('');
function addLora(): void {
  if (props.disabled) return;
  props.inferenceLocation.addLora({ id: lora.value }); lora.value = '';
}
function changeLora({ index, event, field }: { index: number, event: Event, field: 'strength' | 'enabled' }): void {
  if (props.disabled || !(event.target instanceof HTMLInputElement)) return;
  const item = props.inferenceLocation.editor.value.loras[index];
  if (!item) return;
  switch (field) {
  case 'enabled': props.inferenceLocation.changeLora({ index, strength: item.strength, enabled: event.target.checked ? 'enabled' : 'disabled' }); break;
  case 'strength':
    if (Number.isFinite(event.target.valueAsNumber) && event.target.valueAsNumber >= -10 && event.target.valueAsNumber <= 10) props.inferenceLocation.changeLora({ index, strength: event.target.valueAsNumber, enabled: item.enabled });
    break;
  default: { const exhaustive: never = field; throw new Error(String(exhaustive)); }
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="min-w-0 space-y-4" data-testid="image-remote-model-configuration">
    <div tw-class="min-w-0 space-y-3">
      <ImageModelPicker v-for="component in inferenceLocation.components.value" :key="component.slot" :active="active" :model-value="component.selected" :choices="component.choices" :required="component.required" :label="componentLabel({ slot: component.slot })" :disabled="disabled || !inferenceLocation.peerId.value || inferenceLocation.loading.value" @update:model-value="inferenceLocation.chooseComponent({ slot: component.slot, id: $event })" :data-testid="'image-component-' + component.slot" />
    </div>
    <p v-if="inferenceLocation.editor.value.primary && !inferenceLocation.ready.value" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__incomplete_components() }}</p>
    <div tw-class="flex items-center justify-between gap-2">
      <h3 tw-class="text-sm font-medium">{{ lazyStrings.ImageLoraControls__lora_adapters() }}</h3>
      <span tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageLoraControls__selected_adapters({ count: inferenceLocation.editor.value.loras.filter(item => item.enabled === 'enabled').length }) }}</span>
    </div>
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageLoraControls__choose_adapters_for_selected_model() }}</p>
    <ImageModelPicker :active="active" v-model="lora" :choices="inferenceLocation.loraChoices.value" :disabled="disabled || !inferenceLocation.peerId.value || !inferenceLocation.loraChoices.value.length || inferenceLocation.editor.value.loras.length >= 8" :required="false" :label="lazyStrings.ImageLoraControls__saved_adapters()" :empty-label="lazyStrings.ImageLoraControls__choose_saved_adapter()" compact data-testid="image-lora-saved" />
    <button type="button" :disabled="disabled || !lora || inferenceLocation.editor.value.loras.length >= 8" @click="addLora()" data-testid="image-lora-add-saved" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageLoraControls__add_adapter() }}</button>
    <div v-for="(item, index) in inferenceLocation.editor.value.loras" :key="index" data-testid="image-lora-row" tw-class="flex flex-wrap items-center gap-3 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 shadow-sm">
      <label tw-class="min-h-10 cursor-pointer flex min-w-0 flex-1 items-center gap-2 text-sm">
        <input type="checkbox" role="switch" :checked="item.enabled === 'enabled'" :disabled="disabled" :aria-label="lazyStrings.ImageLoraControls__enabled()" @change="changeLora({ index, event: $event, field: 'enabled' })" data-testid="image-lora-enabled" tw-class="sr-only peer" />
        <span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />
        <span tw-class="break-all">{{ item.file.location.path }}</span>
      </label>
      <label tw-class="flex items-center gap-2 text-xs"><span>{{ lazyStrings.ImageLoraControls__strength() }}</span><input type="number" :value="item.strength" min="-10" max="10" step="0.05" required :disabled="disabled || item.enabled === 'disabled'" @input="changeLora({ index, event: $event, field: 'strength' })" data-testid="image-lora-strength" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 w-20 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-gray-800 dark:text-gray-100 shadow-sm disabled:opacity-40" /></label>
      <button type="button" :disabled="disabled" @click="inferenceLocation.removeLora({ index })" data-testid="image-lora-remove" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 text-xs font-bold rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 text-red-600 dark:text-red-400 hover:border-red-200 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors min-h-10 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageLoraControls__remove() }}</button>
    </div>
  </div>
</template>
