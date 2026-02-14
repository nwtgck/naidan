<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { transformersJsService } from '../services/transformers-js';
import { 
  Loader2, CheckCircle2, AlertCircle, Download, FolderOpen, RefreshCcw, Trash2, 
  ChevronDown, Plus, HardDriveDownload, X, BrainCircuit, PowerOff, ExternalLink, Search, FileCode, RotateCcw
} from 'lucide-vue-next';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { checkOPFSSupport } from '../services/storage/opfs-detection';
import { computedAsync } from '@vueuse/core';

const { addToast } = useToast();
const { showConfirm } = useConfirm();

const emit = defineEmits<{
  (e: 'modelLoaded', modelId: string): void;
}>();

const status = ref(transformersJsService.getState().status);
const progress = ref(transformersJsService.getState().progress);
const error = ref(transformersJsService.getState().error);
const activeModelId = ref(transformersJsService.getState().activeModelId);
const device = ref(transformersJsService.getState().device);
const isCached = ref(transformersJsService.getState().isCached);
const isLoadingFromCache = ref(transformersJsService.getState().isLoadingFromCache);

const isFileUrl = typeof window !== 'undefined' && window.location.protocol === 'file:';
const isStandalone = __BUILD_MODE_IS_STANDALONE__;

const isOpfsSupported = computedAsync(
  () => checkOPFSSupport(),
  true // Assume supported initially
);

const defaultModels = [
  'HuggingFaceTB/SmolLM2-135M-Instruct',
  'HuggingFaceTB/SmolLM2-360M-Instruct',
  'HuggingFaceTB/SmolLM2-1.7B-Instruct',
  'HuggingFaceTB/SmolLM3-3B-ONNX',
  'onnx-community/Qwen2.5-0.5B-Instruct',
  'onnx-community/Qwen3-0.6B-ONNX',
  // 'onnx-community/Qwen3-1.7B-ONNX', // failed
  'onnx-community/Qwen3-4B-Instruct-2507-ONNX',
  'onnx-community/Llama-3.2-1B-Instruct',
  'onnx-community/gpt-oss-20b-ONNX',
];

const cachedModels = ref<Array<{ id: string; isLocal: boolean; size: number; fileCount: number; lastModified: number }>>([]);
const searchQuery = ref('');
const listSearchQuery = ref('');
const isDropdownOpen = ref(false);
const containerRef = ref<HTMLElement | null>(null);
const isImporting = ref(false);
const importProgress = ref(0);
const lastDownloadError = ref<string | null>(null);

let unsubscribe: (() => void) | null = null;

const refreshLocalModels = async () => {
  cachedModels.value = await transformersJsService.listCachedModels();
};

const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatDate = (timestamp: number) => {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp).toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const filteredPresets = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  
  // Filter out models that are already cached
  const cachedIds = new Set(cachedModels.value.map(m => m.id));
  const availablePresets = defaultModels.filter(m => {
    const hfId = `hf.co/${m}`;
    return !cachedIds.has(hfId) && !cachedIds.has(m);
  });

  return {
    recommended: availablePresets.filter(m => m.toLowerCase().includes(query)),
    showCustom: query.length > 0 && !defaultModels.some(m => m.toLowerCase() === query)
  };
});

const filteredCachedModels = computed(() => {
  const query = listSearchQuery.value.trim().toLowerCase();
  const models = query 
    ? cachedModels.value.filter(m => m.id.toLowerCase().includes(query))
    : [...cachedModels.value];
  
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return models.sort((a, b) => collator.compare(a.id, b.id));
});

const selectModelId = (id: string) => {
  searchQuery.value = id;
  isDropdownOpen.value = false;
};

const handleClickOutside = (event: MouseEvent) => {
  if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
    isDropdownOpen.value = false;
  }
};

onMounted(async () => {
  searchQuery.value = '';
  document.addEventListener('mousedown', handleClickOutside);
  await refreshLocalModels();
  unsubscribe = transformersJsService.subscribe((s, p, e, c, l) => {
    status.value = s;
    progress.value = p;
    error.value = e;
    isCached.value = c;
    isLoadingFromCache.value = l;
    activeModelId.value = transformersJsService.getState().activeModelId;
    device.value = transformersJsService.getState().device;
  });
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  if (unsubscribe) unsubscribe();
});

const loadModel = async (modelId: string) => {
  if (!modelId || isStandalone) return;
  lastDownloadError.value = null; // Clear previous download error when starting a fresh load
  try {
    await transformersJsService.loadModel(modelId);
    emit('modelLoaded', modelId);
  } catch (e) {
    // Error is handled via subscription
  }
};

const unloadModel = async () => {
  try {
    await transformersJsService.unloadModel();
    addToast({ message: 'Engine unloaded and resources released.' });
  } catch (err) {
    console.error('Unload failed:', err);
  }
};

const handleRestart = async () => {
  const confirmed = await showConfirm({
    title: 'Restart AI Engine',
    message: 'This will terminate the current background worker and start a fresh one. Use this if the engine becomes unresponsive or shows fatal errors.',
    confirmButtonText: 'Restart',
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await transformersJsService.restart();
    addToast({ message: 'AI Engine worker restarted successfully.' });
  } catch (err) {
    console.error('Restart failed:', err);
  }
};

const downloadModel = async () => {
  const modelId = searchQuery.value.trim();
  if (!modelId || isStandalone) return;
  
  lastDownloadError.value = null;
  // Checking if it is already cached
  const isAlreadyCached = cachedModels.value.some(m => m.id === modelId || m.id === `hf.co/${modelId}`);
  if (isAlreadyCached) {
    addToast({ message: 'Model is already downloaded.' });
    return;
  }

  try {
    await transformersJsService.downloadModel(modelId);
    await refreshLocalModels();
    addToast({ message: `Successfully downloaded: ${modelId}` });
    
    // Auto-load after download
    await loadModel(modelId);
  } catch (e) {
    lastDownloadError.value = e instanceof Error ? e.message : String(e);
  }
};

const deleteModel = async (modelId: string) => {
  const confirmed = await showConfirm({
    title: 'Delete Downloaded Model',
    message: `Are you sure you want to delete "${modelId}"? This will remove all associated files from the browser's local storage.`,
    confirmButtonText: 'Delete',
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await transformersJsService.deleteModel(modelId);
    addToast({ message: `Deleted model: ${modelId}` });
    await refreshLocalModels();
  } catch (err) {
    console.error('Delete failed:', err);
    addToast({ message: `Delete failed: ${err instanceof Error ? err.message : String(err)}` });
  }
};

const handleImportLocalModel = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;

  const files = Array.from(input.files);
  const firstFile = files[0];
  if (!firstFile) return;

  const relativePath = firstFile.webkitRelativePath;
  const pathSegments = relativePath.split('/');
  let modelName = pathSegments[0];

  // If the user selected a folder named 'models' or 'local', 
  // try to take the actual model name from the next level
  if ((modelName === 'models' || modelName === 'local') && pathSegments.length > 1) {
    modelName = pathSegments[1]!;
  }

  if (!modelName || modelName === 'models' || modelName === 'local') {
    addToast({ message: 'Could not determine a valid model name from folder structure.' });
    return;
  }

  isImporting.value = true;
  importProgress.value = 0;
  
  try {
    let completed = 0;
    for (const file of files) {
      const fileName = file.webkitRelativePath.substring(pathSegments[0]!.length + 1);
      if (!fileName) continue;
      await transformersJsService.importFile(modelName, fileName, file.stream());
      completed++;
      importProgress.value = Math.round((completed / files.length) * 100);
    }
    
    addToast({ message: `Successfully imported model: user/${modelName}` });
    await refreshLocalModels();
  } catch (err) {
    console.error('Import failed:', err);
    addToast({ message: `Import failed: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    isImporting.value = false;
    importProgress.value = 0;
    input.value = '';
  }
};


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="p-0 space-y-8">
    <!-- Standalone Mode Header Warning -->
    <div v-if="isStandalone" class="p-6 bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-3xl space-y-4 animate-in fade-in slide-in-from-top-2 duration-400">
      <div class="flex items-start gap-3 text-amber-700 dark:text-amber-400 leading-relaxed italic text-sm">
        <AlertCircle class="w-5 h-5 shrink-0 mt-0.5" />
        <p>
          In-browser AI (Transformers.js) is not available in the Standalone build due to browser restrictions on Web Workers and WebAssembly when running from a local file.
        </p>
      </div>
      <div class="flex justify-end border-t border-amber-200/30 dark:border-amber-900/20 pt-3">
        <a 
          href="https://github.com/nwtgck/naidan/releases" 
          target="_blank" 
          rel="noopener noreferrer"
          class="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold rounded-xl shadow-lg shadow-amber-500/20 transition-all active:scale-95"
        >
          <ExternalLink class="w-3.5 h-3.5" />
          Get Hosted Version (GitHub)
        </a>
      </div>
    </div>

    <!-- OPFS Support Warning -->
    <div v-else-if="!isOpfsSupported" class="p-6 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-3xl space-y-4 animate-in fade-in slide-in-from-top-2 duration-400">
      <div class="flex items-start gap-3 text-red-700 dark:text-red-400 leading-relaxed italic text-sm">
        <AlertCircle class="w-5 h-5 shrink-0 mt-0.5" />
        <p>
          In-browser AI (Transformers.js) is not available because the browser does not support or allow access to <strong>Origin Private File System (OPFS)</strong>, which is required for storing model files. 
          This often happens in private browsing modes or insecure contexts.
        </p>
      </div>
    </div>

    <div 
      class="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-400"
      :class="{ 'opacity-40 pointer-events-none grayscale select-none': isStandalone || !isOpfsSupported }"
    >
      <!-- Section 1: Model Downloader & Importer -->
      <section class="space-y-6">
        <div class="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-2">
            <HardDriveDownload class="w-5 h-5 text-purple-500" />
            <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Add New Models</h2>
          </div>
          <a 
            href="https://huggingface.co/onnx-community/models" 
            target="_blank" 
            rel="noopener noreferrer"
            class="flex items-center gap-1 text-[10px] font-bold text-purple-600 hover:text-purple-700 transition-colors uppercase tracking-wider"
          >
            Find more models
            <ExternalLink class="w-3 h-3" />
          </a>
        </div>

        <template v-if="!isStandalone">
          <!-- file:// Warning -->
          <div v-if="isFileUrl" class="flex items-start gap-3 p-5 bg-amber-50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-800/50 rounded-3xl text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
            <AlertCircle class="w-5 h-5 shrink-0 mt-0.5" />
            <p>
              <strong>Note:</strong> Browsers often disable the <strong>Cache API</strong> for local file URLs. To avoid downloading models on every reload, use a local web server or the hosted version.
            </p>
          </div>

          <div class="space-y-4">
            <div class="flex items-center justify-between ml-1">
              <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest">Download from Hugging Face</label>
            </div>
            <div class="flex flex-col sm:flex-row gap-3">
              <div class="relative flex-1 flex gap-2" ref="containerRef">
                <div class="relative flex-1">
                  <input 
                    v-model="searchQuery"
                    type="text"
                    placeholder="Enter Hugging Face model ID (e.g. onnx-community/phi-4)"
                    class="w-full pl-4 pr-10 py-3.5 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-2xl text-sm font-bold focus:ring-4 focus:ring-purple-500/10 outline-none text-gray-900 dark:text-gray-100 transition-all disabled:opacity-60"
                    @focus="isDropdownOpen = true"
                    @keydown.enter="downloadModel"
                  />
                  <button 
                    @click="isDropdownOpen = !isDropdownOpen"
                    class="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                    type="button"
                  >
                    <ChevronDown class="w-4 h-4 transition-transform duration-200" :class="{ 'rotate-180': isDropdownOpen }" />
                  </button>

                  <!-- Dropdown Menu -->
                  <div v-if="isDropdownOpen" class="absolute z-50 top-full mt-3 left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-3xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                    <div class="max-h-[320px] overflow-y-auto p-2 custom-scrollbar overscroll-contain">
                      <!-- Use Custom ID Option -->
                      <div v-if="filteredPresets.showCustom">
                        <button 
                          @click="selectModelId(searchQuery)"
                          class="w-full text-left px-4 py-3 rounded-2xl text-xs font-bold text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 flex items-center gap-2 border border-dashed border-purple-200 dark:border-purple-800/50 mb-2"
                        >
                          <Plus class="w-4 h-4" />
                          Use Custom ID: "{{ searchQuery }}"
                        </button>
                      </div>

                      <!-- Recommended Section -->
                      <div v-if="filteredPresets.recommended.length > 0">
                        <div class="px-4 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Preset Model Paths</div>
                        <button 
                          v-for="m in filteredPresets.recommended" 
                          :key="m"
                          @click="selectModelId(m)"
                          class="w-full text-left px-4 py-3 rounded-2xl text-xs font-medium hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                          :class="{ 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 font-bold': searchQuery === m }"
                        >
                          {{ m }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <button 
                @click="downloadModel" 
                :disabled="status === 'loading' || !searchQuery.trim()"
                class="flex items-center justify-center gap-2 px-8 py-3.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-2xl font-bold text-sm hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm active:scale-95 shrink-0"
              >
                <Download v-if="status !== 'loading'" class="w-4 h-4" />
                <Loader2 v-else class="w-4 h-4 animate-spin" />
                Download Model
              </button>
            </div>

            <!-- Contextual Progress for Download -->
            <div v-if="(status === 'loading' && !isLoadingFromCache) || lastDownloadError" class="animate-in fade-in slide-in-from-top-2 duration-300">
              <template v-if="lastDownloadError">
                <div class="p-4 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-2xl">
                  <div class="flex items-start gap-3">
                    <AlertCircle class="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                    <div class="flex-1 min-w-0">
                      <p class="text-xs font-bold text-red-800 dark:text-red-300 mb-1">Download Failed</p>
                      <p class="text-[11px] text-red-600/80 dark:text-red-400/80 leading-relaxed">{{ lastDownloadError }}</p>
                    </div>
                    <button @click="lastDownloadError = null" class="text-red-400 hover:text-red-600 transition-colors">
                      <X class="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="flex items-center justify-between mb-2 px-1">
                  <span class="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-widest flex items-center gap-2">
                    <Loader2 class="w-3 h-3 animate-spin" />
                    Downloading Assets...
                  </span>
                  <span class="text-xs font-bold text-gray-700 dark:text-gray-300">{{ progress }}%</span>
                </div>
                <div class="h-1.5 w-full bg-purple-100 dark:bg-purple-900/30 rounded-full overflow-hidden">
                  <div class="h-full bg-purple-600 dark:bg-purple-400 transition-all duration-300 ease-out" :style="{ width: progress + '%' }"></div>
                </div>
                <p class="text-[10px] text-gray-400 mt-2 ml-1 italic">Models are cached locally in the browser (OPFS) for offline use.</p>
              </template>
            </div>
          </div>
        </template>

        <!-- Local Import -->
        <div class="bg-gray-50/30 dark:bg-gray-800/20 p-8 rounded-3xl border border-dashed border-gray-200 dark:border-gray-700 space-y-6">
          <div class="text-center">
            <h3 class="text-sm font-bold text-gray-700 dark:text-gray-300">Import from Local Files</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">Select a folder containing ONNX model files to import it into the browser's storage.</p>
          </div>
          
          <div class="flex justify-center">
            <label class="flex items-center gap-2 px-6 py-3 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-purple-600 dark:text-purple-400 font-bold text-sm rounded-xl cursor-pointer transition-all border border-gray-200 dark:border-gray-700 shadow-sm active:scale-95">
              <FolderOpen class="w-5 h-5" />
              <span>Select Model Folder</span>
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
      </section>
      
      <!-- Section 2: Engine Status & Control -->
      <section class="space-y-6">
        <div class="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
          <div class="flex items-center gap-2">
            <BrainCircuit class="w-5 h-5 text-purple-500" />
            <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Engine Control</h2>
          </div>
          <button 
            @click="refreshLocalModels" 
            class="flex items-center gap-1.5 text-[10px] font-bold text-purple-600 hover:text-purple-700 transition-colors uppercase tracking-wider"
          >
            <RefreshCcw class="w-3 h-3" :class="{ 'animate-spin': isImporting }" />
            Refresh
          </button>
        </div>

        <!-- Status Card -->
        <div class="rounded-3xl border border-gray-200 dark:border-gray-700 p-6" 
             :class="{
               'bg-gray-50/50 dark:bg-gray-800/30': status === 'idle',
               'bg-blue-50/50 dark:bg-blue-900/10 border-blue-200/50 dark:border-blue-800/50': status === 'loading',
               'bg-green-50/50 dark:bg-green-900/10 border-green-200/50 dark:border-green-800/50': status === 'ready',
               'bg-red-50/50 dark:bg-red-900/10 border-red-200/50 dark:border-red-800/50': status === 'error'
             }">
          <div class="flex items-start gap-4">
            <div class="mt-1">
              <Loader2 v-if="status === 'loading' || isImporting" class="w-6 h-6 animate-spin text-blue-600 dark:text-blue-400" />
              <CheckCircle2 v-else-if="status === 'ready'" class="w-6 h-6 text-green-600 dark:text-green-400" />
              <AlertCircle v-else-if="status === 'error'" class="w-6 h-6 text-red-600 dark:text-red-400" />
              <div v-else class="w-6 h-6 rounded-full border-2 border-gray-300 dark:border-gray-600"></div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between mb-2">
                <h4 class="font-bold text-base text-gray-900 dark:text-gray-100">
                  <template v-if="isImporting">Importing Local Model... {{ importProgress }}%</template>
                  <template v-else>
                    {{ status === 'idle' ? 'Engine Idle' : 
                      status === 'loading' ? 'Initializing Engine...' : 
                      status === 'ready' ? 'Engine Ready' : 'Error' }}
                  </template>
                </h4>
                <div class="flex items-center gap-2 shrink-0">
                  <span v-if="(status === 'loading' || status === 'ready') && (isLoadingFromCache || activeModelId?.startsWith('user/'))" class="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                    Local Cache
                  </span>
                  <span v-if="status === 'ready'" class="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                    {{ device }}
                  </span>
                  <button 
                    v-if="status === 'ready'"
                    @click="unloadModel"
                    class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                    title="Unload model and release resources"
                  >
                    <PowerOff class="w-4 h-4" />
                  </button>
                  <button 
                    @click="handleRestart"
                    class="p-1.5 text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-all"
                    title="Hard restart AI worker engine"
                  >
                    <RotateCcw class="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                <template v-if="isImporting">Writing model files to browser-local storage (OPFS)...</template>
                <template v-else>
                  {{ status === 'idle' ? 'Load a model from the list below to start in-browser inference.' :
                    status === 'loading' ? (isLoadingFromCache ? `Loading from local storage... ${progress > 0 ? progress + '%' : ''}` : `Downloading and compiling... ${progress}%`) :
                    status === 'ready' ? `Active Model: ${activeModelId}` : 
                    (lastDownloadError ? 'Download failed. Check details in the section below.' : error) }}
                </template>
              </p>
              
              <!-- Progress Bar -->
              <div v-if="status === 'loading' || isImporting" class="mt-5 h-2 w-full bg-blue-200 dark:bg-blue-900/50 rounded-full overflow-hidden">
                <div class="h-full bg-blue-600 dark:bg-blue-400 transition-all duration-300 ease-out" :style="{ width: (isImporting ? importProgress : progress) + '%' }"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Cached Models List -->
        <div class="space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 ml-1">
            <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest shrink-0">Downloaded Models</h3>
            <div class="relative flex-1 max-w-sm">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input 
                v-model="listSearchQuery"
                type="text"
                placeholder="Filter downloaded models..."
                class="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl text-xs font-bold focus:ring-4 focus:ring-purple-500/10 outline-none text-gray-900 dark:text-gray-100 transition-all"
              />
            </div>
          </div>

          <div v-if="filteredCachedModels.length > 0" class="max-h-[400px] overflow-y-auto pr-2 custom-scrollbar -mr-2 overscroll-contain">
            <div class="grid grid-cols-1 gap-2 pb-1">
              <div 
                v-for="model in filteredCachedModels" 
                :key="model.id"
                class="flex items-center justify-between p-3 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-sm hover:border-purple-200 dark:hover:border-purple-900/50 transition-all group relative"
              >
                <div class="flex-1 min-w-0 mr-4">
                  <div class="flex items-center gap-2 mb-0.5">
                    <span class="text-xs font-bold text-gray-800 dark:text-gray-200 truncate">{{ model.id }}</span>
                  </div>
                  <div class="flex items-center gap-3 text-[9px] text-gray-400 font-bold uppercase tracking-tight">
                    <span class="flex items-center gap-1">
                      <HardDriveDownload class="w-2.5 h-2.5" />
                      {{ formatSize(model.size) }}
                    </span>
                    <span class="flex items-center gap-1">
                      <FileCode class="w-2.5 h-2.5" />
                      {{ model.fileCount }}
                    </span>
                    <span v-if="model.lastModified">
                      {{ formatDate(model.lastModified) }}
                    </span>
                  </div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button 
                    @click="loadModel(model.id)"
                    :disabled="status === 'loading' || activeModelId === model.id"
                    class="px-3 py-1.5 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-lg text-[10px] font-bold hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-all disabled:opacity-50"
                  >
                    {{ activeModelId === model.id ? 'Active' : 'Load' }}
                  </button>
                  <button 
                    @click="deleteModel(model.id)"
                    class="p-1.5 text-gray-400 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                    title="Delete model"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="p-12 text-center bg-gray-50/50 dark:bg-gray-800/20 border border-dashed border-gray-200 dark:border-gray-700 rounded-3xl">
            <p class="text-sm text-gray-400 italic">
              {{ listSearchQuery ? 'No models match your filter.' : 'No models downloaded yet.' }}
            </p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.3);
  border-radius: 10px;
}
</style>