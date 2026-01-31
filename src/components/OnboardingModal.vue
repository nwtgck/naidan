<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useSettings } from '../composables/useSettings';
import ThemeToggle from './ThemeToggle.vue';
import { useToast } from '../composables/useToast';
import { useLayout } from '../composables/useLayout';
import { OpenAIProvider, OllamaProvider, type LLMProvider } from '../services/llm';
import { type EndpointType, type Settings as SettingsType } from '../models/types';
import { ENDPOINT_PRESETS } from '../models/constants';
import Logo from './Logo.vue';
import ServerSetupGuide from './ServerSetupGuide.vue';
import ModelSelector from './ModelSelector.vue';
import { Play, ArrowLeft, CheckCircle2, Activity, Settings, X, Plus, Trash2 } from 'lucide-vue-next';
import { naturalSort } from '../utils/string';

const { settings, save, onboardingDraft, setIsOnboardingDismissed, setOnboardingDraft, initialized, isOnboardingDismissed } = useSettings();
const toast = useToast();
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

const isValidUrl = computed(() => {
  return !!getNormalizedUrl();
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
  if (!url) {
    error.value = 'Please enter a valid URL (e.g., localhost:11434)';
    return;
  }

  isTesting.value = true;
  error.value = null;
  abortController = new AbortController();

  try {
    let provider: LLMProvider;
    switch (selectedType.value) {
    case 'openai':
      provider = new OpenAIProvider({ endpoint: url, headers: customHeaders.value });
      break;
    case 'ollama':
      provider = new OllamaProvider({ endpoint: url, headers: customHeaders.value });
      break;
    default: {
      const _ex: never = selectedType.value;
      throw new Error(`Unsupported endpoint type: ${_ex}`);
    }
    }
    const models = await provider.listModels({ signal: abortController.signal });

    if (models.length === 0) {
      throw new Error('No models found at this endpoint.');
    }

    availableModels.value = models;
    selectedModel.value = models[0] || '';
    customUrl.value = url; // Update UI with normalized URL
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
  
  toast.addToast({
    message: 'Setup skipped. You can always configure it later in settings.',
    actionLabel: 'Undo',
    onAction: () => {
      setIsOnboardingDismissed(false);
    },
    duration: 5000,
  });
}

async function handleFinish() {
  const url = getNormalizedUrl();
  
  if (!url) {
    error.value = 'Please enter a valid URL (e.g., localhost:11434)';
    return;
  }

  try {
    const baseSettings = JSON.parse(JSON.stringify(settings.value)) as SettingsType;
    await save({
      ...baseSettings,
      endpointType: selectedType.value,
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
      <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-4xl h-[640px] max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-gray-800 relative modal-content-zoom">
        <!-- Close Button (Top Right) -->
      
        <button 
          @click="handleClose"
          class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
          data-testid="onboarding-close-x"
        >
          <X class="w-5 h-5" />
        </button>

        <div class="px-10 py-4 flex items-center gap-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 shrink-0">
          <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <Logo class="w-8 h-8" />
          </div>
          <div class="text-left flex-1">
            <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Setup Endpoint</h2>
            <p class="text-xs text-gray-600 dark:text-gray-400">Set up your local or remote LLM endpoint to start chatting.</p>
          </div>
          <div class="w-32 flex-shrink-0 mr-8">
            <ThemeToggle />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto min-h-0">

          <div class="flex flex-col lg:flex-row h-full">

            <!-- Left Column: Configuration (Primary) -->

            <div class="w-full lg:w-[62%] p-10 space-y-8">

              <template v-if="availableModels.length === 0">

                <!-- Step 1: Configuration -->

      
                <div>
                  <label class="block text-[10px] font-bold text-gray-500 dark:text-gray-500 uppercase tracking-wider mb-2 ml-1">Quick Presets</label>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="preset in ENDPOINT_PRESETS"
                      :key="preset.name"
                      @click="selectPreset(preset)"
                      class="px-3 py-1.5 text-[11px] font-bold border rounded-lg transition-all duration-200"
                      :class="customUrl === preset.url ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600'"
                    >
                      {{ preset.name }}
                    </button>
                  </div>
                </div>
                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <label class="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Endpoint Configuration</label>
                    <div class="flex bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg border border-gray-100 dark:border-gray-700">
                      <button 
                        @click="selectedType = 'openai'"
                        class="px-2.5 py-1 text-[10px] font-bold rounded-md transition-colors whitespace-nowrap"
                        :class="selectedType === 'openai' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400'"
                      >OpenAI-compatible</button>
                                    
                      <button 
                        @click="selectedType = 'ollama'"
                        class="px-2.5 py-1 text-[10px] font-bold rounded-md transition-colors"
                        :class="selectedType === 'ollama' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-400'"
                      >Ollama</button>
                    </div>
                  
                  </div>
                  <input
                    v-model="customUrl"
                    type="text"
                    placeholder="http://localhost:11434"
                    class="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all dark:text-white"
                    @keydown.enter="$event => !$event.isComposing && handleConnect()"
                  />

                  <!-- Custom HTTP Headers -->
                  <div class="space-y-3">
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
                          class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white shadow-sm"
                          placeholder="Name"
                        />
                        <input 
                          v-model="header[1]"
                          type="text"
                          class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white shadow-sm"
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

                  <p v-if="error" class="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-100 dark:border-red-900/30">
                    {{ error }}
                  </p>
                </div>

                <div class="space-y-3">
                  <div class="flex gap-2">
                    <button
                      @click="handleConnect"
                      :disabled="!isValidUrl || isTesting"
                      class="flex-1 py-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center gap-2"
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
                      class="px-5 py-4 border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400 font-bold rounded-xl hover:bg-red-50 dark:hover:bg-red-900/10 transition-all flex items-center gap-2"
                    >
                      <span>Cancel</span>
                    </button>
                  </div>
                
                  <p class="flex items-center justify-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 pt-2">
                    <Settings class="w-4 h-4 text-blue-500/60" />
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
                      class="px-5 py-4 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 font-bold rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-all flex items-center gap-2"
                    >
                      <ArrowLeft class="w-5 h-5" />
                      <span>Back</span>
                    </button>
                    <button
                      @click="handleFinish"
                      class="flex-1 py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center gap-2"
                      data-testid="onboarding-finish-button"
                    >
                      <Play class="w-5 h-5 fill-current" />
                      <span>Get Started</span>
                    </button>
                  </div>

                  <p class="flex items-center justify-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 pt-2">
                    <Settings class="w-4 h-4 text-blue-500/60" />
                    You can change these settings later in the settings menu.
                  </p>
                </div>
              </template>
            </div>

            <!-- Right Column: Setup Guide (Secondary/Auxiliary) -->
            <div class="w-full lg:w-[38%] p-8 bg-gray-50/30 dark:bg-black/20 border-t lg:border-t-0 lg:border-l border-gray-100 dark:border-gray-800/50">
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
