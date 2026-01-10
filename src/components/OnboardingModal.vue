<script setup lang="ts">
import { ref, computed } from 'vue';
import { useSettings } from '../composables/useSettings';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { type EndpointType } from '../models/types';
import Logo from './Logo.vue';
import { Play, ArrowLeft, CheckCircle2, Activity } from 'lucide-vue-next';

const { settings, save } = useSettings();

const presets = [
  { name: 'Ollama (local)', type: 'ollama' as EndpointType, url: 'http://localhost:11434' },
  { name: 'LM Studio (local)', type: 'openai' as EndpointType, url: 'http://localhost:1234/v1' },
  { name: 'llama-server (local)', type: 'openai' as EndpointType, url: 'http://localhost:8080/v1' },
  // TODO: Uncomment after implementing authentication (API key) settings
  // { name: 'OpenAI (cloud)', type: 'openai' as EndpointType, url: 'https://api.openai.com/v1' },
];

const selectedType = ref<EndpointType>('openai');
const customUrl = ref('');
const isTesting = ref(false);
const error = ref<string | null>(null);
const availableModels = ref<string[]>([]);
const selectedModel = ref('');
let abortController: AbortController | null = null;

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

function selectPreset(preset: typeof presets[0]) {
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
    const provider = selectedType.value === 'openai' ? new OpenAIProvider() : new OllamaProvider();
    const models = await provider.listModels(url, abortController.signal);

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

async function handleFinish() {
  const url = getNormalizedUrl();
  if (!url) {
    error.value = 'Please enter a valid URL before skipping.';
    return;
  }

  try {
    await save({
      ...settings.value,
      endpointType: selectedType.value,
      endpointUrl: url,
      defaultModelId: selectedModel.value || undefined,
      titleModelId: selectedModel.value || undefined,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save settings.';
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur p-4">
    <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col border border-gray-200 dark:border-gray-800 transition-all">
      <div class="p-8 text-center border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
        <Logo class="w-16 h-16 mx-auto mb-4" />
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">Setup Endpoint</h2>
        <p class="text-gray-600 dark:text-gray-400">Set up your local or remote LLM endpoint to start chatting.</p>
      </div>

      <div class="p-6 space-y-6 flex-1 overflow-y-auto">
        <template v-if="availableModels.length === 0">
          <!-- Step 1: Configuration -->
          <div>
            <label class="block text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider mb-3">Quick Presets</label>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="preset in presets"
                :key="preset.name"
                @click="selectPreset(preset)"
                class="px-4 py-2.5 text-sm font-medium border rounded-xl transition-all duration-200 text-left hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                :class="customUrl === preset.url ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 ring-1 ring-blue-500 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800'"
              >
                {{ preset.name }}
              </button>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <label class="block text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">Endpoint Configuration</label>
              <div class="flex bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg border border-gray-200 dark:border-gray-700">
                <button 
                  @click="selectedType = 'openai'"
                  class="px-2 py-1 text-[10px] font-bold rounded-md transition-colors"
                  :class="selectedType === 'openai' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500'"
                >OPENAI</button>
                <button 
                  @click="selectedType = 'ollama'"
                  class="px-2 py-1 text-[10px] font-bold rounded-md transition-colors"
                  :class="selectedType === 'ollama' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500'"
                >OLLAMA</button>
              </div>
            </div>
            <input
              v-model="customUrl"
              type="text"
              placeholder="http://localhost:11434/v1"
              class="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all dark:text-white"
              @keyup.enter="handleConnect"
            />
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
            
            <button
              @click="handleFinish"
              class="w-full py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors underline decoration-dotted underline-offset-4"
            >
              Skip connection test and save anyway
            </button>
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
              <label class="block text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">
                Default Model
              </label>
              <select
                v-model="selectedModel"
                class="w-full px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              >
                <option v-for="model in availableModels" :key="model" :value="model">
                  {{ model }}
                </option>
              </select>
            </div>

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
              >
                <Play class="w-5 h-5 fill-current" />
                <span>Get Started</span>
              </button>
            </div>
          </div>
        </template>
      </div>

      <div class="p-6 pt-0 mt-auto border-t border-gray-100 dark:border-gray-800">
        <p class="text-center mt-4 text-[11px] text-gray-400 dark:text-gray-500">
          You can change these settings later in the settings menu.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-in-from-bottom {
  from { transform: translateY(0.5rem); }
  to { transform: translateY(0); }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-bottom-2 {
  animation-name: slide-in-from-bottom;
}
</style>
