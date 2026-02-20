<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { useLayout } from '../composables/useLayout';
import {
  Settings2,
  MessageSquareQuote, Layers, Globe, AlertCircle, Trash2, Plus,
  ChefHat, Search
} from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
import { useGlobalSearch } from '../composables/useGlobalSearch';

// IMPORTANT: ModelSelector is used for immediate model override feedback and should not flicker.
import ModelSelector from './ModelSelector.vue';

// Lazily load heavier or secondary settings components, but prefetch them when idle.
const LmParametersEditor = defineAsyncComponentAndLoadOnMounted(() => import('./LmParametersEditor.vue'));
// Lazily load modals that are only shown on-demand
const RecipeExportModal = defineAsyncComponentAndLoadOnMounted(() => import('./RecipeExportModal.vue'));
// Lazily load upsell UI
const TransformersJsUpsell = defineAsyncComponentAndLoadOnMounted(() => import('./TransformersJsUpsell.vue'));

import { ENDPOINT_PRESETS } from '../models/constants';
import type { ChatGroup } from '../models/types';
import { naturalSort } from '../utils/string';
import { hasGroupOverrides } from '../utils/chat-settings-resolver';

const chatStore = useChat();
const {
  currentChatGroup,
  fetchingModels,
} = chatStore;
const { settings } = useSettings();
const { setActiveFocusArea } = useLayout();

const selectedProviderProfileId = ref('');
const error = ref<string | null>(null);
const groupModels = ref<string[]>([]);
const sortedGroupModels = computed(() => naturalSort(groupModels.value || []));

const effectiveEndpointType = computed(() => {
  return localSettings.value.endpoint?.type || settings.value.endpointType;
});

// Local state for editing
const localSettings = ref<Partial<Pick<ChatGroup, 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>>({});

// Recipe Export State
const showExportModal = ref(false);

function handleCreateRecipe() {
  showExportModal.value = true;
}

function syncLocalWithCurrent() {
  if (currentChatGroup.value) {
    localSettings.value = {
      endpoint: currentChatGroup.value.endpoint ? JSON.parse(JSON.stringify(currentChatGroup.value.endpoint)) : undefined,
      modelId: currentChatGroup.value.modelId,
      autoTitleEnabled: currentChatGroup.value.autoTitleEnabled,
      titleModelId: currentChatGroup.value.titleModelId,
      systemPrompt: currentChatGroup.value.systemPrompt ? JSON.parse(JSON.stringify(currentChatGroup.value.systemPrompt)) : undefined,
      lmParameters: currentChatGroup.value.lmParameters ? JSON.parse(JSON.stringify(currentChatGroup.value.lmParameters)) : undefined,
    };
  }
}

onMounted(() => {
  syncLocalWithCurrent();
  if (currentChatGroup.value) {
    const url = localSettings.value.endpoint?.url || settings.value.endpointUrl;
    const type = localSettings.value.endpoint?.type || settings.value.endpointType;
    if (type === 'transformers_js' || isLocalhost(url)) {
      fetchModels();
    }
  }
});

// Sync if currentChatGroup changes while open (e.g. from another tab or property update)
watch(currentChatGroup, syncLocalWithCurrent, { deep: true });

const hasActiveOverrides = computed(() => {
  return hasGroupOverrides({ group: localSettings.value });
});

async function saveChanges() {
  if (currentChatGroup.value) {
    await chatStore.updateChatGroupMetadata(currentChatGroup.value.id, localSettings.value);
  }
}

function isLocalhost(url: string | undefined) {
  if (!url) return false;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

async function applyPreset(preset: typeof ENDPOINT_PRESETS[number]) {
  localSettings.value.endpoint = { type: preset.type, url: preset.url };
  error.value = null;
  await saveChanges();
}

async function handleQuickProviderProfileChange() {
  const providerProfile = settings.value.providerProfiles?.find(p => p.id === selectedProviderProfileId.value);
  if (providerProfile) {
    localSettings.value.endpoint = {
      type: providerProfile.endpointType,
      url: providerProfile.endpointUrl,
      httpHeaders: providerProfile.endpointHttpHeaders ? JSON.parse(JSON.stringify(providerProfile.endpointHttpHeaders)) : undefined,
    };
    localSettings.value.modelId = providerProfile.defaultModelId;
    localSettings.value.systemPrompt = providerProfile.systemPrompt ? { content: providerProfile.systemPrompt, behavior: 'override' } : undefined;
    localSettings.value.lmParameters = providerProfile.lmParameters ? JSON.parse(JSON.stringify(providerProfile.lmParameters)) : undefined;
    await saveChanges();
  }
  error.value = null;
  selectedProviderProfileId.value = '';
}

async function addHeader() {
  if (!localSettings.value.endpoint) {
    localSettings.value.endpoint = { type: 'openai', url: '', httpHeaders: [] };
  }
  if (!localSettings.value.endpoint.httpHeaders) localSettings.value.endpoint.httpHeaders = [];
  localSettings.value.endpoint.httpHeaders.push(['', '']);
}

async function removeHeader(index: number) {
  if (localSettings.value.endpoint?.httpHeaders) {
    localSettings.value.endpoint.httpHeaders.splice(index, 1);
    await saveChanges();
  }
}

async function fetchModels() {
  if (currentChatGroup.value) {
    error.value = null;
    const type = localSettings.value.endpoint?.type || settings.value.endpointType;
    const url = localSettings.value.endpoint?.url || settings.value.endpointUrl || '';
    const headers = localSettings.value.endpoint?.httpHeaders || settings.value.endpointHttpHeaders;

    if (!url && type !== 'transformers_js') {
      groupModels.value = [];
      return;
    }

    try {
      const mutableHeaders = headers ? JSON.parse(JSON.stringify(headers)) : undefined;
      const models = await chatStore.fetchAvailableModels(undefined, { type, url, headers: mutableHeaders });
      groupModels.value = models;
      if (models.length === 0) {
        error.value = 'No models found at this endpoint.';
      }

      // Validate local modelId against new models
      if (localSettings.value.modelId && !models.includes(localSettings.value.modelId)) {
        localSettings.value.modelId = undefined;
        await saveChanges();
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Connection failed. Check URL or provider.';
    }
  }
}

// Auto-fetch for localhost or transformers_js when URL/Type changes
watch([
  () => localSettings.value.endpoint?.url,
  () => localSettings.value.endpoint?.type,
], ([url, type]) => {
  error.value = null;
  if (type === 'transformers_js' || (url && isLocalhost(url as string))) {
    fetchModels();
  }
});

/*
async function updateSystemPromptContent(content: string) {
  if (!content && (!localSettings.value.systemPrompt || localSettings.value.systemPrompt.behavior === 'override')) {
    localSettings.value.systemPrompt = undefined;
  } else if (!localSettings.value.systemPrompt) {
    localSettings.value.systemPrompt = { content, behavior: 'override' };
  } else {
    localSettings.value.systemPrompt = { ...localSettings.value.systemPrompt, content };
  }
}
*/

async function updateSystemPromptBehavior(behavior: 'override' | 'append' | 'inherit', isClear = false) {
  switch (behavior) {
  case 'inherit':
    localSettings.value.systemPrompt = undefined;
    break;
  case 'override':
  case 'append':
    if (isClear) {
      localSettings.value.systemPrompt = { behavior: 'override', content: null };
    } else if (!localSettings.value.systemPrompt) {
      localSettings.value.systemPrompt = { content: '', behavior };
    } else {
      const content = localSettings.value.systemPrompt.content ?? '';
      localSettings.value.systemPrompt = { behavior, content };
    }
    break;
  default: {
    const _ex: never = behavior;
    throw new Error(`Unhandled behavior: ${_ex}`);
  }
  }
  await saveChanges();
}

async function restoreDefaults() {
  localSettings.value = {
    endpoint: undefined,
    modelId: undefined,
    autoTitleEnabled: undefined,
    titleModelId: undefined,
    systemPrompt: undefined,
    lmParameters: undefined
  };
  await saveChanges();
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div
    v-if="currentChatGroup"
    class="flex flex-col h-full bg-[#fcfcfd] dark:bg-gray-900 transition-colors relative overflow-hidden focus:outline-none"
    tabindex="-1"
    @click="setActiveFocusArea('chat-group-settings')"
    @focusin="setActiveFocusArea('chat-group-settings')"
  >
    <!-- Header -->
    <div class="border-b border-gray-100 dark:border-gray-800 px-4 sm:px-6 py-3 flex items-center justify-between bg-white/80 dark:bg-gray-900/80 backdrop-blur-md shadow-sm z-20">
      <div class="flex items-center gap-3 overflow-hidden min-h-[44px]">
        <div class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
          <Settings2 class="w-5 h-5 text-blue-600" />
        </div>
        <div class="flex flex-col overflow-hidden">
          <h2 class="text-base sm:text-lg font-bold text-gray-800 dark:text-gray-100 tracking-tight truncate">
            {{ currentChatGroup.name }} Settings
          </h2>
          <span class="text-[10px] font-bold text-blue-600/70 dark:text-blue-400 uppercase tracking-wider">Group Overrides</span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <div
          v-if="hasActiveOverrides"
          class="flex items-center gap-1.5 px-3 py-1 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-full"
        >
          <div class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></div>
          <span class="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">Active Overrides</span>
        </div>
      </div>
    </div>

    <!-- Export Recipe Modal -->
    <RecipeExportModal
      :is-open="showExportModal"
      :group-name="currentChatGroup.name"
      :system-prompt="localSettings.systemPrompt"
      :lm-parameters="localSettings.lmParameters"
      :initial-model-id="localSettings.modelId"
      @close="showExportModal = false"
    />

    <!-- Content -->
    <div class="flex-1 overflow-y-auto overscroll-contain">
      <div class="max-w-4xl mx-auto p-6 sm:p-8 space-y-8">
        <!-- Quick Actions Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            @click="useGlobalSearch().openSearch({ groupIds: [currentChatGroup.id] })"
            class="flex items-center gap-4 w-full bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-2xl px-5 py-3 text-left hover:border-blue-300 dark:hover:border-blue-700 transition-all shadow-sm group"
          >
            <div class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl group-hover:bg-blue-50 dark:group-hover:bg-blue-900/20 transition-colors">
              <Search class="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors" />
            </div>
            <div class="flex flex-col min-w-0">
              <span class="text-[9px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest leading-none mb-1">Search Group</span>
              <span class="text-[11px] font-medium text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors truncate">Search messages...</span>
            </div>
          </button>

          <button
            @click="handleCreateRecipe"
            class="flex items-center gap-4 w-full bg-blue-50/30 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-2xl px-5 py-3 text-left hover:border-blue-400 dark:hover:border-blue-700 transition-all shadow-sm group"
          >
            <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm group-hover:shadow-md transition-all">
              <ChefHat class="w-5 h-5 text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform" />
            </div>
            <div class="flex flex-col">
              <span class="text-[9px] font-bold text-blue-900/50 dark:text-blue-400/50 uppercase tracking-widest leading-none mb-1">Share settings</span>
              <span class="text-[11px] font-bold text-blue-600 dark:text-blue-400">Create Recipe</span>
            </div>
          </button>
        </div>

        <div class="flex flex-col md:flex-row md:items-end justify-between border-b border-gray-200/50 dark:border-gray-800 pb-6 gap-6">
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
                  :class="localSettings.endpoint?.url === preset.url && localSettings.endpoint?.type === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600'"
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
              :value="localSettings.endpoint?.type || 'global'"
              @change="async (e) => {
                const val = (e.target as HTMLSelectElement).value;
                if (val === 'global') {
                  localSettings.endpoint = undefined;
                } else {
                  if (!localSettings.endpoint) {
                    localSettings.endpoint = { type: val as any, url: '' };
                  } else {
                    localSettings.endpoint.type = val as any;
                  }
                }
                await saveChanges();
              }"
              class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
            >
              <option value="global">Global ({{ settings.endpointType === 'transformers_js' ? 'Transformers.js' : settings.endpointType }})</option>
              <option value="openai">OpenAI Compatible</option>
              <option value="ollama">Ollama</option>
              <option value="transformers_js">Transformers.js (Experimental)</option>
            </select>
          </div>

          <div class="space-y-2" v-if="effectiveEndpointType !== 'transformers_js'">
            <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Endpoint URL</label>
            <input
              v-if="localSettings.endpoint"
              v-model="localSettings.endpoint.url"
              @input="error = null"
              @blur="saveChanges"
              type="text"
              class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
              :placeholder="settings.endpointUrl"
              data-testid="group-setting-url-input"
            />
            <div v-if="error" class="mt-2">
              <p class="text-[10px] text-red-500 font-bold ml-1 leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200">{{ error }}</p>
            </div>
          </div>

          <div class="space-y-2" v-if="effectiveEndpointType !== 'transformers_js'">
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

            <div v-if="localSettings.endpoint?.httpHeaders && localSettings.endpoint.httpHeaders.length > 0" class="space-y-2">
              <div
                v-for="(header, index) in localSettings.endpoint.httpHeaders"
                :key="index"
                class="flex gap-2"
              >
                <input
                  v-model="header[0]"
                  @blur="saveChanges"
                  type="text"
                  class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2 text-[11px] font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  placeholder="Name"
                />
                <input
                  v-model="header[1]"
                  @blur="saveChanges"
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
            <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Model ID Override</label>
            <ModelSelector
              :model-value="localSettings.modelId"
              @update:model-value="val => { localSettings.modelId = val; saveChanges(); }"
              :loading="fetchingModels"
              :models="sortedGroupModels"
              :placeholder="'Global (' + (settings.defaultModelId || 'None') + ')'"
              :allow-clear="true"
              @refresh="fetchModels"
              data-testid="group-setting-model-select"
            />
            <TransformersJsUpsell :show="effectiveEndpointType === 'transformers_js'" />
          </div>
        </div>

        <!-- Automatic Title Section -->
        <div class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl space-y-6 shadow-sm">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-blue-600/10 rounded-xl border border-blue-100 dark:border-blue-900/20">
                <Settings2 class="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <h4 class="text-xs font-bold text-gray-800 dark:text-white uppercase tracking-widest">Automatic Title</h4>
                <p class="text-[10px] text-gray-500 dark:text-gray-400 font-medium">Configure how chats in this group are automatically named.</p>
              </div>
            </div>
            <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
              <button
                @click="localSettings.autoTitleEnabled = undefined; saveChanges();"
                class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                :class="localSettings.autoTitleEnabled === undefined ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                Inherit
              </button>
              <button
                @click="localSettings.autoTitleEnabled = true; saveChanges();"
                class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                :class="localSettings.autoTitleEnabled === true ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                Enabled
              </button>
              <button
                @click="localSettings.autoTitleEnabled = false; saveChanges();"
                class="px-3 py-1 text-[9px] font-bold rounded transition-all"
                :class="localSettings.autoTitleEnabled === false ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
              >
                Disabled
              </button>
            </div>
          </div>

          <div v-if="localSettings.autoTitleEnabled !== false" class="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-gray-50 dark:border-gray-800/50">
            <div class="space-y-2">
              <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">Title Model Override</label>
              <ModelSelector
                :model-value="localSettings.titleModelId"
                @update:model-value="val => { localSettings.titleModelId = val; saveChanges(); }"
                :models="sortedGroupModels"
                :loading="fetchingModels"
                :placeholder="'Global (' + (settings.titleModelId || 'None') + ')'"
                :allow-clear="true"
                @refresh="fetchModels"
                data-testid="group-setting-title-model-select"
              />
            </div>
            <div class="flex items-center">
              <p class="text-[10px] text-gray-400 italic leading-relaxed">
                The title model is used to summarize the first user message in new chats.
                {{ localSettings.autoTitleEnabled === undefined ? ' Currently inheriting ' + (settings.autoTitleEnabled ? 'Enabled' : 'Disabled') + ' from Global Settings.' : '' }}
              </p>
            </div>
          </div>
        </div>

        <!-- Info Banners -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="flex items-start gap-4 p-4 bg-white dark:bg-blue-900/10 border border-gray-100 dark:border-blue-900/30 rounded-2xl shadow-sm">
            <div class="p-2 bg-blue-50 dark:bg-gray-800 rounded-xl border border-blue-100 dark:border-blue-900/20">
              <Globe class="w-4 h-4 text-blue-500" />
            </div>
            <div class="space-y-1">
              <p class="text-[10px] font-bold text-blue-900/70 dark:text-blue-300 uppercase tracking-widest">Group Level</p>
              <p class="text-[11px] text-gray-500 dark:text-blue-400/70 leading-relaxed font-medium">These settings will apply to all chats within this group unless overridden by a specific chat.</p>
            </div>
          </div>

          <div class="flex items-start gap-4 p-4 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm">
            <div class="p-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700">
              <AlertCircle class="w-4 h-4 text-gray-400" />
            </div>
            <div class="space-y-1">
              <p class="text-[10px] font-bold text-gray-400 dark:text-gray-400 uppercase tracking-widest">Local Overrides</p>
              <p class="text-[11px] text-gray-500/70 dark:text-gray-400/70 leading-relaxed font-medium">
                These settings only apply to this group.
                <button
                  @click="restoreDefaults"
                  class="font-bold underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  data-testid="group-setting-restore-defaults"
                >
                  Restore defaults
                </button>.
              </p>
            </div>
          </div>
        </div>

        <!-- System Prompt and Parameters -->
        <div class="pt-8 border-t border-gray-200/50 dark:border-gray-800 space-y-8 pb-20">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div class="md:col-span-2 space-y-4">
              <div class="flex items-center justify-between">
                <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <MessageSquareQuote class="w-3 h-3" />
                  Group System Prompt
                </label>

                <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                  <button
                    @click="updateSystemPromptBehavior('inherit')"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="!localSettings.systemPrompt ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    Inherit
                  </button>
                  <button
                    @click="updateSystemPromptBehavior('override', true)"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    Clear
                  </button>
                  <button
                    @click="updateSystemPromptBehavior('override')"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content !== null ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    Override
                  </button>
                  <button
                    @click="updateSystemPromptBehavior('append')"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="localSettings.systemPrompt?.behavior === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    Append
                  </button>
                </div>
              </div>
              <div v-if="!localSettings.systemPrompt" class="w-full bg-gray-50/50 dark:bg-gray-800/30 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-4 text-left">
                <p class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">Inherited Instructions</p>
                <p class="text-xs text-gray-400 dark:text-gray-500 italic whitespace-pre-wrap line-clamp-6">
                  {{ settings.systemPrompt || 'No global instructions defined.' }}
                </p>
              </div>
              <div v-else-if="localSettings.systemPrompt?.behavior === 'override' && localSettings.systemPrompt.content === null" class="w-full bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center">
                <p class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">Global Prompt Cleared</p>
                <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-1">This group will not use any system instructions.</p>
              </div>
              <textarea
                v-else
                :value="localSettings.systemPrompt?.content || ''"
                @input="e => {
                  const val = (e.target as HTMLTextAreaElement).value;
                  if(localSettings.systemPrompt) {
                    localSettings.systemPrompt.content = val;
                  } else {
                    localSettings.systemPrompt = { content: val, behavior: 'override' };
                  }
                }"
                @blur="saveChanges"
                rows="6"
                class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                :placeholder="localSettings.systemPrompt?.behavior === 'append' ? 'Added after global instructions...' : 'Completely replaces global instructions...'"
                data-testid="group-setting-system-prompt-textarea"
              ></textarea>
            </div>

            <div class="space-y-4">
              <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                <Layers class="w-3 h-3" />
                Settings Resolution
              </label>
              <div class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-3 shadow-sm">
                <div class="flex items-center justify-between text-[10px] font-bold">
                  <span class="text-gray-400">System Prompt</span>
                  <span :class="localSettings.systemPrompt ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-system-prompt">
                    {{ localSettings.systemPrompt ? (localSettings.systemPrompt.behavior === 'append' ? 'Appending' : (localSettings.systemPrompt.content === null ? 'Cleared' : 'Overriding')) : 'Global Default' }}
                  </span>
                </div>
                <div class="flex items-center justify-between text-[10px] font-bold">
                  <span class="text-gray-400">Parameters</span>
                  <span :class="localSettings.lmParameters && Object.keys(localSettings.lmParameters).length > 0 ? 'text-blue-500' : 'text-gray-300'" data-testid="resolution-status-lm-parameters">
                    {{ localSettings.lmParameters && Object.keys(localSettings.lmParameters).length > 0 ? 'Group Overrides' : 'Inherited' }}
                  </span>
                </div>
                <div class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                  <p class="text-[9px] text-gray-400 leading-relaxed italic">Group settings take precedence over Global Settings, but can be overridden by individual chats.</p>
                </div>
              </div>
            </div>
          </div>

          <div class="p-6 bg-white dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-3xl">
            <LmParametersEditor
              :model-value="localSettings.lmParameters"
              @update:model-value="val => { localSettings.lmParameters = val; saveChanges(); }"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>