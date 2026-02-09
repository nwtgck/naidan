<script setup lang="ts">
import { ref, watch, computed, h } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useToast } from '../composables/useToast';
import type { ProviderProfile, Settings } from '../models/types';
import { capitalize, naturalSort } from '../utils/string';
import { 
  Loader2, Trash2, Globe, Bot, Type, Save,
  CheckCircle2, BookmarkPlus,
  Check, Activity, MessageSquareQuote, Plus
} from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';

// IMPORTANT: ModelSelector is a core part of the connection setup UI and should not flicker.
import ModelSelector from './ModelSelector.vue';

// Lazily load heavier or secondary settings components, but prefetch them when idle.
const LmParametersEditor = defineAsyncComponentAndLoadOnMounted(() => import('./LmParametersEditor.vue'));
// Lazily load previews that are only shown during specific actions
const ProviderProfilePreview = defineAsyncComponentAndLoadOnMounted(() => import('./ProviderProfilePreview.vue'));
// Lazily load upsell UI
const TransformersJsUpsell = defineAsyncComponentAndLoadOnMounted(() => import('./TransformersJsUpsell.vue'));

import { useConfirm } from '../composables/useConfirm';
import { usePrompt } from '../composables/usePrompt';
import { ENDPOINT_PRESETS } from '../models/constants';

const props = defineProps<{
  modelValue: Settings;
  availableModels: readonly string[];
  isFetchingModels: boolean;
  hasUnsavedChanges: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: Settings): void;
  (e: 'save'): void;
  (e: 'goToProfiles'): void;
  (e: 'goToTransformersJs'): void;
}>();

const sortedModels = computed(() => naturalSort(Array.isArray(props.availableModels) ? props.availableModels : []));

const { save, fetchModels: fetchModelsGlobal, updateProviderProfiles } = useSettings();
const { showConfirm } = useConfirm();
const { showPrompt } = usePrompt();
const { addToast } = useToast();

const isStandalone = __BUILD_MODE_IS_STANDALONE__;

const form = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});

const connectionSuccess = ref(false);

const error = ref<string | null>(null);

const saveSuccess = ref(false);

const selectedProviderProfileId = ref('');



function applyPreset(preset: typeof ENDPOINT_PRESETS[number]) {
  form.value = {
    ...form.value,
    endpointType: preset.type,
    endpointUrl: preset.url
  };
}

async function fetchModels() {
  if (!form.value.endpointUrl && form.value.endpointType !== 'transformers_js') {
    return;
  }
  
  error.value = null;
  try {
    const url = form.value.endpointUrl || '';
    // Trigger global fetch with current form values (may be unsaved)
    const models = await fetchModelsGlobal({
      url,
      type: form.value.endpointType,
      headers: form.value.endpointHttpHeaders
    });

    if (models.length === 0 && form.value.endpointType !== 'transformers_js') {
      throw new Error('No models found at this endpoint.');
    }

    // Validate current selection against new models
    const updatedForm = { ...form.value };
    let changed = false;
    if (updatedForm.defaultModelId && !models.includes(updatedForm.defaultModelId)) {
      updatedForm.defaultModelId = '';
      changed = true;
    }
    if (updatedForm.titleModelId && !models.includes(updatedForm.titleModelId)) {
      updatedForm.titleModelId = '';
      changed = true;
    }
    if (changed) {
      form.value = updatedForm;
    }

    error.value = null;
    connectionSuccess.value = true;
    setTimeout(() => {
      connectionSuccess.value = false;
    }, 3000);
  } catch (err) {
    console.error(err);
    error.value = err instanceof Error ? err.message : 'Connection failed. Check URL or provider.';
    connectionSuccess.value = false;
  }
}

async function handleSave() {
  try {
    await save({
      endpointType: form.value.endpointType,
      endpointUrl: form.value.endpointUrl,
      endpointHttpHeaders: form.value.endpointHttpHeaders,
      defaultModelId: form.value.defaultModelId,
      titleModelId: form.value.titleModelId,
      autoTitleEnabled: form.value.autoTitleEnabled,
      systemPrompt: form.value.systemPrompt,
      lmParameters: form.value.lmParameters,
    });

    emit('save');
    saveSuccess.value = true;
    setTimeout(() => {
      saveSuccess.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to save settings:', err);
    await showConfirm({
      title: 'Save Failed',
      message: `Failed to save settings. ${err instanceof Error ? err.message : String(err)}`,
      confirmButtonText: 'Understand',
    });
  }
}

async function handleCreateProviderProfile() {
  const name = await showPrompt({
    title: 'Create New Profile',
    message: 'Give this configuration a name:',
    defaultValue: `${capitalize(form.value.endpointType)} - ${form.value.defaultModelId || 'Default'}`,
    confirmButtonText: 'Create',
    bodyComponent: h(ProviderProfilePreview, { form: form.value })
  });
  
  if (!name) return;

  const newProviderProfile: ProviderProfile = {
    id: crypto.randomUUID(),
    name,
    endpointType: form.value.endpointType,
    endpointUrl: form.value.endpointUrl,
    endpointHttpHeaders: form.value.endpointHttpHeaders ? JSON.parse(JSON.stringify(form.value.endpointHttpHeaders)) : undefined,
    defaultModelId: form.value.defaultModelId,
    titleModelId: form.value.titleModelId,
    systemPrompt: form.value.systemPrompt,
    lmParameters: form.value.lmParameters ? JSON.parse(JSON.stringify(form.value.lmParameters)) : undefined,
  };

  if (!form.value.providerProfiles) form.value.providerProfiles = [];
  form.value.providerProfiles.push(newProviderProfile);
  await updateProviderProfiles(JSON.parse(JSON.stringify(form.value.providerProfiles)));

  addToast({
    message: `Profile "${name}" created`,
    actionLabel: 'View Profiles',
    onAction: () => emit('goToProfiles'),
    duration: 5000,
  });
}

function handleQuickProviderProfileChange() {
  const providerProfile = form.value.providerProfiles?.find(p => p.id === selectedProviderProfileId.value);
  if (providerProfile) {
    form.value.endpointType = providerProfile.endpointType;
    form.value.endpointUrl = providerProfile.endpointUrl;
    form.value.endpointHttpHeaders = providerProfile.endpointHttpHeaders ? JSON.parse(JSON.stringify(providerProfile.endpointHttpHeaders)) : undefined;
    form.value.defaultModelId = providerProfile.defaultModelId;
    form.value.titleModelId = providerProfile.titleModelId;
    form.value.systemPrompt = providerProfile.systemPrompt;
    form.value.lmParameters = providerProfile.lmParameters ? JSON.parse(JSON.stringify(providerProfile.lmParameters)) : undefined;
  }
  selectedProviderProfileId.value = '';
}

function addHeader() {
  if (!form.value.endpointHttpHeaders) form.value.endpointHttpHeaders = [];
  form.value.endpointHttpHeaders.push(['', '']);
}

function removeHeader(index: number) {
  if (form.value.endpointHttpHeaders) {
    form.value.endpointHttpHeaders.splice(index, 1);
  }
}

// Auto-fetch for localhost or transformers_js
watch([() => form.value.endpointUrl, () => form.value.endpointType], ([url, type]) => {
  if (type === 'transformers_js' || (url && (url.includes('localhost') || url.includes('127.0.0.1')))) {
    fetchModels();
  }
});

defineExpose({
  fetchModels
});
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <div class="flex-1 overflow-y-auto min-h-0 overscroll-contain">
      <div class="p-6 md:p-12 space-y-12 max-w-4xl mx-auto">
        <div class="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-400">
                  
          <!-- Quick Switcher (If profiles exist) -->
          <div v-if="form.providerProfiles && form.providerProfiles.length > 0" class="bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 p-5 rounded-2xl space-y-3 shadow-sm">
            <label class="block text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest ml-1">Quick Profile Switcher</label>
            <div class="flex gap-2">
              <select 
                v-model="selectedProviderProfileId"
                @change="handleQuickProviderProfileChange"
                class="flex-1 bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                data-testid="setting-quick-provider-profile-select"
              >
                <option value="" disabled>Load from saved profiles...</option>
                <option v-for="p in form.providerProfiles" :key="p.id" :value="p.id">{{ p.name }} ({{ capitalize(p.endpointType) }})</option>
              </select>
            </div>
          </div>

          <section class="space-y-6">
            <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
              <Globe class="w-5 h-5 text-blue-500" />
              <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Endpoint Configuration</h2>
            </div>
                      
            <div class="grid grid-cols-1 gap-8">
              <div class="space-y-2">
                <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">API Provider</label>
                <select 
                  v-model="form.endpointType"
                  class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3.5 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                  style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                  data-testid="setting-provider-select"
                >
                  <option value="openai">OpenAI Compatible</option>
                  <option value="ollama">Ollama</option>
                  <option :disabled="isStandalone" value="transformers_js">
                    Transformers.js (Experimental) {{ isStandalone ? '(Unavailable in Standalone due to Worker/WASM restrictions)' : '' }}
                  </option>
                </select>
              </div>

              <!-- Endpoint URL -->
              <div class="space-y-4" v-if="form.endpointType !== 'transformers_js'">
                <div class="flex items-center justify-between ml-1">
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest">Endpoint URL</label>
                  <div class="flex flex-wrap gap-1.5">
                    <button 
                      v-for="preset in ENDPOINT_PRESETS" 
                      :key="preset.name"
                      @click="applyPreset(preset)"
                      type="button"
                      class="px-3 py-1 text-[10px] font-bold rounded-lg border transition-all"
                      :class="form.endpointUrl === preset.url && form.endpointType === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600'"
                      :data-testid="`endpoint-preset-${preset.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`"
                    >
                      {{ preset.name }}
                    </button>
                  </div>
                </div>
                <div class="flex gap-2">
                  <input 
                    v-model="form.endpointUrl"
                    type="text"
                    class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3.5 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                    placeholder="http://localhost:11434"
                    data-testid="setting-url-input"
                  />
                  <button 
                    @click="fetchModels"
                    class="px-6 py-2 rounded-xl transition-all flex items-center justify-center gap-2 min-w-[180px] disabled:opacity-70 shadow-sm"
                    :class="[
                      connectionSuccess 
                        ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 border border-green-100 dark:border-green-800' 
                        : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
                    ]"
                    title="Check Connection"
                    :disabled="isFetchingModels"
                    data-testid="setting-check-connection"
                  >
                    <span class="relative w-4 h-4 flex items-center justify-center">
                      <Loader2 v-if="isFetchingModels" class="w-4 h-4 animate-spin absolute" />
                      <Check v-else-if="connectionSuccess" class="w-4 h-4 text-green-600 dark:text-green-400 animate-in zoom-in duration-300" />
                      <Activity v-else class="w-4 h-4" />
                    </span>
                    <span class="text-xs font-bold">{{ connectionSuccess ? 'Connected' : 'Check Connection' }}</span>
                  </button>
                </div>
                <!-- Info message about auto-connection check -->
                <div class="flex items-start gap-3 p-4 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700/80 dark:text-blue-300/80 rounded-2xl text-[11px] font-medium border border-blue-100 dark:border-blue-900/20 ml-1">
                  <Globe class="w-4 h-4 shrink-0 mt-0.5" />
                  <p>Connection check is automatically performed only for localhost URLs.</p>
                </div>
                <!-- Error message container -->
                <div v-if="error" class="mt-2">
                  <p class="text-xs text-red-500 font-bold ml-1 animate-in fade-in slide-in-from-top-1 duration-200 leading-relaxed">{{ error }}</p>
                </div>
              </div>

              <!-- Custom HTTP Headers -->
              <div class="space-y-4">
                <div class="flex items-center justify-between ml-1">
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest">Custom HTTP Headers</label>
                  <button 
                    @click="addHeader"
                    type="button"
                    class="text-[10px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1"
                  >
                    <Plus class="w-3 h-3" />
                    Add Header
                  </button>
                </div>

                <div v-if="form.endpointHttpHeaders && form.endpointHttpHeaders.length > 0" class="space-y-2">
                  <div 
                    v-for="(header, index) in form.endpointHttpHeaders" 
                    :key="index"
                    class="flex gap-2 animate-in fade-in slide-in-from-left-1 duration-200"
                  >
                    <input 
                      v-model="header[0]"
                      type="text"
                      class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      placeholder="Header Name (e.g. X-API-Key)"
                    />
                    <input 
                      v-model="header[1]"
                      type="text"
                      class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      placeholder="Value"
                    />
                    <button 
                      @click="removeHeader(index)"
                      class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div v-else class="text-[11px] text-gray-400 italic ml-1">No custom headers configured.</div>
              </div>
            </div>
          </section>

          <section class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
              <Bot class="w-5 h-5 text-blue-500" />
              <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Model Selection</h2>
            </div>

            <div class="space-y-8">
              <div class="space-y-2">
                <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Default Model</label>
                <ModelSelector 
                  v-model="form.defaultModelId"
                  :models="sortedModels"
                  :loading="isFetchingModels"
                  placeholder="None"
                  allow-clear
                  clear-label="None"
                  @refresh="fetchModels"
                  data-testid="setting-model-select"
                />
                <TransformersJsUpsell :show="form.endpointType === 'transformers_js'" />
                <p class="text-[11px] font-medium text-gray-400 ml-1">Used for all new conversations unless overridden.</p>
              </div>

              <div class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 space-y-5 shadow-sm">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="p-2 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                      <Type class="w-4 h-4 text-blue-500" />
                    </div>
                    <span class="text-sm font-bold text-gray-700 dark:text-gray-300">Auto-Title Generation</span>
                  </div>
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      v-model="form.autoTitleEnabled" 
                      class="sr-only peer"
                      data-testid="setting-auto-title-checkbox"
                    >
                    <div class="w-10 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                  </label>
                </div>
                          
                <div class="space-y-2 opacity-50 transition-all duration-300" :class="{ 'opacity-100': form.autoTitleEnabled }">
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Title Generation Model</label>
                  <ModelSelector 
                    v-model="form.titleModelId"
                    :models="sortedModels"
                    :loading="isFetchingModels"
                    :disabled="!form.autoTitleEnabled"
                    placeholder="Use Current Chat Model (Default)"
                    allow-clear
                    clear-label="Use Current Chat Model (Default)"
                    @refresh="fetchModels"
                    data-testid="setting-title-model-select"
                  />
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-2 pb-3">
              <MessageSquareQuote class="w-5 h-5 text-blue-500" />
              <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Global Context & Parameters</h2>
            </div>

            <div class="space-y-8">
              <!-- System Prompt -->
              <div class="space-y-2">
                <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Global System Prompt</label>
                <textarea 
                  v-model="form.systemPrompt"
                  rows="4"
                  class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                  placeholder="You are a helpful AI assistant..."
                  data-testid="setting-system-prompt-textarea"
                ></textarea>
                <p class="text-[10px] font-medium text-gray-400 ml-1 leading-relaxed">This instruction is applied to all new chats as a baseline identity.</p>
              </div>

              <!-- LM Parameters -->
              <div class="bg-gray-50/30 dark:bg-gray-800/20 p-6 rounded-3xl border border-gray-100 dark:border-gray-800">
                <LmParametersEditor v-model="form.lmParameters" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- Footer Actions -->
    <div class="p-4 md:p-8 border-t border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row justify-end gap-3 md:gap-4 bg-gray-50/50 dark:bg-gray-900/50 backdrop-blur-sm shrink-0">
      <button 
        @click="handleCreateProviderProfile"
        class="flex items-center justify-center gap-2 py-2.5 px-4 md:py-3 md:px-6 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-xl md:rounded-2xl text-xs md:text-sm font-bold transition-all shadow-sm active:scale-95"
        data-testid="setting-save-provider-profile-button"
      >
        <BookmarkPlus class="w-4 h-4" />
        <span>Save as New Profile</span>
      </button>

      <button 
        @click="handleSave"
        :disabled="!hasUnsavedChanges"
        class="flex items-center justify-center gap-2 py-2.5 px-4 md:py-3 md:px-10 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs md:text-sm font-bold rounded-xl md:rounded-2xl shadow-lg shadow-blue-500/30 transition-all active:scale-95"
        data-testid="setting-save-button"
      >
        <CheckCircle2 v-if="saveSuccess" class="w-4 h-4" />
        <Save v-else class="w-4 h-4" />
        <span>{{ saveSuccess ? 'Settings Saved' : 'Save Changes' }}</span>
      </button>
    </div>
  </div>
</template>