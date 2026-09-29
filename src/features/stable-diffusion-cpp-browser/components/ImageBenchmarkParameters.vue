<script setup lang="ts">
import { useId } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { samplerOptions, schedulerOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
import type { Parameters } from '@/features/stable-diffusion-cpp-browser/types';
import type { ParameterChange } from '@/features/stable-diffusion-cpp-browser/benchmark/types';
const props = defineProps<{ values: Parameters, overrides: Partial<Parameters> | undefined }>();
const emit = defineEmits<{ change: [change: ParameterChange], inherit: [key: keyof Parameters] }>();
const id = useId();
function text({ event }: { event: Event }): string {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement ? event.target.value : '';
}
function numeric({ event }: { event: Event }): number {
  const value = text({ event }); return value.trim() ? Number(value) : NaN;
}
function checked({ event }: { event: Event }): boolean {
  return event.target instanceof HTMLInputElement && event.target.checked;
}
function resolution({ edge }: { edge: number }): void {
  // A preset deliberately overrides both dimensions for a model, even when its
  // size was inherited. Other shared settings continue to be inherited.
  emit('change', { key: 'width', value: edge });
  emit('change', { key: 'height', value: edge });
}
function sampler({ event }: { event: Event }): void {
  const value = samplerOptions.find(option => option === text({ event })); if (value !== undefined) emit('change', { key: 'sampler', value });
}
function scheduler({ event }: { event: Event }): void {
  const value = schedulerOptions.find(option => option === text({ event })); if (value !== undefined) emit('change', { key: 'scheduler', value });
}
function bf16WeightType({ event }: { event: Event }): void {
  const value = text({ event });
  if (value === 'f32' || value === 'f16') emit('change', { key: 'bf16WeightType', value });
}
function setOverride({ key, event }: { key: keyof Parameters, event: Event }): void {
  if (!checked({ event })) emit('inherit', key);
  else {
    // Existing typed property values are only paired with their own key.
    switch (key) {
    case 'prompt': emit('change', { key, value: props.values.prompt }); break;
    case 'negativePrompt': emit('change', { key, value: props.values.negativePrompt }); break;
    case 'width': emit('change', { key, value: props.values.width }); break;
    case 'height': emit('change', { key, value: props.values.height }); break;
    case 'steps': emit('change', { key, value: props.values.steps }); break;
    case 'guidance': emit('change', { key, value: props.values.guidance }); break;
    case 'seed': emit('change', { key, value: props.values.seed }); break;
    case 'sampler': emit('change', { key, value: props.values.sampler }); break;
    case 'scheduler': emit('change', { key, value: props.values.scheduler }); break;
    case 'distilledGuidance': emit('change', { key, value: props.values.distilledGuidance }); break;
    case 'conditioningCacheSize': emit('change', { key, value: props.values.conditioningCacheSize }); break;
    case 'vaeTiling': emit('change', { key, value: props.values.vaeTiling }); break;
    case 'vaeTileSize': emit('change', { key, value: props.values.vaeTileSize }); break;
    case 'flashAttention': emit('change', { key, value: props.values.flashAttention }); break;
    case 'bf16WeightType': emit('change', { key, value: props.values.bf16WeightType }); break;
    case 'qwenVaePolicy': emit('change', { key, value: props.values.qwenVaePolicy }); break;
    case 'modelArguments': emit('change', { key, value: props.values.modelArguments }); break;
    default: { const exhaustive: never = key; throw new Error(String(exhaustive)); }
    }
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-4" data-testid="benchmark-parameters">
    <div tw-class="space-y-1" data-parameter="prompt">
      <label :id="id + '-label-prompt'" :for="id + '-prompt'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__prompt() }}</label>
      <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'prompt')" :aria-describedby="id + '-label-prompt'" @change="setOverride({ key: 'prompt', event: $event })" :data-testid="'override-prompt'" />{{ lazyStrings.imageBenchmark__override() }}</label>
      <textarea :id="id + '-prompt'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'prompt')" :data-testid="'parameter-prompt'" :value="props.values.prompt" @input="emit('change', { key: 'prompt', value: text({ event: $event }) })" rows="2" maxlength="4096" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
    </div>
    <div tw-class="space-y-1" data-parameter="negativePrompt">
      <label :id="id + '-label-negativePrompt'" :for="id + '-negativePrompt'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__negative_prompt() }}</label>
      <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'negativePrompt')" :aria-describedby="id + '-label-negativePrompt'" @change="setOverride({ key: 'negativePrompt', event: $event })" :data-testid="'override-negativePrompt'" />{{ lazyStrings.imageBenchmark__override() }}</label>
      <textarea :id="id + '-negativePrompt'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'negativePrompt')" :data-testid="'parameter-negativePrompt'" :value="props.values.negativePrompt" @input="emit('change', { key: 'negativePrompt', value: text({ event: $event }) })" rows="2" maxlength="4096" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
    </div>
    <div role="group" :aria-labelledby="id + '-label-width ' + id + '-label-height'" data-testid="benchmark-resolution-presets" tw-class="flex flex-wrap gap-2">
      <button v-for="edge in [256, 512, 768, 1024]" :key="edge" type="button" :aria-pressed="props.values.width === edge && props.values.height === edge" :data-testid="'benchmark-resolution-' + edge" @click="resolution({ edge })" :tw-class="['rounded-xl border px-3 py-2 text-xs font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed', props.values.width === edge && props.values.height === edge ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700']">{{ edge }} × {{ edge }}</button>
    </div>
    <div tw-class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <div tw-class="space-y-1" data-parameter="width">
        <label :id="id + '-label-width'" :for="id + '-width'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__width() }}</label>
        <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'width')" :aria-describedby="id + '-label-width'" @change="setOverride({ key: 'width', event: $event })" :data-testid="'override-width'" />{{ lazyStrings.imageBenchmark__override() }}</label>
        <input :id="id + '-width'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'width')" :data-testid="'parameter-width'" :value="props.values.width" type="number" min="128" max="2048" step="64" @input="emit('change', { key: 'width', value: numeric({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
      </div>
      <div tw-class="space-y-1" data-parameter="height">
        <label :id="id + '-label-height'" :for="id + '-height'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__height() }}</label>
        <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'height')" :aria-describedby="id + '-label-height'" @change="setOverride({ key: 'height', event: $event })" :data-testid="'override-height'" />{{ lazyStrings.imageBenchmark__override() }}</label>
        <input :id="id + '-height'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'height')" :data-testid="'parameter-height'" :value="props.values.height" type="number" min="128" max="2048" step="64" @input="emit('change', { key: 'height', value: numeric({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
      </div>
      <div tw-class="space-y-1" data-parameter="steps">
        <label :id="id + '-label-steps'" :for="id + '-steps'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__steps() }}</label>
        <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'steps')" :aria-describedby="id + '-label-steps'" @change="setOverride({ key: 'steps', event: $event })" :data-testid="'override-steps'" />{{ lazyStrings.imageBenchmark__override() }}</label>
        <input :id="id + '-steps'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'steps')" :data-testid="'parameter-steps'" :value="props.values.steps" type="number" min="1" max="100" step="1" @input="emit('change', { key: 'steps', value: numeric({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
      </div>
      <div tw-class="space-y-1" data-parameter="guidance">
        <label :id="id + '-label-guidance'" :for="id + '-guidance'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__guidance() }}</label>
        <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'guidance')" :aria-describedby="id + '-label-guidance'" @change="setOverride({ key: 'guidance', event: $event })" :data-testid="'override-guidance'" />{{ lazyStrings.imageBenchmark__override() }}</label>
        <input :id="id + '-guidance'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'guidance')" :data-testid="'parameter-guidance'" :value="props.values.guidance" type="number" min="0" max="30" step="0.1" @input="emit('change', { key: 'guidance', value: numeric({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
      </div>
      <div tw-class="space-y-1" data-parameter="seed">
        <label :id="id + '-label-seed'" :for="id + '-seed'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__seed() }}</label>
        <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'seed')" :aria-describedby="id + '-label-seed'" @change="setOverride({ key: 'seed', event: $event })" :data-testid="'override-seed'" />{{ lazyStrings.imageBenchmark__override() }}</label>
        <input :id="id + '-seed'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'seed')" :data-testid="'parameter-seed'" :value="props.values.seed" type="text" maxlength="20" @input="emit('change', { key: 'seed', value: text({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
      </div>
    </div>
    <details tw-class="group rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20">
      <summary tw-class="flex min-h-12 items-center justify-between gap-2 rounded-2xl px-4 py-3 text-sm font-bold text-gray-800 dark:text-gray-100 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-gray-100/50 dark:hover:bg-gray-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">{{ lazyStrings.stableDiffusionCppBrowser__runtime_settings() }}<ChevronDownIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180" /></summary>
      <div tw-class="grid sm:grid-cols-2 gap-3 border-t border-gray-100 dark:border-gray-800 p-4">
        <div tw-class="space-y-1" data-parameter="bf16WeightType">
          <label :id="id + '-label-bf16WeightType'" :for="id + '-bf16WeightType'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'bf16WeightType')" :aria-describedby="id + '-label-bf16WeightType'" @change="setOverride({ key: 'bf16WeightType', event: $event })" data-testid="override-bf16WeightType" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <select :id="id + '-bf16WeightType'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'bf16WeightType')" data-testid="parameter-bf16WeightType" :value="props.values.bf16WeightType" @change="bf16WeightType({ event: $event })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed"><option value="f32">F32</option><option value="f16">F16</option></select>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion_help() }}</p>
        </div>
        <div tw-class="space-y-1" data-parameter="sampler">
          <label :id="id + '-label-sampler'" :for="id + '-sampler'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__sampler() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'sampler')" :aria-describedby="id + '-label-sampler'" @change="setOverride({ key: 'sampler', event: $event })" :data-testid="'override-sampler'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <select :id="id + '-sampler'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'sampler')" :data-testid="'parameter-sampler'" :value="props.values.sampler" @change="sampler({ event: $event })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed"><option v-for="value in samplerOptions" :key="value" :value="value">{{ value }}</option></select>
        </div>
        <div tw-class="space-y-1" data-parameter="scheduler">
          <label :id="id + '-label-scheduler'" :for="id + '-scheduler'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__scheduler() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'scheduler')" :aria-describedby="id + '-label-scheduler'" @change="setOverride({ key: 'scheduler', event: $event })" :data-testid="'override-scheduler'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <select :id="id + '-scheduler'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'scheduler')" :data-testid="'parameter-scheduler'" :value="props.values.scheduler" @change="scheduler({ event: $event })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed"><option v-for="value in schedulerOptions" :key="value" :value="value">{{ value }}</option></select>
        </div>
        <div tw-class="space-y-1" data-parameter="distilledGuidance">
          <label :id="id + '-label-distilledGuidance'" :for="id + '-distilledGuidance'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__distilled_guidance() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'distilledGuidance')" :aria-describedby="id + '-label-distilledGuidance'" @change="setOverride({ key: 'distilledGuidance', event: $event })" :data-testid="'override-distilledGuidance'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <input :id="id + '-distilledGuidance'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'distilledGuidance')" :data-testid="'parameter-distilledGuidance'" :value="props.values.distilledGuidance" type="number" min="0" max="30" step="0.1" @input="emit('change', { key: 'distilledGuidance', value: numeric({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
        <div tw-class="space-y-1" data-parameter="conditioningCacheSize">
          <label :id="id + '-label-conditioningCacheSize'" :for="id + '-conditioningCacheSize'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__conditioning_cache() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'conditioningCacheSize')" :aria-describedby="id + '-label-conditioningCacheSize'" @change="setOverride({ key: 'conditioningCacheSize', event: $event })" :data-testid="'override-conditioningCacheSize'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <input :id="id + '-conditioningCacheSize'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'conditioningCacheSize')" :data-testid="'parameter-conditioningCacheSize'" :value="props.values.conditioningCacheSize" type="number" min="0" max="32" step="1" @input="emit('change', { key: 'conditioningCacheSize', value: numeric({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
        <div tw-class="space-y-1" data-parameter="vaeTiling">
          <label :id="id + '-label-vaeTiling'" :for="id + '-vaeTiling'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__vae_tiling() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'vaeTiling')" :aria-describedby="id + '-label-vaeTiling'" @change="setOverride({ key: 'vaeTiling', event: $event })" :data-testid="'override-vaeTiling'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <input :id="id + '-vaeTiling'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'vaeTiling')" :data-testid="'parameter-vaeTiling'" type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="props.values.vaeTiling" @change="emit('change', { key: 'vaeTiling', value: checked({ event: $event }) })" />
        </div>
        <div tw-class="space-y-1" data-parameter="vaeTileSize">
          <label :id="id + '-label-vaeTileSize'" :for="id + '-vaeTileSize'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__vae_tile_size() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'vaeTileSize')" :aria-describedby="id + '-label-vaeTileSize'" @change="setOverride({ key: 'vaeTileSize', event: $event })" :data-testid="'override-vaeTileSize'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <input :id="id + '-vaeTileSize'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'vaeTileSize')" :data-testid="'parameter-vaeTileSize'" :value="props.values.vaeTileSize" type="number" min="16" max="256" step="8" @input="emit('change', { key: 'vaeTileSize', value: numeric({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
        <div tw-class="space-y-1" data-parameter="flashAttention">
          <label :id="id + '-label-flashAttention'" :for="id + '-flashAttention'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__flash_attention() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'flashAttention')" :aria-describedby="id + '-label-flashAttention'" @change="setOverride({ key: 'flashAttention', event: $event })" :data-testid="'override-flashAttention'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <input :id="id + '-flashAttention'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'flashAttention')" :data-testid="'parameter-flashAttention'" type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="props.values.flashAttention" @change="emit('change', { key: 'flashAttention', value: checked({ event: $event }) })" />
        </div>
        <div tw-class="space-y-1" data-parameter="qwenVaePolicy">
          <label :id="id + '-label-qwenVaePolicy'" :for="id + '-qwenVaePolicy'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__qwen_vae_bounded() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'qwenVaePolicy')" :aria-describedby="id + '-label-qwenVaePolicy'" @change="setOverride({ key: 'qwenVaePolicy', event: $event })" :data-testid="'override-qwenVaePolicy'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <input :id="id + '-qwenVaePolicy'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'qwenVaePolicy')" :data-testid="'parameter-qwenVaePolicy'" type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="props.values.qwenVaePolicy === 'bounded'" @change="emit('change', { key: 'qwenVaePolicy', value: checked({ event: $event }) ? 'bounded' : 'native' })" />
        </div>
        <div tw-class="space-y-1" data-parameter="modelArguments">
          <label :id="id + '-label-modelArguments'" :for="id + '-modelArguments'" tw-class="block text-sm">{{ lazyStrings.stableDiffusionCppBrowser__model_arguments() }}</label>
          <label v-if="props.overrides !== undefined" tw-class="inline-flex gap-2 items-center text-xs text-gray-500"><input type="checkbox" tw-class="h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :checked="Object.hasOwn(props.overrides, 'modelArguments')" :aria-describedby="id + '-label-modelArguments'" @change="setOverride({ key: 'modelArguments', event: $event })" :data-testid="'override-modelArguments'" />{{ lazyStrings.imageBenchmark__override() }}</label>
          <input :id="id + '-modelArguments'" :disabled="props.overrides !== undefined && !Object.hasOwn(props.overrides, 'modelArguments')" :data-testid="'parameter-modelArguments'" :value="props.values.modelArguments" type="text" maxlength="4096" @input="emit('change', { key: 'modelArguments', value: text({ event: $event }) })" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-sm text-gray-800 dark:text-gray-100 shadow-sm focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
      </div>
    </details>
  </div>
</template>
