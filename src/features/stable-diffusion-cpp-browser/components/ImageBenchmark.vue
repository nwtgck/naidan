<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed } from 'vue';
import ImageBenchmarkParameters from './ImageBenchmarkParameters.vue';
import ImageBenchmarkResult from './ImageBenchmarkResult.vue';
import ImageModelPicker from './ImageModelPicker.vue';
import ImageLoraControls from './ImageLoraControls.vue';
import { componentLabel } from '@/features/stable-diffusion-cpp-browser/component-label';
import { profileOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
import type { ImageBenchmarkView } from '@/features/stable-diffusion-cpp-browser/benchmark-view';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import type { BenchmarkRunRecord } from '@/features/stable-diffusion-cpp-browser/benchmark/types';
const props = defineProps<{ bench: ImageBenchmarkView, generation: ImageGenerationView }>();
// The view owns these refs; controls edit the handed-out form state, not a prop snapshot.
const { strategy, protocol, preview, notes, includePrompts } = props.bench;
const { profile, weightResidency, gpuBudgetMiB } = props.generation;
const locked = computed(() => props.bench.busy.value || props.bench.exporting.value || props.bench.runs.value.length > 0 || props.generation.busy.value || !props.bench.available.value);
const weightOptions = computed(() => [
  { value: 'auto', label: lazyStrings.stableDiffusionCppBrowser__weight_residency_auto() },
  { value: 'cpu', label: lazyStrings.stableDiffusionCppBrowser__weight_residency_cpu() },
  { value: 'hybrid', label: lazyStrings.stableDiffusionCppBrowser__weight_residency_hybrid() },
  { value: 'disk', label: lazyStrings.stableDiffusionCppBrowser__weight_residency_disk() },
]);
function checked({ event }: { event: Event }): boolean {
  return event.target instanceof HTMLInputElement && event.target.checked;
}
function time({ value }: { value: unknown }): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : '—';
}
function status({ record }: { record: BenchmarkRunRecord }): string | undefined {
  switch (record.status) {
  case 'queued': return lazyStrings.imageBenchmark__queued();
  case 'running': return lazyStrings.imageBenchmark__running();
  case 'succeeded': return lazyStrings.imageBenchmark__succeeded();
  case 'failed': return lazyStrings.imageBenchmark__failed();
  case 'cancelled': return lazyStrings.imageBenchmark__cancelled();
  case 'skipped': return lazyStrings.imageBenchmark__skipped();
  default: { const exhaustive: never = record.status; throw new Error(String(exhaustive)); }
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="image-benchmark">
    <p tw-class="text-sm text-gray-600 dark:text-gray-300">{{ lazyStrings.imageBenchmark__introduction() }}</p>
    <fieldset :disabled="locked" tw-class="space-y-5">
      <div tw-class="grid xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5 items-start">
        <section tw-class="rounded-2xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <h2 tw-class="font-semibold">{{ lazyStrings.imageBenchmark__shared_settings() }}</h2>
          <ImageBenchmarkParameters :values="bench.common.value" :overrides="undefined" @change="bench.setCommon({ change: $event })" />
          <label tw-class="flex items-start gap-2 text-sm"><input v-model="strategy" type="checkbox" true-value="model-defaults" false-value="shared" data-testid="benchmark-model-defaults" />{{ lazyStrings.imageBenchmark__model_sampling_defaults() }}</label>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageBenchmark__defaults_help() }}</p>
        </section>
        <section tw-class="rounded-2xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <h2 tw-class="font-semibold">{{ lazyStrings.imageBenchmark__protocol() }}</h2>
          <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__protocol() }}</span><select v-model="protocol.mode" data-testid="benchmark-mode" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option value="cold-warm">{{ lazyStrings.imageBenchmark__cold_then_warm() }}</option><option value="fresh-each">{{ lazyStrings.imageBenchmark__fresh_each() }}</option></select></label>
          <div tw-class="grid grid-cols-2 gap-3 items-end">
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__runs_per_model() }}</span><input v-model.number="protocol.repeats" data-testid="benchmark-repeats" type="number" min="1" max="10" step="1" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__order() }}</span><select v-model="protocol.order" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option value="listed">{{ lazyStrings.imageBenchmark__listed_order() }}</option><option value="reverse">{{ lazyStrings.imageBenchmark__reverse_order() }}</option></select></label>
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__cooldown() }}</span><input v-model.number="protocol.cooldownSeconds" type="number" min="0" max="60" step="1" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__timeout() }}</span><input v-model.number="protocol.timeoutSeconds" type="number" min="0" max="7200" step="1" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
          </div>
          <label tw-class="text-sm block space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__profile() }}</span><select v-model="profile" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option v-for="value in profileOptions" :value="value" :key="value">{{ value }}</option></select></label>
          <div tw-class="grid grid-cols-2 gap-3 items-end">
            <label tw-class="text-sm block space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__weight_residency() }}</span><select v-model="weightResidency" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option v-for="option in weightOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
            <label tw-class="text-sm block space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget() }}</span><input v-model.number="gpuBudgetMiB" type="number" min="512" step="1" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
          </div>
          <label tw-class="inline-flex gap-2 items-center text-sm"><input v-model="protocol.keepImages" type="checkbox" data-testid="benchmark-keep-images" />{{ lazyStrings.imageBenchmark__keep_images() }}</label>
          <details tw-class="space-y-3">
            <summary tw-class="text-sm font-medium cursor-pointer">{{ lazyStrings.stableDiffusionCppBrowser__preview_title() }}</summary>
            <label tw-class="inline-flex gap-2 items-center text-sm"><input v-model="preview.enabled" type="checkbox" />{{ lazyStrings.stableDiffusionCppBrowser__preview_enabled() }}</label>
            <div tw-class="grid grid-cols-2 gap-3 text-sm">
              <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_mode() }}</span><select v-model="preview.mode" tw-class="block w-full border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent p-2"><option value="vae">{{ lazyStrings.stableDiffusionCppBrowser__preview_vae() }}</option><option value="projection">{{ lazyStrings.stableDiffusionCppBrowser__preview_projection() }}</option></select></label>
              <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_interval() }}</span><input v-model.number="preview.interval" type="number" min="1" max="100" tw-class="block w-full border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent p-2" /></label>
              <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_start_step() }}</span><input v-model.number="preview.startStep" type="number" min="1" max="100" tw-class="block w-full border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent p-2" /></label>
              <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_max_edge() }}</span><select v-model.number="preview.maxEdge" tw-class="block w-full border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent p-2"><option v-for="edge in [128, 256, 512, 0]" :key="edge" :value="edge">{{ edge || lazyStrings.stableDiffusionCppBrowser__preview_original() }}</option></select></label>
            </div>
          </details>
          <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__environment_notes() }}</span><textarea v-model="notes" rows="2" maxlength="2048" tw-class="block w-full border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent p-2" /></label>
          <details tw-class="text-xs space-y-2 text-gray-500 dark:text-gray-400"><summary tw-class="cursor-pointer">{{ lazyStrings.imageBenchmark__protocol() }}</summary><p>{{ lazyStrings.imageBenchmark__fairness() }}</p><p>{{ lazyStrings.imageBenchmark__limits() }}</p><p>{{ lazyStrings.stableDiffusionCppBrowser__debug_help() }}</p></details>
        </section>
      </div>
      <section tw-class="space-y-3">
        <div tw-class="flex flex-wrap justify-between items-center gap-3"><h2 tw-class="font-semibold">{{ lazyStrings.imageBenchmark__available_models() }} · {{ bench.selected.value.length }} / {{ bench.targets.value.length }}</h2><div tw-class="flex flex-wrap gap-x-4 gap-y-2 text-sm"><button type="button" @click="bench.select({ mode: 'all' })" data-testid="benchmark-select-all" tw-class="underline">{{ lazyStrings.imageBenchmark__select_all() }}</button><button type="button" @click="bench.select({ mode: 'none' })" data-testid="benchmark-select-none" tw-class="underline">{{ lazyStrings.imageBenchmark__select_none() }}</button><button type="button" @click="generation.library.refresh()" tw-class="underline">{{ lazyStrings.stableDiffusionCppBrowser__refresh_repositories() }}</button></div></div>
        <p v-if="!bench.targets.value.length" tw-class="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-5 text-sm text-gray-500">{{ lazyStrings.imageBenchmark__no_models() }}</p>
        <article v-for="target in bench.targets.value" :key="target.id" data-testid="benchmark-target" tw-class="rounded-2xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
          <label tw-class="flex gap-3 items-start"><input type="checkbox" :checked="bench.selected.value.includes(target.id)" :disabled="!target.models && !bench.selected.value.includes(target.id)" @change="bench.toggle({ id: target.id, selected: checked({ event: $event }) })" data-testid="benchmark-target-selected" /><span tw-class="min-w-0"><strong tw-class="block text-sm break-all">{{ target.label }}</strong><span tw-class="text-xs text-gray-500 dark:text-gray-400 break-all">{{ target.detail }}</span></span></label>
          <div v-if="target.components.length" tw-class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            <ImageModelPicker v-for="component in target.components" :key="component.slot" :model-value="component.selected" :choices="component.choices" :required="component.required" :label="componentLabel({ slot: component.slot })" :disabled="locked" @update:model-value="bench.chooseComponent({ targetId: target.id, slot: component.slot, id: $event })" :data-testid="'benchmark-component-' + component.slot" />
          </div>
          <p v-if="!target.models" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.imageBenchmark__unavailable_components() }}: {{ target.missing.join(', ') }} {{ target.issue }}</p>
          <ImageLoraControls :model-value="bench.loras.value[target.id] ?? []" :disabled="locked || !generation.supported.value" @update:model-value="bench.chooseLoras({ targetId: target.id, selections: $event })" />
          <details tw-class="space-y-3"><summary tw-class="text-xs cursor-pointer text-purple-600 dark:text-purple-400">{{ lazyStrings.imageBenchmark__overrides() }}</summary><ImageBenchmarkParameters :values="bench.effective({ target })" :overrides="bench.overrides.value[target.id] ?? {}" @change="bench.change({ id: target.id, change: $event })" @inherit="bench.inherit({ id: target.id, key: $event })" /></details>
          <details><summary tw-class="text-xs cursor-pointer text-gray-500">{{ lazyStrings.imageBenchmark__effective_request() }}</summary><pre tw-class="text-xs whitespace-pre-wrap break-all max-h-60 overflow-auto mt-2">{{ JSON.stringify({ parameters: bench.effective({ target }), components: target.models?.map(m => ({ slot: m.slot, path: m.path ?? m.file.name, bytes: m.file.size })), composition: target.composition, evidence: target.facts.evidence }, undefined, 2) }}</pre></details>
        </article>
      </section>
    </fieldset>
    <div tw-class="flex flex-wrap gap-3 items-center">
      <button type="button" :disabled="!bench.canStart.value" @click="bench.start()" data-testid="benchmark-start" tw-class="rounded-lg bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 text-sm font-medium disabled:opacity-40">{{ lazyStrings.imageBenchmark__start() }} · {{ bench.plannedRuns.value }}</button>
      <button type="button" :disabled="!bench.busy.value" @click="bench.stop()" data-testid="benchmark-stop" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-2.5 text-sm disabled:opacity-40">{{ lazyStrings.imageBenchmark__stop() }}</button>
      <label tw-class="inline-flex gap-2 items-center text-xs text-gray-500 dark:text-gray-400"><input type="checkbox" checked disabled />{{ lazyStrings.stableDiffusionCppBrowser__debug_mode() }}</label>
      <span v-if="bench.busy.value" role="status" data-testid="benchmark-progress" tw-class="text-sm">{{ lazyStrings.imageBenchmark__running() }} · {{ bench.current.value }} <template v-if="bench.progress.value"> · {{ bench.progress.value.phase }} {{ bench.progress.value.step }} / {{ bench.progress.value.steps }}</template></span>
    </div>
    <p v-if="!bench.canStart.value && !bench.busy.value" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageBenchmark__check_plan() }}</p>
    <p v-if="bench.error.value" role="alert" tw-class="text-xs whitespace-pre-wrap break-words text-red-600 dark:text-red-400">{{ bench.error.value }}</p>
    <section tw-class="space-y-3">
      <h2 tw-class="font-semibold">{{ lazyStrings.imageBenchmark__results() }}</h2>
      <div tw-class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <table tw-class="w-full text-sm text-left"><thead tw-class="bg-gray-50 dark:bg-gray-800"><tr><th tw-class="p-3">{{ lazyStrings.imageBenchmark__run() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__protocol() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__results() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__elapsed() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__sampling() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__model_load() }}</th></tr></thead>
          <tbody><tr v-for="run in bench.runs.value" :key="run.record.id" data-testid="benchmark-run" tw-class="border-t border-gray-100 dark:border-gray-800"><td tw-class="p-3"><span tw-class="block text-xs">{{ bench.plan.value?.models[run.record.modelIndex]?.target.label }}</span>{{ run.record.id }}<ImageBenchmarkResult :run-id="run.record.id" :png="run.png" :image-status="run.record.image.status" /></td><td tw-class="p-3 text-xs">{{ run.record.plannedKind === 'cold' ? lazyStrings.imageBenchmark__cold() : lazyStrings.imageBenchmark__warm() }}</td><td tw-class="p-3">{{ status({ record: run.record }) }}<p v-if="run.record.error" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ run.record.error }}</p><p v-if="run.record.uniformOutput" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__uniform_image_warning() }}</p><p v-if="run.record.metrics.reuse && run.record.metrics.reuse.reusedWorker !== (run.record.plannedKind === 'warm')" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.imageBenchmark__freshness_warning() }}</p></td><td tw-class="p-3 whitespace-nowrap">{{ time({ value: run.record.elapsedMs }) }}</td><td tw-class="p-3 whitespace-nowrap">{{ time({ value: run.record.metrics.runWall?.sampling }) }}</td><td tw-class="p-3 whitespace-nowrap">{{ time({ value: run.record.metrics.runWall?.['model-load'] }) }}</td></tr></tbody>
        </table>
      </div>
      <div tw-class="flex flex-wrap gap-3 items-center"><button type="button" :disabled="bench.busy.value || bench.exporting.value || !bench.runs.value.length" @click="bench.download()" data-testid="benchmark-download" tw-class="rounded-xl border border-purple-300 dark:border-purple-800 px-4 py-2 text-sm disabled:opacity-40">{{ bench.exporting.value ? lazyStrings.imageBenchmark__exporting() : lazyStrings.imageBenchmark__download_zip() }}</button><button type="button" :disabled="bench.busy.value || bench.exporting.value || !bench.runs.value.length" @click="bench.clear()" data-testid="benchmark-clear" tw-class="text-sm underline disabled:opacity-40">{{ lazyStrings.imageBenchmark__new_measurement() }}</button></div>
      <label tw-class="flex items-center gap-2 text-sm"><input v-model="includePrompts" :disabled="bench.busy.value || bench.exporting.value" type="checkbox" data-testid="benchmark-include-prompts" />{{ lazyStrings.imageBenchmark__include_prompts() }}</label>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageBenchmark__export_privacy() }}</p>
      <p role="status" tw-class="text-xs text-purple-600 dark:text-purple-400">{{ bench.feedback.value }}</p>
    </section>
  </section>
</template>
