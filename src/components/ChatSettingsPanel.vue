<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { 
  X, Settings2, 
  MessageSquareQuote, Layers, Globe, AlertCircle, Trash2, Plus
} from 'lucide-vue-next';
import LmParametersEditor from './LmParametersEditor.vue';
import ModelSelector from './ModelSelector.vue';
import { ENDPOINT_PRESETS } from '../models/constants';

const emit = defineEmits<{
  (e: 'close'): void
}>();

const chatStore = useChat();
const {
  currentChat,
  fetchingModels,
  saveChat,
} = chatStore;
const { settings } = useSettings();

const selectedProviderProfileId = ref('');
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
    currentChat.value.endpointHttpHeaders = providerProfile.endpointHttpHeaders ? JSON.parse(JSON.stringify(providerProfile.endpointHttpHeaders)) : undefined;
    currentChat.value.overrideModelId = providerProfile.defaultModelId;
    currentChat.value.systemPrompt = providerProfile.systemPrompt ? { content: providerProfile.systemPrompt, behavior: 'override' } : undefined;
    currentChat.value.lmParameters = providerProfile.lmParameters ? JSON.parse(JSON.stringify(providerProfile.lmParameters)) : undefined;
  }
  error.value = null;
  // Reset select after apply to allow re-selection if needed
  selectedProviderProfileId.value = '';
}

function addHeader() {
  if (!currentChat.value) return;
  if (!currentChat.value.endpointHttpHeaders) currentChat.value.endpointHttpHeaders = [];
  currentChat.value.endpointHttpHeaders.push(['', '']);
}

function removeHeader(index: number) {
  if (currentChat.value?.endpointHttpHeaders) {
    currentChat.value.endpointHttpHeaders.splice(index, 1);
  }
}

async function fetchModels() {
  if (currentChat.value) {
    error.value = null;
    try {
      const models = await chatStore.fetchAvailableModels(currentChat.value);
      if (models.length === 0) {
        error.value = 'No models found. Check URL or provider.';
      }
    } catch (e) {
      error.value = 'Connection failed. Check URL or provider.';
    }
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
  error.value = null;
  if (url && isLocalhost(url as string)) {
    fetchModels();
  }
});

// Persist overrides on change
watch([
  () => currentChat.value?.endpointUrl,
  () => currentChat.value?.endpointType,
  () => currentChat.value?.endpointHttpHeaders,
  () => currentChat.value?.overrideModelId,
  () => currentChat.value?.systemPrompt,
  () => currentChat.value?.lmParameters,
], () => {
  if (currentChat.value) {
    saveChat(currentChat.value);
  }
}, { deep: true });

function updateSystemPromptContent(content: string) {
  if (!currentChat.value) return;
  if (!content && (!currentChat.value.systemPrompt || currentChat.value.systemPrompt.behavior === 'override')) {
    currentChat.value.systemPrompt = undefined;
    return;
  }
  if (!currentChat.value.systemPrompt) {
    currentChat.value.systemPrompt = { content, behavior: 'override' };
  } else {
    currentChat.value.systemPrompt.content = content;
  }
}

function updateSystemPromptBehavior(behavior: 'override' | 'append') {
  if (!currentChat.value) return;
  if (!currentChat.value.systemPrompt) {
    currentChat.value.systemPrompt = { content: '', behavior };
  } else {
    currentChat.value.systemPrompt.behavior = behavior;
  }
}
</script>

<template>
  <div v-if="currentChat" class="border-b border-gray-100 dark:border-gray-800 bg-gray-50/95 dark:bg-gray-950/90 backdrop-blur-md animate-in slide-in-from-top duration-300 shadow-inner max-h-[75vh] overflow-y-auto">
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
          <!-- Quick Switcher -->
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

      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div class="space-y-2">
          <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Endpoint Type</label>
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

        <div class="space-y-2">
          <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Endpoint URL</label>
          <input 
            v-model="currentChat.endpointUrl"
            @input="error = null"
            type="text"
            class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
            :placeholder="settings.endpointUrl"
            data-testid="chat-setting-url-input"
          />
          <div class="h-4 mt-1">
            <p v-if="error" class="text-[10px] text-red-500 font-bold ml-1">{{ error }}</p>
          </div>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between ml-1">
            <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">Custom HTTP Headers</label>
            <button 
              @click="addHeader"
              type="button"
              class="text-[9px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 uppercase tracking-wider"
            >
              <Plus class="w-2.5 h-2.5" />
              Add Header
            </button>
          </div>

          <div v-if="currentChat.endpointHttpHeaders && currentChat.endpointHttpHeaders.length > 0" class="space-y-2">
            <div 
              v-for="(header, index) in currentChat.endpointHttpHeaders" 
              :key="index"
              class="flex gap-2"
            >
              <input 
                v-model="header[0]"
                type="text"
                class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                placeholder="Name"
              />
              <input 
                v-model="header[1]"
                type="text"
                class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
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
          <div v-else class="text-[10px] text-gray-400 italic ml-1">No custom headers.</div>
        </div>

        <div class="space-y-2">
          <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Model Override</label>
          <ModelSelector 
            v-model="currentChat.overrideModelId"
            :loading="fetchingModels"
            :placeholder="'Global (' + (settings.defaultModelId || 'None') + ')'"
            :allow-clear="true"
            @refresh="fetchModels"
            data-testid="chat-setting-model-select"
          />
        </div>
      </div>

      <!-- Info Banners -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="flex items-start gap-4 p-4 bg-white dark:bg-blue-900/10 border border-gray-100 dark:border-blue-900/30 rounded-2xl shadow-sm">
          <div class="p-2 bg-blue-50 dark:bg-gray-800 rounded-xl border border-blue-100 dark:border-blue-900/20">
            <Globe class="w-4 h-4 text-blue-500" />
          </div>
          <div class="space-y-1">
            <p class="text-[10px] font-bold text-blue-900/70 dark:text-blue-300 uppercase tracking-widest">Auto-Check</p>
            <p class="text-[11px] text-gray-500 dark:text-blue-400/70 leading-relaxed font-medium">Connection check is automatically performed only for localhost URLs.</p>
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
                @click="currentChat.endpointType = undefined; currentChat.endpointUrl = undefined; currentChat.overrideModelId = undefined; currentChat.systemPrompt = undefined; currentChat.lmParameters = undefined"
                class="font-bold underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                data-testid="chat-setting-restore-defaults"
              >
                Restore defaults
              </button>.
            </p>
          </div>
        </div>
      </div>

      <!-- System Prompt and Parameters -->
      <div class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-8">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div class="md:col-span-2 space-y-4">
            <div class="flex items-center justify-between">
              <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                <MessageSquareQuote class="w-3 h-3" />
                Chat System Prompt
              </label>
              
              <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                <button 
                  @click="updateSystemPromptBehavior('override')"
                  class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                  :class="currentChat.systemPrompt?.behavior !== 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                >
                  Override
                </button>
                <button 
                  @click="updateSystemPromptBehavior('append')"
                  class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                  :class="currentChat.systemPrompt?.behavior === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                >
                  Append
                </button>
              </div>
            </div>
            <textarea 
              :value="currentChat.systemPrompt?.content || ''"
              @input="e => updateSystemPromptContent((e.target as HTMLTextAreaElement).value)"
              rows="4"
              class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
              :placeholder="currentChat.systemPrompt?.behavior === 'append' ? 'Added after global instructions...' : 'Completely replaces global instructions...'"
              data-testid="chat-setting-system-prompt-textarea"
            ></textarea>
          </div>

          <div class="space-y-4">
            <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
              <Layers class="w-3 h-3" />
              Settings Resolution
            </label>
            <div class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-3">
              <div class="flex items-center justify-between text-[10px] font-bold">
                <span class="text-gray-400">System Prompt</span>
                <span :class="currentChat.systemPrompt ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-system-prompt">{{ currentChat.systemPrompt ? (currentChat.systemPrompt.behavior === 'append' ? 'Appending' : 'Overriding') : 'Global Default' }}</span>
              </div>
              <div class="flex items-center justify-between text-[10px] font-bold">
                <span class="text-gray-400">Parameters</span>
                <span :class="currentChat.lmParameters && Object.keys(currentChat.lmParameters).length > 0 ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-lm-parameters">
                  {{ currentChat.lmParameters && Object.keys(currentChat.lmParameters).length > 0 ? 'Chat Overrides' : 'Inherited' }}
                </span>
              </div>
              <div class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                <p class="text-[9px] text-gray-400 leading-relaxed italic">Chat settings take precedence over Provider Profiles, which take precedence over Global Settings.</p>
              </div>
            </div>
          </div>
        </div>

        <div class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl">
          <LmParametersEditor v-model="currentChat.lmParameters" />
        </div>
      </div>
    </div>
  </div>
</template>