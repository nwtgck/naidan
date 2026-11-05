<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { ArrowLeftRightIcon, ChevronRightIcon, CopyIcon, ChevronDownIcon, FilePenLineIcon, LanguagesIcon, Loader2Icon, PlusIcon, SlidersHorizontalIcon, SquareIcon, Trash2Icon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import { useSettings } from '@/composables/useSettings';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { splitModelName } from '@/utils/model-name';
import TranslationModelPanel from './TranslationModelPanel.vue';
import LlamaCppBrowserModelLoadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLoadProgress.vue';
import { useAutomaticTranslation } from '@/features/translation/composables/useAutomaticTranslation';
import { useTranslationLanguages } from '@/features/translation/composables/useTranslationLanguages';
import type { EngineState } from '@/features/llama-cpp-browser/types';
import { useTranslationPreferences } from '@/features/translation/composables/useTranslationPreferences';
import { useTranslationSession } from '@/features/translation/composables/useTranslationSession';
import { inspectStoredTranslationModel } from '@/features/translation/model-detection';
import { translationProfile } from '@/features/translation/profiles';
import { registerTranslationNavigation } from '@/features/translation/navigation';
import type { TranslationDetection, TranslationGlossaryEntry, TranslationIssue } from '@/features/translation/types';

const props = defineProps<{ tab: 'workspace' | 'models' }>();
const emit = defineEmits<{ openWorkspace: [], openModels: [] }>();
const id = useId();
const store = useSettings();
const { preferences, saving, failed: saveFailed, save } = useTranslationPreferences({ store });
const { phase, output, progress, issue, failure, busy, translate, stop, reset } = useTranslationSession({ service: llamaCppBrowserService, inspectModel: inspectStoredTranslationModel });
const text = ref('');
const context = ref('');
const glossary = ref<TranslationGlossaryEntry[]>([]);
const form = ref<'default' | 'polite' | 'plain'>('default');
const detailsOpen = ref(false);
const detailsTrigger = ref<HTMLElement>();
const sourceInput = ref<HTMLTextAreaElement>();
const outputElement = ref<HTMLElement>();
const copied = ref<'idle' | 'copied' | 'failed'>('idle');
const modelTrigger = ref<HTMLElement>();
const composing = ref(false);
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const selectedDetection = shallowRef<TranslationDetection>();
const inspecting = ref(false);
const checkingSelection = ref(false);
const modelFailure = ref<'unreadable' | 'unsupported'>();
const selectionFailure = ref<'unreadable' | 'unsupported'>();
let inspection: AbortController | undefined;
let selection: AbortController | undefined;
let disposed = false;
let storageCurrent = store.initialized.value ? store.captureExperimentalStorage() : undefined;
const modelId = computed(() => preferences.value?.modelId);
const autoTranslate = computed(() => preferences.value?.autoTranslate !== false);
const modelParts = computed(() => splitModelName({ name: modelId.value }));
const profile = computed(() => {
  const detection = selectedDetection.value;
  if (detection === undefined) {
    return undefined;
  }
  switch (detection.status) {
  case 'supported': return translationProfile({ id: detection.profileId });
  case 'unsupported': return undefined;
  default: {
    const exhaustive: never = detection;
    throw new Error(String(exhaustive));
  }
  }
});
const languages = useTranslationLanguages({ defaultTarget: computed(() => profile.value?.defaultTargetLanguage ?? 'ja') });
const { sourceLang, targetLang, invalid: invalidLanguages, changing: changingLanguages, failed: languageFailure } = languages;
const drawer = computed(() => props.tab === 'models' && !!modelId.value);
const catalogOpen = computed(() => !modelId.value || modelFailure.value !== undefined || props.tab === 'models');
const blocked = computed(() => saving.value || checkingSelection.value || changingLanguages.value || !store.initialized.value);
const canTranslate = computed(() => !blocked.value && !inspecting.value && !catalogOpen.value && !invalidLanguages.value && state.value.status !== 'unavailable' && state.value.status !== 'working' && !!profile.value && !!modelId.value && !!text.value.trim());
const canSwap = computed(() => !blocked.value && sourceLang.value !== undefined && profile.value?.sourceLanguages.includes(targetLang.value) === true && profile.value.targetLanguages.includes(sourceLang.value));
const options = computed(() => {
  const names = new Intl.DisplayNames([currentLocale.value], { type: 'language' });
  const label = ({ code }: { code: string }) => code === 'ja(easy)' ? lazyStrings.translation__easy_japanese() : names.of(code) ?? code;
  const sources = (profile.value?.sourceLanguages ?? []).map(value => ({ value, label: label({ code: value }) }));
  const targets = (profile.value?.targetLanguages ?? []).map(value => ({ value, label: label({ code: value }) }));
  // URL language choices from another profile are never silently rewritten.
  if (sourceLang.value && !sources.some(option => option.value === sourceLang.value)) {
    sources.push({ value: sourceLang.value, label: sourceLang.value });
  }
  if (!targets.some(option => option.value === targetLang.value)) {
    targets.push({ value: targetLang.value, label: targetLang.value });
  }
  return { sources: [{ value: '', label: lazyStrings.translation__detect_language(), disabled: profile.value?.sourceDetection === 'unavailable' }, ...sources], targets };
});
const formOptions = computed(() => [
  { value: 'default' as const, label: lazyStrings.translation__default_style() },
  { value: 'polite' as const, label: lazyStrings.translation__polite_style() },
  { value: 'plain' as const, label: lazyStrings.translation__plain_style() },
]);
const statusLabel = computed(() => {
  switch (phase.value) {
  case 'idle': return undefined;
  case 'checking': return lazyStrings.translation__checking_model();
  case 'preparing': return lazyStrings.translation__preparing_model();
  case 'prefill': return lazyStrings.translation__processing_source();
  case 'generating': return lazyStrings.translation__translating();
  case 'stopping': return lazyStrings.translation__stopping();
  case 'complete': return undefined;
  case 'stopped': return lazyStrings.translation__translation_stopped();
  case 'truncated': return lazyStrings.translation__translation_truncated();
  case 'error': return lazyStrings.translation__translation_failed();
  default: {
    const exhaustive: never = phase.value;
    throw new Error(String(exhaustive));
  }
  }
});
const issueLabel = computed(() => {
  const value: TranslationIssue | undefined = issue.value;
  switch (value) {
  case undefined: return undefined;
  case 'empty-source': return lazyStrings.translation__enter_source_text();
  case 'unsupported-source': case 'unsupported-target': return lazyStrings.translation__choose_supported_languages();
  case 'reserved-token': return lazyStrings.translation__reserved_tokens_not_allowed();
  case 'incomplete-glossary': return lazyStrings.translation__complete_glossary_entries();
  case 'unsupported-model': return lazyStrings.translation__unsupported_model();
  case 'unexpected-output': return lazyStrings.translation__unexpected_model_output();
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
});
const progressFraction = computed(() => {
  const value = progress.value;
  // A generation token limit is not the length of the eventual translation.
  if (!value || !['loading', 'prefill'].includes(value.phase) || value.total <= 0) {
    return undefined;
  }
  return Math.min(1, value.completed / value.total);
});

async function inspectSelected(): Promise<void> {
  inspection?.abort();
  selectedDetection.value = undefined;
  modelFailure.value = undefined;
  inspecting.value = false;
  const selected = modelId.value;
  if (disposed || !selected || !store.initialized.value) {
    return;
  }
  const controller = new AbortController();
  inspection = controller;
  inspecting.value = true;
  try {
    const found = await inspectStoredTranslationModel({ modelId: selected, signal: controller.signal });
    if (disposed || controller.signal.aborted || inspection !== controller) {
      return;
    }
    selectedDetection.value = found;
    switch (found.status) {
    case 'supported': break;
    case 'unsupported': modelFailure.value = 'unsupported';
      break;
    default: {
      const exhaustive: never = found;
      throw new Error(String(exhaustive));
    }
    }
  } catch {
    if (!disposed && !controller.signal.aborted && inspection === controller) {
      modelFailure.value = 'unreadable';
    }
  } finally {
    if (inspection === controller) {
      inspecting.value = false;
    }
  }
}

async function selectModel({ selected }: { selected: string }): Promise<void> {
  if (blocked.value || busy.value || disposed) {
    return;
  }
  const controller = new AbortController();
  selection?.abort();
  selection = controller;
  checkingSelection.value = true;
  selectionFailure.value = undefined;
  const isCurrent = store.captureExperimentalStorage();
  try {
    const found = await inspectStoredTranslationModel({ modelId: selected, signal: controller.signal });
    if (disposed || controller.signal.aborted || !isCurrent()) {
      return;
    }
    switch (found.status) {
    case 'supported': break;
    case 'unsupported': selectionFailure.value = 'unsupported';
      return;
    default: {
      const exhaustive: never = found;
      throw new Error(String(exhaustive));
    }
    }
    if (await save({ patch: { modelId: selected } }) && !disposed && !controller.signal.aborted && isCurrent()) {
      // The current draft belongs to the workspace, not to the model picker.
      reset();
      emit('openWorkspace');
    }
  } catch {
    if (!disposed && !controller.signal.aborted && isCurrent()) {
      selectionFailure.value = 'unreadable';
    }
  } finally {
    if (selection === controller) {
      checkingSelection.value = false;
    }
  }
}

async function chooseLanguage({ side, value }: { side: 'source' | 'target', value: string }): Promise<void> {
  if (blocked.value) {
    return;
  }
  switch (side) {
  case 'source': await languages.choose({ source: value || undefined, target: targetLang.value });
    break;
  case 'target': await languages.choose({ source: sourceLang.value, target: value });
    break;
  default: {
    const exhaustive: never = side;
    throw new Error(String(exhaustive));
  }
  }
}

async function changeAutomatic({ event }: { event: Event }): Promise<void> {
  if (event.target instanceof HTMLInputElement) {
    const next = event.target.checked;
    // Keep the control honest while settings are being written or after failure.
    event.target.checked = autoTranslate.value;
    await save({ patch: { autoTranslate: next } });
  }
}

async function swapLanguages(): Promise<void> {
  const source = sourceLang.value;
  if (!canSwap.value || source === undefined) {
    return;
  }
  const acceptedText = text.value;
  const translated = (() => {
    switch (phase.value) {
    case 'complete': return output.value;
    case 'idle': case 'checking': case 'preparing': case 'prefill': case 'generating':
    case 'stopping': case 'stopped': case 'truncated': case 'error': return undefined;
    default: {
      const exhaustive: never = phase.value;
      throw new Error(String(exhaustive));
    }
    }
  })();
  if (await languages.choose({ source: targetLang.value, target: source })) {
    // Route guards can be asynchronous. Do not overwrite text entered while
    // the language change was pending with the previous translation.
    if (translated && text.value === acceptedText) {
      text.value = translated;
    }
    reset();
  }
}

async function run(): Promise<void> {
  if (!canTranslate.value || busy.value || !modelId.value) {
    return;
  }
  copied.value = 'idle';
  await translate({ draft: { modelId: modelId.value, text: text.value, sourceLang: sourceLang.value, targetLang: targetLang.value, form: form.value, context: context.value, glossary: glossary.value } });
}

function clearText(): void {
  if (blocked.value) {
    return;
  }
  text.value = '';
  reset();
  sourceInput.value?.focus();
}

function toggleDetails({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) {
    detailsOpen.value = event.target.open;
  }
}

async function copyOutput(): Promise<void> {
  const value = output.value;
  if (!value || busy.value) {
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    if (!disposed && output.value === value) {
      copied.value = 'copied';
    }
  } catch {
    if (!disposed && output.value === value) {
      copied.value = 'failed';
      outputElement.value?.focus();
    }
  }
}

watch([modelId, store.initialized], () => {
  void inspectSelected();
}, { immediate: true });
watch(() => props.tab, () => {
  // Closing the picker invalidates an in-flight selection, not the draft.
  selection?.abort();
  selectionFailure.value = undefined;
});
watch([store.settings, store.initialized], () => {
  if (!store.initialized.value) {
    return;
  }
  if (storageCurrent === undefined) {
    storageCurrent = store.captureExperimentalStorage();
  } else if (!storageCurrent()) {
    storageCurrent = store.captureExperimentalStorage();
    selection?.abort();
    reset();
    text.value = '';
    context.value = '';
    glossary.value = [];
    form.value = 'default';
    selectionFailure.value = undefined;
    saveFailed.value = false;
    void inspectSelected();
  }
});
const requestKey = computed(() => JSON.stringify({ modelId: modelId.value, text: text.value, sourceLang: sourceLang.value, targetLang: targetLang.value, invalidLanguages: invalidLanguages.value, form: form.value, context: context.value, glossary: glossary.value }));
const automatic = useAutomaticTranslation({ key: requestKey, enabled: autoTranslate, ready: canTranslate, busy, composing, run, invalidate: reset, stop });
const showRun = computed(() => !autoTranslate.value || ['error', 'stopped', 'truncated'].includes(phase.value));
watch(output, () => {
  copied.value = 'idle';
});
const unregister = registerTranslationNavigation({ navigation: { openWorkspace: () => emit('openWorkspace'), openModels: () => emit('openModels') } });
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({
    listener: ({ state: next }) => {
      state.value = next;
    },
  });
});
onScopeDispose(() => {
  disposed = true;
  inspection?.abort();
  selection?.abort();
  unregister();
  unsubscribe?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="translation-page" tw-class="absolute inset-0 overflow-y-auto overscroll-y-contain bg-[#fcfcfd] dark:bg-gray-900">
    <main tw-class="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 text-gray-900 sm:px-8 sm:py-6 dark:text-gray-100">
      <header :inert="drawer ? true : undefined" tw-class="flex items-center gap-3">
        <LanguagesIcon aria-hidden="true" tw-class="h-5 w-5 text-blue-500 dark:text-blue-400" />
        <h1 tw-class="text-xl font-semibold tracking-tight">{{ lazyStrings.translation__translation() }}</h1>
      </header>
      <button v-if="modelId" ref="modelTrigger" type="button" :inert="drawer ? true : undefined" :title="modelId" :aria-label="lazyStrings.translation__translation_models()" aria-haspopup="dialog" :aria-expanded="drawer" data-testid="translation-open-models" @click="emit('openModels')" tw-class="group flex min-h-14 w-full items-center gap-3 rounded-xl border border-gray-200/80 bg-gray-50/60 px-4 py-2.5 text-left transition-colors hover:border-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-gray-700/70 dark:bg-gray-800/40 dark:hover:border-blue-500/40 motion-reduce:transition-none">
        <FilePenLineIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400" />
        <span data-testid="translation-selected-model" tw-class="min-w-0 flex-1">
          <span tw-class="block truncate text-sm font-medium leading-5" dir="ltr">{{ modelParts.suffix }}</span>
          <span v-if="modelParts.prefix" tw-class="mt-0.5 block truncate text-xs leading-4 text-gray-500 dark:text-gray-400" dir="ltr">{{ modelParts.prefix.replace(/\/$/, '') }}</span>
        </span>
        <ChevronDownIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400" />
      </button>
      <TranslationModelPanel :open="catalogOpen" :drawer="drawer" :disabled="blocked || busy" :model-id="modelId" :return-focus="modelTrigger ?? sourceInput" @select="selectModel({ selected: $event })" @changed="inspectSelected" @close="emit('openWorkspace')">
        <p v-if="saveFailed" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.translation__preferences_not_saved() }}</p>
        <p v-if="checkingSelection" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.translation__checking_model() }}</p>
        <p v-if="selectionFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ selectionFailure === 'unsupported' ? lazyStrings.translation__unsupported_model() : lazyStrings.translation__model_unreadable() }}</p>
      </TranslationModelPanel>
      <SettingsSelectScope :active="!drawer" :return-focus="modelTrigger">
        <form :inert="drawer ? true : undefined" novalidate tw-class="space-y-4" @submit.prevent="automatic.runManually" @keydown.ctrl.enter.prevent="automatic.runManually" @keydown.meta.enter.prevent="automatic.runManually">
          <div v-if="saveFailed || languageFailure || modelFailure || invalidLanguages" role="alert" tw-class="space-y-1 text-sm text-red-600 dark:text-red-400">
            <p v-if="saveFailed || languageFailure">{{ lazyStrings.translation__preferences_not_saved() }}</p>
            <p v-if="invalidLanguages">{{ lazyStrings.translation__choose_supported_languages() }}</p>
            <p v-if="modelFailure">{{ modelFailure === 'unsupported' ? lazyStrings.translation__unsupported_model() : lazyStrings.translation__model_unreadable() }} <button type="button" :disabled="blocked || inspecting" @click="inspectSelected" tw-class="underline disabled:opacity-45">{{ lazyStrings.translation__check_again() }}</button></p>
          </div>
          <div tw-class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:gap-3">
            <div tw-class="min-w-0 space-y-2"><span tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__source_language() }}</span><SettingsFormSelect :model-value="sourceLang ?? ''" :options="options.sources" :label="lazyStrings.translation__source_language()" :disabled="blocked || !profile" data-testid="translation-source-language" @update:model-value="chooseLanguage({ side: 'source', value: $event })" /></div>
            <button type="button" :disabled="!canSwap" :title="lazyStrings.translation__swap_languages()" :aria-label="lazyStrings.translation__swap_languages()" data-testid="translation-swap" @click="swapLanguages" tw-class="flex h-10 w-9 items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-35 dark:hover:bg-gray-800"><ArrowLeftRightIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
            <div tw-class="min-w-0 space-y-2"><span tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__target_language() }}</span><SettingsFormSelect :model-value="targetLang" :options="options.targets" :label="lazyStrings.translation__target_language()" :disabled="blocked || !profile" data-testid="translation-target-language" @update:model-value="chooseLanguage({ side: 'target', value: $event })" /></div>
          </div>
          <div class="translation-editors" :class="{ 'translation-editors-preview': !modelId }" data-testid="translation-editors" tw-class="grid min-w-0 gap-4 md:grid-cols-2">
            <section class="translation-editor" data-testid="translation-source-panel" tw-class="flex min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-white has-[textarea:focus-visible]:border-blue-400 has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-blue-500/20 dark:border-gray-700/70 dark:bg-gray-800/20 dark:has-[textarea:focus-visible]:border-blue-500">
              <div tw-class="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 dark:border-gray-800"><label :for="`${id}-source`" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__source_text() }}</label><button type="button" :disabled="!text || blocked" @click="clearText" data-testid="translation-clear" tw-class="rounded-lg p-2 text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-35 dark:hover:text-gray-100">{{ lazyStrings.translation__clear() }}</button></div>
              <textarea :id="`${id}-source`" ref="sourceInput" v-model="text" dir="auto" :placeholder="lazyStrings.translation__enter_source_text()" data-testid="translation-source" @compositionstart="composing = true" @compositionend="composing = false" tw-class="block min-h-0 w-full flex-1 resize-none overflow-y-auto border-0 bg-transparent p-4 text-sm leading-7 outline-none" />
              <div data-testid="translation-source-footer" tw-class="flex h-14 shrink-0 items-center justify-between gap-2 border-t border-gray-100 px-4 dark:border-gray-800">
                <label tw-class="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><ToggleSwitch><input type="checkbox" role="switch" :checked="autoTranslate" :disabled="blocked" data-testid="translation-automatic" @change="changeAutomatic({ event: $event })" /></ToggleSwitch><span :title="lazyStrings.translation__automatic_translation()" tw-class="truncate">{{ lazyStrings.translation__automatic_translation() }}</span></label>
                <button v-show="showRun" type="submit" :disabled="!canTranslate || busy || composing" data-testid="translation-run" tw-class="inline-flex h-9 min-w-24 shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500 dark:hover:bg-blue-600 motion-reduce:transition-none"><LanguagesIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.translation__translate() }}</button>
              </div>
            </section>
            <section :aria-busy="busy" class="translation-editor" data-testid="translation-output-panel" tw-class="flex min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-gray-50/50 has-[pre:focus-visible]:border-blue-400 has-[pre:focus-visible]:ring-2 has-[pre:focus-visible]:ring-blue-500/20 dark:border-gray-700/70 dark:bg-gray-800/40 dark:has-[pre:focus-visible]:border-blue-500">
              <div tw-class="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 dark:border-gray-800"><h2 tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__translated_text() }}</h2><button type="button" :disabled="busy || !output" @click="copyOutput" data-testid="translation-copy" tw-class="flex items-center gap-1 rounded-lg p-2 text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-35 dark:hover:text-gray-100"><CopyIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ copied === 'copied' ? lazyStrings.translation__copied() : lazyStrings.translation__copy() }}</button></div>
              <div tw-class="relative min-h-0 flex-1 overflow-hidden">
                <pre :id="`${id}-output`" ref="outputElement" tabindex="0" dir="auto" :aria-label="lazyStrings.translation__translated_text()" data-testid="translation-output" tw-class="h-full overflow-y-auto whitespace-pre-wrap break-words p-4 font-sans text-sm leading-7 outline-none">{{ output }}<span v-if="!output && !busy" tw-class="text-gray-400 dark:text-gray-500">{{ lazyStrings.translation__translation_appears_here() }}</span></pre>
                <div v-if="phase === 'preparing' || phase === 'checking'" tw-class="absolute inset-x-4 top-4"><LlamaCppBrowserModelLoadProgress :progress="progress" /></div>
                <div v-if="issue || failure" role="alert" data-testid="translation-error" tw-class="absolute inset-x-0 bottom-0 max-h-[50%] overflow-y-auto bg-gray-50 p-4 text-sm text-red-600 dark:bg-gray-900 dark:text-red-400">
                  <p v-if="issueLabel">{{ issueLabel }}</p><p v-if="failure">{{ failure === 'context-full' ? lazyStrings.translation__source_too_long() : lazyStrings.translation__translation_failed() }} <code tw-class="text-xs">{{ failure }}</code></p>
                </div>
              </div>
              <div data-testid="translation-output-footer" tw-class="flex h-14 shrink-0 items-center justify-between gap-2 border-t border-gray-100 px-4 dark:border-gray-800">
                <div role="status" aria-live="polite" data-testid="translation-status" tw-class="flex min-w-0 flex-1 items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon v-if="busy" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span tw-class="truncate" :title="copied === 'failed' ? lazyStrings.translation__copy_failed_select_text() : statusLabel">{{ copied === 'failed' ? lazyStrings.translation__copy_failed_select_text() : statusLabel }}</span><progress v-if="busy && phase === 'prefill' && progressFraction !== undefined" :value="progressFraction" :max="1" :aria-label="statusLabel" tw-class="h-1 w-16 shrink-0 accent-blue-500" /></div>
                <LlamaCppBrowserModelActionButton :disabled="!busy || phase === 'stopping'" :tw-class="['h-9 min-w-20 shrink-0 justify-center', { invisible: !busy }]" data-testid="translation-stop" @click="automatic.stopManually"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.translation__stop() }}</LlamaCppBrowserModelActionButton>
              </div>
            </section>
          </div>
          <p v-if="state.status === 'unavailable'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__runtime_unavailable() }}</p>
          <p v-else-if="!busy && state.status === 'working'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__runtime_busy() }}</p>
          <details :open="detailsOpen" @toggle="toggleDetails({ event: $event })" data-testid="translation-details" tw-class="group/translation-settings overflow-hidden rounded-xl border border-gray-200/70 dark:border-gray-800">
            <summary ref="detailsTrigger" tw-class="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 dark:text-gray-200 dark:hover:bg-gray-800/40 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" /><span tw-class="flex-1">{{ lazyStrings.translation__translation_options() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4 transition-transform group-open/translation-settings:rotate-90 motion-reduce:transition-none" /></summary>
            <SettingsSelectScope :active="detailsOpen" :return-focus="detailsTrigger">
              <fieldset :disabled="blocked" tw-class="min-w-0 space-y-5 border-t border-gray-100 p-4 disabled:opacity-60 dark:border-gray-800">
                <div tw-class="max-w-sm space-y-2"><span tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__japanese_style() }}</span><SettingsFormSelect v-model="form" :options="formOptions" :label="lazyStrings.translation__japanese_style()" :disabled="blocked || profile?.formTargetLanguages.includes(targetLang) !== true" data-testid="translation-style" /></div>
                <div tw-class="space-y-2"><label :for="`${id}-context`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__reference_context() }}</label><textarea :id="`${id}-context`" v-model="context" dir="auto" :disabled="profile?.context !== 'available'" rows="3" data-testid="translation-context" tw-class="block w-full rounded-xl border border-gray-200/80 bg-gray-50/60 p-3 text-sm leading-relaxed outline-none focus:border-blue-400 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40" /></div>
                <div tw-class="space-y-3">
                  <h2 tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__glossary() }}</h2>
                  <div v-for="(term, index) in glossary" :key="index" tw-class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
                    <div tw-class="min-w-0 space-y-1"><label :for="`${id}-term-source-${index}`" tw-class="block text-xs text-gray-500">{{ lazyStrings.translation__source_term() }}</label><input :id="`${id}-term-source-${index}`" v-model="term.source" dir="auto" :disabled="profile?.glossary !== 'available'" data-testid="translation-term-source" tw-class="w-full rounded-lg border border-gray-200/80 bg-gray-50/60 p-2 text-sm outline-none focus:border-blue-400 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40" /></div>
                    <div tw-class="min-w-0 space-y-1"><label :for="`${id}-term-target-${index}`" tw-class="block text-xs text-gray-500">{{ lazyStrings.translation__translated_term() }}</label><input :id="`${id}-term-target-${index}`" v-model="term.target" dir="auto" :disabled="profile?.glossary !== 'available'" data-testid="translation-term-target" tw-class="w-full rounded-lg border border-gray-200/80 bg-gray-50/60 p-2 text-sm outline-none focus:border-blue-400 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40" /></div>
                    <button type="button" @click="glossary.splice(index, 1)" :aria-label="lazyStrings.translation__remove_term()" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"><Trash2Icon aria-hidden="true" tw-class="h-4 w-4" /></button>
                  </div>
                  <LlamaCppBrowserModelActionButton :disabled="blocked || profile?.glossary !== 'available'" data-testid="translation-add-term" @click="glossary.push({ source: '', target: '' })"><PlusIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.translation__add_term() }}</LlamaCppBrowserModelActionButton>
                </div>
              </fieldset>
            </SettingsSelectScope>
          </details>
          <p tw-class="text-xs leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.translation__privacy_notice() }}</p>
        </form>
      </SettingsSelectScope>
    </main>
  </div>
</template>
<style scoped>
.translation-editor {
  height: clamp(18rem, calc(100dvh - 19rem), 34rem);
}
@media (max-width: 767px) {
  .translation-editor {
    height: 19rem;
  }
  .translation-editors-preview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .translation-editors-preview .translation-editor {
    height: 15rem;
  }
}
@media (forced-colors: active) {
  .translation-editor:has(textarea:focus-visible, pre:focus-visible) {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }
}
</style>
