<script lang="ts">
export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
</script>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useSampleChat } from '../composables/useSampleChat';
import { useToast } from '../composables/useToast';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import type { ProviderProfile } from '../models/types';
import { 
  X, Loader2, FlaskConical, Trash2, Globe, 
  Database, Bot, Type, Settings2, RefreshCw, Save,
  CheckCircle2, AlertTriangle, Cpu, BookmarkPlus,
  Pencil, Trash, Check, Activity,
} from 'lucide-vue-next';
import { useConfirm } from '../composables/useConfirm'; // Import useConfirm
import { usePrompt } from '../composables/usePrompt';   // Import usePrompt
import { ENDPOINT_PRESETS } from '../models/constants';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const { settings, save } = useSettings();
const { createSampleChat } = useSampleChat();
const { addToast } = useToast();
const { showConfirm } = useConfirm(); // Initialize useConfirm
const { showPrompt } = usePrompt();     // Initialize usePrompt

const form = ref({ ...settings.value });
const initialFormState = ref('');
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);
const connectionSuccess = ref(false);
const error = ref<string | null>(null);
const saveSuccess = ref(false);

// Profile Editing State
const editingProviderProfileId = ref<string | null>(null);
const editingProviderProfileName = ref('');

// Tab State
type Tab = 'connection' | 'profiles' | 'storage' | 'developer';
const activeTab = ref<Tab>('connection');

const hasChanges = computed(() => {
  return JSON.stringify(form.value) !== initialFormState.value;
});

const selectedProviderProfileId = ref('');

function applyPreset(preset: typeof ENDPOINT_PRESETS[number]) {
  form.value.endpointType = preset.type;
  form.value.endpointUrl = preset.url;
}

async function handleResetData() {
  const confirmed = await showConfirm({
    title: 'Confirm Data Reset',
    message: 'Are you sure you want to reset all app data? This will delete all chats, groups, and settings for the current storage location.',
    confirmButtonText: 'Reset',
    confirmButtonVariant: 'danger', // Add danger variant
  });
  if (confirmed) {
    await storageService.clearAll();
    window.location.reload();
  }
}

async function handleCancel() { // Make function async
  if (hasChanges.value) {
    const confirmed = await showConfirm({
      title: 'Discard Unsaved Changes?',
      message: 'You have unsaved changes. Are you sure you want to discard them?',
      confirmButtonText: 'Discard',
      cancelButtonText: 'Keep Editing',
    });
    if (confirmed) {
      emit('close');
    }
  } else {
    emit('close');
  }
}

async function fetchModels() {
  if (!form.value.endpointUrl) {
    availableModels.value = [];
    return;
  }
  fetchingModels.value = true;
  error.value = null;
  try {
    const provider = form.value.endpointType === 'ollama' 
      ? new OllamaProvider() 
      : new OpenAIProvider();
    
    const models = await provider.listModels(form.value.endpointUrl);
    availableModels.value = models;
    error.value = null;
    connectionSuccess.value = true;
    setTimeout(() => {
      connectionSuccess.value = false;
    }, 3000);
  } catch (err) {
    console.error(err);
    error.value = 'Connection failed. Check URL or provider.';
    availableModels.value = [];
  } finally {
    fetchingModels.value = false;
  }
}

async function handleSave() {
  await save(form.value);
  initialFormState.value = JSON.stringify(form.value);
  saveSuccess.value = true;
  setTimeout(() => {
    saveSuccess.value = false;
  }, 2000);
}

// Profile Handlers
async function handleCreateProviderProfile() {
  const name = await showPrompt({
    title: 'Create New Profile',
    message: 'Enter a name for this profile:',
    defaultValue: `${capitalize(form.value.endpointType)} - ${form.value.defaultModelId || 'Default'}`,
    confirmButtonText: 'Create',
  });
  
  if (!name) return; // User cancelled or entered empty string

  const newProviderProfile: ProviderProfile = {
    id: crypto.randomUUID(),
    name,
    endpointType: form.value.endpointType,
    endpointUrl: form.value.endpointUrl,
    defaultModelId: form.value.defaultModelId,
    titleModelId: form.value.titleModelId,
  };

  if (!form.value.providerProfiles) form.value.providerProfiles = [];
  form.value.providerProfiles.push(newProviderProfile);
}

function handleApplyProviderProfile(providerProfile: ProviderProfile) {
  form.value.endpointType = providerProfile.endpointType;
  form.value.endpointUrl = providerProfile.endpointUrl;
  form.value.defaultModelId = providerProfile.defaultModelId;
  form.value.titleModelId = providerProfile.titleModelId;
}

function handleDeleteProviderProfile(id: string) {
  const index = form.value.providerProfiles.findIndex(p => p.id === id);
  if (index === -1) return;
  
  const deletedProfile = form.value.providerProfiles[index];
  if (!deletedProfile) return;

  form.value.providerProfiles.splice(index, 1);
  
  addToast({
    message: `Profile "${deletedProfile.name}" deleted`,
    actionLabel: 'Undo',
    onAction: () => {
      form.value.providerProfiles.splice(index, 0, deletedProfile);
    },
    duration: 5000,
  });
}

function startRename(providerProfile: ProviderProfile) {
  editingProviderProfileId.value = providerProfile.id;
  editingProviderProfileName.value = providerProfile.name;
}

function saveRename() {
  if (!editingProviderProfileId.value) return;
  const providerProfile = form.value.providerProfiles.find(p => p.id === editingProviderProfileId.value);
  if (providerProfile && editingProviderProfileName.value.trim()) {
    providerProfile.name = editingProviderProfileName.value.trim();
  }
  editingProviderProfileId.value = null;
}

function handleQuickProviderProfileChange() {
  const providerProfile = form.value.providerProfiles.find(p => p.id === selectedProviderProfileId.value);
  if (providerProfile) {
    handleApplyProviderProfile(providerProfile);
  }
  // Reset select after apply to allow re-selection if needed
  selectedProviderProfileId.value = '';
}

// Watch for modal open to reset form
watch(() => props.isOpen, (open) => {
  if (open) {
    form.value = JSON.parse(JSON.stringify(settings.value));
    initialFormState.value = JSON.stringify(form.value);
    fetchModels();
  }
});

// Auto-fetch only for localhost
watch([() => form.value.endpointUrl, () => form.value.endpointType], ([url]) => {
  if (url && (url.includes('localhost') || url.includes('127.0.0.1'))) {
    fetchModels();
  }
});

</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-2 md:p-6">    <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-[95vw] h-[95vh] md:h-[90vh] overflow-hidden flex flex-col md:flex-row border border-gray-200 dark:border-gray-800 animate-in fade-in zoom-in-95 duration-200 relative">
      
    <!-- Persistent Close Button (Top Right) -->
    <button 
      @click="handleCancel"
      class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
      data-testid="setting-close-x"
    >
      <X class="w-5 h-5" />
    </button>

    <!-- Sidebar (Tabs) -->
    <aside class="w-full md:w-64 flex-shrink-0 bg-gray-50/50 dark:bg-gray-900/50 border-b md:border-b-0 md:border-r border-gray-200 dark:border-gray-800 flex flex-col">
      <!-- Header -->
      <div class="p-5 border-b border-gray-200 dark:border-gray-800 flex items-center gap-3">
        <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
          <Settings2 class="w-5 h-5" />
        </div>
        <h2 class="text-lg font-bold text-gray-900 dark:text-white tracking-tight">Settings</h2>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 overflow-x-auto md:overflow-y-auto p-2 md:p-4 flex md:flex-col gap-1 no-scrollbar">
        <button 
          @click="activeTab = 'connection'"
          class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all whitespace-nowrap text-left"
          :class="activeTab === 'connection' ? 'bg-white dark:bg-gray-800 shadow-sm text-blue-600 dark:text-blue-400 ring-1 ring-black/5 dark:ring-white/5' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        >
          <Globe class="w-4 h-4" />
          Connection
        </button>
        <button 
          @click="activeTab = 'profiles'"
          class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all whitespace-nowrap text-left"
          :class="activeTab === 'profiles' ? 'bg-white dark:bg-gray-800 shadow-sm text-indigo-600 dark:text-indigo-400 ring-1 ring-black/5 dark:ring-white/5' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        >
          <BookmarkPlus class="w-4 h-4" />
          Provider Profiles
        </button>
        <button 
          @click="activeTab = 'storage'"
          class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all whitespace-nowrap text-left"
          :class="activeTab === 'storage' ? 'bg-white dark:bg-gray-800 shadow-sm text-green-600 dark:text-green-400 ring-1 ring-black/5 dark:ring-white/5' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        >
          <Database class="w-4 h-4" />
          Storage
        </button>
        <button 
          @click="activeTab = 'developer'"
          class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all whitespace-nowrap text-left"
          :class="activeTab === 'developer' ? 'bg-white dark:bg-gray-800 shadow-sm text-orange-600 dark:text-orange-400 ring-1 ring-black/5 dark:ring-white/5' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        >
          <Cpu class="w-4 h-4" />
          Developer
        </button>
      </nav>
    </aside>

    <!-- Main Content Area -->
    <main class="flex-1 flex flex-col min-w-0 bg-white dark:bg-gray-900 relative">
      <div class="flex-1 overflow-y-auto">
        <div class="p-6 md:p-10 space-y-10 max-w-4xl mx-auto">
            
          <!-- Connection Tab -->
          <div v-if="activeTab === 'connection'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              
            <!-- Quick Switcher (If profiles exist) -->
            <div v-if="form.providerProfiles && form.providerProfiles.length > 0" class="bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-900/30 p-4 rounded-2xl space-y-2">
              <label class="block text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider ml-1">Quick Profile Switcher</label>
              <div class="flex gap-2">
                <select 
                  v-model="selectedProviderProfileId"
                  @change="handleQuickProviderProfileChange"
                  class="flex-1 bg-white dark:bg-gray-800 border border-indigo-200 dark:border-indigo-800 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all dark:text-white appearance-none"
                  style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                  data-testid="setting-quick-provider-profile-select"
                >
                  <option value="" disabled>Load from saved profiles...</option>
                  <option v-for="p in form.providerProfiles" :key="p.id" :value="p.id">{{ p.name }} ({{ capitalize(p.endpointType) }})</option>
                </select>
              </div>
            </div>

            <section class="space-y-4">
              <div class="flex items-center gap-2 pb-2 border-b dark:border-gray-800">
                <Globe class="w-5 h-5 text-blue-500" />
                <h2 class="text-lg font-bold text-gray-900 dark:text-white">Endpoint Configuration</h2>
              </div>
                
              <div class="grid grid-cols-1 gap-6">
                <div class="space-y-2">
                  <label class="block text-xs font-bold text-gray-500 uppercase ml-1">API Provider</label>
                  <select 
                    v-model="form.endpointType"
                    class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
                    style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                    data-testid="setting-provider-select"
                  >
                    <option value="openai">OpenAI Compatible</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </div>

                <!-- Endpoint URL -->
                <div class="space-y-3">
                  <div class="flex items-center justify-between ml-1">
                    <label class="block text-[10px] font-bold text-gray-400 uppercase tracking-widest">Endpoint URL</label>
                    <div class="flex flex-wrap gap-1.5">
                      <button 
                        v-for="preset in ENDPOINT_PRESETS" 
                        :key="preset.name"
                        @click="applyPreset(preset)"
                        type="button"
                        class="px-2 py-0.5 text-[9px] font-bold rounded-md border transition-all"
                        :class="form.endpointUrl === preset.url && form.endpointType === preset.type ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm' : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 hover:border-gray-300 dark:hover:border-gray-600'"
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
                      class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white"
                      placeholder="http://localhost:11434"
                      data-testid="setting-url-input"
                    />
                    <button 
                      @click="fetchModels"
                      class="px-4 py-2 rounded-xl transition-all flex items-center justify-center gap-2 min-w-[160px] disabled:opacity-70"
                      :class="[
                        connectionSuccess 
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' 
                          : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300'
                      ]"
                      title="Check Connection"
                      :disabled="fetchingModels"
                      data-testid="setting-check-connection"
                    >
                      <span class="relative w-4 h-4 flex items-center justify-center">
                        <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin absolute" />
                        <Check v-else-if="connectionSuccess" class="w-4 h-4 text-green-600 dark:text-green-400 animate-in zoom-in duration-300" />
                        <Activity v-else class="w-4 h-4" />
                      </span>
                      <span class="text-xs font-bold">{{ connectionSuccess ? 'Connected' : 'Check Connection' }}</span>
                    </button>
                  </div>
                  <!-- Info message about auto-connection check -->
                  <div class="flex items-start gap-2 p-2 bg-blue-50 dark:bg-blue-900/10 text-blue-800 dark:text-blue-300 rounded-lg text-xs border border-blue-100 dark:border-blue-900/30 ml-1">
                    <Globe class="w-4 h-4 shrink-0 mt-0.5" />
                    <p>Connection check is automatically performed only for localhost URLs.</p>
                  </div>
                  <!-- Error message with fixed height to prevent layout shift -->
                  <div class="h-4 mt-1">
                    <p v-if="error" class="text-xs text-red-500 font-medium ml-1 animate-in fade-in slide-in-from-top-1 duration-200">{{ error }}</p>
                  </div>
                </div>
              </div>
            </section>

            <section class="space-y-4">
              <div class="flex items-center gap-2 pb-2 border-b dark:border-gray-800">
                <Bot class="w-5 h-5 text-indigo-500" />
                <h2 class="text-lg font-bold text-gray-900 dark:text-white">Model Selection</h2>
              </div>

              <div class="space-y-6">
                <div class="space-y-2">
                  <label class="block text-xs font-bold text-gray-500 uppercase ml-1">Default Model</label>
                  <div class="flex gap-2">
                    <select 
                      v-model="form.defaultModelId"
                      class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
                      style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                      data-testid="setting-model-select"
                    >
                      <option :value="undefined">None</option>
                      <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
                    </select>
                    <button 
                      @click="fetchModels"
                      class="px-4 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-xl transition-all flex items-center justify-center disabled:opacity-50"
                      :disabled="fetchingModels"
                      title="Refresh Model List"
                      data-testid="setting-refresh-models"
                    >
                      <div class="relative w-4 h-4 flex items-center justify-center">
                        <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin absolute" />
                        <RefreshCw v-else class="w-4 h-4" />
                      </div>
                    </button>
                  </div>
                  <p class="text-xs text-gray-400 ml-1">Used for all new conversations unless overridden.</p>
                </div>

                <div class="bg-gray-50 dark:bg-gray-800/50 p-5 rounded-2xl border border-gray-100 dark:border-gray-800 space-y-4">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <Type class="w-4 h-4 text-gray-500" />
                      <span class="text-sm font-bold text-gray-700 dark:text-gray-300">Auto-Title Generation</span>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        v-model="form.autoTitleEnabled" 
                        class="sr-only peer"
                        data-testid="setting-auto-title-checkbox"
                      >
                      <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                    
                  <div class="space-y-2 opacity-50 transition-opacity" :class="{ 'opacity-100': form.autoTitleEnabled }">
                    <label class="block text-xs font-bold text-gray-500">Title Generation Model</label>
                    <select 
                      v-model="form.titleModelId"
                      :disabled="!form.autoTitleEnabled"
                      class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none disabled:cursor-not-allowed"
                      style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                      data-testid="setting-title-model-select"
                    >
                      <option :value="undefined">Use Current Chat Model (Default)</option>
                      <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>

            <!-- Save as Profile Section -->
            <div class="pt-6 border-t dark:border-gray-800">
              <div class="bg-indigo-50/30 dark:bg-indigo-900/5 border border-dashed border-indigo-200/50 dark:border-indigo-800/30 p-6 rounded-3xl flex flex-col md:flex-row items-center gap-6">
                <div class="flex-1 text-center md:text-left">
                  <h3 class="text-sm font-bold text-indigo-900 dark:text-indigo-300">Reusable Connection Profile</h3>
                  <p class="text-xs text-indigo-600/70 dark:text-indigo-400/60 mt-1">Capture the current provider, URL, and model settings into a reusable profile for quick switching later.</p>
                </div>
                <button 
                  @click="handleCreateProviderProfile"
                  class="shrink-0 flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-2xl shadow-lg shadow-indigo-500/20 transition-all active:scale-95"
                  data-testid="setting-save-provider-profile-button"
                >
                  <BookmarkPlus class="w-4 h-4" />
                  Save as New Profile
                </button>
              </div>
            </div>
          </div>

          <!-- Provider Profiles Tab -->
          <div v-if="activeTab === 'profiles'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <section class="space-y-4">
              <div class="flex items-center gap-2 pb-2 border-b dark:border-gray-800">
                <BookmarkPlus class="w-5 h-5 text-indigo-500" />
                <h2 class="text-lg font-bold text-gray-900 dark:text-white">Provider Profiles</h2>
              </div>
                
              <p class="text-sm text-gray-500">Save and switch between different AI provider configurations easily.</p>

              <div v-if="!form.providerProfiles || form.providerProfiles.length === 0" class="flex flex-col items-center justify-center p-12 bg-gray-50 dark:bg-gray-800/30 rounded-3xl border-2 border-dashed border-gray-200 dark:border-gray-800">
                <BookmarkPlus class="w-12 h-12 text-gray-300 mb-4" />
                <p class="text-sm text-gray-500 font-bold mb-4">No profiles saved yet.</p>
                <button 
                  @click="activeTab = 'connection'"
                  class="px-6 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 transition-colors"
                >
                  Go to Connection to Create One
                </button>
              </div>

              <div v-else class="grid grid-cols-1 gap-4">
                <div 
                  v-for="providerProfile in form.providerProfiles" 
                  :key="providerProfile.id"
                  class="group p-5 bg-white dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-2xl flex items-center justify-between transition-all hover:border-indigo-500/50 hover:shadow-lg hover:shadow-indigo-500/5"
                >
                  <div class="flex-1 min-w-0 mr-4">
                    <div v-if="editingProviderProfileId === providerProfile.id" class="flex items-center gap-2">
                      <input 
                        v-model="editingProviderProfileName"
                        @keyup.enter="saveRename"
                        @keyup.esc="editingProviderProfileId = null"
                        class="flex-1 bg-white dark:bg-gray-900 border border-indigo-500 rounded-lg px-3 py-1.5 text-sm outline-none"
                        autofocus
                      />
                      <button @click="saveRename" class="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg"><Check class="w-4 h-4" /></button>
                    </div>
                    <div v-else class="flex items-center gap-3">
                      <h3 class="text-sm font-bold text-gray-900 dark:text-white truncate">{{ providerProfile.name }}</h3>
                      <span class="text-[10px] px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 rounded-full font-bold" data-testid="provider-type-badge">{{ capitalize(providerProfile.endpointType) }}</span>
                    </div>
                    <div class="text-[11px] text-gray-500 mt-1 truncate">{{ providerProfile.endpointUrl }}</div>
                    <div class="text-[11px] text-gray-400 mt-0.5 italic flex items-center gap-2">
                      <span>{{ providerProfile.defaultModelId || 'No default model' }}</span>
                      <span v-if="providerProfile.titleModelId" class="text-[9px] opacity-60 px-1.5 py-0.5 border border-current rounded">Title: {{ providerProfile.titleModelId }}</span>
                    </div>
                  </div>

                  <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      @click="startRename(providerProfile)"
                      class="p-2 text-gray-400 hover:text-blue-500 transition-colors"
                      title="Rename Profile"
                      data-testid="provider-profile-rename-button"
                    >
                      <Pencil class="w-3.5 h-3.5" />
                    </button>
                    <button 
                      @click="handleDeleteProviderProfile(providerProfile.id)"
                      class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                      title="Delete Profile"
                      data-testid="provider-profile-delete-button"
                    >
                      <Trash class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <!-- Storage Tab -->
          <div v-if="activeTab === 'storage'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <section class="space-y-4">
              <div class="flex items-center gap-2 pb-2 border-b dark:border-gray-800">
                <Database class="w-5 h-5 text-green-500" />
                <h2 class="text-lg font-bold text-gray-900 dark:text-white">Storage Management</h2>
              </div>
                
              <div class="space-y-4">
                <label class="block text-xs font-bold text-gray-500 uppercase ml-1">Active Storage Provider</label>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div 
                    @click="form.storageType = 'local'"
                    class="cursor-pointer border-2 rounded-xl p-4 transition-all"
                    :class="form.storageType === 'local' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/10' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'"
                    data-testid="storage-option-local"
                  >
                    <div class="font-bold mb-1 text-gray-900 dark:text-white">Local Storage</div>
                    <div class="text-xs text-gray-500">Standard browser storage. Fast but limited size (5-10MB).</div>
                  </div>
                  <div 
                    @click="form.storageType = 'opfs'"
                    class="cursor-pointer border-2 rounded-xl p-4 transition-all"
                    :class="form.storageType === 'opfs' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/10' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'"
                    data-testid="storage-option-opfs"
                  >
                    <div class="font-bold mb-1 text-gray-900 dark:text-white">OPFS</div>
                    <div class="text-xs text-gray-500">Origin Private File System. High capacity, optimized for large data.</div>
                  </div>
                </div>
                  
                <div class="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900/10 text-blue-800 dark:text-blue-300 rounded-xl text-sm border border-blue-100 dark:border-blue-900/30">
                  <AlertTriangle class="w-5 h-5 shrink-0" />
                  <p>Switching storage providers will <strong>hide</strong> your current chats. They are not deleted, but you can only access chats from the currently active storage provider.</p>
                </div>
              </div>
            </section>
          </div>

          <!-- Developer Tab -->
          <div v-if="activeTab === 'developer'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <section class="space-y-4">
              <div class="flex items-center gap-2 pb-2 border-b dark:border-gray-800">
                <Cpu class="w-5 h-5 text-orange-500" />
                <h2 class="text-lg font-bold text-gray-900 dark:text-white">Developer Tools</h2>
              </div>
                
              <div class="space-y-6">
                <div class="space-y-4">
                  <h3 class="text-sm font-bold text-gray-700 dark:text-gray-300">Debug & Testing</h3>
                  <div class="flex flex-col sm:flex-row gap-4">
                    <button 
                      @click="createSampleChat"
                      class="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      data-testid="setting-create-sample-button"
                    >
                      <FlaskConical class="w-4 h-4" />
                      Create Sample Chat
                    </button>
                  </div>
                  <p class="text-xs text-gray-500">Adds a sample conversation with complex structures to verify rendering.</p>
                </div>

                <div class="pt-6 border-t dark:border-gray-800 space-y-4">
                  <h3 class="text-sm font-bold text-red-600 dark:text-red-400">Danger Zone</h3>
                  <div class="p-4 border border-red-100 dark:border-red-900/20 bg-red-50 dark:bg-red-900/10 rounded-xl space-y-4">
                    <div class="flex items-start gap-3">
                      <AlertTriangle class="w-5 h-5 text-red-500 shrink-0" />
                      <div>
                        <h4 class="font-bold text-red-700 dark:text-red-400 text-sm">Reset All Application Data</h4>
                        <p class="text-xs text-red-600/80 dark:text-red-400/70 mt-1">
                          This action cannot be undone. It will permanently delete all chat history, groups, and settings stored in the <strong>{{ form.storageType }}</strong> provider.
                        </p>
                      </div>
                    </div>
                    <button 
                      @click="handleResetData"
                      class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-bold transition-colors shadow-sm"
                      data-testid="setting-reset-data-button"
                    >
                      <Trash2 class="w-4 h-4" />
                      Execute Reset
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <!-- Footer Actions (Right-aligned) -->
      <div class="p-6 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3 bg-gray-50/30 dark:bg-gray-900/30 backdrop-blur-sm">
        <button 
          @click="handleSave"
          :disabled="!hasChanges"
          class="flex items-center justify-center gap-2 py-2.5 px-8 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl shadow-lg shadow-blue-500/20 transition-all"
          data-testid="setting-save-button"
        >
          <CheckCircle2 v-if="saveSuccess" class="w-4 h-4" />
          <Save v-else class="w-4 h-4" />
          <span>{{ saveSuccess ? 'Saved' : 'Save Changes' }}</span>
        </button>
      </div>
    </main>
  </div>


  </div>
</template>


<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes slide-in-from-bottom {
  from { transform: translateY(10px); }
  to { transform: translateY(0); }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in-95 {
  animation-name: zoom-in;
}
.slide-in-from-bottom-2 {
  animation-name: slide-in-from-bottom;
}
</style>