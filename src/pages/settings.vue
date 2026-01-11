<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter, onBeforeRouteLeave } from 'vue-router';
import { useSettings } from '../composables/useSettings';
import { useSampleChat } from '../composables/useSampleChat';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import { 
  ArrowLeft, Loader2, FlaskConical, Trash2, Globe, 
  Database, Bot, Type, Settings2, RefreshCw, Save 
} from 'lucide-vue-next';

const { settings, save } = useSettings();
const { createSampleChat } = useSampleChat();
const router = useRouter();

const form = ref({ ...settings.value });
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);
const error = ref<string | null>(null);
const saveSuccess = ref(false);

const hasChanges = computed(() => {
  return JSON.stringify(form.value) !== JSON.stringify(settings.value);
});

// Navigation Guard: Warn if leaving with unsaved changes
onBeforeRouteLeave((_to, _from, next) => {
  if (hasChanges.value) {
    const answer = window.confirm('You have unsaved changes. Are you sure you want to leave?');
    if (!answer) return next(false);
  }
  next();
});

// Browser-level Guard: Warn if refreshing or closing tab
const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  if (hasChanges.value) {
    e.preventDefault();
    e.returnValue = '';
  }
};

onMounted(async () => {
  form.value = { ...settings.value };
  window.addEventListener('beforeunload', handleBeforeUnload);
  await fetchModels();
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload);
});

async function handleResetData() {
  if (confirm('Are you sure you want to reset all app data? This will delete all chats, groups, and settings for the current storage location.')) {
    await storageService.clearAll();
    window.location.reload();
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
  saveSuccess.value = true;
  setTimeout(() => {
    saveSuccess.value = false;
  }, 2000);
}

function goBack() {
  router.back();
}
</script>

<template>
  <div class="flex-1 flex flex-col h-full bg-white dark:bg-gray-950 overflow-y-auto">
    <!-- Sticky Header -->
    <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-950/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-800">
      <div class="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <button 
            @click="goBack"
            class="p-2 -ml-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
            title="Go Back"
          >
            <ArrowLeft class="w-5 h-5" />
          </button>
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white">
              <Settings2 class="w-5 h-5" />
            </div>
            <h1 class="text-xl font-bold text-gray-900 dark:text-white tracking-tight">App Settings</h1>
          </div>
        </div>

        <button 
          @click="handleSave"
          :disabled="!hasChanges"
          class="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all"
        >
          <Save class="w-4 h-4" />
          <span>{{ saveSuccess ? 'Saved!' : 'Save Changes' }}</span>
        </button>
      </div>
    </header>

    <div class="max-w-4xl mx-auto w-full p-4 md:p-8 space-y-12">
      <!-- Endpoint Section -->
      <section class="space-y-6">
        <div class="flex items-center gap-3 pb-2 border-b dark:border-gray-800">
          <Globe class="w-5 h-5 text-blue-500" />
          <h2 class="text-lg font-bold text-gray-900 dark:text-white uppercase tracking-wider text-sm">Endpoint Configuration</h2>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-gray-700 dark:text-gray-300 ml-1">API Provider</label>
            <select 
              v-model="form.endpointType"
              class="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              @change="fetchModels"
            >
              <option value="openai">OpenAI Compatible</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-semibold text-gray-700 dark:text-gray-300 ml-1">Endpoint URL</label>
            <div class="flex gap-2">
              <input 
                v-model="form.endpointUrl"
                type="text"
                class="flex-1 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white"
                placeholder="http://localhost:11434"
              />
              <button 
                @click="fetchModels"
                class="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-xl transition-colors flex items-center justify-center gap-2 min-w-[120px]"
              >
                <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin" />
                <RefreshCw v-else class="w-4 h-4" />
                <span class="text-xs font-bold">Refresh Models</span>
              </button>
            </div>
            <p v-if="error" class="text-xs text-red-500 mt-1 ml-1 font-medium">{{ error }}</p>
          </div>
        </div>
      </section>

      <!-- Models Section -->
      <section class="space-y-6">
        <div class="flex items-center gap-3 pb-2 border-b dark:border-gray-800">
          <Bot class="w-5 h-5 text-indigo-500" />
          <h2 class="text-lg font-bold text-gray-900 dark:text-white uppercase tracking-wider text-sm">Model Selection</h2>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-gray-700 dark:text-gray-300 ml-1">Default Model</label>
            <p class="text-xs text-gray-500 mb-2 ml-1">Used for all new conversations.</p>
            <select 
              v-model="form.defaultModelId"
              class="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
              style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
            >
              <option v-if="availableModels.length === 0" :value="form.defaultModelId">{{ form.defaultModelId || 'Custom' }}</option>
              <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <div class="bg-gray-50 dark:bg-gray-900/50 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 space-y-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-300">
                <Type class="w-4 h-4 text-blue-500" />
                <span>Auto-Title Generation</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="form.autoTitleEnabled" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>
            
            <div class="space-y-2">
              <label class="block text-xs font-medium text-gray-400">Title Generation Model</label>
              <select 
                v-model="form.titleModelId"
                :disabled="!form.autoTitleEnabled"
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none disabled:opacity-30 disabled:cursor-not-allowed"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
              >
                <option :value="undefined">Use Current Chat Model</option>
                <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <!-- Storage Section -->
      <section class="space-y-6">
        <div class="flex items-center gap-3 pb-2 border-b dark:border-gray-800">
          <Database class="w-5 h-5 text-green-500" />
          <h2 class="text-lg font-bold text-gray-900 dark:text-white uppercase tracking-wider text-sm">Storage Management</h2>
        </div>
        
        <div class="max-w-md space-y-4">
          <label class="block text-sm font-semibold text-gray-700 dark:text-gray-300 ml-1">Active Storage Provider</label>
          <select 
            v-model="form.storageType"
            class="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-white appearance-none"
            style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
          >
            <option value="local">Browser Local Storage</option>
            <option value="opfs">Origin Private File System (OPFS)</option>
          </select>
          <div class="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-xl text-xs leading-relaxed">
            <span class="font-bold">Note:</span>
            <span>Switching storage will hide chats from the previous location. Your data is not lost, but only one location is active at a time.</span>
          </div>
        </div>
      </section>

      <!-- Danger Zone -->
      <section class="space-y-6 pt-8 border-t dark:border-gray-800">
        <div class="flex items-center gap-3">
          <FlaskConical class="w-5 h-5 text-red-500" />
          <h2 class="text-lg font-bold text-gray-900 dark:text-white uppercase tracking-wider text-sm">Developer & Danger Zone</h2>
        </div>
        
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="p-6 bg-gray-50 dark:bg-gray-900 rounded-3xl border dark:border-gray-800 space-y-4">
            <h3 class="text-sm font-bold">Maintenance</h3>
            <p class="text-xs text-gray-500">Add example content to your library for testing.</p>
            <button 
              @click="createSampleChat"
              class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-xl text-xs font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <FlaskConical class="w-4 h-4" />
              Create Sample Chat
            </button>
          </div>

          <div class="p-6 bg-red-50/50 dark:bg-red-900/10 rounded-3xl border border-red-100 dark:border-red-900/20 space-y-4">
            <h3 class="text-sm font-bold text-red-600 dark:text-red-400">Destructive Actions</h3>
            <p class="text-xs text-red-500/70">Wipe all local data and configurations.</p>
            <button 
              @click="handleResetData"
              class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-xl text-xs font-bold hover:bg-red-700 transition-colors shadow-lg shadow-red-500/20"
            >
              <Trash2 class="w-4 h-4" />
              Reset All App Data
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- Floating Save Button for Mobile -->
    <div class="md:hidden sticky bottom-4 px-4 pb-4">
      <button 
        @click="handleSave"
        :disabled="!hasChanges"
        class="w-full flex items-center justify-center gap-2 py-4 bg-blue-600 text-white font-bold rounded-2xl shadow-2xl shadow-blue-500/40 disabled:opacity-50"
      >
        <Save class="w-5 h-5" />
        <span>{{ saveSuccess ? 'Saved Changes!' : 'Save Settings' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Scrollbar styling for a cleaner look */
::-webkit-scrollbar {
  width: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.3);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.5);
}
</style>
