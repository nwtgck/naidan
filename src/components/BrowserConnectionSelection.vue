<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ChevronDownIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, Loader2Icon, MonitorIcon, PlugZapIcon, ServerIcon, ShieldCheckIcon } from 'lucide-vue-next';
import type { BrowserProvidedLmEndpoint, HttpEndpoint } from '@/01-models/types';
import type { PromptApiAvailability } from '@/features/prompt-api/language-model';
import type { PromptApiRuntimeState } from '@/features/prompt-api/runtime';
import PromptApiPreparationProgress from '@/features/prompt-api/components/PromptApiPreparationProgress.vue';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api/constants';
import { ENDPOINT_PRESETS } from '@/constants';
import { useModelConnectionSelection } from '@/composables/useModelConnectionSelection';
import { useSettings } from '@/composables/useSettings';
import { modelConnectionApiKey, withModelConnectionApiKey } from '@/logic/model-connection';
import { lazyStrings } from '@/strings';
import LanguageSelector from './LanguageSelector.vue';
import ModelSelector from './ModelSelector.vue';
import EndpointPresetButtons from './EndpointPresetButtons.vue';
import HttpHeadersEditor from './HttpHeadersEditor.vue';
import SettingsCollapse from './SettingsCollapse.vue';

const props = defineProps<{
  initialEndpoint: 'openai' | 'browser_provided_lm',
  active: boolean,
  applySelection: ({ endpoint, modelId }: { endpoint: HttpEndpoint | BrowserProvidedLmEndpoint, modelId: string }) => Promise<void>,
}>();
const emit = defineEmits<{ back: [] }>();
const { settings } = useSettings();
const browserCardEntry = computed(() => props.initialEndpoint === 'browser_provided_lm');
const endpoint = ref<HttpEndpoint['type'] | 'browser_provided_lm'>(props.initialEndpoint);
const endpointListOpen = ref(false);
const endpointTrigger = ref<HTMLButtonElement>();
// This onboarding list intentionally omits Naidan RPC even when it is enabled.
// Transformers.js is also intentionally excluded from this entry.
const endpoints = computed(() => [
  { value: 'openai', label: lazyStrings.BrowserConnectionSelection__openai_compatible_api(), detail: lazyStrings.BrowserConnectionSelection__openai_and_other_api_services() },
  { value: 'ollama', label: 'Ollama', detail: lazyStrings.BrowserConnectionSelection__models_on_your_device_or_server() },
  { value: 'browser_provided_lm', label: lazyStrings.SHARED__browser_provided(), detail: lazyStrings.BrowserConnectionSelection__browser_managed_models() },
] as const);
const selectedEndpoint = computed(() => endpoints.value.find(option => option.value === endpoint.value));
const url = ref('');
const httpHeaders = ref<[string, string][]>([]);
const apiKey = computed({
  get: () => modelConnectionApiKey({ headers: httpHeaders.value }),
  set: apiKey => {
    httpHeaders.value = withModelConnectionApiKey({ headers: httpHeaders.value, apiKey });
  },
});
const keyVisibility = ref<'hidden' | 'visible'>('hidden');
const keyDisclosure = ref<'collapsed' | 'expanded'>('collapsed');
const keyDisclosureTrigger = ref<HTMLButtonElement>();
const keyDisclosureId = useId();
const submitting = ref(false);
const saveError = ref(false);
const disabled = computed(() => !props.active || submitting.value);
const modelList = useModelConnectionSelection({
  active: computed(() => props.active),
  type: endpoint,
  url,
  headers: httpHeaders,
  getFakeLmDebugModeStatus: () => settings.value.experimental?.fakeLm ?? 'disabled',
});
const modelListError = computed(() => {
  const state = modelList.state.value;
  switch (state.status) {
  case 'failed': {
    const reason = state.reason;
    switch (reason) {
    case 'invalid-url': return lazyStrings.BrowserConnectionSelection__invalid_api_url();
    case 'request': return lazyStrings.BrowserConnectionSelection__could_not_fetch_models();
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
    }
  }
  case 'ready': return modelList.models.value.length === 0 ? lazyStrings.BrowserConnectionSelection__no_models_returned() : undefined;
  case 'idle':
  case 'loading': return undefined;
  default: {
    const exhaustive: never = state;
    return exhaustive;
  }
  }
});
const browserAvailability = ref<PromptApiAvailability | 'checking' | 'error'>('checking');
const browserRuntime = shallowRef<typeof import('@/features/prompt-api/runtime')>();
let browserCheckRevision = 0;
let disposed = false;
const browserPresentation = computed<
  | { status: 'progress', state: Extract<PromptApiRuntimeState, { status: 'downloading' | 'preparing' }> }
  | { status: 'notice', text: string | undefined }
>(() => {
  const runtime = browserRuntime.value?.promptApiRuntimeState.value;
  switch (runtime?.status) {
  case 'error': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__could_not_prepare_browser_model() };
  case 'ready': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__available_in_this_browser() };
  case 'api_unavailable':
  case 'model_unavailable': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__unavailable_in_this_environment() };
  case 'downloading':
  case 'preparing': return { status: 'progress', state: runtime };
  case 'unchecked':
  case 'checking':
  case 'downloadable':
  case undefined: break;
  default: {
    const exhaustive: never = runtime;
    return exhaustive;
  }
  }
  switch (browserAvailability.value) {
  case 'available': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__available_in_this_browser() };
  case 'downloadable': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__first_preparation_required() };
  // An availability probe can report an existing browser download before this
  // page owns a monitor. Show unknown progress without starting preparation.
  case 'downloading': return { status: 'progress', state: { status: 'downloading', progress: undefined } };
  case 'checking': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__checking_browser_model() };
  case 'unavailable': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__unavailable_in_this_environment() };
  case 'error': return { status: 'notice', text: lazyStrings.BrowserConnectionSelection__could_not_check_browser_model() };
  default: {
    const exhaustive: never = browserAvailability.value;
    return exhaustive;
  }
  }
});
const canSubmit = computed(() => {
  if (disposed || disabled.value) {
    return false;
  }
  const kind = endpoint.value;
  switch (kind) {
  case 'browser_provided_lm':
    return browserRuntime.value !== undefined && (browserAvailability.value === 'available' || browserAvailability.value === 'downloadable' || browserAvailability.value === 'downloading');
  case 'openai':
  case 'ollama':
    return modelList.endpoint.value !== undefined && modelList.state.value.status !== 'loading'
      && modelList.modelId.value !== undefined && modelList.models.value.includes(modelList.modelId.value);
  default: {
    const exhaustive: never = kind;
    throw new Error(`Unhandled connection type: ${exhaustive}`);
  }
  }
});

async function checkBrowserModel(): Promise<void> {
  const revision = ++browserCheckRevision;
  if (!props.active || endpoint.value !== 'browser_provided_lm' || disposed) {
    return;
  }
  browserAvailability.value = 'checking';
  browserRuntime.value = undefined;
  const isCurrent = () => !disposed && props.active && endpoint.value === 'browser_provided_lm' && browserCheckRevision === revision;
  try {
    const api = await import('@/features/prompt-api/api');
    if (!isCurrent()) {
      return;
    }
    if (api.getPromptApiLanguageModel() === undefined) {
      browserAvailability.value = 'unavailable';
      return;
    }
    const availability = await api.getPromptApiAvailability({ inputMode: 'text' });
    if (!isCurrent()) {
      return;
    }
    switch (availability) {
    case 'unavailable': browserAvailability.value = availability;
      return;
    case 'available':
    case 'downloadable':
    case 'downloading': break;
    default: {
      const exhaustive: never = availability;
      throw new Error(`Unhandled browser availability: ${exhaustive}`);
    }
    }
    // Load preparation code after this explicit browser-model choice, before
    // the later Start click. Importing it from that click would lose activation.
    const runtime = await import('@/features/prompt-api/runtime');
    if (isCurrent()) {
      browserRuntime.value = runtime;
      browserAvailability.value = availability;
    }
  } catch {
    if (isCurrent()) {
      browserAvailability.value = 'error';
    }
  }
}

watch([endpoint, () => props.active], () => {
  void checkBrowserModel();
}, { immediate: true, flush: 'sync' });
watch([endpoint, url, httpHeaders, modelList.modelId], () => {
  saveError.value = false;
}, { deep: true });
onScopeDispose(() => {
  disposed = true;
  browserCheckRevision++;
});

function chooseEndpoint({ value }: { value: typeof endpoint.value }): void {
  if (disposed || disabled.value) {
    return;
  }
  endpoint.value = value;
  endpointListOpen.value = false;
  endpointTrigger.value?.focus({ preventScroll: true });
  url.value = '';
}

function applyPreset({ preset }: { preset: typeof ENDPOINT_PRESETS[number] }): void {
  if (!disposed && !disabled.value) {
    chooseEndpoint({ value: preset.type });
    url.value = preset.url;
  }
}

function back(): void {
  if (!disposed && !disabled.value) {
    modelList.cancel();
    emit('back');
  }
}

function endpointKeydown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Escape' && endpointListOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    endpointListOpen.value = false;
    endpointTrigger.value?.focus({ preventScroll: true });
  }
}

async function submit(): Promise<void> {
  if (disposed || !canSubmit.value) {
    return;
  }
  const selection = (() => {
    const kind = endpoint.value;
    switch (kind) {
    case 'browser_provided_lm': return { endpoint: { type: kind }, modelId: BROWSER_PROVIDED_LM_MODEL_ID };
    case 'openai':
    case 'ollama': {
      const requestedEndpoint = modelList.endpoint.value;
      const modelId = modelList.modelId.value;
      return requestedEndpoint !== undefined && modelId !== undefined ? { endpoint: requestedEndpoint, modelId } : undefined;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled connection type: ${exhaustive}`);
    }
    }
  })();
  if (selection === undefined) {
    return;
  }
  submitting.value = true;
  saveError.value = false;
  try {
    const kind = selection.endpoint.type;
    switch (kind) {
    case 'browser_provided_lm':
      // This click accepts preparation independently of settings persistence.
      // Start before the first await to preserve native user activation; the
      // shared runtime owns completion, even after the form closes or save fails.
      void browserRuntime.value?.preparePromptApi({ signal: undefined }).catch(() => {});
      break;
    case 'openai':
    case 'ollama': break;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled connection type: ${exhaustive}`);
    }
    }
    await props.applySelection(selection);
  } catch {
    if (!disposed && props.active) {
      saveError.value = true;
    }
  } finally {
    submitting.value = false;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="connection-selection" data-testid="model-connection-selection" tw-class="relative flex h-full min-h-0 flex-col px-5 pb-5 pt-16 text-gray-800 dark:text-gray-100 sm:px-10 sm:pb-6">
    <div tw-class="absolute right-16 top-[1.125rem]"><LanguageSelector /></div>
    <button type="button" data-testid="model-connection-back" tw-class="group absolute left-5 top-4 inline-flex min-h-9 items-center gap-2 rounded-lg py-1 pr-3 text-xs text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-gray-100 sm:left-10" @click="back" :disabled="disabled"><ArrowLeftIcon aria-hidden="true" tw-class="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5 motion-reduce:transition-none" />{{ lazyStrings.BrowserConnectionSelection__model_selection() }}</button>
    <div tw-class="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col">
      <header tw-class="mb-5 shrink-0 space-y-3">
        <p v-if="browserCardEntry" tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserConnectionSelection__run_on_your_device() }}</p>
        <h2 :tw-class="['font-bold tracking-tight', browserCardEntry ? 'text-[28px] sm:text-[32px]' : 'text-[22px] sm:text-[28px]']">{{ browserCardEntry ? lazyStrings.BrowserConnectionSelection__browser_provided_model() : lazyStrings.BrowserConnectionSelection__use_openai_ollama_and_more() }}</h2>
        <p v-if="browserCardEntry" tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserConnectionSelection__use_browser_managed_model() }}</p>
        <p v-else tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserConnectionSelection__connect_to_ai_outside_the_browser_or_browser_provided_models() }}</p>
      </header>
      <!-- Keep the heading and final action stationary; only the form scrolls. -->
      <div data-testid="model-connection-fields" tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-1">
        <fieldset :disabled="disabled" tw-class="m-0 min-w-0 space-y-5 border-0 p-0">
          <div v-if="!browserCardEntry" tw-class="space-y-2">
            <label for="model-connection-endpoint" tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserConnectionSelection__connection() }}</label>
            <div tw-class="relative" @keydown="endpointKeydown({ event: $event })">
              <button ref="endpointTrigger" id="model-connection-endpoint" type="button" :aria-expanded="endpointListOpen" aria-controls="connection-endpoint-options" tw-class="flex min-h-12 w-full items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-left hover:border-gray-300 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700/70 dark:bg-gray-800/35" @click="endpointListOpen = !endpointListOpen" :disabled="disabled"><PlugZapIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" /><span tw-class="min-w-0 flex-1 text-sm font-medium">{{ selectedEndpoint?.label }}</span><ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 text-gray-400 transition-transform', endpointListOpen ? 'rotate-180' : '']" /></button>
              <div v-if="endpointListOpen" id="connection-endpoint-options" tw-class="absolute inset-x-0 top-full z-40 mt-1.5 space-y-0.5 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg shadow-gray-950/10 dark:border-gray-700 dark:bg-gray-800 dark:shadow-black/25">
                <button v-for="option in endpoints" :key="option.value" type="button" tw-class="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700/50" @click="chooseEndpoint({ value: option.value })"><span tw-class="min-w-0 flex-1"><span tw-class="block text-sm font-medium">{{ option.label }}</span><span tw-class="block text-[11px] text-gray-500 dark:text-gray-400">{{ option.detail }}</span></span><CheckIcon v-if="endpoint === option.value" aria-hidden="true" tw-class="h-4 w-4 text-blue-500" /></button>
              </div>
            </div>
          </div>
          <Transition name="connection-fields" mode="out-in">
            <section v-if="endpoint === 'browser_provided_lm'" key="browser" tw-class="space-y-4 rounded-2xl border border-gray-200/80 bg-gray-50/60 p-4 dark:border-gray-700/70 dark:bg-gray-800/25 sm:p-5">
              <div v-if="!browserCardEntry" tw-class="flex items-start gap-3"><span tw-class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-blue-400"><MonitorIcon aria-hidden="true" tw-class="h-5 w-5" /></span><div tw-class="space-y-1"><h3 tw-class="text-sm font-semibold">{{ lazyStrings.BrowserConnectionSelection__browser_provided_model() }}</h3><p tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserConnectionSelection__use_browser_managed_model() }}</p></div></div>
              <PromptApiPreparationProgress v-if="browserPresentation.status === 'progress'" :state="browserPresentation.state" tw-class="rounded-xl border border-blue-200/50 bg-white px-3.5 py-3 dark:border-blue-400/15 dark:bg-gray-900/70" />
              <div v-else tw-class="flex items-center gap-2 rounded-lg bg-white px-3 py-2.5 text-xs text-gray-600 dark:bg-gray-900/70 dark:text-gray-300"><span :tw-class="['h-1.5 w-1.5 rounded-full', browserAvailability === 'available' ? 'bg-blue-500' : 'bg-gray-400']" />{{ browserPresentation.text }}</div>
              <button v-if="browserAvailability === 'error'" type="button" data-testid="connection-retry-browser" :disabled="disabled" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg text-xs text-blue-600 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-400 dark:hover:text-blue-300" @click="checkBrowserModel">{{ lazyStrings.BrowserConnectionSelection__retry_check() }}</button>
              <p tw-class="flex items-start gap-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400"><ShieldCheckIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />{{ lazyStrings.BrowserConnectionSelection__model_type_depends_on_browser() }}</p>
            </section>
            <section v-else key="api" tw-class="space-y-4">
              <div tw-class="space-y-2"><label for="model-connection-url" tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ endpoint === 'ollama' ? lazyStrings.BrowserConnectionSelection__ollama_url() : lazyStrings.BrowserConnectionSelection__api_url() }}</label><div tw-class="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-3 transition-colors focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/80 dark:bg-gray-800/35"><ServerIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400" /><input id="model-connection-url" v-model="url" type="url" placeholder="https://..." spellcheck="false" tw-class="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400" /></div><p tw-class="text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.BrowserConnectionSelection__localhost_models_are_fetched_automatically() }}</p></div>
              <EndpointPresetButtons :endpoint="{ type: endpoint === 'ollama' ? 'ollama' : 'openai', url }" test-id-prefix="connection-preset" @apply="applyPreset({ preset: $event })" />
              <div v-if="endpoint === 'openai'">
                <button ref="keyDisclosureTrigger" type="button" data-testid="connection-api-key-disclosure" :aria-expanded="keyDisclosure === 'expanded'" :aria-controls="keyDisclosureId" tw-class="group flex min-h-9 w-full items-center gap-2 rounded-lg py-1 text-left text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-gray-200" @click="keyDisclosure = keyDisclosure === 'expanded' ? 'collapsed' : 'expanded'">
                  <KeyRoundIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 group-hover:text-blue-500 dark:group-hover:text-blue-400" />
                  <span tw-class="min-w-0 flex-1">{{ apiKey ? lazyStrings.BrowserConnectionSelection__api_key() : lazyStrings.BrowserConnectionSelection__configure_api_key() }}<span v-if="!apiKey" tw-class="ml-1 text-gray-400 dark:text-gray-500">{{ lazyStrings.BrowserConnectionSelection__optional() }}</span></span>
                  <span v-if="apiKey" tw-class="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400"><CheckIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.BrowserConnectionSelection__configured() }}</span>
                  <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none', keyDisclosure === 'expanded' ? 'rotate-180' : '']" />
                </button>
                <SettingsCollapse :id="keyDisclosureId" :open="keyDisclosure === 'expanded'" :return-focus="keyDisclosureTrigger">
                  <div tw-class="pb-1 pt-2">
                    <label for="model-connection-key" tw-class="sr-only">{{ lazyStrings.BrowserConnectionSelection__api_key() }}</label>
                    <div tw-class="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-3 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/80 dark:bg-gray-800/35">
                      <input id="model-connection-key" v-model="apiKey" :type="keyVisibility === 'visible' ? 'text' : 'password'" autocomplete="off" :placeholder="lazyStrings.BrowserConnectionSelection__enter_api_key()" tw-class="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400" />
                      <button type="button" :aria-label="keyVisibility === 'visible' ? lazyStrings.BrowserConnectionSelection__hide_api_key() : lazyStrings.BrowserConnectionSelection__show_api_key()" :title="keyVisibility === 'visible' ? lazyStrings.BrowserConnectionSelection__hide_api_key() : lazyStrings.BrowserConnectionSelection__show_api_key()" :aria-pressed="keyVisibility === 'visible'" data-testid="connection-api-key-visibility" tw-class="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700 dark:hover:text-gray-200" @click="keyVisibility = keyVisibility === 'visible' ? 'hidden' : 'visible'"><EyeOffIcon v-if="keyVisibility === 'visible'" aria-hidden="true" tw-class="h-4 w-4" /><EyeIcon v-else aria-hidden="true" tw-class="h-4 w-4" /></button>
                    </div>
                  </div>
                </SettingsCollapse>
              </div>
              <!-- Explicit draft models never refresh the saved global connection. -->
              <div tw-class="space-y-2">
                <div tw-class="flex items-center justify-between gap-3"><label for="model-connection-model" tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserConnectionSelection__model() }}</label><button type="button" data-testid="connection-fetch-models" :disabled="disabled || modelList.state.value.status === 'loading'" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-wait disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-500/10" @click="modelList.refresh"><Loader2Icon v-if="modelList.state.value.status === 'loading'" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin" />{{ lazyStrings.BrowserConnectionSelection__fetch_models() }}</button></div>
                <ModelSelector class="connection-model-selector" v-model="modelList.modelId.value" input-id="model-connection-model" surface="settings" popup-presentation="inline" :models="modelList.models.value" :loading="modelList.state.value.status === 'loading'" :disabled="disabled" :placeholder="lazyStrings.BrowserConnectionSelection__choose_model()" @refresh="modelList.refresh" />
                <p v-if="modelListError" role="alert" data-testid="connection-model-list-error" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ modelListError }}</p>
              </div>
              <HttpHeadersEditor v-model="httpHeaders" :title="lazyStrings.BrowserConnectionSelection__http_headers_optional()" test-id-prefix="connection-header" :name-placeholder="lazyStrings.BrowserConnectionSelection__header_name_example()" />
            </section>
          </Transition>
          <p v-if="saveError" role="alert" data-testid="connection-save-error" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ lazyStrings.BrowserConnectionSelection__could_not_save_connection() }}</p>
        </fieldset>
      </div>
      <footer tw-class="shrink-0 pt-5">
        <button type="button" data-testid="connection-submit" :disabled="!canSubmit" :aria-busy="submitting" @click="submit" tw-class="group flex min-h-12 w-full items-center justify-center gap-3 rounded-xl border border-blue-300/70 bg-blue-50/70 px-4 text-sm font-semibold text-gray-800 transition-colors hover:border-blue-400 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-blue-500/40 dark:bg-gray-800 dark:text-gray-100 dark:hover:border-blue-400/60 dark:hover:bg-gray-700/70 disabled:cursor-not-allowed disabled:opacity-40">{{ browserCardEntry ? lazyStrings.SHARED__run_in_your_browser() : lazyStrings.BrowserConnectionSelection__use_this_connection() }}<ArrowRightIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Align single-line controls with the URL field; model metadata may grow. */
.connection-model-selector :deep(> button) {
  min-height: 2.75rem;
  padding-block: 0.5rem;
}
.connection-fields-enter-active {
  transition: opacity 200ms ease, transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.connection-fields-leave-active {
  transition: opacity 100ms ease;
}
.connection-fields-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.connection-fields-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .connection-fields-enter-active, .connection-fields-leave-active {
    transition: none;
  }
}
</style>
