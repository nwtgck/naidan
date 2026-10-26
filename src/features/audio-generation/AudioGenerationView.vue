<script setup lang="ts">
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useId } from 'vue';
import { AudioLinesIcon, ChevronRightIcon, FolderOpenIcon, Loader2Icon, RefreshCcwIcon, SlidersHorizontalIcon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import { audioLanguageOptions, defaultAudioLanguage } from './languages';
import { audioFieldLabel, audioFieldValidationMessage, audioValidationFields } from './validation';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, type EngineState, type ErrorCode } from '@/features/llama-cpp-browser/types';
import { audioGenerationInputSchema, audioGenerationResultSchema, audioGenerationPreviewSchema, defaultAudioParameters } from './types';
import { createAudioPreviewRequests } from './preview-requests';
import { validateAudioWav } from './wav';
import { inspectStoredAudioModel } from './model-detection';
import { useAudioModels } from './composables/useAudioModels';
import { captureAudioSettings, useAudioHistory } from './composables/useAudioHistory';
import AudioHistoryResult from './components/AudioHistoryResult.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import LlamaCppBrowserModelSuggestions from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelSuggestions.vue';
import { audioModelCatalog } from './model-catalog';
import AudioReferenceInput from './components/AudioReferenceInput.vue';

const id = useId();
const manager = ref<InstanceType<typeof LlamaCppBrowserManager>>();
const recovery = shallowRef<AbortController>();
const { models, modelId, scope: modelScope, scanState, visibleModels, detectedCount, detections,
  updateModels, selectModel, selectionChanged, scopeChanged, showAllModels } = useAudioModels({ inspect: inspectStoredAudioModel });
const { entries: history, totalBytes, append: appendHistory, remove: removeHistory, clear: clearHistory } = useAudioHistory();
const text = ref('');
const referenceInput = ref<InstanceType<typeof AudioReferenceInput>>();
const referenceBusy = ref(false);
const preparingReference = ref(false);
const parameters = ref<ReturnType<typeof defaultAudioParameters>>({ ...defaultAudioParameters(), language: defaultAudioLanguage({ locale: currentLocale.value }) });
const form = ref<HTMLFormElement>();
const debug = ref(false);
const advancedSettingsOpen = ref(false);
const advancedSettingsTrigger = ref<HTMLElement>();

function toggleAdvancedSettings({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) {
    advancedSettingsOpen.value = event.target.open;
  }
}

const runtimeReady = ref(false);
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const controller = shallowRef<AbortController>();
const completionController = shallowRef<AbortController>();
const previews = shallowRef<ReturnType<typeof createAudioPreviewRequests>>();
const previewPending = ref(false);
const finishing = ref(false);
const stopping = ref(false);
const canFinish = computed(() => busy.value && !preparingReference.value && !stopping.value && !finishing.value && state.value.status === 'working' && state.value.progress.phase === 'generating' && state.value.progress.completed > 0);
const stopped = ref(false);
const invalidFields = ref<string[]>([]);
const invalid = computed(() => invalidFields.value.length > 0);
const failure = ref<ErrorCode>();
const busy = computed(() => controller.value !== undefined);
const blocked = computed(() => recovery.value !== undefined || busy.value || state.value.status === 'working');
const canGenerate = computed(() => !blocked.value && !referenceBusy.value && runtimeReady.value && models.value.some(entry => entry.modelId === modelId.value));
let disposed = false;
let generation = 0;
let unsubscribe: (() => void) | undefined;

const selectableModelIds = computed(() => visibleModels.value.map(entry => entry.modelId));
const selectedDetection = computed(() => detections.value.get(modelId.value));

function chooseModel({ value }: { value: string | undefined }): void {
  if (blocked.value || value === undefined || !selectableModelIds.value.includes(value)) {
    return;
  }
  modelId.value = value;
  selectionChanged();
}

async function restartRuntime(): Promise<void> {
  if (blocked.value || disposed) {
    return;
  }
  const controller = new AbortController();
  recovery.value = controller;
  try {
    await llamaCppBrowserService.restartRuntime({ signal: controller.signal });
    if (!disposed && !controller.signal.aborted) {
      failure.value = undefined;
      stopped.value = false;
    }
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      failure.value = errorCode({ error });
    }
  } finally {
    if (!disposed && recovery.value === controller) {
      recovery.value = undefined;
    }
  }
}

const languages = computed(() => audioLanguageOptions({ locale: currentLocale.value }));
const progressLabel = computed(() => {
  if (preparingReference.value && !stopping.value) {
    return lazyStrings.audioGeneration__preparing_references();
  }
  if (stopping.value) {
    return lazyStrings.audioGeneration__stopping();
  }
  if (finishing.value && !(state.value.status === 'working' && state.value.progress.phase === 'decoding-audio')) {
    return lazyStrings.audioGeneration__finishing_current_step();
  }
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
    default: {
      const exhaustive: never = progress.phase;
      throw new Error(String(exhaustive));
    }
    }
  }
  default: {
    const exhaustive: never = current;
    throw new Error(String(exhaustive));
  }
  }
});
const errorMessage = computed(() => {
  if (invalid.value) {
    return lazyStrings.audioGeneration__check_parameters();
  }
  const code = failure.value;
  switch (code) {
  case 'audio-model-unsupported': return lazyStrings.audioGeneration__unsupported_model();
  case 'audio-reference-required': return lazyStrings.audioGeneration__reference_required();
  case 'audio-reference-invalid': return lazyStrings.audioGeneration__invalid_reference();
  case 'audio-output-empty': return lazyStrings.audioGeneration__empty_audio();
  case 'context-full': return lazyStrings.audioGeneration__context_full();
  case undefined: return undefined;
  case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error':
  case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'unsupported-input': case 'busy': case 'aborted': case 'worker-failed':
    return lazyStrings.audioGeneration__generation_failed();
  default: {
    const exhaustive: never = code;
    throw new Error(String(exhaustive));
  }
  }
});

function fieldError({ field }: { field: string }): string | undefined {
  return invalidFields.value.includes(field) ? audioFieldValidationMessage({ field }) : undefined;
}

function revealInvalidField({ field }: { field: string }): void {
  // Open collapsed ancestors before focus. Native form validation cannot focus a
  // hidden number input and otherwise reports only "not focusable" in the console.
  const element = form.value?.querySelector<HTMLElement>(`[data-audio-field="${field}"]`);
  if (!element) {
    return;
  }
  let parent = element.parentElement;
  while (parent && parent !== form.value) {
    if (parent instanceof HTMLDetailsElement) {
      parent.open = true;
    }
    parent = parent.parentElement;
  }
  // ModelSelector owns a button rather than a native select.
  const focusTarget = element.matches('input,select,textarea,button') ? element : element.querySelector<HTMLElement>('button');
  focusTarget?.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: 'nearest' });
}

async function generate(): Promise<void> {
  if (!canGenerate.value) {
    return;
  }
  failure.value = undefined;
  invalidFields.value = [];
  stopped.value = false;
  const accepted = audioGenerationInputSchema.safeParse({ ...parameters.value, modelId: modelId.value, text: text.value, reference: undefined, debug: debug.value ? 'on' : 'off', options: llamaCppBrowserService.getOptions() });
  if (!accepted.success) {
    invalidFields.value = audioValidationFields({ issues: accepted.error.issues });
    await nextTick();
    revealInvalidField({ field: invalidFields.value[0] ?? 'input' });
    return;
  }
  const { options: _options, ...input } = accepted.data;
  const request = ++generation;
  const active = new AbortController();
  controller.value = active;
  stopping.value = false;
  const completion = new AbortController();
  completionController.value = completion;
  finishing.value = false;
  const captures = createAudioPreviewRequests();
  previews.value = captures;
  previewPending.value = false;
  const settings = captureAudioSettings({ input: accepted.data });
  try {
    preparingReference.value = true;
    const reference = await referenceInput.value?.prepare({ signal: active.signal });
    active.signal.throwIfAborted();
    preparingReference.value = false;
    const result = audioGenerationResultSchema.parse(await llamaCppBrowserService.generateAudio({
      input: { ...input, reference },
      cancellationSignal: active.signal,
      completionSignal: completion.signal,
      preview: {
        requests: captures.requests,
        onPreview: ({ event: { result: incoming, requestVersion } }) => {
          if (disposed || request !== generation || active.signal.aborted) {
            return;
          }
          const result = audioGenerationPreviewSchema.parse(incoming);
          validateAudioWav(result);
          appendHistory({ result, settings });
          if (requestVersion >= captures.requests.version) {
            previewPending.value = false;
          }
        },
      },
    }));
    // An RPC may finish after Stop or route unmount. Never publish that old result.
    if (disposed || request !== generation || active.signal.aborted) {
      return;
    }
    validateAudioWav(result);
    appendHistory({ result, settings });
  } catch (error) {
    if (disposed || request !== generation) {
      return;
    }
    const code = errorCode({ error });
    if (active.signal.aborted || code === 'aborted') {
      stopped.value = true;
    } else {
      failure.value = preparingReference.value ? 'audio-reference-invalid' : code;
    }
  } finally {
    if (!disposed && request === generation) {
      if (active.signal.aborted) {
        stopped.value = true;
      }
      preparingReference.value = false;
      controller.value = undefined;
      completionController.value = undefined;
      previews.value = undefined;
      previewPending.value = false;
      stopping.value = false;
      finishing.value = false;
    }
  }
}

function capturePreview(): void {
  if (!canFinish.value || previewPending.value || !previews.value) {
    return;
  }
  previewPending.value = true;
  previews.value.request();
}

function finishAudio(): void {
  if (!canFinish.value) {
    return;
  }
  finishing.value = true;
  previewPending.value = false;
  completionController.value?.abort();
}

function stop(): void {
  if (!controller.value) {
    return;
  }
  stopping.value = true;
  controller.value.abort();
}

onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({
    listener: ({ state: next }) => {
      state.value = next;
    },
  });
});
onUnmounted(() => {
  disposed = true;
  generation++;
  recovery.value?.abort();
  controller.value?.abort();
  unsubscribe?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="absolute inset-0 overflow-y-auto overscroll-y-contain bg-[#fcfcfd] dark:bg-gray-900" data-testid="audio-generation-scroll">
    <main tw-class="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 text-gray-900 sm:px-8 sm:py-8 dark:text-gray-100" data-testid="audio-generation-page">
      <header tw-class="space-y-3 pb-2">
        <h1 tw-class="flex items-center gap-3 text-xl font-semibold tracking-tight"><span tw-class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><AudioLinesIcon aria-hidden="true" tw-class="h-5 w-5" /></span>{{ lazyStrings.audioGeneration__audio_generation() }}</h1>
        <p tw-class="max-w-2xl text-xs leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__introduction() }}</p>
      </header>
      <LlamaCppBrowserModelSuggestions :suggestions="audioModelCatalog" :models="models" :disabled="blocked" :default-model="undefined" :default-action-disabled="blocked" selection-action="select" memory-filter="hide" @select="selectModel({ modelId: $event.modelId })" />
      <details :open="models.length === 0" tw-class="group/audio-manager overflow-hidden rounded-xl border border-gray-200/70 bg-white/60 dark:border-gray-800/80 dark:bg-gray-900/20" data-testid="audio-model-manager">
        <summary tw-class="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 dark:text-gray-200 dark:hover:bg-gray-800/40 [&::-webkit-details-marker]:hidden"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span tw-class="min-w-0 flex-1">{{ lazyStrings.audioGeneration__manage_models_and_runtime() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-6 w-6 shrink-0 rounded-lg bg-gray-100/70 p-1.5 text-gray-400 transition-transform duration-200 group-open/audio-manager:rotate-90 group-open/audio-manager:bg-blue-50 group-open/audio-manager:text-blue-500 motion-reduce:transition-none dark:bg-gray-800 dark:group-open/audio-manager:bg-blue-500/10" /></summary>
        <div tw-class="max-h-[65dvh] min-h-0 space-y-4 overflow-y-auto overscroll-y-contain border-t border-gray-100 p-4 dark:border-gray-800" data-testid="audio-model-manager-scroll">
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__model_setup_help() }}</p>
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__model_support_help() }}</p>
          <LlamaCppBrowserManager ref="manager" presentation="embedded" suggestions="none" @models-changed="updateModels({ entries: $event })" @model-selected="selectModel({ modelId: $event })" @runtime-ready="runtimeReady = $event" />
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
        <fieldset :disabled="blocked" tw-class="min-w-0 space-y-5 rounded-2xl border border-gray-200/70 bg-white/70 p-4 disabled:opacity-60 sm:p-5 dark:border-gray-800/80 dark:bg-gray-900/40">
          <div tw-class="space-y-2">
            <label :for="`${id}-model`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__audio_model() }}</label>
            <ModelSelector :input-id="`${id}-model`" :model-value="modelId || undefined" :models="selectableModelIds" :loading="scanState === 'scanning'" :disabled="blocked" :invalid="invalidFields.includes('modelId')" :placeholder="lazyStrings.audioGeneration__choose_model()" data-testid="audio-model" data-audio-field="modelId" @update:model-value="chooseModel({ value: $event })" @refresh="manager?.refresh()" />
            <p v-if="scanState === 'scanning'" role="status" data-testid="audio-model-scanning" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon tw-class="h-3 w-3 animate-spin motion-reduce:animate-none" />{{ lazyStrings.audioGeneration__checking_local_model_metadata() }}</p>
            <p v-else-if="detectedCount === 0" data-testid="audio-no-detected-models" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__no_audio_models_detected() }} <button type="button" @click="showAllModels" data-testid="audio-show-all" tw-class="underline text-blue-600 dark:text-blue-400">{{ lazyStrings.audioGeneration__show_all_models() }}</button></p>
            <p v-if="selectedDetection?.status === 'unverified'" data-testid="audio-model-unverified" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__not_detected_as_audio() }}</p>
            <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__model_detection_help() }}</p>
            <details tw-class="group/audio-selection rounded-lg bg-gray-50/80 px-3 py-2.5 dark:bg-gray-800/35" data-testid="audio-model-selection-details">
              <summary tw-class="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-gray-500 outline-none focus-visible:text-blue-600 dark:text-gray-400 [&::-webkit-details-marker]:hidden"><span tw-class="flex-1">{{ lazyStrings.audioGeneration__advanced_model_selection() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-3 w-3 text-gray-400 transition-transform duration-200 group-open/audio-selection:rotate-90 motion-reduce:transition-none" /></summary>
              <label tw-class="mt-3 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-1 text-xs leading-5 text-gray-600 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="modelScope" true-value="all" false-value="detected" type="checkbox" @change="scopeChanged" data-testid="audio-all-models" /></SettingsChoiceControl>{{ lazyStrings.audioGeneration__show_all_llama_cpp_browser_models() }}</label>
              <p tw-class="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__all_models_help() }}</p>
            </details>
          </div>
          <div tw-class="rounded-xl border border-gray-200/80 bg-gray-50/40 px-3.5 pb-2 pt-3 transition-colors hover:border-gray-300 focus-within:border-blue-400/70 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/20 dark:hover:border-gray-600 dark:focus-within:bg-gray-900">
            <label :for="`${id}-text`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__input_text() }}</label>
            <textarea :id="`${id}-text`" v-model="text" required maxlength="8192" rows="5" :placeholder="lazyStrings.audioGeneration__input_placeholder()" data-testid="audio-text" data-audio-field="text" :aria-invalid="invalidFields.includes('text') || undefined" tw-class="mt-1 block w-full resize-y border-0 bg-transparent px-0 py-2 text-sm leading-7 text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100" />
          </div>
          <div tw-class="space-y-2">
            <label :for="`${id}-language`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__language() }}</label>
            <span tw-class="block w-full sm:max-w-xs"><SettingsFormSelect :id="`${id}-language`" v-model="parameters.language" :aria-describedby="`${id}-language-help`" data-testid="audio-language" data-audio-field="language" :aria-invalid="invalidFields.includes('language') || undefined" :options="[{ value: 'default', label: lazyStrings.audioGeneration__model_default() }, ...languages]" :label="lazyStrings.audioGeneration__language()" :disabled="blocked" /></span>
            <p :id="`${id}-language-help`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__language_help() }}</p>
          </div>
        </fieldset>
        <!-- Recording Stop/Discard must remain reachable even if another page's
             shared runtime starts working. Do not put these inside a disabled fieldset. -->
        <AudioReferenceInput ref="referenceInput" :disabled="blocked" :invalid="invalidFields.includes('reference')" @busy="referenceBusy = $event" @changed="invalidFields = []; failure = undefined" />
        <fieldset :disabled="blocked" tw-class="min-w-0 space-y-5 disabled:opacity-60">
          <details :open="advancedSettingsOpen" @toggle="toggleAdvancedSettings({ event: $event })" data-testid="audio-advanced-settings" tw-class="group/audio-settings overflow-hidden rounded-xl border border-gray-200/70 bg-white/60 dark:border-gray-800/80 dark:bg-gray-900/20">
            <summary ref="advancedSettingsTrigger" tw-class="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 dark:text-gray-200 dark:hover:bg-gray-800/40 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span tw-class="flex-1">{{ lazyStrings.audioGeneration__advanced_settings() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-6 w-6 shrink-0 rounded-lg bg-gray-100/70 p-1.5 text-gray-400 transition-transform duration-200 group-open/audio-settings:rotate-90 group-open/audio-settings:bg-blue-50 group-open/audio-settings:text-blue-500 motion-reduce:transition-none dark:bg-gray-800 dark:group-open/audio-settings:bg-blue-500/10" /></summary>
            <SettingsSelectScope :active="advancedSettingsOpen" :return-focus="advancedSettingsTrigger">
              <div tw-class="space-y-4 border-t border-gray-100 p-4 dark:border-gray-800">
                <div tw-class="space-y-2">
                  <label :for="`${id}-backend`" tw-class="block text-sm">{{ lazyStrings.audioGeneration__audio_processor() }}</label>
                  <SettingsFormSelect :id="`${id}-backend`" v-model="parameters.audioBackend" data-testid="audio-backend" data-audio-field="audioBackend" :aria-invalid="invalidFields.includes('audioBackend') || undefined" :options="[{ value: 'cpu', label: lazyStrings.audioGeneration__cpu_audio() }, { value: 'profile', label: lazyStrings.audioGeneration__runtime_audio() }]" :label="lazyStrings.audioGeneration__audio_processor()" :disabled="blocked" />
                  <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__processor_help() }}</p>
                </div>
                <div tw-class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__context_tokens() }}</span><input v-model.number="parameters.contextTokens" type="number" min="1024" step="1" required data-testid="audio-context" data-audio-field="contextTokens" :aria-invalid="invalidFields.includes('contextTokens') || undefined" tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'contextTokens' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'contextTokens' }) }}</span></label>
                  <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__maximum_steps() }}</span><input v-model.number="parameters.maxFrames" type="number" min="1" max="2048" step="1" required data-testid="audio-max-frames" data-audio-field="maxFrames" :aria-invalid="invalidFields.includes('maxFrames') || undefined" tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'maxFrames' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'maxFrames' }) }}</span></label>
                  <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_temperature() }}</span><input v-model.number="parameters.temperature" data-testid="audio-temperature" data-audio-field="temperature" :aria-invalid="invalidFields.includes('temperature') || undefined" type="number" min="0" max="2" step="any" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'temperature' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'temperature' }) }}</span></label>
                  <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_top_k() }}</span><input v-model.number="parameters.topK" data-testid="audio-top-k" data-audio-field="topK" :aria-invalid="invalidFields.includes('topK') || undefined" type="number" min="1" max="256" step="1" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'topK' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'topK' }) }}</span></label>
                  <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_top_p() }}</span><input v-model.number="parameters.topP" data-testid="audio-top-p" data-audio-field="topP" :aria-invalid="invalidFields.includes('topP') || undefined" type="number" min="0" max="1" step="any" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'topP' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'topP' }) }}</span></label>
                  <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__seed() }}</span><input v-model.number="parameters.seed" data-testid="audio-seed" data-audio-field="seed" :aria-invalid="invalidFields.includes('seed') || undefined" type="number" min="0" max="4294967295" step="1" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'seed' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'seed' }) }}</span></label>
                </div>
                <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__context_help() }}</p>
                <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__step_limit_help() }}</p>
                <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__sampling_help() }}</p>
                <label tw-class="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg bg-gray-50/70 px-3 text-xs text-gray-600 dark:bg-gray-800/30 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="debug" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.audioGeneration__native_diagnostics() }}</label>
              </div>
            </SettingsSelectScope>
          </details>
        </fieldset>
        <div tw-class="flex flex-wrap items-center gap-3">
          <button type="submit" :disabled="!canGenerate" data-testid="audio-generate" tw-class="inline-flex min-h-11 items-center justify-center gap-2.5 rounded-xl border px-5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-45 border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-100 dark:hover:border-blue-400/60 dark:hover:bg-gray-800"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ lazyStrings.audioGeneration__generate_audio() }}</button>
          <button v-if="busy" type="button" :disabled="!canFinish || previewPending" @click="capturePreview" data-testid="audio-preview" tw-class="inline-flex min-h-10 items-center gap-2 rounded-lg border border-gray-200 bg-white/70 px-3.5 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-200 dark:hover:bg-gray-800"><Loader2Icon v-if="previewPending" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.audioGeneration__capture_preview() }}</button>
          <button v-if="busy" type="button" :disabled="!canFinish" @click="finishAudio" data-testid="audio-finish" tw-class="min-h-10 rounded-lg border border-gray-200 bg-white/70 px-3.5 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-200 dark:hover:bg-gray-800">{{ lazyStrings.audioGeneration__finish_and_keep_audio() }}</button>
          <button v-if="busy" type="button" :disabled="stopping" @click="stop" data-testid="audio-stop" tw-class="min-h-10 rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 disabled:opacity-45 dark:border-gray-700/70 dark:text-gray-400 dark:hover:bg-gray-800">{{ lazyStrings.audioGeneration__cancel_and_discard() }}</button>
          <button type="button" :disabled="blocked" @click="restartRuntime" data-testid="audio-restart-runtime" tw-class="inline-flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"><RefreshCcwIcon :tw-class="['h-4 w-4', { 'animate-spin motion-reduce:animate-none': recovery !== undefined }]" />{{ recovery ? lazyStrings.audioGeneration__reinitializing_runtime() : lazyStrings.audioGeneration__reinitialize_runtime() }}</button>
          <p v-if="!runtimeReady" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__runtime_unavailable() }}</p>
        </div>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__reinitialize_runtime_help() }}</p>
        <p v-if="busy" role="status" data-testid="audio-progress" tw-class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2Icon tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ progressLabel }}</p>
        <p v-if="busy" data-testid="audio-preview-help" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__preview_help() }}</p>
        <p v-if="previewPending && !finishing && !stopping" role="status" data-testid="audio-preview-pending" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.audioGeneration__preview_pending() }}</p>
        <p v-if="busy" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__finish_audio_help() }}</p>
        <p v-if="stopped" role="status" data-testid="audio-stopped" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__generation_stopped() }}</p>

      </form>
      <section v-if="history.length" tw-class="space-y-3 border-t border-gray-100 pt-6 dark:border-gray-800" data-testid="audio-history">
        <div tw-class="flex flex-wrap items-center justify-between gap-3">
          <h2 tw-class="text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.audioGeneration__generated_audio() }}</h2>
          <button type="button" @click="clearHistory" data-testid="audio-delete-all" tw-class="min-h-9 rounded-lg px-3 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 dark:text-gray-400 dark:hover:bg-red-500/10 dark:hover:text-red-400">{{ lazyStrings.audioGeneration__delete_all_audio() }}</button>
        </div>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="audio-history-usage">{{ lazyStrings.audioGeneration__history_memory_usage({ count: history.length, mebibytes: (totalBytes / (1024 * 1024)).toFixed(2) }) }}</p>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__output_lifetime() }}</p>
        <AudioHistoryResult v-for="entry in history" :key="entry.id" :entry="entry" @remove="removeHistory({ id: $event })" />
      </section>
    </main>
  </div>
</template>
