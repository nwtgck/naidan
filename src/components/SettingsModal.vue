<script setup lang="ts">
import { ref, watch } from 'vue';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import { X, Loader2, FlaskConical, Trash2 } from 'lucide-vue-next';

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
  emit('close');
}

// Watch for modal open to reset form
watch(() => props.isOpen, (open) => {
  if (open) {
    form.value = { ...settings.value };
    fetchModels();
  }
});

// Watch for endpoint changes to refresh models
watch(() => [form.value.endpointType, form.value.endpointUrl], () => {
    // Debounce or just wait for user action? 
    // Let's add a button to refresh or do it on blur.
    // Doing it automatically might spam.
});

</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white dark:bg-gray-800 rounded-lg w-full max-w-md p-6 shadow-xl relative text-gray-900 dark:text-gray-100">
      <button 
        @click="emit('close')"
        class="absolute right-4 top-4 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <X class="w-5 h-5" />
      </button>

      <h2 class="text-xl font-bold mb-6">Settings</h2>

      <div class="space-y-4">
        <!-- Endpoint Type -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Provider</label>
          <select 
            v-model="form.endpointType"
            class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700"
            @change="fetchModels"
            data-testid="setting-provider-select"
          >
            <option value="openai">OpenAI Compatible</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>

        <!-- Endpoint URL -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Endpoint URL</label>
          <div class="flex gap-2">
            <input 
              v-model="form.endpointUrl"
              type="text"
              class="flex-1 border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700"
              placeholder="http://localhost:11434"
              data-testid="setting-url-input"
            />
            <button 
              @click="fetchModels"
              class="px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
              title="Refresh Models"
              data-testid="setting-refresh-models"
            >
              <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin" />
              <span v-else>Refresh</span>
            </button>
          </div>
          <p v-if="error" class="text-red-500 text-xs mt-1">{{ error }}</p>
        </div>

        <!-- Model Selection -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default Model</label>
          <select 
            v-model="form.defaultModelId"
            class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700"
            data-testid="setting-model-select"
          >
            <option v-if="availableModels.length === 0" :value="form.defaultModelId">{{ form.defaultModelId || 'Custom' }}</option>
            <option v-for="m in availableModels" :key="m" :value="m">
              {{ m }}
            </option>
          </select>
        </div>

        <!-- Title Model Selection -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">Title Generation Model</label>
            <div class="flex items-center gap-2">
              <input 
                type="checkbox" 
                id="autoTitleEnabled" 
                v-model="form.autoTitleEnabled"
                class="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                data-testid="setting-auto-title-checkbox"
              >
              <label for="autoTitleEnabled" class="text-xs text-gray-500 dark:text-gray-400">Enabled</label>
            </div>
          </div>
          <select 
            v-model="form.titleModelId"
            :disabled="!form.autoTitleEnabled"
            class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="setting-title-model-select"
          >
            <option :value="undefined">Use Current Chat Model</option>
            <option v-for="m in availableModels" :key="m" :value="m">
              {{ m }}
            </option>
          </select>
          <p class="text-[10px] text-gray-500 mt-1">Automatically generates a title after the first response.</p>
        </div>

        <!-- Storage Type -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Storage Location</label>
          <select 
            v-model="form.storageType"
            class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700"
            data-testid="setting-storage-select"
          >
            <option value="local">Browser Local Storage</option>
            <option value="opfs">Origin Private File System (OPFS)</option>
          </select>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Switching storage will hide chats from the previous location.
          </p>
        </div>

        <div class="border-t dark:border-gray-700 pt-4 space-y-2">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Debug / Development</label>
          <button 
            @click="chatStore.createSampleChat(); emit('close')"
            class="w-full flex items-center justify-center gap-2 px-4 py-2 border border-dashed border-gray-300 dark:border-gray-600 rounded text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            data-testid="setting-create-sample-button"
          >
            <FlaskConical class="w-4 h-4" />
            Create Comprehensive Sample Chat
          </button>
          <button 
            @click="handleResetData"
            class="w-full flex items-center justify-center gap-2 px-4 py-2 border border-red-200 dark:border-red-900/30 rounded text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
            data-testid="setting-reset-data-button"
          >
            <Trash2 class="w-4 h-4" />
            Reset All App Data
          </button>
        </div>
      </div>

      <div class="mt-8 flex justify-end gap-2">
        <button 
          @click="emit('close')"
          class="px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          data-testid="setting-cancel-button"
        >
          Cancel
        </button>
        <button 
          @click="handleSave"
          class="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
          data-testid="setting-save-button"
        >
          Save Changes
        </button>
      </div>
    </div>
  </div>
</template>
