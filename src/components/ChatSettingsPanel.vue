<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { X, RefreshCw, Loader2, Settings2, AlertCircle, Check, Globe } from 'lucide-vue-next';
import { ENDPOINT_PRESETS } from '../models/constants';

const emit = defineEmits<{
  (e: 'close'): void
}>();

const chatStore = useChat();
const {
  currentChat,
  availableModels,
  fetchingModels,
  saveCurrentChat,
} = chatStore;
const { settings } = useSettings();

const selectedProviderProfileId = ref('');
const connectionSuccess = ref(false);
const error = ref<string | null>(null);

function isLocalhost(url: string | undefined) {
  if (!url) return false;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

function applyPreset(preset: typeof ENDPOINT_PRESETS[number]) {
  if (!currentChat.value) return;
  currentChat.value.endpointType = preset.type;
  currentChat.value.endpointUrl = preset.url;
  error.value = null;
}

function handleQuickProviderProfileChange() {
  if (!currentChat.value) return;
  const providerProfile = settings.value.providerProfiles?.find(p => p.id === selectedProviderProfileId.value);
  if (providerProfile) {
    currentChat.value.endpointType = providerProfile.endpointType;
    currentChat.value.endpointUrl = providerProfile.endpointUrl;
    currentChat.value.overrideModelId = providerProfile.defaultModelId;
  }
  error.value = null;
  // Reset select after apply to allow re-selection if needed
  selectedProviderProfileId.value = '';
}

async function fetchModels() {
  error.value = null;
  try {
    await chatStore.fetchAvailableModels();
    connectionSuccess.value = true;
    setTimeout(() => {
      connectionSuccess.value = false;
    }, 3000);
  } catch (err) {
    console.error(err);
    error.value = 'Connection failed. Check URL or provider.';
  }
}

onMounted(() => {
  if (currentChat.value) {
    const url = currentChat.value.endpointUrl || settings.value.endpointUrl;
    if (isLocalhost(url)) {
      fetchModels();
    }
  }
});

// Auto-fetch only for localhost when URL changes
watch([
  () => currentChat.value?.endpointUrl, 
  () => currentChat.value?.endpointType,
], ([url]) => {
  if (url && isLocalhost(url as string)) {
    fetchModels();
  }
});

// Persist overrides on change
watch([
  () => currentChat.value?.endpointUrl,
  () => currentChat.value?.endpointType,
  () => currentChat.value?.overrideModelId,
], () => {
  saveCurrentChat();
}, { deep: true });
</script>

<template>
  <div v-if="currentChat" class="border-b border-gray-100 dark:border-gray-800 bg-gray-50/95 dark:bg-gray-950/90 backdrop-blur-md animate-in slide-in-from-top duration-300 shadow-inner">
    <div class="max-w-4xl mx-auto p-6 space-y-8">
      <!-- Title & Close -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
            <Settings2 class="w-4 h-4 text-blue-600" />
          </div>
          <h3 class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">Chat Specific Overrides</h3>
        </div>
        <button @click="emit('close')" class="text-[10px] font-bold text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex items-center gap-1.5 uppercase tracking-widest">
          <X class="w-3.5 h-3.5" />
          Close
        </button>
      </div>

      <div class="flex flex-col md:flex-row md:items-end justify-between border-b border-gray-200/50 dark:border-gray-800 pb-8 gap-6">
        <div class="flex flex-col md:flex-row gap-8 flex-1">
          <!-- Quick Switcher (If profiles exist) -->
          <div v-if="settings.providerProfiles && settings.providerProfiles.length > 0" class="w-full md:max-w-[240px] space-y-2">
            <label class="block text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider ml-1">Quick Profile Switcher</label>
            <select 
              v-model="selectedProviderProfileId"
              @change="handleQuickProviderProfileChange"
              class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
            >
              <option value="" disabled>Load from saved profiles...</option>
              <option v-for="p in settings.providerProfiles" :key="p.id" :value="p.id">{{ p.name }} ({{ p.endpointType === 'ollama' ? 'Ollama' : 'OpenAI' }})</option>
            </select>
          </div>

          <!-- Endpoint Presets -->
          <div class="space-y-2 flex-1">
            <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider ml-1">Quick Endpoint Presets</label>
            <div class="flex flex-wrap gap-1.5">
              <button 
                v-for="preset in ENDPOINT_PRESETS" 
                :key="preset.name"
                @click="applyPreset(preset)"
                type="button"
                class="px-4 py-2 text-[10px] font-bold rounded-xl border transition-all shadow-sm"
                :class="currentChat.endpointUrl === preset.url && currentChat.endpointType === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600'"
              >
                {{ preset.name }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div class="space-y-2">
          <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Endpoint Type</label>
          <div class="relative">
            <select 
              v-model="currentChat.endpointType"
              class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
            >
              <option :value="undefined">Global ({{ settings.endpointType }})</option>
              <option value="openai">OpenAI Compatible</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>
        </div>

        <div class="space-y-2">
          <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Endpoint URL</label>
          <input 
            v-model="currentChat.endpointUrl"
            type="text"
            class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
            :placeholder="settings.endpointUrl"
            data-testid="chat-setting-url-input"
          />

          <!-- Error message with fixed height to prevent layout shift -->
          <div class="h-4 mt-1">
            <p v-if="error" class="text-[10px] text-red-500 font-bold ml-1 animate-in fade-in slide-in-from-top-1 duration-200">{{ error }}</p>
          </div>
        </div>

        <div class="space-y-2">
          <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Model Override</label>
          <div class="flex gap-2">
            <div class="relative flex-1">
              <select 
                v-model="currentChat.overrideModelId"
                class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                data-testid="chat-setting-model-select"
              >
                <option :value="undefined">Global ({{ settings.defaultModelId || 'None' }})</option>
                <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <button 
              @click="fetchModels" 
              class="p-3 border transition-all flex items-center justify-center disabled:opacity-50 shadow-sm rounded-xl"
              :class="[
                connectionSuccess 
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-800 text-green-600 dark:text-green-400' 
                  : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-400'
              ]"
              :disabled="fetchingModels"
              title="Refresh Model List"
              data-testid="chat-setting-refresh-models"
            >
              <div class="relative w-4 h-4 flex items-center justify-center">
                <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin absolute" />
                <Check v-else-if="connectionSuccess" class="w-4 h-4 animate-in zoom-in duration-300" data-testid="chat-setting-refresh-success-icon" />
                <RefreshCw v-else class="w-4 h-4" />
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- Info banners -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="flex items-start gap-4 p-4 bg-white dark:bg-blue-900/10 border border-gray-100 dark:border-blue-900/30 rounded-2xl shadow-sm">
          <div class="p-2 bg-blue-50 dark:bg-gray-800 rounded-xl border border-blue-100 dark:border-blue-900/20">
            <Globe class="w-4 h-4 text-blue-500" />
          </div>
          <div class="space-y-1">
            <p class="text-[10px] font-bold text-blue-900/70 dark:text-blue-300 uppercase tracking-widest">Auto-Check</p>
            <p class="text-[11px] text-gray-500 dark:text-blue-400/70 leading-relaxed font-medium">
              Connection check is automatically performed only for localhost URLs.
            </p>
          </div>
        </div>

        <div class="flex items-start gap-4 p-4 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm">
          <div class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700">
            <AlertCircle class="w-4 h-4 text-gray-400" />
          </div>
          <div class="space-y-1">
            <p class="text-[10px] font-bold text-gray-400 dark:text-gray-400 uppercase tracking-widest">Local Overrides</p>
            <p class="text-[11px] text-gray-500/70 dark:text-gray-400/70 leading-relaxed font-medium">
              These settings only apply to this chat. 
              <button 
                @click="currentChat.endpointType = undefined; currentChat.endpointUrl = undefined; currentChat.overrideModelId = undefined"
                class="font-bold underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
              >
                Restore defaults
              </button>.
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>