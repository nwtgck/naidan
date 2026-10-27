<script setup lang="ts">
import { downloadReadableStream } from '@/utils/stream-download';
import { ref, computed, nextTick, watch, onBeforeUnmount, useId, useTemplateRef } from 'vue';
import {
  XIcon, UploadIcon, DownloadIcon, FileArchiveIcon,
  CheckCircle2Icon, AlertTriangleIcon, Loader2Icon,
  RefreshCwIcon, CopyPlusIcon, CopyIcon, ArrowRightIcon,
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
import type { ImportExportInitialMode } from '@/features/import-export/composables/useImportExportModal';
import { lazyStrings, ensureStrings } from '@/strings';
import ActionButton from '@/components/ActionButton.vue';
import { decodeZipBase64, encodeZipStreamAsBase64 } from '@/features/import-export/zip-base64';

const props = defineProps<{
  isOpen: boolean,
  initialMode: ImportExportInitialMode,
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
const mode = ref<'menu' | 'export' | 'import_base64' | 'import_preview' | 'import_config' | 'processing'>(props.initialMode);
const modalPanel = useTemplateRef<HTMLElement>('modal-panel');
const processingMessage = ref('');
const error = ref<string | null>(null);

// Export State
let exportAbort: AbortController | undefined;
let base64Abort: AbortController | undefined;
let base64Revision = 0;
let importRevision = 0;
let disposed = false;
const preparedBase64 = ref<string | undefined>(undefined);
const base64Operation = ref<'generating' | 'copying' | undefined>(undefined);
const base64Notice = ref<'copied' | 'generate-failed' | 'copy-failed' | undefined>(undefined);
const pastedBase64 = ref('');
const pastedBase64Error = ref(false);
const pastedBase64Id = useId();
onBeforeUnmount(() => {
  disposed = true;
  exportAbort?.abort();
  clearBase64Export();
  importRevision++;
  pastedBase64.value = '';
  selectedFile.value = null;
  importPreview.value = null;
});
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

  if (isAppendPreset) {
    return 'append';
  }
  if (isReplacePreset) {
    return 'replace';
  }
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
  clearBase64Export();
  importRevision++;
  pastedBase64.value = '';
  pastedBase64Error.value = false;
  mode.value = 'menu';
  processingMessage.value = '';
  error.value = null;
  selectedFile.value = null;
  importPreview.value = null;
  exportName.value = '';
  resetExportExclusions();
  importConfig.value = JSON.parse(JSON.stringify(APPEND_DEFAULT_CONFIG));
}

function clearBase64Export(): void {
  base64Revision++;
  base64Abort?.abort();
  base64Abort = undefined;
  preparedBase64.value = undefined;
  base64Operation.value = undefined;
  base64Notice.value = undefined;
}

watch([excludeChats, excludeChatHistory, excludeAttachments, exportName], clearBase64Export, { flush: 'sync' });
watch(pastedBase64, () => {
  pastedBase64Error.value = false;
});

function closeModal(): void {
  exportAbort?.abort();
  resetState();
  emit('close');
}

function leaveExport(): void {
  clearBase64Export();
  mode.value = 'menu';
}

function openBase64Import(): void {
  importRevision++;
  selectedFile.value = null;
  importPreview.value = null;
  pastedBase64.value = '';
  pastedBase64Error.value = false;
  error.value = null;
  mode.value = 'import_base64';
}

function buildExportExclude(): ExportOptions['exclude'] {
  const exclude = buildExcludeList();
  return exclude.length === 0 ? undefined : exclude;
}

// Reset state when modal visibility changes to ensure a clean start
watch(() => props.isOpen, (isOpen) => {
  if (isOpen) {
    resetState();
    mode.value = props.initialMode;
    void nextTick(() => {
      if (props.isOpen) {
        modalPanel.value?.focus();
      }
    });
  } else {
    exportAbort?.abort();
    resetState();
  }
}, { immediate: true });

async function generateBase64(): Promise<void> {
  if (base64Operation.value !== undefined || !props.isOpen || disposed) {
    return;
  }
  clearBase64Export();
  const token = base64Revision;
  const abort = new AbortController();
  base64Abort = abort;
  const isCurrent = () => !disposed && props.isOpen && token === base64Revision && !abort.signal.aborted;
  const exclude = buildExportExclude();
  const options = { fileNameSegment: exportName.value.trim(), ...(exclude === undefined ? {} : { exclude }) };
  base64Operation.value = 'generating';
  try {
    const { stream } = await service.exportData(options);
    if (!isCurrent()) {
      try {
        await stream.cancel();
      } catch { /* The abandoned source is not part of the current UI. */ }
      return;
    }
    const serialized = await encodeZipStreamAsBase64({ stream, signal: abort.signal });
    if (isCurrent()) {
      preparedBase64.value = serialized;
    }
  } catch {
    if (isCurrent()) {
      base64Notice.value = 'generate-failed';
    }
  } finally {
    if (token === base64Revision) {
      base64Abort = undefined;
      base64Operation.value = undefined;
    }
  }
}

async function copyBase64(): Promise<void> {
  const serialized = preparedBase64.value;
  if (serialized === undefined || base64Operation.value !== undefined || !props.isOpen || disposed) {
    return;
  }
  const token = base64Revision;
  const isCurrent = () => !disposed && props.isOpen && token === base64Revision && preparedBase64.value === serialized;
  base64Operation.value = 'copying';
  base64Notice.value = undefined;
  try {
    await navigator.clipboard.writeText(serialized);
    if (isCurrent()) {
      base64Notice.value = 'copied';
    }
  } catch {
    if (isCurrent()) {
      base64Notice.value = 'copy-failed';
    }
  } finally {
    if (isCurrent()) {
      base64Operation.value = undefined;
    }
  }
}

async function handleExport() {
  exportAbort?.abort();
  const abort = new AbortController();
  exportAbort = abort;
  const isCurrent = () => exportAbort === abort && !abort.signal.aborted && props.isOpen;
  const exclude = buildExportExclude();
  const options = {
    fileNameSegment: exportName.value.trim(),
    ...(exclude === undefined ? {} : { exclude }),
  };
  mode.value = 'processing';
  error.value = null;

  try {
    const preparing = await ensureStrings.ImportExportModal__compressing_data();
    if (!isCurrent()) {
      return;
    }
    processingMessage.value = preparing;
    const { stream, filename } = await service.exportData(options);

    // The download helper owns and cancels a late source when this view closed.
    await downloadReadableStream({ stream, filename, size: undefined, signal: abort.signal });
    if (!isCurrent()) {
      return;
    }
    const message = await ensureStrings.ImportExportModal__export_successful();
    if (!isCurrent()) {
      return;
    }
    addToast({ message, duration: 3000 });
    emit('close');
  } catch (e) {
    if (!isCurrent()) {
      return;
    }
    const message = e instanceof Error ? e.message : await ensureStrings.ImportExportModal__export_failed();
    if (!isCurrent()) {
      return;
    }
    error.value = message;
    mode.value = 'export';
  } finally {
    if (exportAbort === abort) {
      exportAbort = undefined;
    }
  }
}

async function handleFileSelect({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (!files || files.length === 0) {
    return;
  }

  const file = files[0];
  if (!file) {
    return;
  }

  try {
    await analyzeImportFile({ file, source: 'file' });
  } finally {
    target.value = '';
  }
}

async function handleBase64Import(): Promise<void> {
  if (disposed || !props.isOpen || mode.value !== 'import_base64') {
    return;
  }
  let file: File;
  try {
    const blob = decodeZipBase64({ serialized: pastedBase64.value });
    file = new File([blob], 'naidan-data-base64.zip', { type: 'application/zip' });
  } catch {
    pastedBase64Error.value = true;
    return;
  }
  await analyzeImportFile({ file, source: 'base64' });
}

async function analyzeImportFile({ file, source }: { file: File, source: 'file' | 'base64' }): Promise<void> {
  if (disposed || !props.isOpen) {
    return;
  }
  const token = ++importRevision;
  const isCurrent = () => !disposed && props.isOpen && token === importRevision;
  selectedFile.value = file;
  importPreview.value = null;
  error.value = null;
  mode.value = 'processing';
  try {
    const message = await ensureStrings.ImportExportModal__analyzing_file();
    if (!isCurrent()) {
      return;
    }
    processingMessage.value = message;
    const preview = await service.analyze({ zipFile: file });
    if (isCurrent()) {
      importPreview.value = preview;
      pastedBase64.value = '';
      mode.value = 'import_preview';
    }
  } catch (e) {
    if (!isCurrent()) {
      return;
    }
    let message: string;
    let failureMode: 'menu' | 'import_base64';
    switch (source) {
    case 'file': message = e instanceof Error ? e.message : await ensureStrings.ImportExportModal__failed_to_analyze_file();
      failureMode = 'menu';
      break;
    case 'base64': message = await ensureStrings.ImportExportModal__could_not_read_base64_zip();
      failureMode = 'import_base64';
      break;
    default: {
      const exhaustive: never = source;
      throw new Error(String(exhaustive));
    }
    }
    if (isCurrent()) {
      error.value = message;
      selectedFile.value = null;
      mode.value = failureMode;
    }
  }
}

async function handleImportExecute() {
  const file = selectedFile.value;
  if (!file) {
    return;
  }
  const token = ++importRevision;
  const config: ImportConfig = JSON.parse(JSON.stringify(importConfig.value));
  const isCurrent = () => !disposed && props.isOpen && token === importRevision;
  mode.value = 'processing';
  error.value = null;

  try {
    const verifying = await ensureStrings.ImportExportModal__verifying_integrity();
    if (!isCurrent()) {
      return;
    }
    processingMessage.value = verifying;
    // 1. Verify before destructive restore
    await service.verify({ zipFile: file, config });

    // 2. Execute
    if (!isCurrent()) {
      return;
    }
    const importing = await ensureStrings.ImportExportModal__importing_data();
    if (!isCurrent()) {
      return;
    }
    processingMessage.value = importing;
    await service.executeImport({ zipFile: file, config });

    if (!isCurrent()) {
      return;
    }
    const success = await ensureStrings.ImportExportModal__import_successful();
    if (!isCurrent()) {
      return;
    }
    addToast({ message: success, duration: 3000 });

    setTimeout(() => {
      if (isCurrent()) {
        window.location.reload();
      }
    }, 1000);
  } catch (e) {
    if (!isCurrent()) {
      return;
    }
    const message = e instanceof Error ? e.message : await ensureStrings.ImportExportModal__import_failed();
    if (isCurrent()) {
      error.value = message;
      mode.value = 'import_config';
    }
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
    <div v-if="isOpen" tw-class="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4 transition-all">
      <div ref="modal-panel" tabindex="-1" class="animate-in fade-in zoom-in-95" tw-class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 duration-200 overflow-hidden relative">

        <!-- Close Button -->
        <button
          @click="closeModal"
          tw-class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
        >
          <XIcon tw-class="w-5 h-5" />
        </button>

        <!-- Header -->
        <div tw-class="p-6 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div tw-class="flex items-center gap-3">
            <div tw-class="p-2.5 bg-blue-50 dark:bg-blue-900/20 rounded-xl text-blue-600 dark:text-blue-400">
              <FolderInputIcon tw-class="w-6 h-6" />
            </div>
            <div>
              <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
                {{ lazyStrings.ImportExportModal__import_export() }}
                <span tw-class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">{{ lazyStrings.ImportExportModal__experimental() }}</span>
              </h2>
              <p tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__portable_data() }}</p>
            </div>
          </div>
        </div>

        <!-- Content -->
        <div tw-class="flex-1 overflow-y-auto p-6 overscroll-contain">

          <!-- Error Message -->
          <div v-if="error" tw-class="mb-6 p-4 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-2xl flex items-start gap-3">
            <AlertTriangleIcon tw-class="w-5 h-5 text-red-500 shrink-0" />
            <div tw-class="flex-1">
              <h4 tw-class="text-sm font-bold text-red-800 dark:text-red-400">{{ lazyStrings.ImportExportModal__error() }}</h4>
              <p tw-class="text-xs text-red-600 dark:text-red-300 mt-1">{{ error }}</p>
            </div>
          </div>

          <!-- MENU MODE -->
          <div v-if="mode === 'menu'" tw-class="grid grid-cols-1 md:grid-cols-2 gap-6 h-full">
            <!-- Export Card -->
            <div
              data-testid="import-export-export-card"
              tw-class="p-6 rounded-3xl border-2 border-gray-100 dark:border-gray-800 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50/10 dark:hover:bg-blue-900/5 transition-all cursor-pointer group flex flex-col gap-4"
              @click="mode = 'export'"
            >
              <div tw-class="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-2xl w-fit text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">
                <component :is="ExportIcon" tw-class="w-6 h-6" />
              </div>
              <div>
                <h3 tw-class="text-lg font-bold text-gray-800 dark:text-white text-left">{{ lazyStrings.ImportExportModal__export() }}</h3>
                <p tw-class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed text-left">{{ lazyStrings.ImportExportModal__download_full_backup() }}</p>
              </div>
            </div>

            <!-- Import Card -->
            <label tw-class="p-6 rounded-3xl border-2 border-gray-100 dark:border-gray-800 hover:border-green-500 dark:hover:border-green-500 hover:bg-green-50/10 dark:hover:bg-green-900/5 transition-all cursor-pointer group flex flex-col gap-4 relative">
              <input type="file" accept=".zip" data-testid="import-export-file-input" tw-class="hidden" @change="handleFileSelect({ event: $event })" />
              <div tw-class="p-3 bg-green-100 dark:bg-green-900/30 rounded-2xl w-fit text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
                <component :is="ImportIcon" tw-class="w-6 h-6" />
              </div>
              <div>
                <h3 tw-class="text-lg font-bold text-gray-800 dark:text-white text-left">{{ lazyStrings.ImportExportModal__import() }}</h3>
                <p tw-class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed text-left">{{ lazyStrings.ImportExportModal__upload_backup_to_restore_or_merge() }}</p>
              </div>
            </label>
            <div tw-class="border-t border-gray-200 pt-3 dark:border-gray-700 md:col-span-2">
              <ActionButton appearance="primary" icon-tone="blue" :disabled="false" data-testid="import-export-paste-base64" @click="openBase64Import"><CopyIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.ImportExportModal__paste_base64_to_import() }}</ActionButton>
            </div>
          </div>

          <section v-if="mode === 'import_base64'" tw-class="space-y-4">
            <h3 tw-class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ lazyStrings.ImportExportModal__paste_base64_to_import() }}</h3>
            <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__paste_the_base64_zip_to_review_before_importing() }}</p>
            <div tw-class="space-y-2">
              <label :for="pastedBase64Id" tw-class="block text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.ImportExportModal__base64_string() }}</label>
              <textarea :id="pastedBase64Id" v-model="pastedBase64" rows="6" wrap="off" autocomplete="off" autocapitalize="off" spellcheck="false" data-testid="import-export-base64-input" tw-class="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-gray-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200" />
              <p v-if="pastedBase64Error" role="alert" data-testid="import-export-base64-paste-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ImportExportModal__could_not_read_base64_zip() }}</p>
            </div>
            <div tw-class="flex flex-wrap justify-end gap-2">
              <ActionButton appearance="secondary" :icon-tone="undefined" :disabled="false" @click="resetState">{{ lazyStrings.ImportExportModal__back_to_menu() }}</ActionButton>
              <ActionButton appearance="primary" icon-tone="blue" :disabled="pastedBase64.trim().length === 0" data-testid="import-export-base64-read" @click="handleBase64Import"><DownloadIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.ImportExportModal__read_base64() }}</ActionButton>
            </div>
          </section>

          <!-- EXPORT MODE -->
          <div v-if="mode === 'export'" tw-class="space-y-8">
            <div tw-class="bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/20 p-6 rounded-2xl flex flex-col items-center text-center gap-4">
              <div tw-class="p-3 bg-white dark:bg-gray-800 rounded-full shadow-sm text-blue-600 dark:text-blue-400">
                <FileArchiveIcon tw-class="w-8 h-8" />
              </div>
              <div tw-class="space-y-1">
                <h3 tw-class="text-lg font-bold text-gray-800 dark:text-white">{{ lazyStrings.ImportExportModal__ready_to_export() }}</h3>
                <p tw-class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ lazyStrings.ImportExportModal__zip_contains_all_data_by_default() }}</p>
              </div>

              <div tw-class="w-full space-y-3 pt-2">
                <div tw-class="space-y-1.5 text-left max-w-sm mx-auto">
                  <label tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ImportExportModal__filename_tag_optional() }}</label>
                  <input
                    v-model="exportName"
                    type="text"
                    :placeholder="lazyStrings.ImportExportModal__filename_tag_example()"
                    tw-class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-xs font-bold focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                  />
                </div>

                <div tw-class="mt-4 flex flex-wrap justify-center gap-4">
                  <label tw-class="flex items-center gap-2 cursor-pointer group">
                    <input
                      v-model="excludeChats"
                      data-testid="export-exclude-chats-checkbox"
                      type="checkbox"
                      tw-class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
                    />
                    <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.ImportExportModal__exclude_chats() }}</span>
                  </label>
                  <label
                    :tw-class="['flex items-center gap-2 group', excludeChatHistoryDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer']"
                  >
                    <input
                      v-model="excludeChatHistory"
                      :disabled="excludeChatHistoryDisabled"
                      data-testid="export-exclude-chat-history-checkbox"
                      type="checkbox"
                      tw-class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700 disabled:cursor-not-allowed"
                    />
                    <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.ImportExportModal__exclude_chat_history() }}</span>
                  </label>
                  <label tw-class="flex items-center gap-2 cursor-pointer group">
                    <input
                      v-model="excludeAttachments"
                      data-testid="export-exclude-attachments-checkbox"
                      type="checkbox"
                      tw-class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
                    />
                    <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.ImportExportModal__exclude_attachments() }}</span>
                  </label>
                </div>

                <div tw-class="flex flex-col items-center gap-4">
                  <div tw-class="w-full max-w-md bg-gray-100 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-3 flex flex-col gap-1.5 shadow-inner">
                    <span tw-class="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] text-center">{{ lazyStrings.ImportExportModal__output_filename() }}</span>
                    <p tw-class="text-xs font-mono font-bold text-blue-600 dark:text-blue-400 break-all text-center">
                      {{ previewFilename }}
                    </p>
                  </div>

                  <button
                    data-testid="import-export-export-now-button"
                    :disabled="base64Operation !== undefined"
                    tw-class="w-full sm:w-auto px-10 py-4 rounded-2xl font-black bg-blue-600 hover:bg-blue-700 text-white shadow-xl shadow-blue-500/20 transition-all active:scale-95 flex items-center justify-center gap-3"
                    @click="handleExport"
                  >
                    <component :is="ExportIcon" tw-class="w-6 h-6" />
                    {{ lazyStrings.ImportExportModal__export_now() }}
                  </button>
                </div>
              </div>
            </div>

            <section tw-class="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h4 tw-class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ lazyStrings.ImportExportModal__copy_zip_as_base64() }}</h4>
              <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__base64_contains_the_same_zip_data_without_a_url() }}</p>
              <div tw-class="flex flex-wrap gap-2">
                <ActionButton appearance="primary" icon-tone="blue" :disabled="base64Operation !== undefined" :aria-busy="base64Operation === 'generating'" data-testid="import-export-base64-generate" @click="generateBase64"><Loader2Icon v-if="base64Operation === 'generating'" aria-hidden="true" tw-class="h-4 w-4 animate-spin" /><FileArchiveIcon v-else aria-hidden="true" tw-class="h-4 w-4" />{{ base64Operation === 'generating' ? lazyStrings.ImportExportModal__preparing_base64() : lazyStrings.ImportExportModal__prepare_base64() }}</ActionButton>
                <ActionButton v-if="preparedBase64 !== undefined" appearance="primary" icon-tone="blue" :disabled="base64Operation !== undefined" :aria-busy="base64Operation === 'copying'" data-testid="import-export-base64-copy" @click="copyBase64"><Loader2Icon v-if="base64Operation === 'copying'" aria-hidden="true" tw-class="h-4 w-4 animate-spin" /><CopyIcon v-else aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.ImportExportModal__copy_base64() }}</ActionButton>
              </div>
              <p v-if="base64Notice === 'copied'" role="status" data-testid="import-export-base64-copy-success" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__base64_copied() }}</p>
              <p v-else-if="base64Notice === 'generate-failed'" role="status" data-testid="import-export-base64-generate-error" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__could_not_prepare_base64() }}</p>
              <p v-else-if="base64Notice === 'copy-failed'" role="status" data-testid="import-export-base64-copy-error" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__could_not_copy_base64() }}</p>
            </section>

            <div tw-class="flex justify-start pt-4 border-t border-gray-100 dark:border-gray-800">
              <button @click="leaveExport" tw-class="px-4 py-2 text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                {{ lazyStrings.ImportExportModal__back_to_menu() }}
              </button>
            </div>
          </div>

          <!-- IMPORT PREVIEW MODE -->
          <div v-if="mode === 'import_preview' && importPreview" data-testid="import-export-preview" tw-class="space-y-6">
            <div tw-class="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div tw-class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div tw-class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.chatGroupsCount }}</div>
                <div tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__groups() }}</div>
              </div>
              <div tw-class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div tw-class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.chatsCount }}</div>
                <div tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__chats() }}</div>
              </div>
              <div tw-class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div tw-class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.attachmentsCount }}</div>
                <div tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__files() }}</div>
              </div>
              <div tw-class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
                <div tw-class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.providerProfilesCount }}</div>
                <div tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__profiles() }}</div>
              </div>
            </div>

            <div tw-class="max-h-60 overflow-y-auto p-4 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-2 overscroll-contain">
              <h4 tw-class="text-xs font-bold text-gray-400 uppercase tracking-widest sticky top-0 bg-white dark:bg-gray-900 pb-2">{{ lazyStrings.ImportExportModal__content_preview() }}</h4>
              <div v-for="(item, idx) in importPreview.items" :key="idx" tw-class="text-sm">
                <div v-if="item.type === 'chat_group'" tw-class="font-bold text-blue-600 dark:text-blue-400 flex items-center gap-2">
                  <FolderInputIcon tw-class="w-4 h-4" /> {{ item.data.name }} ({{ lazyStrings.ImportExportModal__chat_count({ count: item.data.items.length }) }})
                </div>
                <div v-else tw-class="pl-6 text-gray-600 dark:text-gray-300 flex items-center gap-2">
                  <div tw-class="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600"></div>
                  {{ item.data.title || lazyStrings.ImportExportModal__untitled_chat() }}
                </div>
              </div>
            </div>

            <div tw-class="flex justify-end gap-3 pt-4">
              <button @click="resetState" tw-class="px-6 py-2.5 rounded-xl font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{{ lazyStrings.ImportExportModal__cancel() }}</button>
              <button data-testid="import-export-preview-next" @click="mode = 'import_config'" tw-class="px-8 py-2.5 rounded-xl font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20 transition-all active:scale-95 flex items-center gap-2">
                {{ lazyStrings.ImportExportModal__next() }}
                <ArrowRightIcon tw-class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- IMPORT CONFIG MODE -->
          <div v-if="mode === 'import_config'" data-testid="import-export-config" tw-class="space-y-8">

            <!-- Data Strategy -->
            <section tw-class="space-y-4">
              <div tw-class="flex items-center justify-between">
                <h3 tw-class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                  <DatabaseIcon tw-class="w-4 h-4 text-blue-500" />
                  {{ lazyStrings.ImportExportModal__mode_and_data_strategy() }}
                </h3>
                <div tw-class="flex gap-2">
                  <button v-if="activePreset === 'custom'"
                          @click="applyPreset({ preset: importConfig.data.mode })"
                          tw-class="text-[9px] font-black uppercase tracking-widest bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-800/50 hover:bg-amber-200 transition-colors">
                    {{ lazyStrings.ImportExportModal__custom_click_to_reset() }}
                  </button>
                  <span v-else tw-class="text-[9px] font-black uppercase tracking-widest bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full border border-blue-200 dark:border-blue-800/50">
                    {{ activePreset === 'append' ? lazyStrings.ImportExportModal__append_preset() : lazyStrings.ImportExportModal__restore_preset() }}
                  </span>
                </div>
              </div>

              <div tw-class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label
                  :tw-class="['cursor-pointer p-4 rounded-2xl border-2 transition-all flex flex-col gap-2', activePreset === 'append' ? 'border-blue-500 bg-blue-50/20 dark:bg-blue-900/10' : 'border-gray-100 dark:border-gray-800 hover:border-blue-300']">
                  <div tw-class="flex items-center justify-between">
                    <div tw-class="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                      <CopyPlusIcon tw-class="w-4 h-4" /> {{ lazyStrings.ImportExportModal__append_merge() }}
                    </div>
                    <input type="radio" :checked="activePreset === 'append'" @change="applyPreset({ preset: 'append' })" tw-class="w-4 h-4 accent-blue-600" />
                  </div>
                  <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__append_keeps_current_data() }}</p>
                </label>

                <label
                  :tw-class="['cursor-pointer p-4 rounded-2xl border-2 transition-all flex flex-col gap-2', activePreset === 'replace' ? 'border-blue-500 bg-blue-50/20 dark:bg-blue-900/10' : 'border-gray-100 dark:border-gray-800 hover:border-blue-300']">
                  <div tw-class="flex items-center justify-between">
                    <div tw-class="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                      <RefreshCwIcon tw-class="w-4 h-4" /> {{ lazyStrings.ImportExportModal__replace_restore() }}
                    </div>
                    <input type="radio" :checked="activePreset === 'replace'" @change="applyPreset({ preset: 'replace' })" tw-class="w-4 h-4 accent-blue-600" />
                  </div>
                  <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImportExportModal__replace_clears_current_data() }}</p>
                </label>
              </div>

              <!-- Prefix Inputs (Only for Append) -->
              <div v-if="importConfig.data.mode === 'append'" class="animate-in fade-in slide-in-from-top-2" tw-class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl space-y-4">
                <div tw-class="grid grid-cols-2 gap-4">
                  <div tw-class="space-y-1">
                    <label tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__chat_title_prefix() }}</label>
                    <input v-model="importConfig.data.chatTitlePrefix" tw-class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs font-bold" />
                  </div>
                  <div tw-class="space-y-1">
                    <label tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ lazyStrings.ImportExportModal__group_name_prefix() }}</label>
                    <input v-model="importConfig.data.chatGroupNamePrefix" tw-class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs font-bold" />
                  </div>
                </div>
              </div>
            </section>

            <!-- Settings Strategy -->
            <section tw-class="space-y-4">
              <div tw-class="flex items-center justify-between">
                <h3 tw-class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                  <Settings2Icon tw-class="w-4 h-4 text-blue-500" />
                  {{ lazyStrings.ImportExportModal__settings_and_profiles() }}
                </h3>
              </div>

              <div v-if="importPreview?.stats.hasSettings" tw-class="space-y-3 p-4 border border-gray-100 dark:border-gray-700 rounded-2xl flex flex-col gap-1">
                <!-- Endpoint -->
                <div tw-class="flex items-center justify-between">
                  <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__url_and_http_headers() }}</span>
                  <select v-model="importConfig.settings.endpoint" tw-class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- Default Model -->
                <div tw-class="flex items-center justify-between">
                  <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__default_model() }}</span>
                  <select v-model="importConfig.settings.model" tw-class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- Title Model -->
                <div tw-class="flex items-center justify-between">
                  <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__title_generation_model() }}</span>
                  <select v-model="importConfig.settings.titleModel" tw-class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- Profiles -->
                <div tw-class="flex items-center justify-between">
                  <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__provider_profiles() }}</span>
                  <select v-model="importConfig.settings.providerProfiles" tw-class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="append">{{ lazyStrings.ImportExportModal__add_new() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__ignore() }}</option>
                  </select>
                </div>

                <!-- System Prompt -->
                <div tw-class="flex items-center justify-between">
                  <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__global_system_prompt() }}</span>
                  <select v-model="importConfig.settings.systemPrompt" tw-class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>

                <!-- LM Parameters -->
                <div tw-class="flex items-center justify-between">
                  <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.ImportExportModal__lm_parameters() }}</span>
                  <select v-model="importConfig.settings.lmParameters" tw-class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                    <option value="replace">{{ lazyStrings.ImportExportModal__overwrite() }} {{ activePreset === 'replace' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                    <option value="none">{{ lazyStrings.ImportExportModal__keep_current() }} {{ activePreset === 'append' ? lazyStrings.ImportExportModal__default_marker() : '' }}</option>
                  </select>
                </div>
              </div>
              <div v-else tw-class="p-6 border-2 border-dashed border-gray-100 dark:border-gray-800 rounded-2xl text-center">
                <p tw-class="text-xs font-bold text-gray-400">{{ lazyStrings.ImportExportModal__no_settings_or_profiles() }}</p>
              </div>
            </section>

            <div tw-class="flex justify-end gap-3 pt-4">
              <button @click="mode = 'import_preview'" tw-class="px-6 py-2.5 rounded-xl font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">{{ lazyStrings.ImportExportModal__back() }}</button>
              <button
                data-testid="import-export-import-now"
                @click="handleImportExecute"
                tw-class="px-8 py-2.5 rounded-xl font-bold text-white shadow-lg transition-all active:scale-95 flex items-center gap-2 bg-blue-600 hover:bg-blue-700 shadow-blue-500/20"
              >
                <CheckCircle2Icon tw-class="w-4 h-4" />
                {{ lazyStrings.ImportExportModal__import() }}
              </button>
            </div>
          </div>

          <!-- PROCESSING MODE -->
          <div v-if="mode === 'processing'" tw-class="h-full flex flex-col items-center justify-center space-y-6 min-h-[300px]">
            <Loader2Icon tw-class="w-12 h-12 text-blue-600 animate-spin" />
            <p tw-class="text-sm font-bold text-gray-500 dark:text-gray-400 animate-pulse">{{ processingMessage }}</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
