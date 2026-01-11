<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useSampleChat } from '../composables/useSampleChat';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import { 
  X, Loader2, FlaskConical, Trash2, Globe, 
  Database, Bot, Type, Settings2, RefreshCw, Save,
  CheckCircle2, AlertTriangle, Cpu
} from 'lucide-vue-next';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const { settings, save } = useSettings();
const { createSampleChat } = useSampleChat();

const form = ref({ ...settings.value });
const initialFormState = ref('');
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);
const error = ref<string | null>(null);
const saveSuccess = ref(false);

// Tab State
type Tab = 'general' | 'storage' | 'developer';
const activeTab = ref<Tab>('general');

const hasChanges = computed(() => {
  return JSON.stringify(form.value) !== initialFormState.value;
});

async function handleResetData() {
  if (confirm('Are you sure you want to reset all app data? This will delete all chats, groups, and settings for the current storage location.')) {
    await storageService.clearAll();
    window.location.reload();
  }
}

function handleCancel() {
  if (hasChanges.value) {
    if (confirm('You have unsaved changes. Are you sure you want to discard them?')) {
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
    availableModels.value = await provider.listModels(form.value.endpointUrl);
  } catch (e) {
    console.error(e);
    error.value = 'Failed to fetch models. Check URL.';
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

// Watch for modal open to reset form
watch(() => props.isOpen, (open) => {
  if (open) {
    form.value = JSON.parse(JSON.stringify(settings.value));
    initialFormState.value = JSON.stringify(form.value);
    activeTab.value = 'general';
    saveSuccess.value = false;
    fetchModels();
  }
});
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur p-2 md:p-6">
    <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-[95vw] h-[95vh] md:h-[90vh] overflow-hidden flex flex-col md:flex-row border border-gray-200 dark:border-gray-800 animate-in fade-in zoom-in-95 duration-200 relative">
      
      <!-- Persistent Close Button (Top Right) -->
      <button 
        @click="handleCancel"
        class="absolute top-4 right-4 z-[120] p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors shadow-sm bg-white/50 dark:bg-gray-900/50 backdrop-blur"
        title="Close (Esc)"
      >
        <X class="w-6 h-6" />
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
            @click="activeTab = 'general'"
            class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all whitespace-nowrap text-left"
            :class="activeTab === 'general' ? 'bg-white dark:bg-gray-800 shadow-sm text-blue-600 dark:text-blue-400 ring-1 ring-black/5 dark:ring-white/5' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
          >
            <Settings2 class="w-4 h-4" />
            General
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
            
            <!-- General Tab -->
            <div v-if="activeTab === 'general'" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
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
                      @change="fetchModels"
                      data-testid="setting-provider-select"
                    >
                      <option value="openai">OpenAI Compatible</option>
                      <option value="ollama">Ollama</option>
                    </select>
                  </div>

                  <div class="space-y-2">
                    <label class="block text-xs font-bold text-gray-500 uppercase ml-1">Endpoint URL</label>
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
                        class="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-xl transition-colors flex items-center justify-center gap-2 min-w-[100px]"
                        title="Refresh Models"
                        data-testid="setting-refresh-models"
                      >
                        <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin" />
                        <RefreshCw v-else class="w-4 h-4" />
                      </button>
                    </div>
                    <p v-if="error" class="text-xs text-red-500 font-medium ml-1">{{ error }}</p>
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
                    <select 
                      v-model="form.defaultModelId"
                      class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
                      style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                      data-testid="setting-model-select"
                    >
                      <option v-if="availableModels.length === 0" :value="form.defaultModelId">{{ form.defaultModelId || 'Custom' }}</option>
                      <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
                    </select>
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
                      <label class="block text-xs font-bold text-gray-500 uppercase">Title Generation Model</label>
                      <select 
                        v-model="form.titleModelId"
                        :disabled="!form.autoTitleEnabled"
                        class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none disabled:cursor-not-allowed"
                        style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                        data-testid="setting-title-model-select"
                      >
                        <option :value="undefined">Use Current Chat Model</option>
                        <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
                      </select>
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
            @click="handleCancel"
            class="py-2.5 px-6 text-sm font-bold text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-all border border-gray-200 dark:border-gray-700"
            data-testid="setting-cancel-button"
          >
            Cancel
          </button>
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
