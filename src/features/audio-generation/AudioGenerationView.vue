<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useId } from 'vue';
import { AudioLinesIcon, Loader2Icon, RefreshCcwIcon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import { audioLanguageOptions, defaultAudioLanguage } from './languages';
import { audioFieldLabel, audioFieldValidationMessage, audioValidationFields } from './validation';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, type EngineState, type ErrorCode } from '@/features/llama-cpp-browser/types';
import { audioGenerationInputSchema, audioGenerationResultSchema, defaultAudioParameters } from './types';
import { validateAudioWav } from './wav';
import { inspectStoredAudioModel } from './model-detection';
import { useAudioModels } from './composables/useAudioModels';
import { captureAudioSettings, useAudioHistory } from './composables/useAudioHistory';
import AudioHistoryResult from './components/AudioHistoryResult.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import LlamaCppBrowserRepositoryCatalog from '@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryCatalog.vue';
import { audioModelCatalog } from './model-catalog';

const id = useId();
const manager = ref<InstanceType<typeof LlamaCppBrowserManager>>();
const recovery = shallowRef<AbortController>();
const { models, model, scope: modelScope, scanState, visibleModels, detectedCount, detections,
  updateModels, selectModel, selectionChanged, scopeChanged, showAllModels } = useAudioModels({ inspect: inspectStoredAudioModel });
const { entries: history, totalBytes, append: appendHistory, remove: removeHistory, clear: clearHistory } = useAudioHistory();
const text = ref('');
const reference = shallowRef<File>();
const referenceInput = ref<HTMLInputElement>();
const parameters = ref<ReturnType<typeof defaultAudioParameters>>({ ...defaultAudioParameters(), language: defaultAudioLanguage({ locale: currentLocale.value }) });
const form = ref<HTMLFormElement>();
const debug = ref(false);
const runtimeReady = ref(false);
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const controller = shallowRef<AbortController>();
const stopping = ref(false);
const stopped = ref(false);
const invalidFields = ref<string[]>([]);
const invalid = computed(() => invalidFields.value.length > 0);
const failure = ref<ErrorCode>();
const busy = computed(() => controller.value !== undefined);
const blocked = computed(() => recovery.value !== undefined || busy.value || state.value.status === 'working');
const canGenerate = computed(() => !blocked.value && runtimeReady.value && models.value.some(entry => entry.id === model.value));
let disposed = false;
let generation = 0;
let unsubscribe: (() => void) | undefined;

const selectableModelIds = computed(() => visibleModels.value.map(entry => entry.id));
const modelLabels = computed(() => Object.fromEntries(visibleModels.value.map(entry => {
  const status = detections.value.get(entry.id)?.status;
  let label: string;
  switch (status) {
  case 'detected': label = entry.name; break;
  case 'unverified': case undefined: {
    const suffix = lazyStrings.audioGeneration__not_detected_as_audio();
    label = suffix === undefined ? entry.name : `${entry.name} · ${suffix}`; break;
  }
  default: { const exhaustive: never = status; throw new Error(String(exhaustive)); }
  }
  return [entry.id, label];
})));
function chooseModel({ value }: { value: string | undefined }): void {
  if (blocked.value || value === undefined || !selectableModelIds.value.includes(value)) return;
  model.value = value; selectionChanged();
}
async function restartRuntime(): Promise<void> {
  if (blocked.value || disposed) return;
  const controller = new AbortController(); recovery.value = controller;
  try {
    await llamaCppBrowserService.restartRuntime({ signal: controller.signal });
    if (!disposed && !controller.signal.aborted) {
      failure.value = undefined; stopped.value = false;
    }
  } catch (error) {
    if (!disposed && !controller.signal.aborted) failure.value = errorCode({ error });
  } finally {
    if (!disposed && recovery.value === controller) recovery.value = undefined;
  }
}
const languages = computed(() => audioLanguageOptions({ locale: currentLocale.value }));
const progressLabel = computed(() => {
  if (stopping.value) return lazyStrings.audioGeneration__stopping();
  const current = state.value;
  switch (current.status) {
  case 'idle': case 'error': case 'unavailable': return lazyStrings.audioGeneration__waiting();
  case 'working': {
    const progress = current.progress;
    switch (progress.phase) {
    case 'initializing': return lazyStrings.llamaCppBrowser__initializing();
    case 'loading': return lazyStrings.llamaCppBrowser__loading();
    case 'prefill': return lazyStrings.llamaCppBrowser__prefill();
    case 'decoding-audio': return lazyStrings.audioGeneration__decoding_audio();
    case 'generating': return lazyStrings.audioGeneration__steps_completed({ completed: progress.completed, maximum: progress.total });
    case 'importing': return lazyStrings.audioGeneration__waiting();
    default: { const exhaustive: never = progress.phase; throw new Error(String(exhaustive)); }
    }
  }
  default: { const exhaustive: never = current; throw new Error(String(exhaustive)); }
  }
});
const errorMessage = computed(() => {
  if (invalid.value) return lazyStrings.audioGeneration__check_parameters();
  const code = failure.value;
  switch (code) {
  case 'audio-model-unsupported': return lazyStrings.audioGeneration__unsupported_model();
  case 'audio-reference-required': return lazyStrings.audioGeneration__reference_required();
  case 'audio-reference-invalid': return lazyStrings.audioGeneration__invalid_reference();
  case 'audio-output-empty': return lazyStrings.audioGeneration__empty_audio();
  case 'context-full': return lazyStrings.audioGeneration__context_full();
  case undefined: return undefined;
  case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error':
  case 'runtime-error': case 'template-unsupported': case 'unsupported-input': case 'busy': case 'aborted': case 'worker-failed':
    return lazyStrings.audioGeneration__generation_failed();
  default: { const exhaustive: never = code; throw new Error(String(exhaustive)); }
  }
});
function chooseReference({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  reference.value = event.target.files?.[0];
  invalidFields.value = []; failure.value = undefined;
}
function clearReference(): void {
  reference.value = undefined;
  if (referenceInput.value) referenceInput.value.value = '';
}
function fieldError({ field }: { field: string }): string | undefined {
  return invalidFields.value.includes(field) ? audioFieldValidationMessage({ field }) : undefined;
}
function revealInvalidField({ field }: { field: string }): void {
  // Open collapsed ancestors before focus. Native form validation cannot focus a
  // hidden number input and otherwise reports only "not focusable" in the console.
  const element = form.value?.querySelector<HTMLElement>(`[data-audio-field="${field}"]`);
  if (!element) return;
  let parent = element.parentElement;
  while (parent && parent !== form.value) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
  // ModelSelector owns a button rather than a native select.
  const focusTarget = element.matches('input,select,textarea,button') ? element : element.querySelector<HTMLElement>('button');
  focusTarget?.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: 'nearest' });
}
async function generate(): Promise<void> {
  if (!canGenerate.value) return;
  failure.value = undefined; invalidFields.value = []; stopped.value = false;
  const accepted = audioGenerationInputSchema.safeParse({ ...parameters.value, model: model.value, text: text.value, reference: reference.value, debug: debug.value ? 'on' : 'off', options: llamaCppBrowserService.getOptions() });
  if (!accepted.success) {
    invalidFields.value = audioValidationFields({ issues: accepted.error.issues });
    await nextTick();
    revealInvalidField({ field: invalidFields.value[0] ?? 'input' });
    return;
  }
  const { options: _options, ...input } = accepted.data;
  const request = ++generation; const active = new AbortController(); controller.value = active; stopping.value = false;
  const modelName = models.value.find(entry => entry.id === input.model)!.name;
  const settings = captureAudioSettings({ input: accepted.data, modelName });
  try {
    const result = audioGenerationResultSchema.parse(await llamaCppBrowserService.generateAudio({ input, signal: active.signal }));
    // An RPC may finish after Stop or route unmount. Never publish that old result.
    if (disposed || request !== generation || active.signal.aborted) return;
    validateAudioWav(result);
    appendHistory({ result, settings });
  } catch (error) {
    if (disposed || request !== generation) return;
    const code = errorCode({ error });
    if (active.signal.aborted || code === 'aborted') stopped.value = true;
    else failure.value = code;
  } finally {
    if (!disposed && request === generation) {
      if (active.signal.aborted) stopped.value = true;
      controller.value = undefined; stopping.value = false;
    }
  }
}
function stop(): void {
  if (!controller.value) return;
  stopping.value = true; controller.value.abort();
}
onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({ listener: ({ state: next }) => {
    state.value = next;
  } });
});
onUnmounted(() => {
  disposed = true; generation++; recovery.value?.abort(); controller.value?.abort(); unsubscribe?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="absolute inset-0 overflow-y-auto overscroll-y-contain" data-testid="audio-generation-scroll">
    <main tw-class="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-8 text-gray-900 dark:text-gray-100" data-testid="audio-generation-page">
      <header tw-class="space-y-3">
        <h1 tw-class="flex items-center gap-3 text-2xl font-semibold tracking-tight"><AudioLinesIcon tw-class="h-7 w-7 text-purple-500" />{{ lazyStrings.audioGeneration__audio_generation() }}</h1>
        <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__introduction() }}</p>
      </header>
      <details :open="models.length === 0" tw-class="rounded-2xl border border-gray-200 dark:border-gray-700 p-4 sm:p-5" data-testid="audio-model-manager">
        <summary tw-class="cursor-pointer text-sm font-semibold">{{ lazyStrings.audioGeneration__manage_models_and_runtime() }}</summary>
        <div tw-class="mt-4 max-h-[65dvh] min-h-0 overflow-y-auto overscroll-y-contain space-y-4 pr-2" data-testid="audio-model-manager-scroll">
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__model_setup_help() }}</p>
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__model_support_help() }}</p>
          <LlamaCppBrowserManager ref="manager" suggestions="none" @models-changed="updateModels({ entries: $event })" @model-selected="selectModel({ name: $event })" @runtime-ready="runtimeReady = $event">
            <template #catalog="{ disabled, inspect }">
              <LlamaCppBrowserRepositoryCatalog :entries="audioModelCatalog" :disabled="disabled" @inspect="inspect({ input: $event })" />
            </template>
          </LlamaCppBrowserManager>
        </div>
      </details>
      <form ref="form" novalidate @submit.prevent="generate" tw-class="space-y-5">
        <div v-if="invalid || failure" role="alert" data-testid="audio-error" tw-class="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/10 p-4 text-sm text-red-700 dark:text-red-400">
          <p>{{ errorMessage }}</p>
          <ul v-if="invalid" tw-class="mt-2 space-y-2">
            <li v-for="field in invalidFields" :key="field"><button type="button" tw-class="text-left underline" @click="revealInvalidField({ field })">{{ audioFieldLabel({ field }) }}: {{ audioFieldValidationMessage({ field }) }}</button></li>
          </ul>
          <code v-if="failure" tw-class="mt-2 block text-xs">{{ failure }}</code>
        </div>
        <fieldset :disabled="blocked" tw-class="space-y-5 disabled:opacity-60">
          <div tw-class="space-y-2">
            <label :for="`${id}-model`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__audio_model() }}</label>
            <ModelSelector :input-id="`${id}-model`" :model-value="model || undefined" :models="selectableModelIds" :model-labels="modelLabels" :loading="scanState === 'scanning'" :disabled="blocked" :invalid="invalidFields.includes('model')" :placeholder="lazyStrings.audioGeneration__choose_model()" data-testid="audio-model" data-audio-field="model" @update:model-value="chooseModel({ value: $event })" @refresh="manager?.refresh()" />
            <p v-if="scanState === 'scanning'" role="status" data-testid="audio-model-scanning" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon tw-class="h-3 w-3 animate-spin motion-reduce:animate-none" />{{ lazyStrings.audioGeneration__checking_local_model_metadata() }}</p>
            <p v-else-if="detectedCount === 0" data-testid="audio-no-detected-models" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__no_audio_models_detected() }} <button type="button" @click="showAllModels" data-testid="audio-show-all" tw-class="underline text-purple-600 dark:text-purple-400">{{ lazyStrings.audioGeneration__show_all_models() }}</button></p>
            <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__model_detection_help() }}</p>
            <details tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3" data-testid="audio-model-selection-details">
              <summary tw-class="cursor-pointer text-xs font-medium">{{ lazyStrings.audioGeneration__advanced_model_selection() }}</summary>
              <label tw-class="mt-3 flex items-start gap-2 text-sm"><input v-model="modelScope" true-value="all" false-value="detected" type="checkbox" @change="scopeChanged" data-testid="audio-all-models" />{{ lazyStrings.audioGeneration__show_all_llama_cpp_browser_models() }}</label>
              <p tw-class="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__all_models_help() }}</p>
            </details>
          </div>
          <div tw-class="space-y-2">
            <label :for="`${id}-text`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__input_text() }}</label>
            <textarea :id="`${id}-text`" v-model="text" required maxlength="8192" rows="5" :placeholder="lazyStrings.audioGeneration__input_placeholder()" data-testid="audio-text" data-audio-field="text" :aria-invalid="invalidFields.includes('text') || undefined" tw-class="w-full resize-y rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 text-sm leading-relaxed" />
          </div>
          <div tw-class="space-y-2">
            <label :for="`${id}-language`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__language() }}</label>
            <select :id="`${id}-language`" v-model="parameters.language" :aria-describedby="`${id}-language-help`" data-testid="audio-language" data-audio-field="language" :aria-invalid="invalidFields.includes('language') || undefined" tw-class="w-full sm:w-64 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 text-sm">
              <option value="default">{{ lazyStrings.audioGeneration__model_default() }}</option>
              <option v-for="language in languages" :key="language.value" :value="language.value">{{ language.label }}</option>
            </select>
            <p :id="`${id}-language-help`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__language_help() }}</p>
          </div>
          <div tw-class="space-y-2">
            <label :for="`${id}-reference`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__reference_voice() }}</label>
            <input :id="`${id}-reference`" ref="referenceInput" type="file" accept=".wav,.mp3,.flac,audio/wav,audio/mpeg,audio/flac" :aria-describedby="`${id}-reference-help`" data-testid="audio-reference" data-audio-field="reference" :aria-invalid="invalidFields.includes('reference') || undefined" tw-class="block w-full text-sm" @change="chooseReference({ event: $event })" />
            <button v-if="reference" type="button" @click="clearReference" data-testid="audio-clear-reference" tw-class="text-xs text-purple-600 dark:text-purple-400 underline">{{ lazyStrings.audioGeneration__clear_reference() }}</button>
            <p :id="`${id}-reference-help`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__reference_help() }}</p>
          </div>
          <details tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.audioGeneration__advanced_settings() }}</summary>
            <div tw-class="pt-4 space-y-4">
              <div tw-class="space-y-2">
                <label :for="`${id}-backend`" tw-class="block text-sm">{{ lazyStrings.audioGeneration__audio_processor() }}</label>
                <select :id="`${id}-backend`" v-model="parameters.audioBackend" data-testid="audio-backend" data-audio-field="audioBackend" :aria-invalid="invalidFields.includes('audioBackend') || undefined" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-sm">
                  <option value="cpu">{{ lazyStrings.audioGeneration__cpu_audio() }}</option>
                  <option value="profile">{{ lazyStrings.audioGeneration__runtime_audio() }}</option>
                </select>
                <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__processor_help() }}</p>
              </div>
              <div tw-class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__context_tokens() }}</span><input v-model.number="parameters.contextTokens" type="number" min="1024" step="1" required data-testid="audio-context" data-audio-field="contextTokens" :aria-invalid="invalidFields.includes('contextTokens') || undefined" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /><span v-if="fieldError({ field: 'contextTokens' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'contextTokens' }) }}</span></label>
                <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__maximum_steps() }}</span><input v-model.number="parameters.maxFrames" type="number" min="1" max="2048" step="1" required data-testid="audio-max-frames" data-audio-field="maxFrames" :aria-invalid="invalidFields.includes('maxFrames') || undefined" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /><span v-if="fieldError({ field: 'maxFrames' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'maxFrames' }) }}</span></label>
                <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_temperature() }}</span><input v-model.number="parameters.temperature" data-testid="audio-temperature" data-audio-field="temperature" :aria-invalid="invalidFields.includes('temperature') || undefined" type="number" min="0" max="2" step="any" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /><span v-if="fieldError({ field: 'temperature' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'temperature' }) }}</span></label>
                <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_top_k() }}</span><input v-model.number="parameters.topK" data-testid="audio-top-k" data-audio-field="topK" :aria-invalid="invalidFields.includes('topK') || undefined" type="number" min="1" max="256" step="1" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /><span v-if="fieldError({ field: 'topK' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'topK' }) }}</span></label>
                <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_top_p() }}</span><input v-model.number="parameters.topP" data-testid="audio-top-p" data-audio-field="topP" :aria-invalid="invalidFields.includes('topP') || undefined" type="number" min="0" max="1" step="any" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /><span v-if="fieldError({ field: 'topP' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'topP' }) }}</span></label>
                <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__seed() }}</span><input v-model.number="parameters.seed" data-testid="audio-seed" data-audio-field="seed" :aria-invalid="invalidFields.includes('seed') || undefined" type="number" min="0" max="4294967295" step="1" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /><span v-if="fieldError({ field: 'seed' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'seed' }) }}</span></label>
              </div>
              <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__context_help() }}</p>
              <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__step_limit_help() }}</p>
              <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__sampling_help() }}</p>
              <label tw-class="flex items-center gap-2 text-sm"><input v-model="debug" type="checkbox" />{{ lazyStrings.audioGeneration__native_diagnostics() }}</label>
            </div>
          </details>
        </fieldset>
        <div tw-class="flex flex-wrap items-center gap-3">
          <button type="submit" :disabled="!canGenerate" data-testid="audio-generate" tw-class="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"><AudioLinesIcon tw-class="h-4 w-4" />{{ lazyStrings.audioGeneration__generate_audio() }}</button>
          <button v-if="busy" type="button" :disabled="stopping" @click="stop" data-testid="audio-stop" tw-class="rounded-xl border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm disabled:opacity-50">{{ lazyStrings.audioGeneration__stop_generation() }}</button>
          <button type="button" :disabled="blocked" @click="restartRuntime" data-testid="audio-restart-runtime" tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"><RefreshCcwIcon :tw-class="['h-4 w-4', { 'animate-spin motion-reduce:animate-none': recovery !== undefined }]" />{{ recovery ? lazyStrings.audioGeneration__reinitializing_runtime() : lazyStrings.audioGeneration__reinitialize_runtime() }}</button>
          <p v-if="!runtimeReady" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__runtime_unavailable() }}</p>
        </div>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__reinitialize_runtime_help() }}</p>
        <p v-if="busy" role="status" data-testid="audio-progress" tw-class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2Icon tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ progressLabel }}</p>
        <p v-if="stopped" role="status" data-testid="audio-stopped" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__generation_stopped() }}</p>

      </form>
      <section v-if="history.length" tw-class="space-y-4" data-testid="audio-history">
        <div tw-class="flex flex-wrap items-center justify-between gap-3">
          <h2 tw-class="text-lg font-semibold">{{ lazyStrings.audioGeneration__generated_audio() }}</h2>
          <button type="button" @click="clearHistory" data-testid="audio-delete-all" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800">{{ lazyStrings.audioGeneration__delete_all_audio() }}</button>
        </div>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="audio-history-usage">{{ lazyStrings.audioGeneration__history_memory_usage({ count: history.length, mebibytes: (totalBytes / (1024 * 1024)).toFixed(2) }) }}</p>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__output_lifetime() }}</p>
        <AudioHistoryResult v-for="entry in history" :key="entry.id" :entry="entry" @remove="removeHistory({ id: $event })" />
      </section>
    </main>
  </div>
</template>
