<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import { X, Loader2, FlaskConical, Trash2, Globe, Database, Bot, Type, Settings2, RefreshCw } from 'lucide-vue-next';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const { settings, save } = useSettings();
const chatStore = useChat();

const form = ref({ ...settings.value });
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);
const error = ref<string | null>(null);

const hasChanges = computed(() => {
  return JSON.stringify(form.value) !== JSON.stringify(settings.value);
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
  emit('close');
}

// Watch for modal open to reset form
watch(() => props.isOpen, (open) => {
  if (open) {
    form.value = { ...settings.value };
    fetchModels();
  }
});
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur p-4">
    <div class="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col border border-gray-200 dark:border-gray-800 animate-in fade-in zoom-in-95 duration-200">
      <!-- Header -->
      <div class="px-6 py-5 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <Settings2 class="w-5 h-5" />
          </div>
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">Settings</h2>
        </div>
        <button 
          @click="handleCancel"
          class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- Body -->
      <div class="p-6 space-y-6 flex-1 overflow-y-auto max-h-[70vh]">
        <!-- Endpoint Section -->
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">
            <Globe class="w-3.5 h-3.5" />
            <span>Endpoint Configuration</span>
          </div>
          
          <div class="space-y-3">
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1 ml-1">API Provider</label>
              <select 
                v-model="form.endpointType"
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                @change="fetchModels"
                data-testid="setting-provider-select"
              >
                <option value="openai">OpenAI Compatible</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1 ml-1">Endpoint URL</label>
              <div class="flex gap-2">
                <input 
                  v-model="form.endpointUrl"
                  type="text"
                  class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white"
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
                  <span class="text-xs font-bold">Refresh</span>
                </button>
              </div>
              <p v-if="error" class="text-[10px] text-red-500 mt-1 ml-1">{{ error }}</p>
            </div>
          </div>
        </div>

        <!-- Models Section -->
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">
            <Bot class="w-3.5 h-3.5" />
            <span>Model Selection</span>
          </div>

          <div class="space-y-3">
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1 ml-1">Default Model</label>
              <select 
                v-model="form.defaultModelId"
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                data-testid="setting-model-select"
              >
                <option v-if="availableModels.length === 0" :value="form.defaultModelId">{{ form.defaultModelId || 'Custom' }}</option>
                <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>

            <div class="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-2xl border border-gray-100 dark:border-gray-800">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2 text-xs font-bold text-gray-700 dark:text-gray-300">
                  <Type class="w-3.5 h-3.5" />
                  <span>Auto-Title Generation</span>
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
              <select 
                v-model="form.titleModelId"
                :disabled="!form.autoTitleEnabled"
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none disabled:opacity-30 disabled:cursor-not-allowed"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                data-testid="setting-title-model-select"
              >
                <option :value="undefined">Use Current Chat Model</option>
                <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Storage Section -->
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">
            <Database class="w-3.5 h-3.5" />
            <span>Storage Management</span>
          </div>
          
          <div class="space-y-2">
            <select 
              v-model="form.storageType"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              data-testid="setting-storage-select"
            >
              <option value="local">Browser Local Storage</option>
              <option value="opfs">Origin Private File System (OPFS)</option>
            </select>
            <p class="text-[10px] text-gray-400 dark:text-gray-500 ml-1">
              Note: Switching storage will hide chats from the previous location.
            </p>
          </div>
        </div>

        <!-- Debug Section -->
        <div class="space-y-4 pt-2">
          <div class="flex items-center gap-2 text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">
            <FlaskConical class="w-3.5 h-3.5" />
            <span>Developer Tools</span>
          </div>
          
          <div class="grid grid-cols-1 gap-2">
            <button 
              @click="chatStore.createSampleChat(); emit('close')"
              class="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-dashed border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded-xl text-xs hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              data-testid="setting-create-sample-button"
            >
              <FlaskConical class="w-4 h-4" />
              Create Sample Chat
            </button>
            <button 
              @click="handleResetData"
              class="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-red-100 dark:border-red-900/20 text-red-500 dark:text-red-400 rounded-xl text-xs hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
              data-testid="setting-reset-data-button"
            >
              <Trash2 class="w-4 h-4" />
              Reset All App Data
            </button>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="p-6 bg-gray-50/50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800 flex gap-3">
        <button 
          @click="handleCancel"
          class="flex-1 py-3 px-4 text-sm font-bold text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-all"
          data-testid="setting-cancel-button"
        >
          Cancel
        </button>
        <button 
          @click="handleSave"
          class="flex-1 py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all"
          data-testid="setting-save-button"
        >
          Save Changes
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.zoom-in-95 {
  animation-name: zoom-in;
}
</style>