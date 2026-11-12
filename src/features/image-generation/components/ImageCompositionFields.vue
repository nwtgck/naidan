<script setup lang="ts">
import { computed, shallowRef, useId, watch } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import ImageNumberPreferenceMenu from './ImageNumberPreferenceMenu.vue';
import type { ImageModelParameterPreference } from '@/01-models/image-generation';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import { lazyStrings } from '@/strings';
import type { ImageGenerationInput } from '@/features/image-generation/composition/input';
import { samplerOptions, schedulerOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
const props = defineProps<{ input: ImageGenerationInput, disabled: boolean, shared: Record<string, unknown> }>();
const emit = defineEmits<{ update: [input: ImageGenerationInput] }>();
const id = useId();
type Field = { key: Exclude<keyof ImageGenerationInput, 'prompt'>, label: string | undefined, kind: 'text' | 'number' | 'boolean' | 'choice' | 'auto-number' | 'seed', options?: readonly { value: string, label: string | undefined }[], sharedLabel?: string | undefined, layout?: 'stacked' };
const fields = computed<Field[]>(() => [
  { key: 'negativePrompt', layout: 'stacked', label: lazyStrings.stableDiffusionCppBrowser__negative_prompt(), kind: 'text' },
  { key: 'uiModelConfigurationSlot', layout: 'stacked', label: lazyStrings.ImageCompositionFields__model_configuration_slot(), kind: 'text', sharedLabel: lazyStrings.imageComposition__inherit() },
  { key: 'count', label: lazyStrings.imageGeneration__images(), kind: 'number' },
  { key: 'width', label: lazyStrings.stableDiffusionCppBrowser__width(), kind: 'number' },
  { key: 'height', label: lazyStrings.stableDiffusionCppBrowser__height(), kind: 'number' },
  { key: 'steps', label: lazyStrings.stableDiffusionCppBrowser__steps(), kind: 'auto-number' },
  { key: 'guidance', label: lazyStrings.stableDiffusionCppBrowser__guidance(), kind: 'auto-number' },
  { key: 'seed', layout: 'stacked', label: lazyStrings.stableDiffusionCppBrowser__seed(), kind: 'seed', sharedLabel: props.shared.seed === null ? lazyStrings.imageComposition__random() : undefined },
  { key: 'sampler', label: lazyStrings.stableDiffusionCppBrowser__sampler(), kind: 'choice', options: samplerOptions.map(value => ({ value, label: value })) },
  { key: 'scheduler', label: lazyStrings.stableDiffusionCppBrowser__scheduler(), kind: 'choice', options: schedulerOptions.map(value => ({ value, label: value })) },
  { key: 'distilledGuidance', label: lazyStrings.stableDiffusionCppBrowser__distilled_guidance(), kind: 'number' },
  { key: 'vaeTiling', label: lazyStrings.stableDiffusionCppBrowser__vae_tiling(), kind: 'boolean' },
  { key: 'vaeTileSize', label: lazyStrings.stableDiffusionCppBrowser__vae_tile_size(), kind: 'auto-number' },
  { key: 'flashAttention', label: lazyStrings.stableDiffusionCppBrowser__flash_attention(), kind: 'boolean' },
  { key: 'bf16WeightType', label: lazyStrings.stableDiffusionCppBrowser__bf16_weight_storage(), kind: 'choice', options: [{ value: 'f32', label: 'F32' }, { value: 'f16', label: 'F16' }, { value: 'bf16', label: 'BF16' }], sharedLabel: typeof props.shared.bf16WeightType === 'string' ? props.shared.bf16WeightType.toUpperCase() : undefined },
  { key: 'qwenVaePolicy', label: lazyStrings.stableDiffusionCppBrowser__qwen_vae_bounded(), kind: 'choice', options: [{ value: 'bounded', label: 'bounded' }, { value: 'native', label: 'native' }] },
  { key: 'conditioningCacheSize', label: lazyStrings.stableDiffusionCppBrowser__conditioning_cache(), kind: 'number' },
  { key: 'modelArguments', layout: 'stacked', label: lazyStrings.stableDiffusionCppBrowser__model_arguments(), kind: 'text' },
]);

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
    case 'choice': case 'text': return field.options?.[0]?.value ?? '';
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

const preferenceField = shallowRef<Field>();
const preferenceTrigger = shallowRef<HTMLButtonElement>();
const seedModes = computed(() => [
  { value: 'random' as const, label: lazyStrings.ImageGenerationEditor__new_seed_each_time() },
  { value: 'fixed' as const, label: lazyStrings.ImageGenerationEditor__fixed_seed() },
]);

function dismissPreference(): void {
  preferenceField.value = undefined;
  preferenceTrigger.value = undefined;
}

function closePreference(): void {
  const trigger = preferenceTrigger.value;
  dismissPreference();
  trigger?.focus({ preventScroll: true });
}

watch(() => [props.input, props.disabled], dismissPreference, { flush: 'sync' });

function openPreference({ field, event }: { field: Field, event: Event }): void {
  if (props.disabled || props.input[field.key] === undefined || !(event.currentTarget instanceof HTMLButtonElement)) {
    return;
  }
  if (preferenceField.value?.key === field.key) {
    closePreference();
    return;
  }
  preferenceTrigger.value = event.currentTarget;
  preferenceField.value = field;
}

function numberPreference({ field }: { field: Field }): ImageModelParameterPreference {
  const value = props.input[field.key];
  return value === 'auto' ? 'auto' : typeof value === 'number' ? value : NaN;
}

function fixedNumber({ field }: { field: Field }): number {
  const value = props.input[field.key];
  // A slot may use a different model. Until this request is resolved, neither
  // the common model's number nor a made-up fallback is its automatic value.
  return typeof value === 'number' ? value : NaN;
}

function preferenceLabel({ field }: { field: Field }): string | undefined {
  const mode = props.input[field.key] === 'auto' ? lazyStrings.ImageModelNumberInput__automatic() : lazyStrings.ImageModelNumberInput__fixed();
  return field.label && mode ? `${field.label}: ${mode}` : undefined;
}

function selectPreference({ preference }: { preference: ImageModelParameterPreference }): void {
  const field = preferenceField.value;
  if (field) {
    change({ key: field.key, value: preference });
  }
}

function seedMode({ mode }: { mode: 'random' | 'fixed' }): void {
  switch (mode) {
  case 'random': change({ key: 'seed', value: null });
    break;
  case 'fixed': change({ key: 'seed', value: typeof props.input.seed === 'string' ? props.input.seed : '0' });
    break;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
}

function inheritanceLabel({ field }: { field: Field }): string | undefined {
  const label = lazyStrings.imageComposition__inherit();
  return field.label && label ? `${field.label}: ${label}` : label;
}

function sharedValue({ field }: { field: Field }): string | undefined {
  const value = props.shared[field.key];
  return field.sharedLabel ?? (value === 'auto' ? lazyStrings.imageComposition__auto() : String(value ?? '—'));
}

function qwenVaePolicy({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) {
    change({ key: 'qwenVaePolicy', value: event.target.checked ? 'bounded' : 'native' });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="divide-y divide-gray-100 dark:divide-gray-800">
    <div v-for="field in fields" :key="field.key" :tw-class="['grid min-w-0 items-center gap-x-2 gap-y-1 py-2 first:pt-0 last:pb-0', field.kind === 'boolean' || field.key === 'qwenVaePolicy' ? 'grid-cols-[minmax(0,1fr)_auto_auto]' : 'grid-cols-[minmax(0,1fr)_minmax(6.5rem,1fr)_auto]']" :data-testid="'composition-field-' + field.key">
      <label :for="id + field.key" :title="field.key" :tw-class="['min-w-0 text-xs font-medium leading-5 text-gray-700 dark:text-gray-300 [overflow-wrap:anywhere]', field.layout === 'stacked' && input[field.key] !== undefined && 'col-span-2']">{{ field.label }}</label>
      <label :title="lazyStrings.imageComposition__inherit()" tw-class="col-start-3 row-start-1 inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg text-xs text-gray-500 dark:text-gray-400 has-disabled:cursor-not-allowed">
        <SettingsChoiceControl presentation="checkbox"><input type="checkbox" :aria-label="inheritanceLabel({ field })" :disabled="disabled" :checked="input[field.key] === undefined" @change="inherit({ field, event: $event })" /></SettingsChoiceControl>
        <span>{{ lazyStrings.ImageCompositionFields__shared() }}</span>
      </label>
      <div v-if="input[field.key] === undefined" tw-class="col-start-2 row-start-1 min-w-0 text-xs leading-5 text-gray-500 dark:text-gray-400">
        <SettingsChoiceControl v-if="field.kind === 'boolean' || field.key === 'qwenVaePolicy'" presentation="switch"><input :id="id + field.key" type="checkbox" role="switch" disabled :checked="field.key === 'qwenVaePolicy' ? shared[field.key] === 'bounded' : shared[field.key] === true" /></SettingsChoiceControl>
        <p v-else :title="sharedValue({ field })" tw-class="truncate">{{ sharedValue({ field }) }}</p>
      </div>
      <div v-else :tw-class="['min-w-0', field.layout === 'stacked' ? 'col-span-3' : 'col-start-2 row-start-1']">
        <textarea v-if="field.key === 'negativePrompt' || field.key === 'modelArguments'" :id="id + field.key" :value="String(input[field.key] ?? '')" :disabled="disabled" rows="2" @input="edit({ field, event: $event })" tw-class="block w-full resize-y rounded-lg border border-gray-200/80 bg-gray-50/60 px-2.5 py-1.5 text-sm leading-6 text-gray-800 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700/60 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:border-blue-500/35" />
        <input v-else-if="field.kind === 'text'" :id="id + field.key" :value="String(input[field.key] ?? '')" :disabled="disabled" type="text" @input="edit({ field, event: $event })" tw-class="block w-full rounded-lg border border-gray-200/80 bg-gray-50/60 px-2.5 py-1.5 text-sm text-gray-800 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700/60 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:border-blue-500/35" />
        <div v-else-if="field.kind === 'auto-number'" tw-class="flex min-h-8 items-center rounded-lg border border-gray-200/80 bg-gray-50/60 pr-1 transition-colors hover:border-blue-200/80 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/60 dark:bg-gray-800/40 dark:hover:border-blue-500/35">
          <input :id="id + field.key" :value="input[field.key] === 'auto' ? '' : input[field.key]" :placeholder="input[field.key] === 'auto' ? lazyStrings.imageComposition__auto() : undefined" :disabled="disabled" type="number" step="any" @input="edit({ field, event: $event })" tw-class="block min-w-0 w-full border-0 bg-transparent px-2 py-1 text-sm tabular-nums text-gray-800 outline-none placeholder:text-gray-400 disabled:opacity-50 dark:text-gray-300" />
          <button type="button" :disabled="disabled" :aria-label="preferenceLabel({ field })" :aria-expanded="preferenceField?.key === field.key" :aria-controls="id + '-number-preference'" aria-haspopup="menu" :data-testid="'composition-' + field.key + '-preference'" @click="openPreference({ field, event: $event })" @keydown.down.stop.prevent="openPreference({ field, event: $event })" @keydown.up.stop.prevent="openPreference({ field, event: $event })" tw-class="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200">
            {{ input[field.key] === 'auto' ? lazyStrings.ImageModelNumberInput__automatic() : lazyStrings.ImageModelNumberInput__fixed() }}<ChevronDownIcon aria-hidden="true" tw-class="h-3 w-3" />
          </button>
        </div>
        <div v-else-if="field.kind === 'seed'" tw-class="flex min-w-0 items-center gap-2">
          <input :id="id + field.key" :value="input.seed === null ? '' : input.seed" :readonly="input.seed === null" :placeholder="input.seed === null ? lazyStrings.imageComposition__random() : undefined" :disabled="disabled" type="text" inputmode="numeric" @input="edit({ field, event: $event })" tw-class="block min-w-0 flex-1 rounded-lg border border-gray-200/80 bg-gray-50/60 px-2.5 py-1.5 font-mono text-sm text-gray-800 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 read-only:text-gray-400 disabled:opacity-50 dark:border-gray-700/60 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:border-blue-500/35" />
          <SettingsFormSelect :model-value="input.seed === null ? 'random' : 'fixed'" :options="seedModes" :label="field.label" :disabled="disabled" presentation="inline" data-testid="composition-seed-mode" @update:model-value="seedMode({ mode: $event })" />
        </div>
        <SettingsChoiceControl v-else-if="field.key === 'qwenVaePolicy'" presentation="switch"><input :id="id + field.key" type="checkbox" role="switch" :checked="input[field.key] === 'bounded'" :disabled="disabled" @change="qwenVaePolicy({ event: $event })" /></SettingsChoiceControl>
        <SettingsFormSelect v-else-if="field.kind === 'choice'" :id="id + field.key" :model-value="String(input[field.key] ?? '')" :options="field.options ?? []" :label="field.label" :disabled="disabled" presentation="inline" @update:model-value="change({ key: field.key, value: $event })" />
        <SettingsChoiceControl v-else-if="field.kind === 'boolean'" presentation="switch"><input :id="id + field.key" type="checkbox" role="switch" :checked="input[field.key] === true" :disabled="disabled" @change="edit({ field, event: $event })" /></SettingsChoiceControl>
        <input v-else :id="id + field.key" type="number" step="any" :value="input[field.key]" :disabled="disabled" @input="edit({ field, event: $event })" tw-class="block min-h-8 w-full rounded-lg border border-gray-200/80 bg-gray-50/60 px-2.5 py-1 text-sm tabular-nums text-gray-800 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700/60 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:border-blue-500/35" />
      </div>
    </div>
    <ImageNumberPreferenceMenu v-if="preferenceField && preferenceTrigger" :id="id + '-number-preference'" :open="true" :trigger="preferenceTrigger" :label="preferenceLabel({ field: preferenceField })" :preference="numberPreference({ field: preferenceField })" :value="fixedNumber({ field: preferenceField })" :disabled="disabled" :automatic-label="lazyStrings.ImageModelNumberInput__automatic()" :fixed-label="lazyStrings.ImageModelNumberInput__fixed()" :automatic-test-id="'composition-' + preferenceField.key + '-automatic'" :fixed-test-id="'composition-' + preferenceField.key + '-fixed'" @select="selectPreference({ preference: $event })" @close="closePreference" @dismiss="dismissPreference" />
  </div>
</template>
