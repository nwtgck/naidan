<script setup lang="ts">
import { CopyIcon, XIcon } from 'lucide-vue-next';
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
const { modelDraft, modelInputError, diagnostics, models, selected, query, repeats, maxTokens, timeoutMinutes, notes, profile, running, stopping, exporting,
  loading, error, downloadStarted, pageHidden, snapshot, current, preview, filteredModels, otherWork, canStart, callCount, selectedModels } = view;
const dialog = ref<HTMLDialogElement>(), heading = ref<HTMLElement>();
const finishedCount = computed(() => snapshot.value?.trials.filter(trial => trial.status !== 'running').length ?? 0);
const currentStep = computed(() => snapshot.value?.plan.steps.find(step => step.id === current.value?.stepId));
const phaseLabel = computed(() => {
  const phase = current.value?.lastProgress?.phase;
  switch (phase) {
  case undefined: return undefined;
  case 'initializing': return lazyStrings.llamaCppBrowser__initializing();
  case 'loading': return lazyStrings.llamaCppBrowser__loading();
  case 'prefill': return lazyStrings.llamaCppBrowser__prefill();
  case 'importing': return lazyStrings.llamaCppBrowser__importing();
  case 'generating': case 'decoding-audio': return lazyStrings.llamaCppBrowser__generating();
  default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
});

function stepFor({ trial }: { trial: PerformanceTrial }) {
  return snapshot.value?.plan.steps.find(step => step.id === trial.stepId);
}

function numberText({ value }: { value: number | undefined }): string {
  return value === undefined ? '—' : value.toFixed(1);
}

function close(): void {
  view.stop(); dialog.value?.close(); emit('close');
}

async function syncOpen(): Promise<void> {
  await nextTick();
  if (props.isOpen) {
    if (!dialog.value?.open) dialog.value?.showModal();
    heading.value?.focus();
    await view.refresh({ defaultModel: props.defaultModel });
  } else {
    view.stop(); dialog.value?.close();
  }
}

watch(() => props.isOpen, () => {
  void syncOpen();
});
onMounted(() => {
  void syncOpen();
});
onBeforeUnmount(() => {
  view.stop(); dialog.value?.close();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { view } }) || {}) });
</script>

<template>
  <dialog ref="dialog" aria-labelledby="llama-performance-heading" data-testid="llama-performance-modal" tw-class="m-auto w-[96vw] max-w-6xl max-h-[94dvh] rounded-2xl border border-gray-200 bg-white p-0 text-gray-900 shadow-2xl backdrop:bg-black/50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" @cancel.prevent="close">
    <div tw-class="flex max-h-[94dvh] flex-col">
      <header tw-class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-800">
        <h2 id="llama-performance-heading" ref="heading" tabindex="-1" tw-class="text-lg font-bold outline-none">llama.cpp browser · {{ lazyStrings.llamaCppPerformance__speed_investigation() }}</h2>
        <button type="button" data-testid="llama-performance-back" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700" @click="close">{{ running ? lazyStrings.llamaCppPerformance__stop_and_return_to_settings() : lazyStrings.llamaCppPerformance__back_to_settings() }}</button>
      </header>
      <main tw-class="min-h-0 space-y-5 overflow-y-auto p-4 md:p-6">
        <p tw-class="text-sm text-gray-600 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__measure_saved_models() }}</p>
        <div tw-class="grid gap-6 md:grid-cols-2">
          <fieldset :disabled="running || exporting" tw-class="min-w-0 space-y-3">
            <legend tw-class="sr-only">{{ lazyStrings.llamaCppPerformance__model_input() }}</legend>
            <div tw-class="flex items-center justify-between gap-3">
              <div>
                <p tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.ModelSupportInvestigationModal__targets() }}</p>
                <p id="llama-performance-model-input-help" tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__model_input() }}</p>
              </div>
              <button type="button" :disabled="!selectedModels.length || !!modelInputError" data-testid="llama-performance-copy-models" tw-class="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-[10px] font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" @click="view.copyModels">
                <CopyIcon tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelSupportInvestigationModal__copy_model_list() }}
              </button>
            </div>
            <div v-if="selected.length" data-testid="llama-performance-target-list" tw-class="space-y-1.5">
              <div v-for="id in selected" :key="id" data-testid="llama-performance-target-row" tw-class="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                <code tw-class="min-w-0 flex-1 break-all text-xs text-gray-800 dark:text-gray-100">{{ id }}</code>
                <button type="button" :aria-label="`${lazyStrings.llamaCppPerformance__remove_model()}: ${id}`" data-testid="llama-performance-target-remove" tw-class="shrink-0 rounded-lg p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20" @click="selected = selected.filter(value => value !== id)">
                  <XIcon tw-class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <textarea v-model="modelDraft" rows="2" maxlength="32768" data-testid="llama-performance-model-input" :aria-label="lazyStrings.llamaCppPerformance__model_input()" :aria-invalid="!!modelInputError" aria-describedby="llama-performance-model-input-help llama-performance-model-input-scope" :placeholder="lazyStrings.ModelSupportInvestigationModal__add_models_placeholder()" tw-class="w-full resize-y rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-700" @paste="view.pasteModels({ event: $event })" @keydown="view.keydownModels({ event: $event })" />
            <div v-if="modelInputError" role="alert" data-testid="llama-performance-model-input-errors" tw-class="space-y-1 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2 dark:border-red-900 dark:bg-red-950/20">
              <p tw-class="whitespace-pre-wrap break-words text-[10px] text-red-600 dark:text-red-300">{{ modelInputError }}</p>
            </div>
            <p id="llama-performance-model-input-scope" tw-class="text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__model_input_help() }}</p>
            <details data-testid="llama-performance-saved-models">
              <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.llamaCppPerformance__saved_models() }}</summary>
              <div tw-class="mt-3 space-y-3">
                <input v-model="query" type="search" :placeholder="lazyStrings.llamaCppPerformance__search_models()" :aria-label="lazyStrings.llamaCppPerformance__search_models()" tw-class="w-full rounded-lg border border-gray-300 bg-transparent p-2 text-sm dark:border-gray-700" />
                <div tw-class="flex flex-wrap gap-3 text-xs">
                  <button type="button" @click="selected = [...new Set([...selected, ...filteredModels.map(model => model.id)])]">{{ lazyStrings.llamaCppPerformance__select_all() }}</button>
                  <button type="button" @click="selected = []; modelDraft = ''">{{ lazyStrings.llamaCppPerformance__clear_selection() }}</button>
                  <button type="button" :disabled="loading" @click="view.refresh({ defaultModel: props.defaultModel })">{{ lazyStrings.llamaCppPerformance__refresh_models() }}</button>
                </div>
                <p v-if="loading" role="status" tw-class="text-sm">{{ lazyStrings.llamaCppPerformance__loading_models() }}</p>
                <p v-else-if="!models.length" tw-class="text-sm">{{ lazyStrings.llamaCppPerformance__no_saved_models() }}</p>
                <div tw-class="max-h-72 space-y-2 overflow-y-auto">
                  <label v-for="model in filteredModels" :key="model.id" tw-class="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800">
                    <input v-model="selected" type="checkbox" :value="model.id" data-testid="llama-performance-model" tw-class="mt-1" />
                    <span tw-class="min-w-0 break-all">{{ model.name }}<small tw-class="mt-1 block text-gray-500">{{ (model.size / 1024 ** 3).toFixed(2) }} GiB · {{ model.id }}</small></span>
                  </label>
                </div>
              </div>
            </details>
          </fieldset>
          <section tw-class="min-w-0 space-y-3">
            <h3 tw-class="font-semibold">{{ lazyStrings.llamaCppPerformance__standard_measurement() }}</h3>
            <p tw-class="text-sm text-gray-600 dark:text-gray-400">{{ lazyStrings.llamaCppPerformance__standard_measurement_help() }}</p>
            <details>
              <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.llamaCppPerformance__advanced_conditions() }}</summary>
              <fieldset :disabled="running || exporting" tw-class="mt-3 grid gap-3 text-sm">
                <label tw-class="grid gap-1">{{ lazyStrings.llamaCppPerformance__repeats() }}<input v-model.number="repeats" type="number" min="1" max="5" step="1" tw-class="rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700" /></label>
                <label tw-class="grid gap-1">{{ lazyStrings.llamaCppPerformance__maximum_output_tokens() }}<input v-model.number="maxTokens" type="number" min="1" max="512" step="1" tw-class="rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700" /></label>
                <label tw-class="grid gap-1">{{ lazyStrings.llamaCppPerformance__per_request_timeout_minutes() }}<input v-model.number="timeoutMinutes" type="number" min="1" max="60" step="1" tw-class="rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700" /></label>
                <label tw-class="grid gap-1">{{ lazyStrings.llamaCppPerformance__runtime_profile() }}<select v-model="profile" tw-class="rounded border border-gray-300 bg-white p-2 dark:border-gray-700 dark:bg-gray-950"><option v-for="item in selectableProfiles" :key="item" :value="item">{{ item }}</option></select></label>
                <label tw-class="grid gap-1">{{ lazyStrings.llamaCppPerformance__environment_notes() }}<textarea v-model="notes" rows="3" maxlength="10000" tw-class="rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700" /></label>
                <p tw-class="text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__notes_help() }}</p>
              </fieldset>
            </details>
            <fieldset :disabled="running || exporting" tw-class="space-y-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800">
              <label tw-class="flex items-start gap-2"><input v-model="diagnostics" type="checkbox" data-testid="llama-performance-diagnostic" tw-class="mt-1" />{{ lazyStrings.llamaCppPerformance__operation_diagnostic() }}</label>
              <p tw-class="text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__operation_diagnostic_help() }}</p>
            </fieldset>
            <p tw-class="text-sm font-medium">{{ lazyStrings.llamaCppPerformance__planned_calls({ models: selectedModels.length, calls: callCount }) }}</p>
            <p tw-class="break-words text-xs text-gray-500">{{ selectedModels.map(model => model.name).join(' → ') }}</p>
          </section>
        </div>
        <p v-if="otherWork" role="status" tw-class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{{ lazyStrings.llamaCppPerformance__wait_for_other_work() }}</p>
        <p tw-class="text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__keep_page_visible() }}</p>
        <p v-if="error" role="alert" tw-class="break-words rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-100">{{ error }}</p>
        <section v-if="snapshot" tw-class="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <div role="status" aria-live="polite" tw-class="flex flex-wrap justify-between gap-2 text-sm">
            <span>{{ lazyStrings.llamaCppPerformance__completed_trials() }}: {{ finishedCount }} / {{ snapshot.plan.steps.length }}</span>
            <span v-if="stopping">{{ lazyStrings.llamaCppPerformance__stopping() }}</span>
            <span v-else-if="running && pageHidden">{{ lazyStrings.llamaCppPerformance__waiting_for_visible_page() }}</span>
          </div>
          <template v-if="current && currentStep">
            <p tw-class="break-words font-medium">{{ snapshot.plan.models[current.modelIndex]?.name }}</p>
            <p tw-class="text-sm">{{ lazyStrings.llamaCppPerformance__initial_short_long_or_continuation({ value: currentStep.scenario }) }} · {{ lazyStrings.llamaCppPerformance__preparation_or_measurement({ value: currentStep.role }) }} {{ currentStep.repetition }}</p>
            <LlamaCppBrowserModelLoadProgress v-if="current.lastProgress?.phase === 'loading' || current.lastProgress?.phase === 'initializing'" :progress="current.lastProgress" />
            <p v-else-if="phaseLabel" role="status" data-testid="llama-performance-phase" tw-class="text-sm text-gray-600 dark:text-gray-400">{{ phaseLabel }}</p>
            <details open><summary tw-class="text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__output_preview() }}</summary><pre tw-class="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900">{{ preview }}</pre></details>
          </template>
          <details v-if="!running" open>
            <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.llamaCppPerformance__result_details() }}</summary>
            <div tw-class="mt-3 overflow-x-auto">
              <table tw-class="w-full text-left text-xs tabular-nums">
                <thead><tr tw-class="border-b border-gray-200 dark:border-gray-800"><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__saved_models() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__standard_measurement() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__first_received_ms() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__generation_tokens_per_second() }}</th><th tw-class="p-2">{{ lazyStrings.llamaCppPerformance__elapsed_ms() }}</th></tr></thead>
                <tbody><tr v-for="trial in snapshot.trials" :key="trial.id" tw-class="border-b border-gray-100 align-top dark:border-gray-900">
                  <td tw-class="max-w-56 break-words p-2">{{ snapshot.plan.models[trial.modelIndex]?.name }}</td>
                  <td tw-class="p-2"><template v-if="stepFor({ trial })">{{ lazyStrings.llamaCppPerformance__initial_short_long_or_continuation({ value: stepFor({ trial })!.scenario }) }} ({{ stepFor({ trial })!.position }}) · {{ lazyStrings.llamaCppPerformance__preparation_or_measurement({ value: stepFor({ trial })!.role }) }}</template><br />{{ lazyStrings.llamaCppPerformance__trial_status({ value: trial.status }) }}<span v-if="trial.error || trial.exclusion.length || trial.warnings.length" tw-class="block max-w-64 break-words text-amber-700 dark:text-amber-400">{{ trial.error }} {{ trial.exclusion.join(', ') }} {{ trial.warnings.join(', ') }}</span></td>
                  <td tw-class="p-2">{{ numberText({ value: trial.firstReceivedMs }) }}</td><td tw-class="p-2">{{ trial.exclusion.includes('instrumented') ? '—' : numberText({ value: trialRates({ trial }).generationTokensPerSecond }) }}</td><td tw-class="p-2">{{ numberText({ value: trial.elapsedMs }) }}</td>
                </tr></tbody>
              </table>
            </div>
            <p v-for="failure in snapshot.modelErrors" :key="failure.modelIndex" tw-class="mt-2 break-words text-xs text-red-700 dark:text-red-300">{{ snapshot.plan.models[failure.modelIndex]?.name }}: {{ failure.error }}</p>
          </details>
        </section>
        <p tw-class="text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__results_are_memory_only() }}</p>
      </main>
      <footer tw-class="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-gray-200 p-4 dark:border-gray-800">
        <span v-if="downloadStarted" role="status" tw-class="mr-auto text-xs text-gray-500">{{ lazyStrings.llamaCppPerformance__download_requested() }}</span>
        <button v-if="snapshot" type="button" :disabled="running || exporting" data-testid="llama-performance-download" tw-class="rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-gray-700" @click="view.download">{{ exporting ? lazyStrings.llamaCppPerformance__creating_zip() : lazyStrings.llamaCppPerformance__save_zip() }}</button>
        <button v-if="running" type="button" :disabled="stopping" data-testid="llama-performance-stop" tw-class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="view.stop">{{ stopping ? lazyStrings.llamaCppPerformance__stopping() : lazyStrings.llamaCppPerformance__stop_measurement() }}</button>
        <button v-else type="button" :disabled="!canStart" data-testid="llama-performance-start" tw-class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40" @click="view.start">{{ snapshot ? lazyStrings.llamaCppPerformance__replace_results_and_measure() : lazyStrings.llamaCppPerformance__start_measurement() }}</button>
      </footer>
    </div>
  </dialog>
</template>
