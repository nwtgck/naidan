<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  XIcon, UploadIcon, DownloadIcon, FileArchiveIcon,
  CheckCircle2Icon, AlertTriangleIcon, Loader2Icon,
  RefreshCwIcon, CopyPlusIcon, ArrowRightIcon,
  DatabaseIcon, Settings2Icon, FolderInputIcon,
} from 'lucide-vue-next';
import { ImportExportService } from '@/features/import-export/service';
import { storageService } from '@/00-storage/service';
import { useToast } from '@/composables/useToast';
import type {
  ExportOptions,
  ImportConfig,
  ImportPreview,
} from '@/features/import-export/types';
import { useExportExclusions } from '@/features/import-export/composables/useExportExclusions';
import { lazyStrings, ensureStrings } from '@/strings';

const props = defineProps<{
  isOpen: boolean,
}>();

const emit = defineEmits<{
  (e: 'close'): void,
}>();

const service = new ImportExportService({ storage: storageService });
const { addToast } = useToast();

/**
 * Directional icons chosen based on data flow relative to the application:
 * - Export: Sending data OUT of the app (represented by Upload/Up arrow)
 * - Import: Bringing data IN to the app (represented by Download/Down arrow)
 */
const ExportIcon = UploadIcon;
const ImportIcon = DownloadIcon;

// --- State ---
const mode = ref<'menu' | 'export' | 'import_preview' | 'import_config' | 'processing'>('menu');
const processingMessage = ref('');
const error = ref<string | null>(null);

// Export State
const exportName = ref('');
const {
  excludeChats,
  excludeChatHistory,
  excludeAttachments,
  excludeChatHistoryDisabled,
  buildExcludeList,
  reset: resetExportExclusions,
} = useExportExclusions();
const previewFilename = computed(() => {
  const dateStr = new Date().toISOString().split('T')[0];
  // eslint-disable-next-line no-control-regex
  const sanitized = exportName.value.replace(/[/?%*:|"<>\x00-\x1F]/g, '_').trim();
  const midSegment = sanitized ? `-${sanitized}` : '';
  return `naidan-data${midSegment}-${dateStr}.zip`;
});

// Import State
const selectedFile = ref<File | null>(null);
const importPreview = ref<ImportPreview | null>(null);

// Default configurations
const APPEND_DEFAULT_CONFIG: ImportConfig = {
  settings: {
    endpoint: 'none',
    model: 'none',
    titleModel: 'none',
    systemPrompt: 'none',
    lmParameters: 'none',
    providerProfiles: 'append',
  },
  data: {
    mode: 'append',
    chatTitlePrefix: '',
    chatGroupNamePrefix: '',
  },
};

const REPLACE_DEFAULT_CONFIG: ImportConfig = {
  settings: {
    endpoint: 'replace',
    model: 'replace',
    titleModel: 'replace',
    systemPrompt: 'replace',
    lmParameters: 'replace',
    providerProfiles: 'replace',
  },
  data: {
    mode: 'replace',
  },
};

const importConfig = ref<ImportConfig>(JSON.parse(JSON.stringify(APPEND_DEFAULT_CONFIG)));

// Computed to determine if the current config matches a preset
const activePreset = computed(() => {
  const c = importConfig.value;

  const isAppendPreset =
      c.data.mode === 'append' &&
      c.settings.endpoint === 'none' &&
      c.settings.model === 'none' &&
      c.settings.titleModel === 'none' &&
      c.settings.systemPrompt === 'none' &&
      c.settings.lmParameters === 'none' &&
      c.settings.providerProfiles === 'append';

  const isReplacePreset =
      c.data.mode === 'replace' &&
      c.settings.endpoint === 'replace' &&
      c.settings.model === 'replace' &&
      c.settings.titleModel === 'replace' &&
      c.settings.systemPrompt === 'replace' &&
      c.settings.lmParameters === 'replace' &&
      c.settings.providerProfiles === 'replace';

  if (isAppendPreset) return 'append';
  if (isReplacePreset) return 'replace';
  return 'custom';
});

function applyPreset({ preset }: { preset: 'append' | 'replace' }) {
  switch (preset) {
  case 'append':
    importConfig.value = JSON.parse(JSON.stringify(APPEND_DEFAULT_CONFIG));
    break;
  case 'replace':
    importConfig.value = JSON.parse(JSON.stringify(REPLACE_DEFAULT_CONFIG));
    break;
  default: {
    const _ex: never = preset;
    throw new Error(`Unhandled preset: ${_ex}`);
  }
  }
}

// --- Actions ---

function resetState() {
  mode.value = 'menu';
  processingMessage.value = '';
  error.value = null;
  selectedFile.value = null;
  importPreview.value = null;
  exportName.value = '';
  resetExportExclusions();
  importConfig.value = JSON.parse(JSON.stringify(APPEND_DEFAULT_CONFIG));
}

function buildExportExclude(): ExportOptions['exclude'] {
  const exclude = buildExcludeList();
  return exclude.length === 0 ? undefined : exclude;
}

// Reset state when modal visibility changes to ensure a clean start
watch(() => props.isOpen, (isOpen) => {
  if (isOpen) {
    resetState();
  }
});

async function handleExport() {
  mode.value = 'processing';
  processingMessage.value = await ensureStrings.ImportExportModal__compressing_data();
  error.value = null;

  try {
    const exclude = buildExportExclude();
    const { stream, filename } = await service.exportData({
      fileNameSegment: exportName.value.trim(),
      ...(exclude === undefined ? {} : { exclude }),
    });

    const newResponse = new Response(stream);
    const blob = await newResponse.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addToast({ message: await ensureStrings.ImportExportModal__export_successful(), duration: 3000 });
    emit('close');
  } catch (e) {
    error.value = e instanceof Error ? e.message : await ensureStrings.ImportExportModal__export_failed();
    mode.value = 'export';
  }
}

async function handleFileSelect({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  if (!file) return;

  selectedFile.value = file;

  mode.value = 'processing';
  processingMessage.value = await ensureStrings.ImportExportModal__analyzing_file();
  error.value = null;

  try {
    importPreview.value = await service.analyze({ zipFile: file });
    mode.value = 'import_preview';
  } catch (e) {
    error.value = e instanceof Error ? e.message : await ensureStrings.ImportExportModal__failed_to_analyze_file();
    mode.value = 'menu';
  } finally {
    target.value = '';
  }
}

async function handleImportExecute() {
  const file = selectedFile.value;
  if (!file) return;

  mode.value = 'processing';
  processingMessage.value = await ensureStrings.ImportExportModal__verifying_integrity();
  error.value = null;

  try {
    // 1. Verify before destructive restore
    await service.verify({ zipFile: file, config: importConfig.value });

    // 2. Execute
    processingMessage.value = await ensureStrings.ImportExportModal__importing_data();
    await service.executeImport({ zipFile: file, config: importConfig.value });

    addToast({ message: await ensureStrings.ImportExportModal__import_successful(), duration: 3000 });

    setTimeout(() => {
      window.location.reload();
    }, 1000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : await ensureStrings.ImportExportModal__import_failed();
    mode.value = 'import_config';
  }
}



defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4 transition-all">
      <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 animate-in fade-in zoom-in-95 duration-200 overflow-hidden relative">

        <!-- Close Button -->
        <button
          @click="emit('close')"
          class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <!-- Header -->
        <div class="p-6 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div class="flex items-center gap-3">
            <div class="p-2.5 bg-blue-50 dark:bg-blue-900/20 rounded-xl text-blue-600 dark:text-blue-400">
              <FolderInputIcon class="w-6 h-6" />
            </div>
            <div>
              <h2 class="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
                {{ lazyStrings.ImportExportModal__import_export() }}
                <span class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">{{ lazyStrings.ImportExportModal__experimental() }}</span>
              </h2>
              <p class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__portable_data() }}</p>
            </div>
          </div>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto p-6 overscroll-contain">

          <!-- Error Message -->
          <div v-if="error" class="mb-6 p-4 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-2xl flex items-start gap-3">
            <AlertTriangleIcon class="w-5 h-5 text-red-500 shrink-0" />
            <div class="flex-1">
              <h4 class="text-sm font-bold text-red-800 dark:text-red-400">{{ lazyStrings.ImportExportModal__error() }}</h4>
              <p class="text-xs text-red-600 dark:text-red-300 mt-1">{{ error }}</p>
            </div>
          </div>

          <!-- MENU MODE -->
          <div v-if="mode === 'menu'" class="grid grid-cols-1 md:grid-cols-2 gap-6 h-full">
            <!-- Export Card -->
            <div
              data-testid="import-export-export-card"
              class="p-6 rounded-3xl border-2 border-gray-100 dark:border-gray-800 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50/10 dark:hover:bg-blue-900/5 transition-all cursor-pointer group flex flex-col gap-4"
              @click="mode = 'export'"
            >
              <div class="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-2xl w-fit text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">
                <component :is="ExportIcon" class="w-6 h-6" />
              </div>
              <div>
                <h3 class="text-lg font-bold text-gray-800 dark:text-white text-left">{{ lazyStrings.ImportExportModal__export() }}</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed text-left">{{ lazyStrings.ImportExportModal__download_full_backup() }}</p>
              </div>
            </div>

            <!-- Import Card -->
            <label class="p-6 rounded-3xl border-2 border-gray-100 dark:border-gray-800 hover:border-green-500 dark:hover:border-green-500 hover:bg-green-50/10 dark:hover:bg-green-900/5 transition-all cursor-pointer group flex flex-col gap-4 relative">
              <input type="file" accept=".zip" class="hidden" @change="handleFileSelect({ event: $event })" />
              <div class="p-3 bg-green-100 dark:bg-green-900/30 rounded-2xl w-fit text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
                <component :is="ImportIcon" class="w-6 h-6" />
              </div>
              <div>
                <h3 class="text-lg font-bold text-gray-800 dark:text-white text-left">{{ lazyStrings.ImportExportModal__import() }}</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed text-left">{{ lazyStrings.ImportExportModal__upload_backup_to_restore_or_merge() }}</p>
              </div>
            </label>
          </div>

          <!-- EXPORT MODE -->
          <div v-if="mode === 'export'" class="space-y-8">
            <div class="bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/20 p-6 rounded-2xl flex flex-col items-center text-center gap-4">
              <div class="p-3 bg-white dark:bg-gray-800 rounded-full shadow-sm text-blue-600 dark:text-blue-400">
                <FileArchiveIcon class="w-8 h-8" />
              </div>
              <div class="space-y-1">
                <h3 class="text-lg font-bold text-gray-800 dark:text-white">{{ lazyStrings.ImportExportModal__ready_to_export() }}</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ lazyStrings.ImportExportModal__zip_contains_all_data_by_default() }}</p>
              </div>

              <div class="w-full space-y-3 pt-2">
                <div class="space-y-1.5 text-left max-w-sm mx-auto">
                  <label class="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ImportExportModal__filename_tag_optional() }}</label>
                  <input
                    v-model="exportName"
                    type="text"
                    :placeholder="lazyStrings.ImportExportModal__filename_tag_example()"
                    class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-xs font-bold focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  />
                </div>

                <div class="mt-4 flex flex-wrap justify-center gap-4">
                  <label class="flex items-center gap-2 cursor-pointer group">
                    <input
                      v-model="excludeChats"
                      data-testid="export-exclude-chats-checkbox"
                      type="checkbox"
                      class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
                    />
                    <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.ImportExportModal__exclude_chats() }}</span>
                  </label>
                  <label
                    class="flex items-center gap-2 group"
                    :class="excludeChatHistoryDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
                  >
                    <input
                      v-model="excludeChatHistory"
                      :disabled="excludeChatHistoryDisabled"
                      data-testid="export-exclude-chat-history-checkbox"
                      type="checkbox"
                      class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700 disabled:cursor-not-allowed"
                    />
                    <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.ImportExportModal__exclude_chat_history() }}</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer group">
                    <input
                      v-model="excludeAttachments"
                      data-testid="export-exclude-attachments-checkbox"
                      type="checkbox"
                      class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
                    />
                    <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.ImportExportModal__exclude_attachments() }}</span>
                  </label>
                </div>

                <div class="flex flex-col items-center gap-4">
                  <div class="w-full max-w-md bg-gray-100 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-3 flex flex-col gap-1.5 shadow-inner">
                    <span class="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] text-center">{{ lazyStrings.ImportExportModal__output_filename() }}</span>
                    <p class="text-xs font-mono font-bold text-blue-600 dark:text-blue-400 break-all text-center">
                      {{ previewFilename }}
                    </p>
                  </div>

                  <button
                    data-testid="import-export-export-now-button"
                    class="w-full sm:w-auto px-10 py-4 rounded-2xl font-black bg-blue-600 hover:bg-blue-700 text-white shadow-xl shadow-blue-500/20 transition-all active:scale-95 flex items-center justify-center gap-3"
                    @click="handleExport"
                  >
                    <component :is="ExportIcon" class="w-6 h-6" />
                    {{ lazyStrings.ImportExportModal__export_now() }}
                  </button>
                </div>
              </div>
            </div>

            <div class="flex justify-start pt-4 border-t border-gray-100 dark:border-gray-800">
              <button @click="mode = 'menu'" class="px-4 py-2 text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                {{ lazyStrings.ImportExportModal__back_to_menu() }}
              </button>
            </div>
          </div>

          <!-- IMPORT PREVIEW MODE -->
          <div v-if="mode === 'import_preview' && importPreview" class="space-y-6">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.chatGroupsCount }}</div>
                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__groups() }}</div>
              </div>
              <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.chatsCount }}</div>
                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__chats() }}</div>
              </div>
              <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.attachmentsCount }}</div>
                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__files() }}</div>
              </div>
              <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.providerProfilesCount }}</div>
                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__profiles() }}</div>
              </div>
            </div>

            <div class="max-h-60 overflow-y-auto p-4 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-2 overscroll-contain">
              <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest sticky top-0 bg-white dark:bg-gray-900 pb-2">{{ lazyStrings.ImportExportModal__content_preview() }}</h4>
              <div v-for="(item, idx) in importPreview.items" :key="idx" class="text-sm">
                <div v-if="item.type === 'chat_group'" class="font-bold text-blue-600 dark:text-blue-400 flex items-center gap-2">
                  <FolderInputIcon class="w-4 h-4" /> {{ item.data.name }} ({{ lazyStrings.ImportExportModal__chat_count({ count: item.data.items.length }) }})
                </div>
                <div v-else class="pl-6 text-gray-600 dark:text-gray-300 flex items-center gap-2">
                  <div class="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600"></div>
                  {{ item.data.title || lazyStrings.ImportExportModal__untitled_chat() }}
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-4">
              <button @click="resetState" class="px-6 py-2.5 rounded-xl font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{{ lazyStrings.ImportExportModal__cancel() }}</button>
              <button @click="mode = 'import_config'" class="px-8 py-2.5 rounded-xl font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20 transition-all active:scale-95 flex items-center gap-2">
                {{ lazyStrings.ImportExportModal__next() }}
                <ArrowRightIcon class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- IMPORT CONFIG MODE -->
          <div v-if="mode === 'import_config'" class="space-y-8">

            <!-- Data Strategy -->
            <section class="space-y-4">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                  <DatabaseIcon class="w-4 h-4 text-blue-500" />
                  {{ lazyStrings.ImportExportModal__mode_and_data_strategy() }}
                </h3>
                <div class="flex gap-2">
                  <button v-if="activePreset === 'custom'"
                          @click="applyPreset({ preset: importConfig.data.mode })"
                          class="text-[9px] font-black uppercase tracking-widest bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-800/50 hover:bg-amber-200 transition-colors">
                    {{ lazyStrings.ImportExportModal__custom_click_to_reset() }}
                  </button>
                  <span v-else class="text-[9px] font-black uppercase tracking-widest bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full border border-blue-200 dark:border-blue-800/50">
                    {{ activePreset === 'append' ? lazyStrings.ImportExportModal__append_preset() : lazyStrings.ImportExportModal__restore_preset() }}
                  </span>
                </div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label class="cursor-pointer p-4 rounded-2xl border-2 transition-all flex flex-col gap-2"
                       :class="activePreset === 'append' ? 'border-blue-500 bg-blue-50/20 dark:bg-blue-900/10' : 'border-gray-100 dark:border-gray-800 hover:border-blue-300'">
                  <div class="flex items-center justify-between">
                    <div class="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                      <CopyPlusIcon class="w-4 h-4" /> {{ lazyStrings.ImportExportModal__append_merge() }}
                    </div>
                    <input type="radio" :checked="activePreset === 'append'" @change="applyPreset({ preset: 'append' })" class="w-4 h-4 accent-blue-600" />
                  </div>
                  <p class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__append_keeps_current_data() }}</p>
                </label>

                <label class="cursor-pointer p-4 rounded-2xl border-2 transition-all flex flex-col gap-2"
                       :class="activePreset === 'replace' ? 'border-blue-500 bg-blue-50/20 dark:bg-blue-900/10' : 'border-gray-100 dark:border-gray-800 hover:border-blue-300'">
                  <div class="flex items-center justify-between">
                    <div class="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                      <RefreshCwIcon class="w-4 h-4" /> {{ lazyStrings.ImportExportModal__replace_restore() }}
                    </div>
                    <input type="radio" :checked="activePreset === 'replace'" @change="applyPreset({ preset: 'replace' })" class="w-4 h-4 accent-blue-600" />
                  </div>
                  <p class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__replace_clears_current_data() }}</p>
                </label>
              </div>

              <!-- Prefix Inputs (Only for Append) -->
              <div v-if="importConfig.data.mode === 'append'" class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl space-y-4 animate-in fade-in slide-in-from-top-2">
                <div class="grid grid-cols-2 gap-4">
                  <div class="space-y-1">
                    <label class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__chat_title_prefix() }}</label>
                    <input v-model="importConfig.data.chatTitlePrefix" class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs font-bold" />
                  </div>
                  <div class="space-y-1">
                    <label class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__group_name_prefix() }}</label>
                    <input v-model="importConfig.data.chatGroupNamePrefix" class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs font-bold" />
                  </div>
                </div>
              </div>
            </section>

            <!-- Settings Strategy -->
            <section class="space-y-4">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                  <Settings2Icon class="w-4 h-4 text-blue-500" />
                  {{ lazyStrings.ImportExportModal__settings_and_profiles() }}
                </h3>
              </div>

              <div v-if="importPreview?.stats.hasSettings" class="space-y-3 p-4 border border-gray-100 dark:border-gray-700 rounded-2xl flex flex-col gap-1">
                <!-- Endpoint -->
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__url_and_http_headers() }}</span>
                  <select v-model="importConfig.settings.endpoint" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- Default Model -->
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__default_model() }}</span>
                  <select v-model="importConfig.settings.model" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- Title Model -->
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__title_generation_model() }}</span>
                  <select v-model="importConfig.settings.titleModel" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- Profiles -->
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__provider_profiles() }}</span>
                  <select v-model="importConfig.settings.providerProfiles" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="append">{{ lazyStrings.ImportExportModal__add_new() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__ignore() }}</option>
                  </select>
                </div>

                <!-- System Prompt -->
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__global_system_prompt() }}</span>
                  <select v-model="importConfig.settings.systemPrompt" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- LM Parameters -->
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__lm_parameters() }}</span>
                  <select v-model="importConfig.settings.lmParameters" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>
              </div>
              <div v-else class="p-6 border-2 border-dashed border-gray-100 dark:border-gray-800 rounded-2xl text-center">
                <p class="text-xs font-bold text-gray-400">{{ lazyStrings.ImportExportModal__no_settings_or_profiles() }}</p>
              </div>
            </section>

            <div class="flex justify-end gap-3 pt-4">
              <button @click="mode = 'import_preview'" class="px-6 py-2.5 rounded-xl font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{{ lazyStrings.ImportExportModal__back() }}</button>
              <button
                @click="handleImportExecute"
                class="px-8 py-2.5 rounded-xl font-bold text-white shadow-lg transition-all active:scale-95 flex items-center gap-2 bg-blue-600 hover:bg-blue-700 shadow-blue-500/20"
              >
                <CheckCircle2Icon class="w-4 h-4" />
                {{ lazyStrings.ImportExportModal__import() }}
              </button>
            </div>
          </div>

          <!-- PROCESSING MODE -->
          <div v-if="mode === 'processing'" class="h-full flex flex-col items-center justify-center space-y-6 min-h-[300px]">
            <Loader2Icon class="w-12 h-12 text-blue-600 animate-spin" />
            <p class="text-sm font-bold text-gray-500 dark:text-gray-400 animate-pulse">{{ processingMessage }}</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
