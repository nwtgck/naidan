<script setup lang="ts">
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import ImageSettingsSection from '@/features/image-generation/components/ImageSettingsSection.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { lazyStrings } from '@/strings';
import { computed } from 'vue';
import { ChevronDownIcon, DownloadIcon, PlayIcon, RotateCcwIcon, SlidersHorizontalIcon, SquareIcon, TimerIcon } from 'lucide-vue-next';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ImageBenchmarkParameters from './ImageBenchmarkParameters.vue';
import ImageBenchmarkResult from './ImageBenchmarkResult.vue';
import ImageModelPicker from './ImageModelPicker.vue';
import ImageLoraControls from './ImageLoraControls.vue';
import ImageInputControls from '@/features/image-generation/components/ImageInputControls.vue';
import { emptyImageInputs } from '@/features/image-generation/image-input-form';
import { componentLabel } from '@/features/stable-diffusion-cpp-browser/component-label';
import { profileOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
import type { ImageBenchmarkView } from '@/features/stable-diffusion-cpp-browser/benchmark-view';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import type { BenchmarkRunRecord } from '@/features/stable-diffusion-cpp-browser/benchmark/types';
const props = defineProps<{ bench: ImageBenchmarkView, generation: ImageGenerationView, active: boolean }>();
// The view owns these refs; controls edit the handed-out form state, not a prop snapshot.
const { strategy, protocol, preview, notes, includePrompts, includeInputImages } = props.bench;
const { profile, weightResidency, gpuBudgetMiB } = props.generation;
const locked = computed(() => props.bench.busy.value || props.bench.exporting.value || props.bench.runs.value.length > 0 || props.generation.busy.value || !props.bench.available.value);
const weightOptions = computed(() => [
  { value: 'auto' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_auto() },
  { value: 'cpu' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_cpu() },
  { value: 'hybrid' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_hybrid() },
  { value: 'disk' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_disk() },
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
  default: {
    const exhaustive: never = record.status;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="image-benchmark">
    <SettingsSelectScope :active="active" :return-focus="undefined">
      <p tw-class="max-w-3xl text-xs leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.imageBenchmark__introduction() }}</p>
      <fieldset :disabled="locked" tw-class="space-y-5">
        <div tw-class="grid xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5 items-start">
          <section tw-class="min-w-0 rounded-2xl border border-gray-200/70 bg-white/70 p-4 space-y-4 dark:border-gray-700/60 dark:bg-gray-900/30 sm:p-5">
            <h2 tw-class="flex items-center gap-2.5 text-sm font-semibold text-gray-800 dark:text-gray-100"><span tw-class="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4" /></span>{{ lazyStrings.imageBenchmark__shared_settings() }}</h2>
            <ImageBenchmarkParameters :disabled="locked" :values="bench.common.value" :overrides="undefined" @change="bench.setCommon({ change: $event })" />
            <label tw-class="flex min-h-10 cursor-pointer items-center gap-3 rounded-xl bg-gray-50/80 px-3 text-xs leading-5 text-gray-600 dark:bg-gray-800/30 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="strategy" type="checkbox" true-value="model-defaults" false-value="shared" data-testid="benchmark-model-defaults" /></SettingsChoiceControl>{{ lazyStrings.imageBenchmark__model_sampling_defaults() }}</label>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageBenchmark__defaults_help() }}</p>
          </section>
          <section tw-class="min-w-0 rounded-2xl border border-gray-200/70 bg-white/70 p-4 space-y-4 dark:border-gray-700/60 dark:bg-gray-900/30 sm:p-5">
            <h2 tw-class="flex items-center gap-2.5 text-sm font-semibold text-gray-800 dark:text-gray-100"><span tw-class="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><TimerIcon aria-hidden="true" tw-class="h-4 w-4" /></span>{{ lazyStrings.imageBenchmark__protocol() }}</h2>
            <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__protocol() }}</span><SettingsFormSelect v-model="protocol.mode" data-testid="benchmark-mode" :options="[{ value: 'cold-warm', label: lazyStrings.imageBenchmark__cold_then_warm() }, { value: 'fresh-each', label: lazyStrings.imageBenchmark__fresh_each() }]" :label="lazyStrings.imageBenchmark__protocol()" :disabled="locked" /></label>
            <div tw-class="grid grid-cols-2 gap-3 items-end">
              <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__runs_per_model() }}</span><input v-model.number="protocol.repeats" data-testid="benchmark-repeats" type="number" min="1" max="10" step="1" tw-class="block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" /></label>
              <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__order() }}</span><SettingsFormSelect v-model="protocol.order" :options="[{ value: 'listed', label: lazyStrings.imageBenchmark__listed_order() }, { value: 'reverse', label: lazyStrings.imageBenchmark__reverse_order() }]" :label="lazyStrings.imageBenchmark__order()" :disabled="locked" /></label>
              <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__cooldown() }}</span><input v-model.number="protocol.cooldownSeconds" type="number" min="0" max="60" step="1" tw-class="block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" /></label>
              <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__timeout() }}</span><input v-model.number="protocol.timeoutSeconds" type="number" min="0" max="7200" step="1" tw-class="block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" /></label>
            </div>
            <label tw-class="text-sm block space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__profile() }}</span><SettingsFormSelect v-model="profile" :options="profileOptions.map(value => ({ value, label: value }))" :label="lazyStrings.stableDiffusionCppBrowser__profile()" :disabled="locked" /></label>
            <div tw-class="grid grid-cols-2 gap-3 items-end">
              <label tw-class="text-sm block space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__weight_residency() }}</span><SettingsFormSelect v-model="weightResidency" :options="weightOptions" :label="lazyStrings.stableDiffusionCppBrowser__weight_residency()" :disabled="locked" /></label>
              <label tw-class="text-sm block space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget() }}</span><input v-model.number="gpuBudgetMiB" type="number" min="512" step="1" tw-class="block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" /></label>
            </div>
            <label tw-class="inline-flex min-h-9 cursor-pointer items-center gap-3 text-xs text-gray-600 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="protocol.keepImages" type="checkbox" data-testid="benchmark-keep-images" /></SettingsChoiceControl>{{ lazyStrings.imageBenchmark__keep_images() }}</label>
            <ImageSettingsSection compact :title="lazyStrings.stableDiffusionCppBrowser__preview_title()" :summary="undefined" data-testid="benchmark-preview-settings">
              <div tw-class="space-y-3">
                <label tw-class="inline-flex min-h-9 cursor-pointer items-center gap-3 text-xs text-gray-600 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="preview.enabled" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.stableDiffusionCppBrowser__preview_enabled() }}</label>
                <div tw-class="grid grid-cols-2 gap-3 text-sm">
                  <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_mode() }}</span><SettingsFormSelect v-model="preview.mode" :options="[{ value: 'vae', label: lazyStrings.stableDiffusionCppBrowser__preview_vae() }, { value: 'projection', label: lazyStrings.stableDiffusionCppBrowser__preview_projection() }]" :label="lazyStrings.stableDiffusionCppBrowser__preview_mode()" :disabled="locked" /></label>
                  <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_interval() }}</span><input v-model.number="preview.interval" type="number" min="1" max="100" tw-class="block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" /></label>
                  <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_start_step() }}</span><input v-model.number="preview.startStep" type="number" min="1" max="100" tw-class="block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" /></label>
                  <label><span>{{ lazyStrings.stableDiffusionCppBrowser__preview_max_edge() }}</span><SettingsFormSelect v-model="preview.maxEdge" :options="[128, 256, 512, 0].map(value => ({ value, label: value === 0 ? lazyStrings.stableDiffusionCppBrowser__preview_original() : String(value) }))" :label="lazyStrings.stableDiffusionCppBrowser__preview_max_edge()" :disabled="locked" /></label>
                </div>
              </div>
            </ImageSettingsSection>
            <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.imageBenchmark__environment_notes() }}</span><textarea v-model="notes" rows="2" maxlength="2048" tw-class="block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed" /></label>
            <details tw-class="group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400"><summary tw-class="flex min-h-10 items-center justify-between gap-2 px-3 py-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-gray-50 dark:hover:bg-gray-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">{{ lazyStrings.imageBenchmark__protocol() }}<ChevronDownIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" /></summary><div tw-class="space-y-2 border-t border-gray-100 dark:border-gray-700 p-3"><p>{{ lazyStrings.imageBenchmark__fairness() }}</p><p>{{ lazyStrings.imageBenchmark__limits() }}</p><p>{{ lazyStrings.stableDiffusionCppBrowser__debug_help() }}</p></div></details>
          </section>
        </div>
        <section tw-class="space-y-3">
          <div tw-class="flex flex-wrap justify-between items-center gap-3"><h2 tw-class="font-semibold">{{ lazyStrings.imageBenchmark__available_models() }} · {{ bench.selected.value.length }} / {{ bench.targets.value.length }}</h2><div tw-class="flex flex-wrap gap-2 text-sm"><button type="button" @click="bench.select({ mode: 'all' })" data-testid="benchmark-select-all" tw-class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageBenchmark__select_all() }}</button><button type="button" @click="bench.select({ mode: 'none' })" data-testid="benchmark-select-none" tw-class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageBenchmark__select_none() }}</button><button type="button" @click="generation.library.refresh()" :disabled="generation.formDisabled.value || generation.library.importing.value || generation.library.downloading.value" data-testid="benchmark-refresh" tw-class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.stableDiffusionCppBrowser__refresh_repositories() }}</button></div></div>
          <p v-if="!bench.targets.value.length" tw-class="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-5 text-sm text-gray-500">{{ lazyStrings.imageBenchmark__no_models() }}</p>
          <article v-for="target in bench.targets.value" :key="target.candidateKey" data-testid="benchmark-target" :tw-class="['rounded-xl border p-4 space-y-4 transition-colors', bench.selected.value.includes(target.candidateKey) ? 'border-blue-200/80 bg-blue-50/20 dark:border-blue-500/25 dark:bg-blue-500/[0.035]' : 'border-gray-200/70 bg-white/60 dark:border-gray-800 dark:bg-gray-900/20']">
            <label tw-class="flex min-h-10 cursor-pointer items-start gap-3"><SettingsChoiceControl presentation="checkbox"><input type="checkbox" :checked="bench.selected.value.includes(target.candidateKey)" :disabled="!target.models && !bench.selected.value.includes(target.candidateKey)" @change="bench.toggle({ id: target.candidateKey, selected: checked({ event: $event }) })" data-testid="benchmark-target-selected" /></SettingsChoiceControl><span tw-class="min-w-0"><strong tw-class="block break-all text-sm font-semibold leading-5 text-gray-800 dark:text-gray-100">{{ target.label }}</strong><span tw-class="text-xs text-gray-500 dark:text-gray-400 break-all">{{ target.detail }}</span></span></label>
            <div v-if="target.components.length" tw-class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              <ImageModelPicker :active="active" v-for="component in target.components" :key="component.slot" :model-value="component.selectedCandidateKey" :choices="component.choices" :required="component.required" :label="componentLabel({ slot: component.slot })" :disabled="locked || generation.library.scanState.value === 'scanning'" @update:model-value="bench.chooseComponent({ targetId: target.candidateKey, slot: component.slot, candidateKey: $event })" :data-testid="'benchmark-component-' + component.slot" />
            </div>
            <p v-if="!target.models" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.imageBenchmark__unavailable_components() }}: {{ target.missing.join(', ') }} {{ target.issue }}</p>
            <ImageLoraControls :active="active" :model-value="bench.loras.value[target.candidateKey] ?? []" :saved="generation.library.savedLoras.value" :disabled="locked || !generation.supported.value" @update:model-value="bench.chooseLoras({ targetId: target.candidateKey, selections: $event })" />
            <ImageInputControls :active="active" :model-value="bench.imageInputs.value[target.candidateKey] ?? emptyImageInputs()" :disabled="locked || !generation.supported.value" @update:model-value="bench.chooseImageInputs({ targetId: target.candidateKey, inputs: $event })" />
            <ImageSettingsSection compact :title="lazyStrings.imageBenchmark__overrides()" :summary="undefined" data-testid="benchmark-target-overrides"><ImageBenchmarkParameters :disabled="locked" :values="bench.effective({ target })" :overrides="bench.overrides.value[target.candidateKey] ?? {}" @change="bench.change({ id: target.candidateKey, change: $event })" @inherit="bench.inherit({ id: target.candidateKey, key: $event })" /></ImageSettingsSection>
            <details tw-class="group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40"><summary tw-class="flex min-h-10 items-center justify-between gap-2 px-3 py-2 text-xs font-medium cursor-pointer list-none text-gray-600 dark:text-gray-300 [&::-webkit-details-marker]:hidden hover:bg-gray-50 dark:hover:bg-gray-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">{{ lazyStrings.imageBenchmark__effective_request() }}<ChevronDownIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180" /></summary><pre tw-class="text-xs whitespace-pre-wrap break-all max-h-60 overflow-auto border-t border-gray-100 dark:border-gray-800 p-3">{{ JSON.stringify({ parameters: bench.effective({ target }), components: target.models?.map(m => ({ slot: m.slot, path: m.relativePath ?? m.file.name, bytes: m.file.size })), composition: target.composition, evidence: target.facts.evidence }, undefined, 2) }}</pre></details>
          </article>
        </section>
      </fieldset>
      <div tw-class="flex flex-wrap gap-3 items-center">
        <button type="button" :disabled="!bench.canStart.value" @click="bench.start()" data-testid="benchmark-start" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-40 border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-100 dark:hover:border-blue-400/60 dark:hover:bg-gray-800"><PlayIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ lazyStrings.imageBenchmark__start() }} · {{ bench.plannedRuns.value }}</button>
        <button type="button" :disabled="!bench.busy.value" @click="bench.stop()" data-testid="benchmark-stop" tw-class="inline-flex min-h-11 items-center gap-2 rounded-xl border border-red-200/70 bg-red-50/60 px-4 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-400 dark:hover:bg-red-500/10"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.imageBenchmark__stop() }}</button>
        <label tw-class="inline-flex gap-2 items-center text-xs text-gray-500 dark:text-gray-400"><SettingsChoiceControl presentation="checkbox"><input type="checkbox" checked disabled /></SettingsChoiceControl>{{ lazyStrings.stableDiffusionCppBrowser__debug_mode() }}</label>
        <span v-if="bench.busy.value" role="status" data-testid="benchmark-progress" tw-class="text-xs leading-5 text-gray-600 dark:text-gray-300">{{ lazyStrings.imageBenchmark__running() }} · {{ bench.current.value }} <template v-if="bench.progress.value"> · {{ bench.progress.value.phase }} {{ bench.progress.value.step }} / {{ bench.progress.value.steps }}</template></span>
      </div>
      <p v-if="!bench.canStart.value && !bench.busy.value" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageBenchmark__check_plan() }}</p>
      <p v-if="bench.error.value" role="alert" tw-class="text-xs whitespace-pre-wrap break-words text-red-600 dark:text-red-400">{{ bench.error.value }}</p>
      <section tw-class="space-y-3">
        <h2 tw-class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ lazyStrings.imageBenchmark__results() }}</h2>
        <div tw-class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table tw-class="w-full text-left text-xs tabular-nums"><thead tw-class="bg-gray-50/80 text-[11px] font-medium text-gray-500 dark:bg-gray-800/50 dark:text-gray-400"><tr><th tw-class="p-3">{{ lazyStrings.imageBenchmark__run() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__protocol() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__results() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__elapsed() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__sampling() }}</th><th tw-class="p-3">{{ lazyStrings.imageBenchmark__model_load() }}</th></tr></thead>
            <tbody><tr v-for="run in bench.runs.value" :key="run.record.id" data-testid="benchmark-run" tw-class="border-t border-gray-100 dark:border-gray-800"><td tw-class="p-3"><span tw-class="block text-xs">{{ bench.plan.value?.models[run.record.modelIndex]?.target.label }}</span>{{ run.record.id }}<ImageBenchmarkResult :run-id="run.record.id" :png="run.png" :image-status="run.record.image.status" /></td><td tw-class="p-3 text-xs">{{ run.record.plannedKind === 'cold' ? lazyStrings.imageBenchmark__cold() : lazyStrings.imageBenchmark__warm() }}</td><td tw-class="p-3">{{ status({ record: run.record }) }}<p v-if="run.record.error" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ run.record.error }}</p><p v-if="run.record.uniformOutput" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__uniform_image_warning() }}</p><p v-if="run.record.metrics.reuse && run.record.metrics.reuse.reusedWorker !== (run.record.plannedKind === 'warm')" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.imageBenchmark__freshness_warning() }}</p></td><td tw-class="p-3 whitespace-nowrap">{{ time({ value: run.record.elapsedMs }) }}</td><td tw-class="p-3 whitespace-nowrap">{{ time({ value: run.record.metrics.runWall?.sampling }) }}</td><td tw-class="p-3 whitespace-nowrap">{{ time({ value: run.record.metrics.runWall?.['model-load'] }) }}</td></tr></tbody>
          </table>
        </div>
        <div tw-class="flex flex-wrap gap-3 items-center"><button type="button" :disabled="bench.busy.value || bench.exporting.value || !bench.runs.value.length" @click="bench.download()" data-testid="benchmark-download" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-40 border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-100 dark:hover:border-blue-400/60 dark:hover:bg-gray-800"><DownloadIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ bench.exporting.value ? lazyStrings.imageBenchmark__exporting() : lazyStrings.imageBenchmark__download_zip() }}</button><button type="button" :disabled="bench.busy.value || bench.exporting.value || !bench.runs.value.length" @click="bench.clear()" data-testid="benchmark-clear" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"><RotateCcwIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400" />{{ lazyStrings.imageBenchmark__new_measurement() }}</button></div>
        <label tw-class="flex min-h-9 cursor-pointer items-center gap-3 text-xs text-gray-600 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="includePrompts" :disabled="bench.exporting.value" type="checkbox" data-testid="benchmark-include-prompts" /></SettingsChoiceControl>{{ lazyStrings.imageBenchmark__include_prompts() }}</label>
        <label tw-class="flex min-h-9 cursor-pointer items-center gap-3 text-xs text-gray-600 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="includeInputImages" :disabled="bench.exporting.value" type="checkbox" true-value="include" false-value="omit" data-testid="benchmark-input-images" /></SettingsChoiceControl>{{ lazyStrings.imageBenchmark__include_input_images_in_zip() }}</label>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageBenchmark__export_privacy() }}</p>
        <p role="status" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ bench.feedback.value }}</p>
      </section>
    </SettingsSelectScope>
  </section>
</template>
