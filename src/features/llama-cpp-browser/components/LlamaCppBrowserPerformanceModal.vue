<script setup lang="ts">
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { profileFeatures } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, GaugeIcon, PlayIcon, SquareIcon, XIcon } from 'lucide-vue-next';
import LlamaCppBrowserModelLoadProgress from './LlamaCppBrowserModelLoadProgress.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { useLlamaCppPerformance } from '@/features/llama-cpp-browser/composables/useLlamaCppPerformance';
import { selectableProfiles } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { trialRates } from '@/features/llama-cpp-browser/performance/summary';
import type { PerformanceTrial } from '@/features/llama-cpp-browser/performance/types';

const props = defineProps<{ isOpen: boolean, defaultModel: string | undefined }>();
const emit = defineEmits<{ close: [] }>();
const view = useLlamaCppPerformance();
const { canInterruptCurrent, interruptionPending, mode, profilingUnavailableReason, profilingSupported, modelDraft, modelInputError, diagnostics, models, selected, query, repeats, maxTokens, timeoutMinutes, notes, profile, running, stopping, exporting,
  loading, error, downloadStarted, pageHidden, snapshot, current, preview, filteredModels, otherWork, canStart, callCount, selectedModels } = view;
const measurementProfile = computed({
  get: () => {
    switch (mode.value) {
    case 'standard': return profile.value;
    case 'both': case 'gpu-profile': return 'webgpu-wasm64-jspi';
    default: {
      const exhaustive: never = mode.value;
      throw new Error(String(exhaustive));
    }
    }
  },
  set: (value: typeof profile.value) => {
    switch (mode.value) {
    case 'standard': profile.value = value;
      break;
    case 'both': case 'gpu-profile': break;
    default: {
      const exhaustive: never = mode.value;
      throw new Error(String(exhaustive));
    }
    }
  },
});
const dialog = ref<HTMLDialogElement>(), heading = ref<HTMLElement>();
const finishedCount = computed(() => snapshot.value?.trials.filter(trial => trial.status !== 'running').length ?? 0);
const currentStep = computed(() => snapshot.value?.plan.steps.find(step => step.id === current.value?.stepId));
const profilingUnavailableText = computed(() => {
  if (loading.value) {
    return lazyStrings.llamaCppPerformance__checking_profiling_support();
  }
  const reason = profilingUnavailableReason.value;
  switch (reason) {
  case undefined: return undefined;
  case 'standalone': return lazyStrings.llamaCppPerformance__profiling_requires_hosted_mode();
  case 'profiling-artifact': return lazyStrings.llamaCppPerformance__profiling_runtime_not_installed();
  case 'wasm': case 'memory64': case 'jspi': case 'webgpu': case 'shader-f16': case 'brotli': case 'storage': case 'worker': case 'timestamp-query':
    return lazyStrings.llamaCppBrowser__unavailable_feature({ feature: profileFeatures[reason] });
  default: {
    const exhaustive: never = reason;
    throw new Error(String(exhaustive));
  }
  }
});
const phaseLabel = computed(() => {
  const phase = current.value?.lastProgress?.phase;
  switch (phase) {
  case undefined: return undefined;
  case 'initializing': return lazyStrings.llamaCppBrowser__initializing();
  case 'loading': return lazyStrings.llamaCppBrowser__loading();
  case 'prefill': return lazyStrings.llamaCppBrowser__prefill();
  case 'importing': return lazyStrings.llamaCppBrowser__importing();
  case 'generating': case 'decoding-audio': return lazyStrings.llamaCppBrowser__generating();
  default: {
    const exhaustive: never = phase;
    throw new Error(String(exhaustive));
  }
  }
});

function stepFor({ trial }: { trial: PerformanceTrial }) {
  return snapshot.value?.plan.steps.find(step => step.id === trial.stepId);
}

function numberText({ value }: { value: number | undefined }): string {
  return value === undefined ? '—' : value.toFixed(1);
}

function interruptDisplayed({ event }: { event: MouseEvent }): void {
  // Use the rendered button's identity, not a reactive current value that may
  // already refer to the next attempt before Vue flushes its DOM update.
  const target = event.currentTarget;
  if (target instanceof HTMLButtonElement && target.dataset.trialId) {
    view.interruptCurrent({ trialId: target.dataset.trialId });
  }
}

function close(): void {
  view.stop();
  dialog.value?.close();
  emit('close');
}

async function syncOpen(): Promise<void> {
  await nextTick();
  if (props.isOpen) {
    if (!dialog.value?.open) {
      dialog.value?.showModal();
    }
    heading.value?.focus();
    await view.refresh({ defaultModel: props.defaultModel });
  } else {
    view.stop();
    dialog.value?.close();
  }
}

watch(() => props.isOpen, () => {
  void syncOpen();
});
onMounted(() => {
  void syncOpen();
});
onBeforeUnmount(() => {
  view.stop();
  dialog.value?.close();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { view } }) || {}) });
</script>

<template>
  <dialog ref="dialog" aria-labelledby="llama-performance-heading" data-testid="llama-performance-modal" tw-class="m-auto max-h-[94dvh] w-[96vw] max-w-6xl rounded-2xl border border-gray-200 bg-[#fcfcfd] p-0 text-gray-900 shadow-2xl shadow-gray-950/20 backdrop:bg-black/45 dark:border-gray-700/70 dark:bg-gray-900 dark:text-gray-300" @cancel.prevent="close">
    <div tw-class="flex max-h-[94dvh] flex-col">
      <header tw-class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-white/70 px-4 py-4 md:px-6 dark:border-gray-800 dark:bg-gray-900/60">
        <div tw-class="flex min-w-0 items-center gap-3"><span tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><GaugeIcon aria-hidden="true" tw-class="h-4 w-4" /></span><div tw-class="min-w-0 space-y-0.5"><p tw-class="text-xs font-medium text-gray-400 dark:text-gray-400">llama.cpp browser</p><h2 id="llama-performance-heading" ref="heading" tabindex="-1" tw-class="text-base font-semibold tracking-tight outline-none">{{ lazyStrings.llamaCppPerformance__speed_investigation() }}</h2></div></div>
        <button type="button" data-testid="llama-performance-back" tw-class="group inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" @click="close"><ArrowLeftIcon aria-hidden="true" tw-class="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transform-none" />{{ running ? lazyStrings.llamaCppPerformance__stop_and_return_to_settings() : lazyStrings.llamaCppPerformance__back_to_settings() }}</button>
      </header>
      <main tw-class="min-h-0 space-y-5 overflow-y-auto overscroll-contain p-4 md:p-6">
        <p tw-class="max-w-3xl text-xs leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__measure_saved_models() }}</p>
        <div tw-class="grid items-start gap-4 md:grid-cols-2">
          <fieldset :disabled="running || exporting" tw-class="min-w-0 space-y-3 rounded-2xl border border-gray-200/70 bg-white/70 p-4 disabled:opacity-65 dark:border-gray-800/80 dark:bg-gray-900/40">
            <legend tw-class="sr-only">{{ lazyStrings.llamaCppPerformance__model_input() }}</legend>
            <div tw-class="flex items-center justify-between gap-3">
              <div>
                <p tw-class="text-sm font-semibold text-gray-800 dark:text-gray-300">{{ lazyStrings.ModelSupportInvestigationModal__targets() }}</p>
                <p id="llama-performance-model-input-help" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__model_input() }}</p>
              </div>
              <button type="button" :disabled="!selectedModels.length || !!modelInputError" data-testid="llama-performance-copy-models" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50/70 px-2.5 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:bg-gray-800" @click="view.copyModels">
                <CopyIcon tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelSupportInvestigationModal__copy_model_list() }}
              </button>
            </div>
            <div v-if="selected.length" data-testid="llama-performance-target-list" tw-class="space-y-1.5">
              <div v-for="modelId in selected" :key="modelId" data-testid="llama-performance-target-row" tw-class="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-gray-50/60 px-3 py-2.5 dark:border-gray-700/60 dark:bg-gray-800/30">
                <span :title="modelId" tw-class="min-w-0 flex-1 break-words text-sm text-gray-800 dark:text-gray-300">{{ modelId }}</span>
                <button type="button" :aria-label="`${lazyStrings.llamaCppPerformance__remove_model()}: ${modelId}`" data-testid="llama-performance-target-remove" tw-class="shrink-0 rounded-lg p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20" @click="selected = selected.filter(value => value !== modelId)">
                  <XIcon tw-class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <textarea v-model="modelDraft" rows="2" maxlength="32768" data-testid="llama-performance-model-input" :aria-label="lazyStrings.llamaCppPerformance__model_input()" :aria-invalid="!!modelInputError" aria-describedby="llama-performance-model-input-help llama-performance-model-input-scope" :placeholder="lazyStrings.ModelSupportInvestigationModal__add_models_placeholder()" tw-class="min-h-24 w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-3 font-mono text-sm leading-6 text-gray-800 outline-none transition-colors placeholder:text-gray-400 hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-300 dark:hover:border-gray-600 dark:focus:border-blue-500" @paste="view.pasteModels({ event: $event })" @keydown="view.keydownModels({ event: $event })" />
            <div v-if="modelInputError" role="alert" data-testid="llama-performance-model-input-errors" tw-class="space-y-1 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2 dark:border-red-900 dark:bg-red-950/20">
              <p tw-class="whitespace-pre-wrap break-words text-xs text-red-600 dark:text-red-300">{{ modelInputError }}</p>
            </div>
            <p id="llama-performance-model-input-scope" tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__model_input_help() }}</p>
            <details data-testid="llama-performance-saved-models" tw-class="group/performance-models border-t border-gray-100 pt-3 dark:border-gray-800">
              <summary tw-class="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-gray-600 outline-none focus-visible:text-blue-600 dark:text-gray-300 [&::-webkit-details-marker]:hidden">{{ lazyStrings.llamaCppPerformance__saved_models() }}<ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 group-open/performance-models:rotate-90 motion-reduce:transition-none" /></summary>
              <div tw-class="mt-3 space-y-3">
                <input v-model="query" type="search" :placeholder="lazyStrings.llamaCppPerformance__search_models()" :aria-label="lazyStrings.llamaCppPerformance__search_models()" tw-class="min-h-9 w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm outline-none transition-colors placeholder:text-gray-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/30" />
                <div tw-class="flex flex-wrap gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 [&>button]:min-h-8 [&>button]:rounded-lg [&>button]:px-2 [&>button]:transition-colors [&>button:hover]:bg-gray-100 dark:[&>button:hover]:bg-gray-800 [&>button:focus-visible]:outline-2 [&>button:focus-visible]:outline-blue-400">
                  <button type="button" @click="selected = [...new Set([...selected, ...filteredModels.map(model => model.modelId)])]">{{ lazyStrings.llamaCppPerformance__select_all() }}</button>
                  <button type="button" @click="selected = []; modelDraft = ''">{{ lazyStrings.llamaCppPerformance__clear_selection() }}</button>
                  <button type="button" :disabled="loading" @click="view.refresh({ defaultModel: props.defaultModel })">{{ lazyStrings.llamaCppPerformance__refresh_models() }}</button>
                </div>
                <p v-if="loading" role="status" tw-class="text-sm">{{ lazyStrings.llamaCppPerformance__loading_models() }}</p>
                <p v-else-if="!models.length" tw-class="text-sm">{{ lazyStrings.llamaCppPerformance__no_saved_models() }}</p>
                <div tw-class="max-h-72 space-y-2 overflow-y-auto">
                  <label v-for="model in filteredModels" :key="model.modelId" tw-class="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200/70 bg-white/70 p-3 text-sm leading-5 transition-colors hover:border-blue-200 hover:bg-blue-50/30 dark:border-gray-800 dark:bg-gray-900/20 dark:hover:border-blue-900 dark:hover:bg-blue-500/5">
                    <SettingsChoiceControl presentation="checkbox"><input v-model="selected" type="checkbox" :value="model.modelId" data-testid="llama-performance-model" /></SettingsChoiceControl>
                    <span tw-class="min-w-0 break-all">{{ model.modelId }}<small tw-class="mt-1 block text-xs leading-5 text-gray-500 dark:text-gray-400">{{ (model.size / 1024 ** 3).toFixed(2) }} GiB</small></span>
                  </label>
                </div>
              </div>
            </details>
          </fieldset>
          <section tw-class="min-w-0 space-y-3">
            <fieldset :disabled="running || exporting || loading" data-testid="llama-performance-modes" tw-class="space-y-2 rounded-xl border border-gray-200/70 bg-white/70 p-3.5 text-sm leading-5 dark:border-gray-800/80 dark:bg-gray-900/40">
              <legend tw-class="px-1 font-semibold">{{ lazyStrings.llamaCppPerformance__measurement_mode() }}</legend>
              <label tw-class="flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40"><input v-model="mode" value="gpu-profile" type="radio" name="llama-performance-mode" :disabled="!profilingSupported" data-testid="llama-performance-mode-gpu-profile" tw-class="mt-1 h-3.5 w-3.5 shrink-0 accent-blue-500" /><span>{{ lazyStrings.llamaCppPerformance__gpu_profiling() }}<small tw-class="mt-1 block text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__gpu_profiling_help() }}</small></span></label>
              <label tw-class="flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40"><input v-model="mode" value="standard" type="radio" name="llama-performance-mode" data-testid="llama-performance-mode-standard" tw-class="mt-1 h-3.5 w-3.5 shrink-0 accent-blue-500" /><span>{{ lazyStrings.llamaCppPerformance__standard_measurement() }}<small tw-class="mt-1 block text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__standard_runtime_measurement_help() }}</small></span></label>
              <label tw-class="flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40"><input v-model="mode" value="both" type="radio" name="llama-performance-mode" :disabled="!profilingSupported" data-testid="llama-performance-mode-both" tw-class="mt-1 h-3.5 w-3.5 shrink-0 accent-blue-500" /><span>{{ lazyStrings.llamaCppPerformance__measure_both() }}<small tw-class="mt-1 block text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__measure_both_help() }}</small></span></label>
              <p v-if="loading" role="status" tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__checking_profiling_support() }}</p>
              <p v-else-if="profilingUnavailableText" role="status" data-testid="llama-performance-profiling-unavailable" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ profilingUnavailableText }}</p>
            </fieldset>
            <p tw-class="text-sm text-gray-600 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__standard_measurement_help() }}</p>
            <details tw-class="group/performance-conditions rounded-xl border border-gray-200/70 bg-white/60 p-3.5 dark:border-gray-800/80 dark:bg-gray-900/20">
              <summary tw-class="flex min-h-7 cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-gray-700 outline-none focus-visible:text-blue-600 dark:text-gray-300 [&::-webkit-details-marker]:hidden">{{ lazyStrings.llamaCppPerformance__advanced_conditions() }}<ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 transition-transform duration-200 group-open/performance-conditions:rotate-90 motion-reduce:transition-none" /></summary>
              <fieldset :disabled="running || exporting" tw-class="mt-3 grid gap-3 text-sm disabled:opacity-60 sm:grid-cols-2">
                <label tw-class="grid gap-1.5">{{ lazyStrings.llamaCppPerformance__repeats() }}<input v-model.number="repeats" type="number" min="1" max="5" step="1" tw-class="min-h-10 w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm tabular-nums outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/35" /></label>
                <label tw-class="grid gap-1.5">{{ lazyStrings.llamaCppPerformance__maximum_output_tokens() }}<input v-model.number="maxTokens" type="number" min="1" max="512" step="1" tw-class="min-h-10 w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm tabular-nums outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/35" /></label>
                <label tw-class="grid gap-1.5">{{ lazyStrings.llamaCppPerformance__per_request_timeout_minutes() }}<input v-model.number="timeoutMinutes" type="number" min="1" max="60" step="1" tw-class="min-h-10 w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm tabular-nums outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/35" /></label>
                <label tw-class="grid min-w-0 gap-1.5">{{ lazyStrings.llamaCppPerformance__runtime_profile() }}<span tw-class="relative block"><select v-model="measurementProfile" :disabled="mode !== 'standard'" tw-class="min-h-10 w-full appearance-none rounded-lg border border-gray-200 bg-gray-50/60 py-2 pl-3 pr-8 text-sm text-gray-700 outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 dark:border-gray-700/70 dark:bg-gray-800/35 dark:text-gray-300"><option v-for="item in selectableProfiles" :key="item" :value="item">{{ item }}</option></select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" /></span></label>
                <label tw-class="grid gap-1.5 sm:col-span-2">{{ lazyStrings.llamaCppPerformance__environment_notes() }}<textarea v-model="notes" rows="3" maxlength="10000" tw-class="w-full resize-y rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm leading-6 outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/35" /></label>
                <p tw-class="text-xs leading-5 text-gray-500 sm:col-span-2 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__notes_help() }}</p>
              </fieldset>
            </details>
            <fieldset :disabled="running || exporting" tw-class="space-y-2 rounded-xl border border-gray-200/70 bg-white/60 p-3.5 text-sm leading-5 dark:border-gray-800/80 dark:bg-gray-900/20">
              <label tw-class="flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40"><SettingsChoiceControl presentation="checkbox"><input v-model="diagnostics" type="checkbox" data-testid="llama-performance-diagnostic" /></SettingsChoiceControl>{{ lazyStrings.llamaCppPerformance__operation_diagnostic() }}</label>
              <p tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__operation_diagnostic_help() }}</p>
            </fieldset>
            <p tw-class="flex items-center gap-2 rounded-lg bg-blue-50/70 px-3 py-2.5 text-xs font-medium text-gray-700 dark:bg-blue-500/8 dark:text-gray-300"><GaugeIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.llamaCppPerformance__planned_calls({ models: selectedModels.length, calls: callCount }) }}</p>
            <p tw-class="break-words text-xs text-gray-500">{{ selectedModels.map(model => model.modelId).join(' → ') }}</p>
          </section>
        </div>
        <p v-if="otherWork" role="status" tw-class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{{ lazyStrings.llamaCppPerformance__wait_for_other_work() }}</p>
        <p tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__keep_page_visible() }}</p>
        <p v-if="error" role="alert" tw-class="break-words rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-100">{{ error }}</p>
        <p v-if="running" data-testid="llama-performance-interruption-help" tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__interrupt_current_help() }}</p>
        <section v-if="snapshot" tw-class="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <div role="status" aria-live="polite" tw-class="flex flex-wrap justify-between gap-2 text-sm">
            <span>{{ lazyStrings.llamaCppPerformance__completed_trials() }}: {{ finishedCount }} / {{ snapshot.plan.steps.length }}</span>
            <span v-if="stopping">{{ lazyStrings.llamaCppPerformance__stopping() }}</span>
            <span v-else-if="interruptionPending" data-testid="llama-performance-interrupting">{{ lazyStrings.llamaCppPerformance__interrupting_and_preparing_next() }}</span>
            <span v-else-if="running && pageHidden">{{ lazyStrings.llamaCppPerformance__waiting_for_visible_page() }}</span>
          </div>
          <p v-if="snapshot.q8KernelDiagnostic?.status === 'running'" role="status" data-testid="llama-performance-kernel-progress" tw-class="text-sm text-gray-600 dark:text-gray-400">
            {{ lazyStrings.llamaCppPerformance__gpu_profiling() }}
            <template v-if="snapshot.q8KernelDiagnostic.progress"> · {{ snapshot.q8KernelDiagnostic.progress.completedSamples }} / {{ snapshot.q8KernelDiagnostic.progress.totalSamples }}</template>
          </p>
          <template v-if="current && currentStep">
            <p tw-class="break-words font-medium">{{ snapshot.plan.models[current.modelIndex]?.modelId }}</p>
            <p tw-class="text-sm">{{ lazyStrings.llamaCppPerformance__initial_short_long_or_continuation({ value: currentStep.scenario }) }} · {{ lazyStrings.llamaCppPerformance__preparation_or_measurement({ value: currentStep.role }) }} {{ currentStep.repetition }} · {{ current.lane === 'gpu-profile' ? lazyStrings.llamaCppPerformance__gpu_profiling() : lazyStrings.llamaCppPerformance__standard_measurement() }}</p>
            <LlamaCppBrowserModelLoadProgress v-if="current.lastProgress?.phase === 'loading' || current.lastProgress?.phase === 'initializing'" :progress="current.lastProgress" />
            <p v-else-if="phaseLabel" role="status" data-testid="llama-performance-phase" tw-class="text-sm text-gray-600 dark:text-gray-400">{{ phaseLabel }}</p>
            <details open><summary tw-class="text-sm leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__output_preview() }}</summary><pre tw-class="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900">{{ preview }}</pre></details>
          </template>
          <details v-if="!running" open>
            <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.llamaCppPerformance__result_details() }}</summary>
            <div tw-class="mt-3 overflow-x-auto rounded-xl border border-gray-200/70 dark:border-gray-800">
              <table tw-class="w-full border-collapse bg-white/60 text-left text-xs leading-5 tabular-nums dark:bg-gray-900/20 [&_th]:bg-gray-50 [&_th]:font-medium [&_th]:text-gray-500 dark:[&_th]:bg-gray-800/40 dark:[&_th]:text-gray-400">
                <thead><tr tw-class="border-b border-gray-200 dark:border-gray-800"><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__saved_models() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__standard_measurement() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__first_received_ms() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__generation_tokens_per_second() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__elapsed_ms() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__gpu_pass_time_ms() }}</th></tr></thead>
                <tbody><tr v-for="trial in snapshot.trials" :key="trial.id" tw-class="border-b border-gray-100 align-top dark:border-gray-900">
                  <td tw-class="max-w-56 break-words p-2">{{ snapshot.plan.models[trial.modelIndex]?.modelId }}</td>
                  <td tw-class="p-2"><template v-if="stepFor({ trial })">{{ lazyStrings.llamaCppPerformance__initial_short_long_or_continuation({ value: stepFor({ trial })!.scenario }) }} ({{ stepFor({ trial })!.position }}) · {{ lazyStrings.llamaCppPerformance__preparation_or_measurement({ value: stepFor({ trial })!.role }) }}</template><br />{{ trial.lane === 'gpu-profile' ? lazyStrings.llamaCppPerformance__gpu_profiling() : lazyStrings.llamaCppPerformance__standard_measurement() }}<br />{{ lazyStrings.llamaCppPerformance__trial_status({ value: trial.status }) }}<span v-if="trial.error || trial.exclusion.length || trial.warnings.length" tw-class="block max-w-64 break-words text-amber-700 dark:text-amber-400">{{ trial.error }} {{ trial.exclusion.join(', ') }} {{ trial.warnings.join(', ') }}</span></td>
                  <td tw-class="p-2">{{ numberText({ value: trial.firstReceivedMs }) }}</td><td tw-class="p-2">{{ trial.exclusion.includes('instrumented') ? '—' : numberText({ value: trialRates({ trial }).generationTokensPerSecond }) }}</td><td tw-class="p-2">{{ numberText({ value: trial.elapsedMs }) }}</td><td tw-class="p-2">{{ numberText({ value: trial.summary?.performance?.gpuProfile?.status === 'unavailable' ? undefined : trial.summary?.performance?.gpuProfile?.totalGpuMs }) }}</td>
                </tr></tbody>
              </table>
            </div>
            <p v-for="failure in snapshot.modelErrors" :key="`${failure.modelIndex}-${failure.lane}`" tw-class="mt-2 break-words text-xs text-red-700 dark:text-red-300">{{ snapshot.plan.models[failure.modelIndex]?.modelId }} ({{ failure.lane }}): {{ failure.error }}</p>
          </details>
        </section>
        <p tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__results_are_memory_only() }}</p>
      </main>
      <footer tw-class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-100 bg-white/70 px-4 py-3.5 md:px-6 dark:border-gray-800 dark:bg-gray-900/60">
        <span v-if="downloadStarted" role="status" tw-class="mr-auto text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__download_requested() }}</span>
        <button v-if="running" :key="current?.id ?? 'inactive-trial'" type="button" :data-trial-id="current?.id" :disabled="!canInterruptCurrent" data-testid="llama-performance-interrupt" tw-class="min-h-10 rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2 text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:bg-gray-800" @click="interruptDisplayed({ event: $event })">{{ lazyStrings.llamaCppPerformance__interrupt_current_and_continue() }}</button>
        <button v-if="running" type="button" :disabled="stopping" data-testid="llama-performance-stop" tw-class="inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-200/70 bg-red-50/50 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 disabled:opacity-45 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20" @click="view.stop"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ stopping ? lazyStrings.llamaCppPerformance__stopping() : lazyStrings.llamaCppPerformance__stop_measurement() }}</button>
        <button v-else type="button" :disabled="!canStart" data-testid="llama-performance-start" :tw-class="['inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:opacity-40', snapshot ? 'border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300 hover:bg-gray-100 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-300 dark:hover:bg-gray-800' : 'border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-300 dark:hover:border-blue-400/60 dark:hover:bg-gray-800']" @click="view.start"><PlayIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />{{ snapshot ? lazyStrings.llamaCppPerformance__replace_results_and_measure() : lazyStrings.llamaCppPerformance__start_measurement() }}</button>
        <button v-if="snapshot" type="button" :disabled="running || exporting" data-testid="llama-performance-download" tw-class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:opacity-45 border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-300 dark:hover:border-blue-400/60 dark:hover:bg-gray-800" @click="view.download"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />{{ exporting ? lazyStrings.llamaCppPerformance__creating_zip() : lazyStrings.llamaCppPerformance__save_zip() }}</button>
      </footer>
    </div>
  </dialog>
</template>
