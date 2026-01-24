<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { transformerService } from '../services/transformer-js';
import { Loader2, CheckCircle2, AlertCircle, Download, Power, FolderOpen, RefreshCcw, Trash2 } from 'lucide-vue-next';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';

const { addToast } = useToast();
const { showConfirm } = useConfirm();
const status = ref(transformerService.getState().status);
const progress = ref(transformerService.getState().progress);
const error = ref(transformerService.getState().error);
const activeModelId = ref(transformerService.getState().activeModelId);
const device = ref(transformerService.getState().device);
const isCached = ref(transformerService.getState().isCached);
const isLoadingFromCache = ref(transformerService.getState().isLoadingFromCache);

const isFileUrl = typeof window !== 'undefined' && window.location.protocol === 'file:';
const isStandalone = __BUILD_MODE_IS_STANDALONE__;

const defaultModels = [
  'onnx-community/Qwen2.5-0.5B-Instruct',
  'onnx-community/SmolLM2-135M-Instruct',
  'onnx-community/SmolLM2-360M-Instruct',
  'onnx-community/TinyLlama-1.1B-Chat-v1.0',
  'onnx-community/Llama-3.2-1B-Instruct',
  'onnx-community/phi-4',
  'Xenova/Qwen1.5-0.5B-Chat',
];

const localModels = ref<string[]>([]);
const selectedModel = ref(defaultModels[0]);
const isImporting = ref(false);
const importProgress = ref(0);

let unsubscribe: (() => void) | null = null;

const refreshLocalModels = async () => {
  localModels.value = await transformerService.listLocalModels();
};

onMounted(async () => {
  await refreshLocalModels();
  unsubscribe = transformerService.subscribe((s, p, e, c, l) => {
    status.value = s;
    progress.value = p;
    error.value = e;
    isCached.value = c;
    isLoadingFromCache.value = l;
    activeModelId.value = transformerService.getState().activeModelId;
    device.value = transformerService.getState().device;
  });
});

onUnmounted(() => {
  if (unsubscribe) unsubscribe();
});

const loadModel = async () => {
  if (!selectedModel.value || isStandalone) return;
  try {
    await transformerService.loadModel(selectedModel.value);
  } catch (e) {
    // Error is handled via subscription
  }
};

const deleteSelectedModel = async () => {
  if (!selectedModel.value || !selectedModel.value.startsWith('local/')) return;
  
  const confirmed = await showConfirm({
    title: 'Delete Local Model',
    message: `Are you sure you want to delete "${selectedModel.value}"? This will remove all associated files from your browser's local storage.`,
    confirmButtonText: 'Delete',
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await transformerService.deleteModel(selectedModel.value);
    addToast({ message: `Deleted model: ${selectedModel.value}` });
    await refreshLocalModels();
    selectedModel.value = defaultModels[0];
  } catch (err) {
    console.error('Delete failed:', err);
    addToast({ message: `Delete failed: ${err instanceof Error ? err.message : String(err)}` });
  }
};

const handleImportLocalModel = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;

  const files = Array.from(input.files);
  // Get the model name from the directory name (the first part of the relative path)
  const firstFile = files[0];
  if (!firstFile) return;

  const relativePath = firstFile.webkitRelativePath;
  const modelName = relativePath.split('/')[0];

  if (!modelName) {
    addToast({ message: 'Could not determine model name from folder.' });
    return;
  }

  isImporting.value = true;
  importProgress.value = 0;
  
  try {
    let completed = 0;
    for (const file of files) {
      // The file name should be relative to the model folder
      const fileName = file.webkitRelativePath.substring(modelName.length + 1);
      if (!fileName) continue; // Skip the directory entry itself if present

      // Use file.stream() for memory-efficient streaming to OPFS
      await transformerService.importFile(modelName, fileName, file.stream());
      completed++;
      importProgress.value = Math.round((completed / files.length) * 100);
    }
    
    addToast({ message: `Successfully imported model: local/${modelName}` });
    await refreshLocalModels();
    selectedModel.value = `local/${modelName}`;
  } catch (err) {
    console.error('Import failed:', err);
    addToast({ message: `Import failed: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    isImporting.value = false;
    importProgress.value = 0;
    input.value = ''; // Reset input
  }
};
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-2">
        <div class="p-1.5 bg-purple-100 dark:bg-purple-900/30 rounded-lg text-purple-600 dark:text-purple-400">
          <Power class="w-4 h-4" />
        </div>
        <h3 class="text-sm font-bold text-gray-700 dark:text-gray-200 uppercase tracking-widest">
          Browser AI Manager (Transformers.js)
        </h3>
      </div>
      <button 
        @click="refreshLocalModels" 
        class="p-1.5 text-gray-400 hover:text-purple-500 transition-colors rounded-lg hover:bg-purple-50 dark:hover:bg-purple-900/20"
        title="Refresh local model list"
      >
        <RefreshCcw class="w-4 h-4" :class="{ 'animate-spin': isImporting }" />
      </button>
    </div>

    <!-- Status Card -->
    <div class="rounded-2xl border border-gray-200 dark:border-gray-700 p-5" 
         :class="{
           'bg-gray-50/50 dark:bg-gray-800/30': status === 'idle',
           'bg-blue-50/50 dark:bg-blue-900/10 border-blue-200/50 dark:border-blue-800/50': status === 'loading',
           'bg-green-50/50 dark:bg-green-900/10 border-green-200/50 dark:border-green-800/50': status === 'ready',
           'bg-red-50/50 dark:bg-red-900/10 border-red-200/50 dark:border-red-800/50': status === 'error'
         }">
      <div class="flex items-start gap-4">
        <div class="mt-1">
          <Loader2 v-if="status === 'loading' || isImporting" class="w-5 h-5 animate-spin text-blue-600 dark:text-blue-400" />
          <CheckCircle2 v-else-if="status === 'ready'" class="w-5 h-5 text-green-600 dark:text-green-400" />
          <AlertCircle v-else-if="status === 'error'" class="w-5 h-5 text-red-600 dark:text-red-400" />
          <div v-else class="w-5 h-5 rounded-full border-2 border-gray-300 dark:border-gray-600"></div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1.5">
            <h4 class="font-bold text-sm text-gray-900 dark:text-gray-100">
              <template v-if="isImporting">Importing Local Model... {{ importProgress }}%</template>
              <template v-else>
                {{ status === 'idle' ? 'Engine Idle' : 
                  status === 'loading' ? 'Initializing Engine...' : 
                  status === 'ready' ? 'Engine Ready' : 'Error' }}
              </template>
            </h4>
            <div class="flex items-center gap-1.5 shrink-0">
              <span v-if="(status === 'loading' || status === 'ready') && (isLoadingFromCache || activeModelId?.startsWith('local/'))" class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                Local Cache
              </span>
              <span v-if="status === 'ready'" class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                {{ device }}
              </span>
            </div>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            <template v-if="isImporting">Writing model files to browser-local storage (OPFS)...</template>
            <template v-else>
              {{ status === 'idle' ? 'Select a model to initialize the in-browser inference engine.' :
                status === 'loading' ? (isLoadingFromCache ? `Loading from local storage... ${progress}%` : `Downloading and compiling WebAssembly modules... ${progress}%`) :
                status === 'ready' ? `Active Model: ${activeModelId}` : error }}
            </template>
          </p>
          
          <!-- Progress Bar -->
          <div v-if="status === 'loading' || isImporting" class="mt-4 h-1.5 w-full bg-blue-200 dark:bg-blue-900/50 rounded-full overflow-hidden">
            <div class="h-full bg-blue-600 dark:bg-blue-400 transition-all duration-300 ease-out" :style="{ width: (isImporting ? importProgress : progress) + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Standalone mode info -->
    <div v-if="isStandalone" class="p-4 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-2xl text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed italic">
      <AlertCircle class="w-4 h-4 inline-block mr-1 -mt-0.5" />
      Browser AI is currently only available in Hosted mode (when served via a web server).
    </div>

    <template v-else>
      <!-- file:// Warning -->
      <div v-if="isFileUrl" class="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-800/50 rounded-2xl text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
        <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
        <p>
          <strong>Note:</strong> Browsers often disable the <strong>Cache API</strong> for local file URLs. To avoid downloading models on every reload, use a local web server.
        </p>
      </div>

      <!-- Model Selection & Load Button -->
      <div class="space-y-4">
        <div class="flex flex-col sm:flex-row gap-3">
          <div class="relative flex-1 flex gap-2">
            <div class="relative flex-1">
              <select v-model="selectedModel" 
                      class="w-full pl-3 pr-10 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-sm font-bold focus:ring-4 focus:ring-purple-500/10 outline-none appearance-none text-gray-900 dark:text-gray-100 transition-all disabled:opacity-60"
                      :disabled="status === 'loading' || isImporting">
                <optgroup label="Hugging Face Hub">
                  <option v-for="m in defaultModels" :key="m" :value="m">{{ m }}</option>
                </optgroup>
                <optgroup v-if="localModels.length > 0" label="Imported (Local)">
                  <option v-for="m in localModels" :key="m" :value="m">{{ m }}</option>
                </optgroup>
              </select>
              <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-gray-400">
                <svg class="h-4 w-4 fill-current" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
              </div>
            </div>
            <button 
              v-if="selectedModel?.startsWith('local/')"
              @click="deleteSelectedModel"
              class="p-3 bg-red-50 dark:bg-red-900/20 text-red-500 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors border border-red-100 dark:border-red-900/30"
              title="Delete local model"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
          <button 
            @click="loadModel" 
            :disabled="status === 'loading' || isImporting || (status === 'ready' && activeModelId === selectedModel)"
            class="flex items-center justify-center gap-2 px-6 py-3 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl font-bold text-sm hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm active:scale-95 shrink-0">
            <Download v-if="status !== 'loading' && !isImporting" class="w-4 h-4" />
            <Loader2 v-else class="w-4 h-4 animate-spin" />
            {{ status === 'ready' && activeModelId === selectedModel ? 'Loaded' : 'Initialize Engine' }}
          </button>
        </div>

        <!-- Local Import Button -->
        <div class="flex justify-center">
          <label class="flex items-center gap-2 px-4 py-2 text-xs font-bold text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg cursor-pointer transition-all border border-dashed border-purple-200 dark:border-purple-800/50">
            <FolderOpen class="w-4 h-4" />
            <span>Import Model from Local Folder</span>
            <input 
              type="file" 
              class="hidden" 
              webkitdirectory 
              @change="handleImportLocalModel"
              :disabled="isImporting || status === 'loading'"
            />
          </label>
        </div>
      </div>
    </template>
  </div>
</template>