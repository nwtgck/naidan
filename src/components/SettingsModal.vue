<script lang="ts">
export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
</script>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useSampleChat } from '../composables/useSampleChat';
import { useToast } from '../composables/useToast';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import type { ProviderProfile } from '../models/types';
import { 
  X, Loader2, FlaskConical, Trash2, Globe, 
  Database, Bot, Type, Settings2, RefreshCw, Save,
  CheckCircle2, AlertTriangle, Cpu, BookmarkPlus,
  Pencil, Trash, Check, Activity, Info, HardDrive,
  MessageSquareQuote, Download,
} from 'lucide-vue-next';
import LmParametersEditor from './LmParametersEditor.vue';
import { useConfirm } from '../composables/useConfirm'; // Import useConfirm
import { usePrompt } from '../composables/usePrompt';   // Import usePrompt
import { ENDPOINT_PRESETS } from '../models/constants';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const { settings, save, availableModels, isFetchingModels, fetchModels: fetchModelsGlobal } = useSettings();
const chatStore = useChat();
const { createSampleChat } = useSampleChat();
const { addToast } = useToast();
const { showConfirm } = useConfirm(); // Initialize useConfirm
const { showPrompt } = usePrompt();     // Initialize usePrompt
const router = useRouter();

const isHostedMode = __BUILD_MODE_IS_HOSTED__;

const form = ref({ ...settings.value });
const initialFormState = ref('');
const fetchingModels = computed(() => isFetchingModels.value);
const connectionSuccess = ref(false);
const error = ref<string | null>(null);
const saveSuccess = ref(false);
const isOPFSSupported = typeof navigator !== 'undefined' && 
                        typeof navigator.storage?.getDirectory === 'function' &&
                        (typeof window !== 'undefined' ? window.isSecureContext : true);

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

async function handleDeleteAllHistory() {
  const confirmed = await showConfirm({
    title: 'Clear History',
    message: 'Are you absolutely sure you want to delete ALL chats and groups? This action cannot be undone.',
    confirmButtonText: 'Clear All',
    confirmButtonVariant: 'danger',
  });

  if (confirmed) {
    await chatStore.deleteAllChats();
    emit('close');
    router.push('/');
  }
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
    return;
  }
  
  error.value = null;
  try {
    const provider = form.value.endpointType === 'ollama' 
      ? new OllamaProvider() 
      : new OpenAIProvider();
    
    await provider.listModels(form.value.endpointUrl);
    error.value = null;
    connectionSuccess.value = true;
    setTimeout(() => {
      connectionSuccess.value = false;
    }, 3000);
    
    // Also trigger global fetch if it's the current settings
    if (!hasChanges.value) {
      await fetchModelsGlobal();
    }
  } catch (err) {
    console.error(err);
    error.value = 'Connection failed. Check URL or provider.';
  }
}

async function handleSave() {
  try {
    await save(form.value);
    initialFormState.value = JSON.stringify(form.value);
    saveSuccess.value = true;
    setTimeout(() => {
      saveSuccess.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to save settings:', err);
    await showConfirm({
      title: 'Save Failed',
      message: `Failed to save settings or migrate data. ${err instanceof Error ? err.message : String(err)}`,
      confirmButtonText: 'Understand',
    });
  }
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
    systemPrompt: form.value.systemPrompt,
    lmParameters: form.value.lmParameters ? JSON.parse(JSON.stringify(form.value.lmParameters)) : undefined,
  };

  if (!form.value.providerProfiles) form.value.providerProfiles = [];
  form.value.providerProfiles.push(newProviderProfile);
}

function handleApplyProviderProfile(providerProfile: ProviderProfile) {
  form.value.endpointType = providerProfile.endpointType;
  form.value.endpointUrl = providerProfile.endpointUrl;
  form.value.defaultModelId = providerProfile.defaultModelId;
  form.value.titleModelId = providerProfile.titleModelId;
  form.value.systemPrompt = providerProfile.systemPrompt;
  form.value.lmParameters = providerProfile.lmParameters ? JSON.parse(JSON.stringify(providerProfile.lmParameters)) : undefined;
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
  <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-2 md:p-6 transition-all">
    <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-[95vw] h-[95vh] md:h-[90vh] overflow-hidden flex flex-col md:flex-row border border-gray-100 dark:border-gray-800 animate-in fade-in zoom-in-95 duration-200 relative">
      
      <!-- Persistent Close Button (Top Right) -->
      <button 
        @click="handleCancel"
        class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
        data-testid="setting-close-x"
      >
        <X class="w-5 h-5" />
      </button>

      <!-- Sidebar (Tabs) -->
      <aside class="w-full md:w-72 flex-shrink-0 bg-gray-50/50 dark:bg-black/20 border-b md:border-b-0 md:border-r border-gray-100 dark:border-gray-800/50 flex flex-col transition-colors">
        <!-- Header -->
        <div class="p-6 border-b border-gray-100 dark:border-gray-800/50 flex items-center gap-3">
          <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <Settings2 class="w-5 h-5 text-blue-600" />
          </div>
          <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Settings</h2>
        </div>

        <!-- Navigation -->
        <nav class="flex-1 overflow-x-auto md:overflow-y-auto p-4 flex md:flex-col gap-1.5 no-scrollbar">
          <button 
            @click="activeTab = 'connection'"
            class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
            :class="activeTab === 'connection' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
          >
            <Globe class="w-4 h-4" />
            Connection
          </button>
          <button 
            @click="activeTab = 'profiles'"
            class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
            :class="activeTab === 'profiles' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
          >
            <BookmarkPlus class="w-4 h-4" />
            Provider Profiles
          </button>
          <button 
            @click="activeTab = 'storage'"
            class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
            :class="activeTab === 'storage' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
          >
            <Database class="w-4 h-4" />
            Storage
          </button>
          <button 
            @click="activeTab = 'developer'"
            class="flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-left border"
            :class="activeTab === 'developer' ? 'bg-white dark:bg-gray-800 shadow-lg shadow-blue-500/5 text-blue-600 dark:text-blue-400 border-gray-100 dark:border-gray-700' : 'text-gray-500 dark:text-gray-400 border-transparent hover:bg-white/50 dark:hover:bg-gray-800/50 hover:text-gray-700'"
          >
            <Cpu class="w-4 h-4" />
            Developer
          </button>
        </nav>

        <!-- Download Footer (Hosted Mode Only) -->
        <div v-if="isHostedMode" class="p-4 border-t border-gray-100 dark:border-gray-800/50 mt-auto">
          <a 
            href="./lm-web-ui-standalone.zip" 
            download="lm-web-ui-standalone.zip"
            class="flex items-center gap-3 px-4 py-3 bg-green-50 dark:bg-green-900/10 hover:bg-green-100 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-900/30 rounded-xl transition-all group no-underline"
            data-testid="sidebar-download-button"
          >
            <div class="p-2 bg-green-100 dark:bg-green-800/50 rounded-lg text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
              <Download class="w-4 h-4" />
            </div>
            <div class="flex-1 min-w-0 text-left">
              <div class="text-xs font-bold text-green-800 dark:text-green-300">Offline Standalone</div>
              <div class="text-[10px] text-green-600/70 dark:text-green-400/60 font-medium truncate">Runs locally via file://</div>
            </div>
          </a>
        </div>
      </aside>

      <!-- Main Content Area -->
      <main class="flex-1 flex flex-col min-w-0 bg-white dark:bg-gray-900 relative">
        <div class="flex-1 overflow-y-auto">
          <div class="p-6 md:p-12 space-y-12 max-w-4xl mx-auto">
            
            <!-- Connection Tab -->
            <div v-if="activeTab === 'connection'" class="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-400">
              
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
                    </select>
                  </div>

                  <!-- Endpoint URL -->
                  <div class="space-y-4">
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
                    <div class="flex items-start gap-3 p-4 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700/80 dark:text-blue-300/80 rounded-2xl text-[11px] font-medium border border-blue-100 dark:border-blue-900/20 ml-1">
                      <Globe class="w-4 h-4 shrink-0 mt-0.5" />
                      <p>Connection check is automatically performed only for localhost URLs.</p>
                    </div>
                    <!-- Error message with fixed height to prevent layout shift -->
                    <div class="h-4 mt-1">
                      <p v-if="error" class="text-xs text-red-500 font-bold ml-1 animate-in fade-in slide-in-from-top-1 duration-200">{{ error }}</p>
                    </div>
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
                    <div class="flex gap-2">
                      <select 
                        v-model="form.defaultModelId"
                        class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3.5 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                        style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                        data-testid="setting-model-select"
                      >
                        <option :value="undefined">None</option>
                        <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
                      </select>
                      <button 
                        @click="fetchModels"
                        class="px-4 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 rounded-xl transition-all flex items-center justify-center disabled:opacity-50 shadow-sm"
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
                      <select 
                        v-model="form.titleModelId"
                        :disabled="!form.autoTitleEnabled"
                        class="w-full bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none disabled:cursor-not-allowed shadow-sm"
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

              <!-- Save as Profile Section -->
              <div class="pt-8 border-t border-gray-100 dark:border-gray-800">
                <div class="bg-blue-50/30 dark:bg-blue-900/5 border border-dashed border-blue-200/50 dark:border-blue-800/30 p-8 rounded-3xl flex flex-col md:flex-row items-center gap-8">
                  <div class="flex-1 text-center md:text-left">
                    <h3 class="text-base font-bold text-blue-900 dark:text-blue-300">Reusable Connection Profile</h3>
                    <p class="text-xs text-blue-600/70 dark:text-blue-400/60 mt-1.5 font-medium leading-relaxed">Capture the current provider, URL, and model settings into a reusable profile for quick switching later.</p>
                  </div>
                  <button 
                    @click="handleCreateProviderProfile"
                    class="shrink-0 flex items-center gap-2 px-8 py-3.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-2xl shadow-lg shadow-blue-500/20 transition-all active:scale-95"
                    data-testid="setting-save-provider-profile-button"
                  >
                    <BookmarkPlus class="w-4 h-4" />
                    Save as New Profile
                  </button>
                </div>
              </div>
            </div>

            <!-- Provider Profiles Tab -->
            <div v-if="activeTab === 'profiles'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
              <section class="space-y-6">
                <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
                  <BookmarkPlus class="w-5 h-5 text-blue-500" />
                  <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Provider Profiles</h2>
                </div>
                
                <p class="text-sm font-medium text-gray-500">Save and switch between different AI provider configurations easily.</p>

                <div v-if="!form.providerProfiles || form.providerProfiles.length === 0" class="flex flex-col items-center justify-center p-16 bg-gray-50 dark:bg-gray-800/30 rounded-3xl border-2 border-dashed border-gray-200 dark:border-gray-800">
                  <div class="p-4 bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 mb-6">
                    <BookmarkPlus class="w-12 h-12 text-gray-300" />
                  </div>
                  <p class="text-sm text-gray-400 font-bold mb-6">No profiles saved yet.</p>
                  <button 
                    @click="activeTab = 'connection'"
                    class="px-8 py-3 bg-blue-600 text-white text-sm font-bold rounded-2xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 active:scale-95"
                  >
                    Go to Connection to Create One
                  </button>
                </div>

                <div v-else class="grid grid-cols-1 gap-5">
                  <div 
                    v-for="providerProfile in form.providerProfiles" 
                    :key="providerProfile.id"
                    class="group p-6 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 rounded-3xl flex items-center justify-between transition-all hover:border-blue-500/50 hover:shadow-xl hover:shadow-blue-500/5"
                    data-testid="provider-profile-item"
                  >
                    <div class="flex-1 min-w-0 mr-6">
                      <div v-if="editingProviderProfileId === providerProfile.id" class="flex items-center gap-2">
                        <input 
                          v-model="editingProviderProfileName"
                          @keyup.enter="saveRename"
                          @keyup.esc="editingProviderProfileId = null"
                          class="flex-1 bg-white dark:bg-gray-900 border-2 border-blue-500 rounded-xl px-4 py-2 text-sm font-bold text-gray-800 outline-none shadow-sm"
                          autofocus
                        />
                        <button @click="saveRename" class="p-2 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-xl transition-colors"><Check class="w-5 h-5" /></button>
                      </div>
                      <div v-else class="flex items-center gap-4">
                        <h3 class="text-base font-bold text-gray-800 dark:text-white truncate">{{ providerProfile.name }}</h3>
                        <span class="text-[10px] px-2.5 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg font-bold uppercase tracking-wider border border-blue-100 dark:border-blue-900/30" data-testid="provider-type-badge">{{ capitalize(providerProfile.endpointType) }}</span>
                      </div>                      <div class="text-xs font-medium text-gray-400 mt-1.5 truncate">{{ providerProfile.endpointUrl }}</div>
                      <div class="text-[11px] font-bold text-gray-500 mt-2 flex items-center gap-3">
                        <span class="flex items-center gap-1.5 bg-gray-50 dark:bg-gray-800 px-2 py-0.5 rounded-lg border border-gray-100 dark:border-gray-700">{{ providerProfile.defaultModelId || 'No default model' }}</span>
                        <span v-if="providerProfile.titleModelId" class="text-[9px] opacity-60 px-2 py-0.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-transparent">Title: {{ providerProfile.titleModelId }}</span>
                      </div>
                    </div>

                    <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200">
                      <button 
                        @click="startRename(providerProfile)"
                        class="p-2.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-xl transition-colors"
                        title="Rename Profile"
                        data-testid="provider-profile-rename-button"
                      >
                        <Pencil class="w-4 h-4" />
                      </button>
                      <button 
                        @click="handleDeleteProviderProfile(providerProfile.id)"
                        class="p-2.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-xl transition-colors"
                        title="Delete Profile"
                        data-testid="provider-profile-delete-button"
                      >
                        <Trash class="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <!-- Storage Tab -->
            <div v-if="activeTab === 'storage'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
              <section class="space-y-6">
                <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
                  <Database class="w-5 h-5 text-blue-500" />
                  <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Storage Management</h2>
                </div>
                
                <div class="space-y-6">
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Active Storage Provider</label>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div 
                      @click="form.storageType = 'local'"
                      class="cursor-pointer border-2 rounded-2xl p-6 transition-all shadow-sm flex flex-col gap-3"
                      :class="form.storageType === 'local' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 hover:border-gray-200 dark:hover:border-gray-700'"
                      data-testid="storage-option-local"
                    >
                      <div class="flex items-center justify-between">
                        <div class="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                          <HardDrive class="w-4 h-4 text-gray-600 dark:text-gray-300" />
                        </div>
                      </div>
                      <div>
                        <div class="font-bold text-base mb-1 text-gray-800 dark:text-white">Local Storage</div>
                        <div class="text-xs font-medium text-gray-500 leading-relaxed">Standard browser storage. Fast but limited size (5-10MB).</div>
                      </div>
                    </div>
                    <div 
                      @click="isOPFSSupported && (form.storageType = 'opfs')"
                      class="cursor-pointer border-2 rounded-2xl p-6 transition-all shadow-sm flex flex-col gap-3"
                      :class="[
                        form.storageType === 'opfs' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 hover:border-gray-200 dark:hover:border-gray-700',
                        !isOPFSSupported ? 'opacity-50 cursor-not-allowed grayscale' : ''
                      ]"
                      data-testid="storage-option-opfs"
                    >
                      <div class="flex items-center justify-between">
                        <div class="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                          <HardDrive class="w-4 h-4 text-gray-600 dark:text-gray-300" />
                        </div>
                        <span v-if="!isOPFSSupported" class="text-[10px] bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">Unsupported</span>
                      </div>
                      <div>
                        <div class="font-bold text-base mb-1 text-gray-800 dark:text-white">OPFS</div>
                        <div class="text-xs font-medium text-gray-500 leading-relaxed">Origin Private File System. High capacity, optimized for large data.</div>
                      </div>
                    </div>
                  </div>
                  
                  <div class="flex items-start gap-4 p-5 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-300 rounded-2xl text-[11px] font-medium border border-blue-100 dark:border-blue-900/30">
                    <Info class="w-5 h-5 shrink-0 mt-0.5 text-blue-500" />
                    <p class="leading-relaxed">Switching storage will <strong>migrate</strong> all your chats, groups, and settings to the new location. This process will start automatically after you click <strong>Save Changes</strong>.</p>
                  </div>
                </div>
              </section>

              <section class="space-y-6 pt-8 border-t border-gray-100 dark:border-gray-800">
                <div class="flex items-center gap-2 pb-3">
                  <Trash2 class="w-5 h-5 text-red-500" />
                  <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Data Cleanup</h2>
                </div>
                
                <div class="p-6 border border-red-100 dark:border-red-900/20 bg-red-50/30 dark:bg-red-900/5 rounded-3xl space-y-4">
                  <div>
                    <h4 class="font-bold text-red-800 dark:text-red-400 text-sm">Clear Conversation History</h4>
                    <p class="text-xs font-medium text-red-600/70 dark:text-red-400/60 mt-1.5 leading-relaxed">
                      This will permanently delete all your chats and groups. Your settings and provider profiles will be preserved.
                    </p>
                  </div>
                  <button 
                    @click="handleDeleteAllHistory"
                    class="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-sm font-bold transition-all shadow-lg shadow-red-500/20 active:scale-95"
                    data-testid="setting-clear-history-button"
                  >
                    <Trash2 class="w-4 h-4" />
                    Clear All Conversation History
                  </button>
                </div>
              </section>
            </div>

            <!-- Developer Tab -->
            <div v-if="activeTab === 'developer'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
              <section class="space-y-8">
                <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
                  <Cpu class="w-5 h-5 text-blue-500" />
                  <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Developer Tools</h2>
                </div>
                
                <div class="space-y-8">
                  <div class="space-y-4">
                    <h3 class="text-sm font-bold text-gray-500 uppercase tracking-widest ml-1">Debug & Testing</h3>
                    <div class="flex flex-col sm:flex-row gap-4">
                      <button 
                        @click="createSampleChat"
                        class="flex-1 flex items-center justify-center gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-2xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-all shadow-sm active:scale-95"
                        data-testid="setting-create-sample-button"
                      >
                        <FlaskConical class="w-5 h-5" />
                        Create Sample Chat
                      </button>
                    </div>
                    <p class="text-[11px] font-medium text-gray-400 ml-1">Adds a sample conversation with complex structures to verify rendering.</p>
                  </div>

                  <div class="pt-8 border-t border-gray-100 dark:border-gray-800 space-y-5">
                    <h3 class="text-sm font-bold text-red-500 uppercase tracking-widest ml-1">Danger Zone</h3>
                    <div class="p-6 border border-red-100 dark:border-red-900/20 bg-red-50/30 dark:bg-red-900/5 rounded-3xl space-y-6">
                      <div class="flex items-start gap-4">
                        <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-100 dark:border-red-900/20">
                          <AlertTriangle class="w-6 h-6 text-red-500 shrink-0" />
                        </div>
                        <div>
                          <h4 class="font-bold text-red-800 dark:text-red-400 text-sm">Reset All Application Data</h4>
                          <p class="text-xs font-medium text-red-600/70 dark:text-red-400/60 mt-1.5 leading-relaxed">
                            This action cannot be undone. It will permanently delete all chat history, groups, and settings stored in the <strong>{{ form.storageType }}</strong> provider.
                          </p>
                        </div>
                      </div>
                      <button 
                        @click="handleResetData"
                        class="w-full flex items-center justify-center gap-2 px-6 py-4 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-sm font-bold transition-all shadow-lg shadow-red-500/20 active:scale-95"
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
        <div class="p-8 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-4 bg-gray-50/50 dark:bg-gray-900/50 backdrop-blur-sm">
          <button 
            @click="handleSave"
            :disabled="!hasChanges"
            class="flex items-center justify-center gap-2 py-3 px-10 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-2xl shadow-lg shadow-blue-500/30 transition-all active:scale-95"
            data-testid="setting-save-button"
          >
            <CheckCircle2 v-if="saveSuccess" class="w-4 h-4" />
            <Save v-else class="w-4 h-4" />
            <span>{{ saveSuccess ? 'Settings Saved' : 'Save Changes' }}</span>
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
  from { transform: translateY(15px); }
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