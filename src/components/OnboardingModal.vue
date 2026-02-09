<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useLayout } from '../composables/useLayout';
import { OpenAIProvider, OllamaProvider, type LLMProvider } from '../services/llm';
import { TransformersJsProvider } from '../services/transformers-js-provider';
import { type EndpointType, type Settings as SettingsType } from '../models/types';
import { ENDPOINT_PRESETS } from '../models/constants';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';

// IMPORTANT: ThemeToggle is part of the core onboarding UI.
import ThemeToggle from './ThemeToggle.vue';
// IMPORTANT: Logo is part of the core onboarding UI.
import Logo from './Logo.vue';
// IMPORTANT: ModelSelector is part of the core onboarding UI.
import ModelSelector from './ModelSelector.vue';

// Lazily load onboarding guides and managers, but prefetch them when idle.
const ServerSetupGuide = defineAsyncComponentAndLoadOnMounted(() => import('./ServerSetupGuide.vue'));
const TransformersJsManager = defineAsyncComponentAndLoadOnMounted(() => import('./TransformersJsManager.vue'));
import { transformersJsService } from '../services/transformers-js';
import { Play, ArrowLeft, CheckCircle2, Activity, Settings, X, Plus, Trash2, FlaskConical } from 'lucide-vue-next';
import { naturalSort } from '../utils/string';

const { settings, save, onboardingDraft, setIsOnboardingDismissed, setOnboardingDraft, initialized, isOnboardingDismissed } = useSettings();
const { setActiveFocusArea } = useLayout();

const show = computed(() => initialized.value && !isOnboardingDismissed.value);

watch(show, (val) => {
  if (val) {
    setActiveFocusArea('onboarding');
  } else {
    setActiveFocusArea('chat');
  }
}, { immediate: true });

const selectedType = ref<EndpointType>(onboardingDraft.value?.type || 'openai');

const isTransformersJs = computed(() => {
  const type = selectedType.value;
  switch (type) {
  case 'transformers_js':
    return true;
  case 'openai':
  case 'ollama':
    return false;
  default: {
    const _ex: never = type;
    return _ex;
  }
  }
});

// Reactive sync with transformersJsService
let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = transformersJsService.subscribe(() => {
    const state = transformersJsService.getState();
    const type = selectedType.value;
    switch (type) {
    case 'transformers_js':
      if (state.activeModelId) {
        selectedModel.value = state.activeModelId;
      }
      break;
    case 'openai':
    case 'ollama':
      break;
    default: {
      const _ex: never = type;
      return _ex;
    }
    }
  });
});

onUnmounted(() => {
  if (unsubscribe) unsubscribe();
});

// Auto-load existing model when switching to transformers_js
watch(selectedType, async (newType) => {
  switch (newType) {
  case 'transformers_js': {
    const cached = await transformersJsService.listCachedModels();
    if (cached.length > 0 && !transformersJsService.getState().activeModelId) {
      // Load the most recently modified model
      const sorted = [...cached].sort((a, b) => b.lastModified - a.lastModified);
      const target = sorted[0]?.id;
      if (target) {
        try {
          await transformersJsService.loadModel(target);
          selectedModel.value = target;
        } catch (e) {
          console.warn('Auto-load failed:', e);
        }
      }
    }
    break;
  }
  case 'openai':
  case 'ollama':
    break;
  default: {
    const _ex: never = newType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
});

const customUrl = ref(onboardingDraft.value?.url || '');
const customHeaders = ref<[string, string][]>(onboardingDraft.value?.headers ? JSON.parse(JSON.stringify(onboardingDraft.value.headers)) : []);
const isTesting = ref(false);
const error = ref<string | null>(null);
const availableModels = ref<string[]>(onboardingDraft.value?.models ? JSON.parse(JSON.stringify(onboardingDraft.value.models)) : []);
const sortedModels = computed(() => naturalSort(availableModels.value));
const selectedModel = ref(onboardingDraft.value?.selectedModel || '');
let abortController: AbortController | null = null;

function addHeader() {
  customHeaders.value.push(['', '']);
}

function removeHeader(index: number) {
  customHeaders.value.splice(index, 1);
}

function handleModelLoaded(modelId: string) {
  if (isTransformersJs.value) {
    selectedModel.value = modelId;
  }
}

const isValidUrl = computed(() => {
  return isTransformersJs.value || !!getNormalizedUrl();
});

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

function isLocalhost(url: string | undefined) {
  if (!url) return false;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

// Auto-fetch for localhost or transformers_js when URL/Type changes
watch([selectedType, customUrl], ([type, url]) => {
  error.value = null;
  const isAutoFetch = (() => {
    switch (type) {
    case 'transformers_js':
      return true;
    case 'openai':
    case 'ollama':
      return isLocalhost(url);
    default: {
      const _ex: never = type;
      return _ex;
    }
    }
  })();

  if (isAutoFetch) {
    handleConnect();
  }
});

function selectPreset(preset: typeof ENDPOINT_PRESETS[number]) {
  selectedType.value = preset.type;
  customUrl.value = preset.url;
  // Reset models if user changes preset/url
  availableModels.value = [];
}

function handleCancelConnect() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  isTesting.value = false;
  error.value = 'Connection attempt cancelled.';
}

async function handleConnect() {
  const url = getNormalizedUrl();
  const type = selectedType.value;

  if (!url && !isTransformersJs.value) {
    error.value = 'Please enter a valid URL (e.g., localhost:11434)';
    return;
  }

  isTesting.value = true;
  error.value = null;
  abortController = new AbortController();

  try {
    let provider: LLMProvider;
    switch (type) {
    case 'openai':
      provider = new OpenAIProvider({ endpoint: url || '', headers: customHeaders.value });
      break;
    case 'ollama':
      provider = new OllamaProvider({ endpoint: url || '', headers: customHeaders.value });
      break;
    case 'transformers_js':
      provider = new TransformersJsProvider();
      break;
    default: {
      const _ex: never = type;
      throw new Error(`Unsupported endpoint type: ${_ex}`);
    }
    }
    const models = await provider.listModels({ signal: abortController.signal });

    if (models.length === 0) {
      throw new Error('No models found at this endpoint.');
    }

    availableModels.value = models;
    selectedModel.value = models[0] || '';
    if (url) customUrl.value = url; // Update UI with normalized URL
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return;
    }
    error.value = e instanceof Error ? e.message : 'Failed to connect to the endpoint.';
  } finally {
    isTesting.value = false;
    abortController = null;
  }
}

async function handleClose() {
  setOnboardingDraft({ 
    url: customUrl.value, 
    type: selectedType.value,
    headers: customHeaders.value,
    models: availableModels.value,
    selectedModel: selectedModel.value,
  });
  setIsOnboardingDismissed(true);
}

async function handleFinish() {
  const url = getNormalizedUrl();
  const type = selectedType.value;
  
  if (!url && !isTransformersJs.value) {
    error.value = 'Please enter a valid URL (e.g., localhost:11434)';
    return;
  }

  try {
    const baseSettings = JSON.parse(JSON.stringify(settings.value)) as SettingsType;
    await save({
      ...baseSettings,
      endpointType: type,
      endpointUrl: url || undefined,
      endpointHttpHeaders: customHeaders.value.length > 0 ? customHeaders.value : undefined,
      defaultModelId: selectedModel.value || undefined,
      titleModelId: selectedModel.value || undefined,
    });

    setOnboardingDraft(null);
    setIsOnboardingDismissed(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save settings.';
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4">
      <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-4xl md:h-[640px] max-h-[95vh] md:max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-gray-800 relative modal-content-zoom">
        <!-- Close Button (Top Right) -->
      
        <button 
          @click="handleClose"
          class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
          data-testid="onboarding-close-x"
        >
          <X class="w-5 h-5" />
        </button>

        <div class="px-6 md:px-10 py-4 flex items-center gap-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 shrink-0">
          <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <Logo class="w-6 h-6 md:w-8 md:h-8" />
          </div>
          <div class="text-left flex-1">
            <h2 class="text-base md:text-lg font-bold text-gray-800 dark:text-white tracking-tight">Setup Endpoint</h2>
            <p class="hidden sm:block text-xs text-gray-600 dark:text-gray-400">Set up your local or remote LLM endpoint to start chatting.</p>
          </div>
          <div class="w-24 md:w-32 flex-shrink-0 mr-8">
            <ThemeToggle />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto min-h-0 overscroll-contain">

          <div class="flex flex-col lg:flex-row h-full">

            <!-- Left Column: Configuration (Primary) -->

            <div :class="isTransformersJs ? 'w-full' : 'w-full lg:w-[62%]'" class="p-6 md:p-10 space-y-6 md:space-y-8">

              <template v-if="isTransformersJs">
                <!-- Transformers.js Integrated View -->
                <div class="space-y-6 md:space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <!-- Type Switcher (Repeated here for easy switching) -->
                  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800">
                    <div>
                      <h3 class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                        <FlaskConical class="w-4 h-4 text-purple-500" />
                        In-Browser AI
                        <span class="px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400 text-[10px] rounded-md font-bold uppercase tracking-wider">Experimental</span>
                      </h3>
                      <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">Run models locally in your browser using Transformers.js. No server required.</p>
                    </div>
                    <div class="flex bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg border border-gray-100 dark:border-gray-700 w-fit shrink-0">
                      <button 
                        @click="selectedType = 'openai'; availableModels = []"
                        class="px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors whitespace-nowrap text-gray-400"
                      >OpenAI-compatible</button>
                                    
                      <button 
                        @click="selectedType = 'ollama'; availableModels = []"
                        class="px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors text-gray-400"
                      >Ollama</button>

                      <button 
                        class="px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors whitespace-nowrap bg-white dark:bg-gray-700 shadow-sm text-purple-600 dark:text-purple-400"
                      >Transformers.js</button>
                    </div>
                  </div>

                  <TransformersJsManager @model-loaded="handleModelLoaded" />

                  <div class="flex flex-col sm:flex-row items-center gap-4 pt-6 border-t border-gray-100 dark:border-gray-800">
                    <button
                      @click="handleFinish"
                      :disabled="!selectedModel"
                      class="w-full sm:w-auto px-8 py-3.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-lg shadow-purple-500/30 transition-all flex items-center justify-center gap-2 text-sm md:text-base"
                    >
                      <Play class="w-5 h-5 fill-current" />
                      <span>Get Started</span>
                    </button>
                    <p class="flex items-center gap-2 text-[10px] md:text-xs font-medium text-gray-500 dark:text-gray-400">
                      <Settings class="w-3.5 h-3.5 md:w-4 md:h-4 text-purple-500/60" />
                      Settings will be saved for local inference.
                    </p>
                  </div>
                </div>
              </template>

              <template v-else-if="availableModels.length === 0">

                <!-- Step 1: Configuration -->

      
                <div>
                  <label class="block text-[10px] font-bold text-gray-500 dark:text-gray-500 uppercase tracking-wider mb-2 ml-1">Quick Presets</label>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="preset in ENDPOINT_PRESETS"
                      :key="preset.name"
                      @click="selectPreset(preset)"
                      class="px-2.5 py-1.5 md:px-3 md:py-1.5 text-[10px] md:text-[11px] font-bold border rounded-lg transition-all duration-200"
                      :class="customUrl === preset.url ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600'"
                    >
                      {{ preset.name }}
                    </button>
                  </div>
                </div>
                <div class="space-y-3">
                  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <label class="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Endpoint Configuration</label>
                    <div class="flex bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg border border-gray-100 dark:border-gray-700 w-fit">
                      <button 
                        @click="selectedType = 'openai'"
                        class="px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors whitespace-nowrap"
                        :class="selectedType === 'openai' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400'"
                      >OpenAI-compatible</button>
                                    
                      <button 
                        @click="selectedType = 'ollama'"
                        class="px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-colors"
                        :class="selectedType === 'ollama' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400'"
                      >Ollama</button>

                      <button 
                        @click="selectedType = 'transformers_js'"
                        class="px-2 md:px-2.5 py-1 text-[9px] md:text-[10px] font-bold rounded-md transition-all whitespace-nowrap flex items-center gap-1"
                        :class="isTransformersJs ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600'"
                      >
                        <FlaskConical class="w-2.5 h-2.5" />
                        Transformers.js
                      </button>
                    </div>
                  
                  </div>
                  <input
                    v-if="!isTransformersJs"
                    v-model="customUrl"
                    type="text"
                    placeholder="http://localhost:11434"
                    class="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all dark:text-white text-sm"
                    @keydown.enter="$event => !$event.isComposing && handleConnect()"
                  />

                  <!-- Custom HTTP Headers -->
                  <div class="space-y-3" v-if="!isTransformersJs">
                    <div class="flex items-center justify-between ml-1">
                      <label class="block text-[10px] font-bold text-gray-500 uppercase tracking-widest">Custom HTTP Headers</label>
                      <button 
                        @click="addHeader"
                        type="button"
                        class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
                      >
                        <Plus class="w-2.5 h-2.5" />
                        Add Header
                      </button>
                    </div>

                    <div v-if="customHeaders.length > 0" class="space-y-2 max-h-[120px] overflow-y-auto no-scrollbar">
                      <div 
                        v-for="(header, index) in customHeaders" 
                        :key="index"
                        class="flex gap-2 animate-in fade-in slide-in-from-left-1 duration-200"
                      >
                        <input 
                          v-model="header[0]"
                          type="text"
                          class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-[10px] md:text-[11px] font-bold text-gray-800 focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white shadow-sm"
                          placeholder="Name"
                        />
                        <input 
                          v-model="header[1]"
                          type="text"
                          class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-[10px] md:text-[11px] font-bold text-gray-800 focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white shadow-sm"
                          placeholder="Value"
                        />
                        <button 
                          @click="removeHeader(index)"
                          class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 class="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <p v-if="error" class="text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-100 dark:border-red-900/30">
                    {{ error }}
                  </p>
                </div>

                <div class="space-y-3">
                  <div class="flex gap-2">
                    <button
                      @click="handleConnect"
                      :disabled="!isValidUrl || isTesting"
                      class="flex-1 py-3.5 md:py-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center gap-2 text-sm md:text-base"
                      data-testid="onboarding-connect-button"
                    >
                      <template v-if="isTesting">
                        <span class="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                        <span>Connecting...</span>
                      </template>
                      <template v-else>
                        <Activity class="w-5 h-5" />
                        <span>Check Connection</span>
                      </template>
                    </button>
                    <button
                      v-if="isTesting"
                      @click="handleCancelConnect"
                      class="px-4 py-3.5 md:px-5 md:py-4 border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400 font-bold rounded-xl hover:bg-red-50 dark:hover:bg-red-900/10 transition-all flex items-center gap-2 text-sm"
                    >
                      <span>Cancel</span>
                    </button>
                  </div>
                
                  <p class="flex items-center justify-center gap-2 text-[10px] md:text-xs font-medium text-gray-500 dark:text-gray-400 pt-2">
                    <Settings class="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-500/60" />
                    You can change these settings later in the settings menu.
                  </p>
                </div>
              </template>

              <template v-else>
                <!-- Step 2: Model Selection -->
                <div class="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div class="bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-900/30 p-4 rounded-xl flex items-center gap-3">
                    <div class="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center text-white shadow-lg shadow-green-500/20">
                      <CheckCircle2 class="w-6 h-6" />
                    </div>
                    <div class="overflow-hidden">
                      <p class="text-sm font-bold text-green-800 dark:text-green-300">Successfully Connected!</p>
                      <p class="text-xs text-green-600 dark:text-green-400 opacity-80 truncate">{{ customUrl }}</p>
                    </div>
                  </div>

                  <div class="space-y-2">
                    <label class="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Default Model
                    </label>
                    <ModelSelector
                      v-model="selectedModel"
                      :models="sortedModels"
                      :loading="isTesting"
                      @refresh="handleConnect"
                      placeholder="Select a model"
                    />
                  </div>

                  <p v-if="error" class="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-100 dark:border-red-900/30">
                    {{ error }}
                  </p>

                  <div class="flex gap-2">
                    <button
                      @click="availableModels = []"
                      class="px-4 py-3.5 md:px-5 md:py-4 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 font-bold rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-all flex items-center gap-2 text-sm"
                    >
                      <ArrowLeft class="w-5 h-5" />
                      <span>Back</span>
                    </button>
                    <button
                      @click="handleFinish"
                      class="flex-1 py-3.5 md:py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center gap-2 text-sm md:text-base"
                      data-testid="onboarding-finish-button"
                    >
                      <Play class="w-5 h-5 fill-current" />
                      <span>Get Started</span>
                    </button>
                  </div>

                  <p class="flex items-center justify-center gap-2 text-[10px] md:text-xs font-medium text-gray-500 dark:text-gray-400 pt-2">
                    <Settings class="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-500/60" />
                    You can change these settings later in the settings menu.
                  </p>
                </div>
              </template>
            </div>

            <!-- Right Column: Setup Guide (Secondary/Auxiliary) -->
            <div v-if="!isTransformersJs" class="w-full lg:w-[38%] p-6 md:p-8 bg-gray-50/30 dark:bg-black/20 border-t lg:border-t-0 lg:border-l border-gray-100 dark:border-gray-800/50">
              <div class="flex items-center gap-2 mb-4">
                <span class="px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-[9px] font-bold uppercase tracking-widest">Help & Guide</span>
              </div>
              <h3 class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4">Don't have a server yet?</h3>
              <div class="opacity-70 hover:opacity-100 transition-opacity">
                <ServerSetupGuide />
              </div>
              <p class="mt-6 text-[10px] text-gray-400 leading-relaxed italic">
                * If you already have Ollama or llama-server running, just enter the URL on the left.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
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
