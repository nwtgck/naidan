<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { ensureStrings, lazyStrings } from '@/strings';
import type { LmProvider } from '@/01-models/lm';
import { loadLmProvider } from '@/features/lm/providerFactory';
import { type Endpoint, type EndpointType, type Settings as SettingsType } from '@/01-models/types';
import { ENDPOINT_PRESETS } from '@/constants';

// IMPORTANT: ThemeToggle is part of the core onboarding UI.
import ThemeToggle from '@/features/theme/components/ThemeToggle.vue';
// IMPORTANT: LanguageSelector is part of the core onboarding UI.
import LanguageSelector from './LanguageSelector.vue';
// IMPORTANT: Logo is part of the core onboarding UI.
import Logo from './Logo.vue';
// IMPORTANT: ModelSelector is part of the core onboarding UI.
import ModelSelector from './ModelSelector.vue';

// Load onboarding subviews only when their current template branch needs them.
const ServerSetupGuide = defineAsyncComponent(() => import('./ServerSetupGuide.vue'));
const TransformersJsManager = defineAsyncComponent(() => import('@/features/transformers-js/components/TransformersJsManager.vue'));
import { transformersJsService } from '@/features/transformers-js';
import { PlayIcon, ArrowLeftIcon, CheckCircle2Icon, ActivityIcon, SettingsIcon, XIcon, PlusIcon, Trash2Icon, FlaskConicalIcon } from 'lucide-vue-next';
import { naturalSort } from '@/utils/string';
import { detectOllama } from '@/utils/ollama-detection';
import PromptApiStatus from '@/features/prompt-api/components/PromptApiStatus.vue';
import { getPromptApiLanguageModel } from '@/features/prompt-api/api';
import { promptApiRuntimeState } from '@/features/prompt-api/runtime';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api';

const { settings, save, onboardingDraft, setIsOnboardingDismissed, setOnboardingDraft, initialized, isOnboardingDismissed } = useSettings();
const { setActiveFocusArea } = useLayout();
const modalContent = ref<HTMLElement | undefined>(undefined);

function getFocusableElements(): HTMLElement[] {
  const root = modalContent.value;
  if (root === undefined) return [];

  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.offsetParent !== null);
}

function handleModalKeydown({ event }: {
  event: KeyboardEvent,
}): void {
  if (event.key !== 'Tab') return;

  const focusableElements = getFocusableElements();
  if (focusableElements.length === 0) {
    event.preventDefault();
    modalContent.value?.focus();
    return;
  }

  const first = focusableElements[0];
  const last = focusableElements.at(-1);
  if (first === undefined || last === undefined) return;

  if (event.shiftKey && (document.activeElement === first || document.activeElement === modalContent.value)) {
    event.preventDefault();
    last.focus();
    return;
  }

  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const DEFAULT_TYPE = Symbol('default');
const selectedType = ref<EndpointType | typeof DEFAULT_TYPE>(onboardingDraft.value?.type || DEFAULT_TYPE);

const effectiveType = computed<EndpointType>(() => {
  if (selectedType.value === DEFAULT_TYPE) return 'openai';
  return selectedType.value;
});

/**
 * Gets the initial URL for the endpoint.
 * Prioritizes the user's current session draft, then falls back to the
 * reverse proxy path provided by naidan-server via Cookie.
 */
const getDefaultCustomUrl = () => {
  if (onboardingDraft.value?.url) return onboardingDraft.value.url;

  // Read reverse proxy info from naidan-server via cookie.
  const cookieValue = document.cookie
    .split('; ')
    .find(row => row.startsWith('reverse_proxy_path='))
    ?.split('=')[1];

  if (!cookieValue) return '';

  const path = decodeURIComponent(cookieValue);
  // If the path is relative (starts with /), join it with the current origin.
  // This ensures a valid absolute URL like "http://localhost:5536/myapi".
  if (path.startsWith('/')) {
    return window.location.origin + path;
  }
  return path;
};
const show = computed(() => initialized.value && !isOnboardingDismissed.value);

watch(show, (val) => {
  if (val) {
    setActiveFocusArea({ area: 'onboarding' });
  } else {
    setActiveFocusArea({ area: 'chat' });
  }
}, { immediate: true });

const isTransformersJs = computed(() => {
  const type = effectiveType.value;
  switch (type) {
  case 'transformers_js':
    return true;
  case 'openai':
  case 'ollama':
  case 'browser_provided_lm':
    return false;
  default: {
    const _ex: never = type;
    return _ex;
  }
  }
});

const isBrowserProvidedLm = computed(() => effectiveType.value === 'browser_provided_lm');
const isPromptApiSupported = computed(() => getPromptApiLanguageModel() !== undefined);
const isHttpEndpointType = computed(() => (
  effectiveType.value === 'openai'
  || effectiveType.value === 'ollama'
));

// Reactive sync with transformersJsService
let unsubscribe: (() => void) | null = null;
onMounted(async () => {
  await nextTick();
  modalContent.value?.focus();

  // Trigger auto-detection immediately if a URL is present from the cookie/draft
  // but the type is still the default.
  if (selectedType.value === DEFAULT_TYPE && customUrl.value && isLocalhost({ url: customUrl.value })) {
    const normalized = getNormalizedUrl();
    if (normalized) {
      const isOllama = await detectOllama({ url: normalized, headers: customHeaders.value });
      if (isOllama) {
        selectedType.value = 'ollama';
      }
    }
  }

});

onUnmounted(() => {
  if (unsubscribe) unsubscribe();
});

// Subscribe and auto-load only while Transformers.js is selected. The service
// state is lightweight, while cache scans, model loading, and Worker creation
// remain isolated from ordinary OpenAI or Ollama onboarding.
watch(
  effectiveType,
  (newType, _previousType, onCleanup) => {
    switch (newType) {
    case 'openai':
    case 'ollama':
    case 'browser_provided_lm':
      return;
    case 'transformers_js':
      break;
    default: {
      const _ex: never = newType;
      throw new Error(`Unhandled endpoint type: ${_ex}`);
    }
    }

    let cancelled = false;
    unsubscribe = transformersJsService.subscribe({ listener: () => {
      const state = transformersJsService.getState();
      if (state.activeModelId) {
        selectedModel.value = state.activeModelId;
      }
    } });
    onCleanup(() => {
      cancelled = true;
      unsubscribe?.();
      unsubscribe = null;
    });

    (async () => {
      try {
        const cached = await transformersJsService.listCachedModels();
        if (cancelled) {
          return;
        }

        const completeModels = cached.filter(model => model.isComplete);
        if (completeModels.length === 0 || transformersJsService.getState().activeModelId) {
          return;
        }

        const sorted = [...completeModels].sort((a, b) => b.lastModified - a.lastModified);
        const target = sorted[0]?.id;
        if (target === undefined) {
          return;
        }

        try {
          await transformersJsService.loadModel({ modelId: target });
          if (!cancelled) {
            selectedModel.value = target;
          }
        } catch (error) {
          if (!cancelled) {
            console.warn('Auto-load failed:', error);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to prepare Transformers.js onboarding:', error);
        }
      }
    })();
  },
  { immediate: true },
);

const customUrl = ref(getDefaultCustomUrl());
const customHeaders = ref<[string, string][]>(onboardingDraft.value?.headers ? JSON.parse(JSON.stringify(onboardingDraft.value.headers)) : []);
const isTesting = ref(false);
const error = ref<string | null>(null);
const availableModels = ref<string[]>(onboardingDraft.value?.models ? JSON.parse(JSON.stringify(onboardingDraft.value.models)) : []);
const sortedModels = computed(() => naturalSort({ values: availableModels.value }));
const selectedModel = ref(onboardingDraft.value?.selectedModel || '');
let abortController: AbortController | null = null;

function addHeader() {
  customHeaders.value.push(['', '']);
}

function removeHeader({ index }: { index: number }) {
  customHeaders.value.splice(index, 1);
}

function handleModelLoaded({ modelId }: { modelId: string }) {
  if (isTransformersJs.value) {
    selectedModel.value = modelId;
  }
}

function selectEndpointType({ type }: { type: EndpointType }): void {
  abortController?.abort();
  abortController = null;
  isTesting.value = false;
  selectedType.value = type;
  availableModels.value = [];
  selectedModel.value = '';
  error.value = null;
}

function selectBrowserProvidedLm(): void {
  selectEndpointType({ type: 'browser_provided_lm' });
  availableModels.value = [BROWSER_PROVIDED_LM_MODEL_ID];
  selectedModel.value = BROWSER_PROVIDED_LM_MODEL_ID;
}

const isValidUrl = computed(() => !isHttpEndpointType.value || !!getNormalizedUrl());

function getNormalizedUrl() {
  let url = customUrl.value.trim();
  if (!url) return null;
  if (!url.includes('://')) {
    url = 'http://' + url;
  }
  try {
    return new URL(url).toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isLocalhost({ url }: { url: string | undefined }) {
  if (!url) return false;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

function createEndpoint({
  type,
  url,
  httpHeaders,
}: {
  type: EndpointType,
  url: string | null,
  httpHeaders: [string, string][],
}): Endpoint {
  switch (type) {
  case 'openai':
  case 'ollama':
    return {
      type,
      url: url ?? '',
      httpHeaders: httpHeaders.length > 0 ? httpHeaders : undefined,
    };
  case 'transformers_js':
  case 'browser_provided_lm':
    return { type };
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

// Auto-fetch for localhost or transformers_js when URL/Type changes
watch([selectedType, customUrl], async ([_type, url]) => {
  error.value = null;

  // Auto-detect Ollama if URL is localhost and type is still default
  if (_type === DEFAULT_TYPE && url && isLocalhost({ url })) {
    const normalized = getNormalizedUrl();
    if (normalized) {
      const isOllama = await detectOllama({ url: normalized, headers: customHeaders.value });
      if (isOllama) {
        selectedType.value = 'ollama';
        // After auto-detection, we STOP here.
        // We never want to trigger handleConnect automatically because it jumps to the next page.
        return;
      }
    }
  }

  const currentEffectiveType = effectiveType.value;
  const isAutoFetch = (() => {
    switch (currentEffectiveType) {
    case 'transformers_js':
      return true;
    case 'openai':
    case 'ollama':
    case 'browser_provided_lm':
      // Keep preparation and connection checks user initiated so the UI does
      // not jump to Step 2 or start a browser model download unexpectedly.
      return false;
    default: {
      const _ex: never = currentEffectiveType;
      return _ex;
    }
    }
  })();

  if (isAutoFetch) {
    await handleConnect();
  }
});
function selectPreset({ preset }: { preset: typeof ENDPOINT_PRESETS[number] }) {
  selectEndpointType({ type: preset.type });
  customUrl.value = preset.url;
}

async function handleCancelConnect(): Promise<void> {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  isTesting.value = false;
  error.value = await ensureStrings.OnboardingModal__connection_attempt_cancelled();
}

async function handleConnect() {
  const url = getNormalizedUrl();

  if (!url && isHttpEndpointType.value) {
    error.value = await ensureStrings.OnboardingModal__enter_valid_url();
    return;
  }

  if (isBrowserProvidedLm.value && promptApiRuntimeState.value.status !== 'ready') {
    return;
  }

  abortController?.abort();
  isTesting.value = true;
  error.value = null;
  const currentAbortController = new AbortController();
  abortController = currentAbortController;

  try {
    // We've moved primary auto-detection to the watcher for a better UX,
    // but if we're still in DEFAULT_TYPE when connecting, we do a quick check.
    const normalizedUrl = url || '';
    if (selectedType.value === DEFAULT_TYPE && isLocalhost({ url: normalizedUrl }) && normalizedUrl) {
      const isOllama = await detectOllama({ url: normalizedUrl, headers: customHeaders.value });
      currentAbortController.signal.throwIfAborted();
      if (isOllama) {
        selectedType.value = 'ollama';
        // The watcher will handle the update, but we continue here with Ollama.
      }
    }

    currentAbortController.signal.throwIfAborted();
    const provider: LmProvider = await loadLmProvider({
      endpoint: createEndpoint({
        type: effectiveType.value,
        url,
        httpHeaders: customHeaders.value,
      }),
      fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
    });
    currentAbortController.signal.throwIfAborted();
    const models = await provider.listModels({ signal: currentAbortController.signal });
    currentAbortController.signal.throwIfAborted();

    if (models.length === 0) {
      throw new Error(await ensureStrings.SHARED__no_models_found_at_this_endpoint());
    }

    availableModels.value = models;
    selectedModel.value = models[0] || '';
    if (url) customUrl.value = url; // Update UI with normalized URL
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return;
    }
    error.value = e instanceof Error ? e.message : await ensureStrings.OnboardingModal__failed_to_connect();
  } finally {
    if (abortController === currentAbortController) {
      isTesting.value = false;
      abortController = null;
    }
  }
}

async function handleClose() {
  setOnboardingDraft({ draft: {
    url: customUrl.value,
    type: effectiveType.value,
    headers: customHeaders.value,
    models: availableModels.value,
    selectedModel: selectedModel.value,
  } });
  setIsOnboardingDismissed({ dismissed: true });
}

async function handleFinish() {
  const url = getNormalizedUrl();
  const type = effectiveType.value;

  if (!url && isHttpEndpointType.value) {
    error.value = await ensureStrings.OnboardingModal__enter_valid_url();
    return;
  }

  try {
    const baseSettings = JSON.parse(JSON.stringify(settings.value)) as SettingsType;
    const modelSettings = (() => {
      switch (type) {
      case 'openai':
      case 'ollama':
        return {
          defaultModelId: selectedModel.value || undefined,
          titleGeneration: selectedModel.value === ''
            ? { endpoint: 'same_scope' as const, model: 'same_scope' as const }
            : { endpoint: 'same_scope' as const, model: { id: selectedModel.value } },
        };
      case 'transformers_js':
        return {
          defaultModelId: selectedModel.value || undefined,
          titleGeneration: { endpoint: 'same_scope' as const, model: 'same_scope' as const },
        };
      case 'browser_provided_lm':
        return {
          defaultModelId: BROWSER_PROVIDED_LM_MODEL_ID,
          titleGeneration: { endpoint: 'same_scope' as const, model: 'same_scope' as const },
        };
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled endpoint type: ${_ex}`);
      }
      }
    })();
    await save({
      patch: {
        ...baseSettings,
        endpoint: createEndpoint({
          type,
          url,
          httpHeaders: customHeaders.value,
        }),
        ...modelSettings,
      },
      modelRefresh: 'await',
    });

    setOnboardingDraft({ draft: null });
    setIsOnboardingDismissed({ dismissed: true });
  } catch (e) {
    error.value = e instanceof Error ? e.message : await ensureStrings.OnboardingModal__failed_to_save_settings();
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      selectedType,
      effectiveType,
      availableModels,
      handleConnect,
    },
  }) || {}),
});
</script>

<template>
  <div
    tw-class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4"
    @keydown="handleModalKeydown({ event: $event })"
  >
    <div
      ref="modalContent"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      tabindex="-1"
      class="modal-content-zoom" tw-class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-4xl md:h-[640px] max-h-[95vh] md:max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-gray-800 relative outline-none"
    >
      <!-- Header Actions (Top Right) -->
      <div tw-class="absolute top-4 right-4 z-10 flex items-center gap-2">
        <div tw-class="w-20 md:w-28 shrink-0">
          <ThemeToggle />
        </div>
        <LanguageSelector />
        <button
          @click="handleClose"
          tw-class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
          data-testid="onboarding-close-x"
        >
          <XIcon tw-class="w-5 h-5" />
        </button>
      </div>

      <div tw-class="px-6 md:px-10 py-4 flex items-center gap-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 shrink-0">
        <div tw-class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <Logo tw-class="w-6 h-6 md:w-8 md:h-8" />
        </div>
        <div tw-class="text-left flex-1">
          <h2 id="onboarding-title" tw-class="text-base md:text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.OnboardingModal__setup_endpoint() }}</h2>
          <p tw-class="hidden sm:block text-xs text-gray-600 dark:text-gray-400">{{ lazyStrings.OnboardingModal__setup_endpoint_description() }}</p>
        </div>
      </div>

      <div tw-class="flex-1 overflow-y-auto min-h-0 overscroll-contain">

        <div tw-class="flex flex-col lg:flex-row h-full">

          <!-- Left Column: Configuration (Primary) -->

          <div :tw-class="['p-6 md:p-10 space-y-6 md:space-y-8', isTransformersJs || isBrowserProvidedLm ? 'w-full' : 'w-full lg:w-[62%]']">

            <template v-if="isTransformersJs">
              <!-- Transformers.js Integrated View -->
              <div class="animate-in fade-in slide-in-from-bottom-2" tw-class="space-y-6 md:space-y-8 duration-300">
                <!-- Type Switcher (Repeated here for easy switching) -->
                <div tw-class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
                  <div>
                    <h3 tw-class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                      <FlaskConicalIcon tw-class="w-4 h-4 text-purple-500" />
                      {{ lazyStrings.OnboardingModal__in_browser_ai() }}
                      <span tw-class="px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400 text-[10px] rounded-md font-bold uppercase tracking-wider">{{ lazyStrings.OnboardingModal__experimental() }}</span>
                    </h3>
                    <p tw-class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{{ lazyStrings.OnboardingModal__run_models_in_browser() }}</p>
                  </div>
                  <div tw-class="flex bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg border border-gray-100 dark:border-gray-700 w-fit shrink-0">
                    <button
                      @click="selectEndpointType({ type: 'openai' })"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors whitespace-nowrap text-gray-400', effectiveType === 'openai' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : '']"
                    >{{ lazyStrings.OnboardingModal__openai_compatible() }}</button>

                    <button
                      @click="selectEndpointType({ type: 'ollama' })"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors text-gray-400', effectiveType === 'ollama' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : '']"
                    >{{ lazyStrings.OnboardingModal__ollama() }}</button>

                    <button
                      @click="selectEndpointType({ type: 'transformers_js' })"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors whitespace-nowrap', effectiveType === 'transformers_js' ? 'bg-white dark:bg-gray-700 shadow-sm text-purple-600 dark:text-purple-400' : 'text-gray-400']"
                    >{{ lazyStrings.OnboardingModal__transformers_js() }}</button>
                    <button
                      @click="selectBrowserProvidedLm"
                      data-testid="onboarding-browser-provided-lm-button"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors whitespace-nowrap flex items-center gap-1', effectiveType === 'browser_provided_lm' ? 'bg-white dark:bg-gray-700 shadow-sm text-purple-600 dark:text-purple-400' : 'text-gray-400', { 'opacity-40': !isPromptApiSupported }]"
                    >
                      <FlaskConicalIcon tw-class="w-2.5 h-2.5" aria-hidden="true" />
                      {{ lazyStrings.SHARED__browser_provided() }}
                    </button>
                  </div>
                </div>

                <TransformersJsManager @model-loaded="modelId => handleModelLoaded({ modelId })" />

                <div tw-class="flex flex-col sm:flex-row items-center gap-4 pt-6 border-t border-gray-100 dark:border-gray-800">
                  <button
                    @click="handleFinish"
                    :disabled="!selectedModel"
                    tw-class="w-full sm:w-auto px-8 py-3.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-lg shadow-purple-500/30 transition-all flex items-center justify-center gap-2 text-sm md:text-base"
                  >
                    <PlayIcon tw-class="w-5 h-5 fill-current" />
                    <span>{{ lazyStrings.OnboardingModal__get_started() }}</span>
                  </button>
                  <p tw-class="flex items-center gap-2 text-[10px] md:text-xs font-medium text-gray-500 dark:text-gray-400">
                    <SettingsIcon tw-class="w-3.5 h-3.5 md:w-4 md:h-4 text-purple-500/60" />
                    {{ lazyStrings.OnboardingModal__settings_saved_for_local_inference() }}
                  </p>
                </div>
              </div>
            </template>

            <template v-else-if="availableModels.length === 0 || (isBrowserProvidedLm && promptApiRuntimeState.status !== 'ready')">

              <!-- Step 1: Configuration -->


              <div>
                <label tw-class="block text-[10px] font-bold text-gray-500 dark:text-gray-500 uppercase tracking-wider mb-2 ml-1">{{ lazyStrings.OnboardingModal__quick_presets() }}</label>
                <div tw-class="flex flex-wrap gap-1.5">
                  <button
                    v-for="preset in ENDPOINT_PRESETS"
                    :key="preset.name"
                    @click="selectPreset({ preset })"
                    :tw-class="['px-2.5 py-1.5 md:px-3 md:py-1.5 text-[10px] md:text-[11px] font-bold border rounded-lg transition-all duration-200', customUrl === preset.url ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600']"
                  >
                    {{ preset.name }}
                  </button>
                </div>
              </div>
              <div tw-class="space-y-3">
                <div tw-class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <label tw-class="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{{ lazyStrings.OnboardingModal__endpoint_configuration() }}</label>
                  <div tw-class="flex bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg border border-gray-100 dark:border-gray-700 w-fit">
                    <button
                      @click="selectEndpointType({ type: 'openai' })"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors whitespace-nowrap', effectiveType === 'openai' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400']"
                    >{{ lazyStrings.OnboardingModal__openai_compatible() }}</button>

                    <button
                      @click="selectEndpointType({ type: 'ollama' })"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors', effectiveType === 'ollama' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400']"
                    >{{ lazyStrings.OnboardingModal__ollama() }}</button>

                    <button
                      @click="selectEndpointType({ type: 'transformers_js' })"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-all whitespace-nowrap flex items-center gap-1', effectiveType === 'transformers_js' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600']"
                    >
                      <FlaskConicalIcon tw-class="w-2.5 h-2.5" />
                      {{ lazyStrings.OnboardingModal__transformers_js() }}
                    </button>
                    <button
                      @click="selectBrowserProvidedLm"
                      data-testid="onboarding-browser-provided-lm-button"
                      :tw-class="['px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-all whitespace-nowrap flex items-center gap-1', effectiveType === 'browser_provided_lm' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600', { 'opacity-40': !isPromptApiSupported }]"
                    >
                      <FlaskConicalIcon tw-class="w-2.5 h-2.5" aria-hidden="true" />
                      {{ lazyStrings.SHARED__browser_provided() }}
                    </button>
                  </div>

                </div>
                <PromptApiStatus v-if="isBrowserProvidedLm" show-ready />
                <input
                  v-if="isHttpEndpointType"
                  v-model="customUrl"
                  type="text"
                  placeholder="http://localhost:11434"
                  tw-class="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all dark:text-white text-sm"
                  @keydown.enter="$event => !$event.isComposing && handleConnect()"
                />

                <!-- Custom HTTP Headers -->
                <div tw-class="space-y-3" v-if="isHttpEndpointType">
                  <div tw-class="flex items-center justify-between ml-1">
                    <label tw-class="block text-[10px] font-bold text-gray-500 uppercase tracking-widest">{{ lazyStrings.OnboardingModal__custom_http_headers() }}</label>
                    <button
                      @click="addHeader"
                      type="button"
                      tw-class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
                    >
                      <PlusIcon tw-class="w-2.5 h-2.5" />
                      {{ lazyStrings.OnboardingModal__add_header() }}
                    </button>
                  </div>

                  <div v-if="customHeaders.length > 0" class="no-scrollbar" tw-class="space-y-2 max-h-[120px] overflow-y-auto">
                    <div
                      v-for="(header, index) in customHeaders"
                      :key="index"
                      class="animate-in fade-in slide-in-from-left-1" tw-class="flex gap-2 duration-200"
                    >
                      <input
                        v-model="header[0]"
                        type="text"
                        tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-[10px] md:text-[11px] font-bold text-gray-800 focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white shadow-sm"
                        :placeholder="lazyStrings.OnboardingModal__name()"
                      />
                      <input
                        v-model="header[1]"
                        type="text"
                        tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-[10px] md:text-[11px] font-bold text-gray-800 focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white shadow-sm"
                        :placeholder="lazyStrings.OnboardingModal__value()"
                      />
                      <button
                        @click="removeHeader({ index })"
                        tw-class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2Icon tw-class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                <p v-if="error" tw-class="text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-100 dark:border-red-900/30">
                  {{ error }}
                </p>
              </div>

              <div tw-class="space-y-3">
                <div tw-class="flex gap-2">
                  <button
                    @click="handleConnect"
                    :disabled="!isValidUrl || isTesting || (isBrowserProvidedLm && promptApiRuntimeState.status !== 'ready')"
                    tw-class="flex-1 py-3.5 md:py-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center gap-2 text-sm md:text-base"
                    data-testid="onboarding-connect-button"
                  >
                    <template v-if="isTesting">
                      <span tw-class="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                      <span>{{ lazyStrings.OnboardingModal__connecting() }}</span>
                    </template>
                    <template v-else>
                      <ActivityIcon tw-class="w-5 h-5" />
                      <span>{{ lazyStrings.OnboardingModal__check_connection() }}</span>
                    </template>
                  </button>
                  <button
                    v-if="isTesting"
                    @click="handleCancelConnect"
                    tw-class="px-4 py-3.5 md:px-5 md:py-4 border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400 font-bold rounded-xl hover:bg-red-50 dark:hover:bg-red-900/10 transition-all flex items-center gap-2 text-sm"
                  >
                    <span>{{ lazyStrings.OnboardingModal__cancel() }}</span>
                  </button>
                </div>

                <p tw-class="flex items-center justify-center gap-2 text-[10px] md:text-xs font-medium text-gray-500 dark:text-gray-400 pt-2">
                  <SettingsIcon tw-class="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-500/60" />
                  {{ lazyStrings.OnboardingModal__settings_can_be_changed_later() }}
                </p>
              </div>
            </template>

            <template v-else>
              <!-- Step 2: Model Selection -->
              <div class="animate-in fade-in slide-in-from-bottom-2" tw-class="space-y-4 duration-300">
                <div tw-class="bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-900/30 p-4 rounded-xl flex items-center gap-3">
                  <div tw-class="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center text-white shadow-lg shadow-green-500/20">
                    <CheckCircle2Icon tw-class="w-6 h-6" />
                  </div>
                  <div tw-class="overflow-hidden">
                    <p tw-class="text-sm font-bold text-green-800 dark:text-green-300">{{ lazyStrings.OnboardingModal__successfully_connected() }}</p>
                    <p tw-class="text-xs text-green-600 dark:text-green-400 opacity-80 truncate">{{ customUrl }}</p>
                  </div>
                </div>

                <div tw-class="space-y-2">
                  <label tw-class="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {{ lazyStrings.OnboardingModal__default_model() }}
                  </label>
                  <ModelSelector
                    v-model="selectedModel"
                    :models="sortedModels"
                    :loading="isTesting"
                    :disabled="isBrowserProvidedLm"
                    @refresh="handleConnect"
                    :placeholder="lazyStrings.OnboardingModal__select_a_model()"
                  />
                </div>

                <p v-if="error" tw-class="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-100 dark:border-red-900/30">
                  {{ error }}
                </p>

                <div tw-class="flex gap-2">
                  <button
                    @click="availableModels = []"
                    tw-class="px-4 py-3.5 md:px-5 md:py-4 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 font-bold rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-all flex items-center gap-2 text-sm"
                  >
                    <ArrowLeftIcon tw-class="w-5 h-5" />
                    <span>{{ lazyStrings.OnboardingModal__back() }}</span>
                  </button>
                  <button
                    @click="handleFinish"
                    tw-class="flex-1 py-3.5 md:py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center gap-2 text-sm md:text-base"
                    data-testid="onboarding-finish-button"
                  >
                    <PlayIcon tw-class="w-5 h-5 fill-current" />
                    <span>{{ lazyStrings.OnboardingModal__get_started() }}</span>
                  </button>
                </div>

                <p tw-class="flex items-center justify-center gap-2 text-[10px] md:text-xs font-medium text-gray-500 dark:text-gray-400 pt-2">
                  <SettingsIcon tw-class="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-500/60" />
                  {{ lazyStrings.OnboardingModal__settings_can_be_changed_later() }}
                </p>
              </div>
            </template>
          </div>

          <!-- Right Column: Setup Guide (Secondary/Auxiliary) -->
          <div v-if="isHttpEndpointType" tw-class="w-full lg:w-[38%] p-6 md:p-8 bg-gray-50/30 dark:bg-black/20 border-t lg:border-t-0 lg:border-l border-gray-100 dark:border-gray-800/50">
            <div tw-class="flex items-center gap-2 mb-4">
              <span tw-class="px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-[9px] font-bold uppercase tracking-widest">{{ lazyStrings.OnboardingModal__help_and_guide() }}</span>
            </div>
            <h3 tw-class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4">{{ lazyStrings.OnboardingModal__do_not_have_a_server() }}</h3>
            <div tw-class="opacity-70 hover:opacity-100 transition-opacity">
              <ServerSetupGuide />
            </div>
            <p tw-class="mt-6 text-[10px] text-gray-400 leading-relaxed italic">
              {{ lazyStrings.OnboardingModal__enter_existing_server_url() }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
/* Modal Transition */
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.9);
  opacity: 0;
}

.animate-in {
  animation-fill-mode: forwards;
}

@keyframes slide-in-from-bottom {
  from { transform: translateY(0.5rem); }
  to { transform: translateY(0); }
}

.slide-in-from-bottom-2 {
  animation-name: slide-in-from-bottom;
}
</style>
