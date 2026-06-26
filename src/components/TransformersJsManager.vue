<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { transformersJsService } from '@/services/transformers-js';
import type { ProgressInfo } from '@/services/transformers-js/types';
import {
  Loader2Icon, CheckCircle2Icon, AlertCircleIcon, DownloadIcon, FolderOpenIcon, RefreshCcwIcon, Trash2Icon,
  ChevronDownIcon, PlusIcon, HardDriveDownloadIcon, XIcon, BrainCircuitIcon, PowerOffIcon, ExternalLinkIcon, SearchIcon, FileCodeIcon, RotateCcwIcon,
} from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import { computedAsync } from '@vueuse/core';

const { addToast } = useToast();
const { showConfirm } = useConfirm();

const emit = defineEmits<{
  (e: 'modelLoaded', modelId: string): void,
}>();

const status = ref(transformersJsService.getState().status);
const progress = ref(transformersJsService.getState().progress);
const progressItems = ref<ReadonlyMap<string, ProgressInfo>>(transformersJsService.getState().progressItems);
const progressItemEntries = computed(() => [...progressItems.value.entries()]);
const totalLoadedAmount = ref(transformersJsService.getState().totalLoadedAmount);
const totalSizeAmount = ref(transformersJsService.getState().totalSizeAmount);
const error = ref(transformersJsService.getState().error);
const activeModelId = ref(transformersJsService.getState().activeModelId);
const device = ref(transformersJsService.getState().device);
const isCached = ref(transformersJsService.getState().isCached);
const isLoadingFromCache = ref(transformersJsService.getState().isLoadingFromCache);

const isFileUrl = typeof window !== 'undefined' && window.location.protocol === 'file:';
const isStandalone = __BUILD_MODE_IS_STANDALONE__;

const isOpfsSupported = computedAsync(
  () => checkOPFSSupport(),
  true, // Assume supported initially
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
  'onnx-community/gemma-4-E2B-it-ONNX',
  'onnx-community/Llama-3.2-1B-Instruct',
  'onnx-community/gpt-oss-20b-ONNX',
];

const cachedModels = ref<Array<{ id: string, isLocal: boolean, size: number, fileCount: number, lastModified: number, isComplete: boolean }>>([]);
const searchQuery = ref('');
const listSearchQuery = ref('');
const isDropdownOpen = ref(false);
const isDetailsExpanded = ref(true);
const containerRef = ref<HTMLElement | null>(null);
const isImporting = ref(false);
const importProgress = ref(0);
const lastDownloadError = ref<string | null>(null);

let unsubscribe: (() => void) | null = null;
let unsubscribeList: (() => void) | null = null;

const refreshLocalModels = async () => {
  cachedModels.value = await transformersJsService.listCachedModels();
};

const formatSize = ({ bytes }: { bytes: number }) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
};

const formatDate = ({ timestamp }: { timestamp: number }) => {
  if (!timestamp) return lazyStrings.TransformersJsManager__unknown();
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
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
    showCustom: query.length > 0 && !defaultModels.some(m => m.toLowerCase() === query),
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

const selectModelId = ({ id }: { id: string }) => {
  searchQuery.value = id;
  isDropdownOpen.value = false;
};

const handleClickOutside = ({ event }: { event: MouseEvent }) => {
  if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
    isDropdownOpen.value = false;
  }
};

useEventTargetListener(document, 'mousedown', (event) => handleClickOutside({ event }));

onMounted(async () => {
  searchQuery.value = '';
  await refreshLocalModels();
  unsubscribe = transformersJsService.subscribe({ listener: ({ status: s, progress: p, error: e, isCached: c, isLoadingFromCache: l, progressItems: items }) => {
    status.value = s;
    progress.value = p;
    error.value = e;
    isCached.value = c;
    isLoadingFromCache.value = l;
    progressItems.value = items;
    const state = transformersJsService.getState();
    activeModelId.value = state.activeModelId;
    device.value = state.device;
    totalLoadedAmount.value = state.totalLoadedAmount;
    totalSizeAmount.value = state.totalSizeAmount;
  } });
  unsubscribeList = transformersJsService.subscribeModelList({ listener: () => {
    refreshLocalModels();
  } });
});

onUnmounted(() => {
  if (unsubscribe) unsubscribe();
  if (unsubscribeList) unsubscribeList();
});

const loadModel = async ({ modelId }: { modelId: string }) => {
  if (!modelId || isStandalone) return;
  lastDownloadError.value = null; // Clear previous download error when starting a fresh load
  try {
    await transformersJsService.loadModel({ modelId });
    emit('modelLoaded', modelId);
  } catch (e) {
    // Error is handled via subscription
  }
};

const unloadModel = async () => {
  try {
    await transformersJsService.unloadModel();
    addToast({ message: await ensureStrings.TransformersJsManager__engine_unloaded_and_resources_released() });
  } catch (err) {
    console.error('Unload failed:', err);
  }
};

const handleRestart = async () => {
  const confirmed = await showConfirm({
    title: await ensureStrings.TransformersJsManager__restart_ai_engine(),
    message: await ensureStrings.TransformersJsManager__this_will_terminate_the_current_background_worker_and_start_a_fresh_one_use_this_if_the_engine_becomes_unresponsive_or_shows_fatal_errors(),
    confirmButtonText: await ensureStrings.TransformersJsManager__restart(),
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await transformersJsService.restart();
    addToast({ message: await ensureStrings.TransformersJsManager__ai_engine_worker_restarted_successfully() });
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
    addToast({ message: await ensureStrings.TransformersJsManager__model_is_already_downloaded() });
    return;
  }

  try {
    await transformersJsService.downloadModel({ modelId });
    await refreshLocalModels();
    addToast({ message: await ensureStrings.TransformersJsManager__successfully_downloaded_model({ modelId }) });

    // Auto-load after download
    await loadModel({ modelId });
  } catch (e) {
    lastDownloadError.value = e instanceof Error ? e.message : String(e);
  }
};

const deleteModel = async ({ modelId }: { modelId: string }) => {
  const confirmed = await showConfirm({
    title: await ensureStrings.TransformersJsManager__delete_downloaded_model(),
    message: await ensureStrings.TransformersJsManager__delete_model_warning({ modelId }),
    confirmButtonText: await ensureStrings.TransformersJsManager__delete(),
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await transformersJsService.deleteModel({ modelId });
    addToast({ message: await ensureStrings.TransformersJsManager__deleted_model({ modelId }) });
    await refreshLocalModels();
  } catch (err) {
    console.error('Delete failed:', err);
    addToast({ message: await ensureStrings.TransformersJsManager__delete_failed({ errorMessage: err instanceof Error ? err.message : String(err) }) });
  }
};

const handleImportLocalModel = async ({ event }: { event: Event }) => {
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
    addToast({ message: await ensureStrings.TransformersJsManager__could_not_determine_a_valid_model_name_from_folder_structure() });
    return;
  }

  isImporting.value = true;
  importProgress.value = 0;

  try {
    let completed = 0;
    for (const file of files) {
      const fileName = file.webkitRelativePath.substring(pathSegments[0]!.length + 1);
      if (!fileName) continue;
      await transformersJsService.importFile({ modelName, fileName, data: file.stream() });
      completed++;
      importProgress.value = Math.round((completed / files.length) * 100);
    }

    addToast({ message: await ensureStrings.TransformersJsManager__successfully_imported_model({ modelId: `user/${modelName}` }) });
    await refreshLocalModels();
  } catch (err) {
    console.error('Import failed:', err);
    addToast({ message: await ensureStrings.TransformersJsManager__import_failed({ errorMessage: err instanceof Error ? err.message : String(err) }) });
  } finally {
    isImporting.value = false;
    importProgress.value = 0;
    input.value = '';
  }
};


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="p-0 space-y-8">
    <!-- Standalone Mode Header Warning -->
    <div v-if="isStandalone" class="p-6 bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-3xl space-y-4 animate-in fade-in slide-in-from-top-2 duration-400">
      <div class="flex items-start gap-3 text-amber-700 dark:text-amber-400 leading-relaxed italic text-sm">
        <AlertCircleIcon class="w-5 h-5 shrink-0 mt-0.5" />
        <p>
          {{ lazyStrings.TransformersJsManager__in_browser_ai_transformers_js_is_not_available_in_the_standalone_build_due_to_browser_restrictions_on_web_workers_and_webassembly_when_running_from_a_local_file() }}
        </p>
      </div>
      <div class="flex justify-end border-t border-amber-200/30 dark:border-amber-900/20 pt-3">
        <a
          href="https://github.com/nwtgck/naidan/releases"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold rounded-xl shadow-lg shadow-amber-500/20 transition-all active:scale-95"
        >
          <ExternalLinkIcon class="w-3.5 h-3.5" />
          {{ lazyStrings.TransformersJsManager__get_hosted_version_github() }}
        </a>
      </div>
    </div>

    <!-- OPFS Support Warning -->
    <div v-else-if="!isOpfsSupported" class="p-6 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-3xl space-y-4 animate-in fade-in slide-in-from-top-2 duration-400">
      <div class="flex items-start gap-3 text-red-700 dark:text-red-400 leading-relaxed italic text-sm">
        <AlertCircleIcon class="w-5 h-5 shrink-0 mt-0.5" />
        <p>
          {{ lazyStrings.TransformersJsManager__in_browser_ai_transformers_js_is_not_available_because_the_browser_does_not_support_or_allow_access_to() }} <strong>{{ lazyStrings.TransformersJsManager__origin_private_file_system_opfs() }}</strong>{{ lazyStrings.TransformersJsManager__which_is_required_for_storing_model_files_this_often_happens_in_private_browsing_modes_or_insecure_contexts() }}
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
            <HardDriveDownloadIcon class="w-5 h-5 text-purple-500" />
            <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.TransformersJsManager__add_new_models() }}</h2>
          </div>
          <a
            href="https://huggingface.co/onnx-community/models"
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-1 text-[10px] font-bold text-purple-600 hover:text-purple-700 transition-colors uppercase tracking-wider"
          >
            {{ lazyStrings.TransformersJsManager__find_more_models() }}
            <ExternalLinkIcon class="w-3 h-3" />
          </a>
        </div>

        <template v-if="!isStandalone">
          <!-- file:// Warning -->
          <div v-if="isFileUrl" class="flex items-start gap-3 p-5 bg-amber-50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-800/50 rounded-3xl text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
            <AlertCircleIcon class="w-5 h-5 shrink-0 mt-0.5" />
            <p>
              <strong>{{ lazyStrings.TransformersJsManager__note() }}</strong> {{ lazyStrings.TransformersJsManager__browsers_often_disable_the() }} <strong>{{ lazyStrings.TransformersJsManager__cache_api() }}</strong> {{ lazyStrings.TransformersJsManager__for_local_file_urls_to_avoid_downloading_models_on_every_reload_use_a_local_web_server_or_the_hosted_version() }}
            </p>
          </div>

          <div class="space-y-4">
            <div class="flex items-center justify-between ml-1">
              <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.TransformersJsManager__download_from_hugging_face() }}</label>
            </div>
            <div class="flex flex-col sm:flex-row gap-3">
              <div class="relative flex-1 flex gap-2" ref="containerRef">
                <div class="relative flex-1">
                  <input
                    v-model="searchQuery"
                    type="text"
                    :placeholder="lazyStrings.TransformersJsManager__enter_hugging_face_model_id_e_g_onnx_community_phi_4()"
                    class="w-full pl-4 pr-10 py-3.5 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-2xl text-sm font-bold focus:ring-4 focus:ring-purple-500/10 outline-none text-gray-900 dark:text-gray-100 transition-all disabled:opacity-60"
                    @focus="isDropdownOpen = true"
                    @keydown.enter="downloadModel"
                  />
                  <button
                    @click="isDropdownOpen = !isDropdownOpen"
                    class="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                    type="button"
                  >
                    <ChevronDownIcon class="w-4 h-4 transition-transform duration-200" :class="{ 'rotate-180': isDropdownOpen }" />
                  </button>

                  <!-- Dropdown Menu -->
                  <div v-if="isDropdownOpen" class="absolute z-50 top-full mt-3 left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-3xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                    <div class="max-h-[320px] overflow-y-auto p-2 custom-scrollbar overscroll-contain">
                      <!-- Use Custom ID Option -->
                      <div v-if="filteredPresets.showCustom">
                        <button
                          @click="selectModelId({ id: searchQuery })"
                          class="w-full text-left px-4 py-3 rounded-2xl text-xs font-bold text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 flex items-center gap-2 border border-dashed border-purple-200 dark:border-purple-800/50 mb-2"
                        >
                          <PlusIcon class="w-4 h-4" />
                          {{ lazyStrings.TransformersJsManager__use_custom_id({ modelId: searchQuery }) }}
                        </button>
                      </div>

                      <!-- Recommended Section -->
                      <div v-if="filteredPresets.recommended.length > 0">
                        <div class="px-4 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.TransformersJsManager__preset_model_paths() }}</div>
                        <button
                          v-for="m in filteredPresets.recommended"
                          :key="m"
                          @click="selectModelId({ id: m })"
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
                <DownloadIcon v-if="status !== 'loading'" class="w-4 h-4" />
                <Loader2Icon v-else class="w-4 h-4 animate-spin" />
                {{ lazyStrings.TransformersJsManager__download_model() }}
              </button>
            </div>

            <!-- Contextual Progress for Download -->
            <div v-if="(status === 'loading' && !isLoadingFromCache) || lastDownloadError" class="animate-in fade-in slide-in-from-top-2 duration-300">
              <template v-if="lastDownloadError">
                <div class="p-4 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-2xl">
                  <div class="flex items-start gap-3">
                    <AlertCircleIcon class="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                    <div class="flex-1 min-w-0">
                      <p class="text-xs font-bold text-red-800 dark:text-red-300 mb-1">{{ lazyStrings.TransformersJsManager__download_failed() }}</p>
                      <p class="text-[11px] text-red-600/80 dark:text-red-400/80 leading-relaxed">{{ lastDownloadError }}</p>
                    </div>
                    <button @click="lastDownloadError = null" class="text-red-400 hover:text-red-600 transition-colors">
                      <XIcon class="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="flex items-center justify-between mb-2 px-1">
                  <span class="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-widest flex items-center gap-2">
                    <Loader2Icon class="w-3 h-3 animate-spin" />
                    {{ lazyStrings.TransformersJsManager__overall_progress() }}
                  </span>
                  <div class="flex flex-col items-end">
                    <span class="text-xs font-bold text-gray-700 dark:text-gray-300">{{ progress }}%</span>
                    <span v-if="totalLoadedAmount > 0" class="text-[8px] text-gray-400 font-bold uppercase tabular-nums">
                      {{ formatSize({ bytes: totalLoadedAmount }) }} / {{ formatSize({ bytes: totalSizeAmount }) }}
                    </span>
                  </div>
                </div>
                <div class="h-1.5 w-full bg-purple-100 dark:bg-purple-900/30 rounded-full overflow-hidden">
                  <div class="h-full bg-purple-600 dark:bg-purple-400 transition-all duration-300 ease-out" :style="{ width: progress + '%' }"></div>
                </div>

                <!-- Detailed File Progress -->
                <div v-if="progressItems.size > 0" class="mt-4 border-t border-gray-100 dark:border-gray-800 pt-3 animate-in fade-in duration-500">
                  <button
                    @click="isDetailsExpanded = !isDetailsExpanded"
                    class="flex items-center gap-1.5 text-[9px] font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors uppercase tracking-widest mb-3"
                  >
                    <ChevronDownIcon class="w-2.5 h-2.5 transition-transform" :class="{ '-rotate-90': !isDetailsExpanded }" />
                    {{ lazyStrings.TransformersJsManager__asset_details() }}
                  </button>

                  <div v-if="isDetailsExpanded" class="space-y-3 ml-1 border-l-2 border-gray-50 dark:border-gray-800/50 pl-3">
                    <template v-for="[fileName, info] in progressItemEntries" :key="fileName">
                      <div v-if="info.progress !== undefined && info.progress < 100" class="space-y-1.5">
                        <div class="flex justify-between text-[8px] font-medium tracking-tight">
                          <div class="flex flex-col min-w-0">
                            <span class="text-gray-500 truncate" :title="String(fileName)">{{ fileName }}</span>
                            <span v-if="info.loaded !== undefined" class="text-[7px] text-gray-400 font-bold uppercase tabular-nums">
                              {{ formatSize({ bytes: info.loaded }) }} / {{ info.total ? formatSize({ bytes: info.total }) : '??' }}
                            </span>
                          </div>
                          <span class="text-purple-500/70 shrink-0 self-start">{{ Math.round(info.progress) }}%</span>
                        </div>
                        <div class="h-0.5 w-full bg-gray-100 dark:bg-gray-800/50 rounded-full overflow-hidden">
                          <div
                            class="h-full bg-purple-400/40 dark:bg-purple-500/30 transition-all duration-300"
                            :style="{ width: info.progress + '%' }"
                          ></div>
                        </div>
                      </div>
                    </template>
                  </div>
                </div>

                <p class="text-[10px] text-gray-400 mt-2 ml-1 italic">{{ lazyStrings.TransformersJsManager__models_are_cached_locally_in_the_browser_opfs_for_offline_use() }}</p>
              </template>
            </div>
          </div>
        </template>

        <!-- Local Import -->
        <div class="bg-gray-50/30 dark:bg-gray-800/20 p-8 rounded-3xl border border-dashed border-gray-200 dark:border-gray-700 space-y-6">
          <div class="text-center">
            <h3 class="text-sm font-bold text-gray-700 dark:text-gray-300">{{ lazyStrings.TransformersJsManager__import_from_local_files() }}</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">{{ lazyStrings.TransformersJsManager__select_a_folder_containing_onnx_model_files_to_import_it_into_the_browsers_storage() }}</p>
          </div>

          <div class="flex justify-center">
            <label class="flex items-center gap-2 px-6 py-3 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-purple-600 dark:text-purple-400 font-bold text-sm rounded-xl cursor-pointer transition-all border border-gray-200 dark:border-gray-700 shadow-sm active:scale-95">
              <FolderOpenIcon class="w-5 h-5" />
              <span>{{ lazyStrings.TransformersJsManager__select_model_folder() }}</span>
              <input
                type="file"
                class="hidden"
                webkitdirectory
                @change="handleImportLocalModel({ event: $event })"
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
            <BrainCircuitIcon class="w-5 h-5 text-purple-500" />
            <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.TransformersJsManager__engine_control() }}</h2>
          </div>
          <button
            @click="refreshLocalModels"
            class="flex items-center gap-1.5 text-[10px] font-bold text-purple-600 hover:text-purple-700 transition-colors uppercase tracking-wider"
          >
            <RefreshCcwIcon class="w-3 h-3" :class="{ 'animate-spin': isImporting }" />
            {{ lazyStrings.TransformersJsManager__refresh() }}
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
              <Loader2Icon v-if="status === 'loading' || isImporting" class="w-6 h-6 animate-spin text-blue-600 dark:text-blue-400" />
              <CheckCircle2Icon v-else-if="status === 'ready'" class="w-6 h-6 text-green-600 dark:text-green-400" />
              <AlertCircleIcon v-else-if="status === 'error'" class="w-6 h-6 text-red-600 dark:text-red-400" />
              <div v-else class="w-6 h-6 rounded-full border-2 border-gray-300 dark:border-gray-600"></div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between mb-2">
                <h4 class="font-bold text-base text-gray-900 dark:text-gray-100">
                  <template v-if="isImporting">{{ lazyStrings.TransformersJsManager__importing_local_model({ progress: importProgress }) }}</template>
                  <template v-else>
                    {{ status === 'idle' ? lazyStrings.TransformersJsManager__engine_idle() :
                      status === 'loading' ? lazyStrings.TransformersJsManager__initializing_engine() :
                      status === 'ready' ? lazyStrings.TransformersJsManager__engine_ready() : lazyStrings.TransformersJsManager__error() }}
                  </template>
                </h4>
                <div class="flex items-center gap-2 shrink-0">
                  <span v-if="(status === 'loading' || status === 'ready') && (isLoadingFromCache || activeModelId?.startsWith('user/'))" class="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                    {{ lazyStrings.TransformersJsManager__local_cache() }}
                  </span>
                  <span v-if="status === 'ready'" class="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                    {{ device }}
                  </span>
                  <button
                    v-if="status === 'ready'"
                    @click="unloadModel"
                    class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                    :title="lazyStrings.TransformersJsManager__unload_model_and_release_resources()"
                  >
                    <PowerOffIcon class="w-4 h-4" />
                  </button>
                  <button
                    @click="handleRestart"
                    class="p-1.5 text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-all"
                    :title="lazyStrings.TransformersJsManager__hard_restart_ai_worker_engine()"
                  >
                    <RotateCcwIcon class="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                <template v-if="isImporting">{{ lazyStrings.TransformersJsManager__writing_model_files_to_browser_local_storage_opfs() }}</template>
                <template v-else>
                  {{ status === 'idle' ? lazyStrings.TransformersJsManager__load_a_model_from_the_list_below_to_start_in_browser_inference() :
                    status === 'loading' ? (isLoadingFromCache ? lazyStrings.TransformersJsManager__loading_from_local_storage({ progress }) : lazyStrings.TransformersJsManager__downloading_and_compiling({ progress })) :
                    status === 'ready' ? lazyStrings.TransformersJsManager__active_model({ modelId: activeModelId }) :
                    (lastDownloadError ? lazyStrings.TransformersJsManager__download_failed_check_details_in_the_section_below() : error) }}
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
            <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest shrink-0">{{ lazyStrings.TransformersJsManager__downloaded_models() }}</h3>
            <div class="relative flex-1 max-w-sm">
              <SearchIcon class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                v-model="listSearchQuery"
                type="text"
                :placeholder="lazyStrings.TransformersJsManager__filter_downloaded_models()"
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
                      <HardDriveDownloadIcon class="w-2.5 h-2.5" />
                      {{ formatSize({ bytes: model.size }) }}
                    </span>
                    <span class="flex items-center gap-1">
                      <FileCodeIcon class="w-2.5 h-2.5" />
                      {{ model.fileCount }}
                    </span>
                    <span v-if="model.lastModified">
                      {{ formatDate({ timestamp: model.lastModified }) }}
                    </span>
                  </div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <span v-if="!model.isComplete" class="px-2 py-0.5 rounded-lg text-[8px] font-bold uppercase bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-300 border border-amber-200 dark:border-amber-800 mr-1">
                    {{ lazyStrings.TransformersJsManager__incomplete() }}
                  </span>
                  <button
                    @click="loadModel({ modelId: model.id })"
                    :disabled="status === 'loading' || activeModelId === model.id"
                    class="px-3 py-1.5 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-lg text-[10px] font-bold hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-all disabled:opacity-50"
                  >
                    {{ activeModelId === model.id ? lazyStrings.TransformersJsManager__active() : (model.isComplete ? lazyStrings.TransformersJsManager__load() : lazyStrings.TransformersJsManager__resume()) }}
                  </button>
                  <button
                    @click="deleteModel({ modelId: model.id })"
                    class="p-1.5 text-gray-400 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                    :title="lazyStrings.TransformersJsManager__delete_model()"
                  >
                    <Trash2Icon class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="p-12 text-center bg-gray-50/50 dark:bg-gray-800/20 border border-dashed border-gray-200 dark:border-gray-700 rounded-3xl">
            <p class="text-sm text-gray-400 italic">
              {{ listSearchQuery ? lazyStrings.TransformersJsManager__no_models_match_your_filter() : lazyStrings.TransformersJsManager__no_models_downloaded_yet() }}
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
