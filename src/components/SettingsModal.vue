<script setup lang="ts">
import { ref, watch } from 'vue';
import { useSettings } from '../composables/useSettings';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { X, Loader2 } from 'lucide-vue-next';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const { settings, save } = useSettings();

const form = ref({ ...settings.value });
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);
const error = ref<string | null>(null);

async function fetchModels() {
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
    <div class="bg-white rounded-lg w-full max-w-md p-6 shadow-xl relative">
      <button 
        @click="emit('close')"
        class="absolute right-4 top-4 text-gray-500 hover:text-gray-700"
      >
        <X class="w-5 h-5" />
      </button>

      <h2 class="text-xl font-bold mb-6">Settings</h2>

      <div class="space-y-4">
        <!-- Endpoint Type -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">API Provider</label>
          <select 
            v-model="form.endpointType"
            class="w-full border rounded px-3 py-2 bg-white"
            @change="fetchModels"
          >
            <option value="openai">OpenAI Compatible</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>

        <!-- Endpoint URL -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Endpoint URL</label>
          <div class="flex gap-2">
            <input 
              v-model="form.endpointUrl"
              type="text"
              class="flex-1 border rounded px-3 py-2"
              placeholder="http://localhost:11434"
            />
            <button 
              @click="fetchModels"
              class="px-3 py-2 bg-gray-100 rounded hover:bg-gray-200"
              title="Refresh Models"
            >
              <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin" />
              <span v-else>Refresh</span>
            </button>
          </div>
          <p v-if="error" class="text-red-500 text-xs mt-1">{{ error }}</p>
        </div>

        <!-- Model Selection -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Default Model</label>
          <select 
            v-model="form.defaultModelId"
            class="w-full border rounded px-3 py-2 bg-white"
          >
            <option v-if="availableModels.length === 0" :value="form.defaultModelId">{{ form.defaultModelId || 'Custom' }}</option>
            <option v-for="m in availableModels" :key="m" :value="m">
              {{ m }}
            </option>
          </select>
        </div>

        <!-- Storage Type -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Storage Location</label>
          <select 
            v-model="form.storageType"
            class="w-full border rounded px-3 py-2 bg-white"
          >
            <option value="local">Browser Local Storage</option>
            <option value="opfs">Origin Private File System (OPFS)</option>
          </select>
          <p class="text-xs text-gray-500 mt-1">
            Switching storage will hide chats from the previous location.
          </p>
        </div>

        <!-- Debug Mode -->
        <div class="flex items-center gap-2">
          <input 
            type="checkbox" 
            id="debugMode" 
            v-model="form.debugMode"
            class="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          >
          <label for="debugMode" class="text-sm font-medium text-gray-700">Enable Debug Mode</label>
        </div>
      </div>

      <div class="mt-8 flex justify-end gap-2">
        <button 
          @click="emit('close')"
          class="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
        >
          Cancel
        </button>
        <button 
          @click="handleSave"
          class="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
        >
          Save Changes
        </button>
      </div>
    </div>
  </div>
</template>
