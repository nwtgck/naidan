<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { 
  X, Upload, Download, FileArchive, 
  CheckCircle2, AlertTriangle, Loader2,
  RefreshCw, CopyPlus, ArrowRight,
  Database, Settings2, FolderInput
} from 'lucide-vue-next';
import { ImportExportService } from '../services/import-export/service';
import { storageService } from '../services/storage';
import { useToast } from '../composables/useToast';
import type { 
  ImportConfig, 
  ImportPreview
} from '../services/import-export/types';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const service = new ImportExportService(storageService);
const { addToast } = useToast();

/**
 * Directional icons chosen based on data flow relative to the application:
 * - Export: Sending data OUT of the app (represented by Upload/Up arrow)
 * - Import: Bringing data IN to the app (represented by Download/Down arrow)
 */
const ExportIcon = Upload;
const ImportIcon = Download;

// --- State ---
const mode = ref<'menu' | 'export' | 'import_preview' | 'import_config' | 'processing'>('menu');
const processingMessage = ref('');
const error = ref<string | null>(null);

// Export State
const exportName = ref('');
const previewFilename = computed(() => {
  const dateStr = new Date().toISOString().split('T')[0];
  // eslint-disable-next-line no-control-regex
  const sanitized = exportName.value.replace(/[/?%*:|"<>\x00-\x1F]/g, '_').trim();
  const midSegment = sanitized ? `_${sanitized}` : '';
  return `naidan_data${midSegment}_${dateStr}.zip`;
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

function applyPreset(preset: 'append' | 'replace') {
  if (preset === 'append') {
    importConfig.value = JSON.parse(JSON.stringify(APPEND_DEFAULT_CONFIG));
  } else {
    importConfig.value = JSON.parse(JSON.stringify(REPLACE_DEFAULT_CONFIG));
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
  importConfig.value = JSON.parse(JSON.stringify(APPEND_DEFAULT_CONFIG));
}

// Reset state when modal visibility changes to ensure a clean start
watch(() => props.isOpen, (isOpen) => {
  if (isOpen) {
    resetState();
  }
});

async function handleExport() {
  mode.value = 'processing';
  processingMessage.value = 'Compressing data...';
  error.value = null;

  try {
    const { stream, filename } = await service.exportData({ 
      fileNameSegment: exportName.value.trim() 
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

    addToast({ message: 'Export successful!', duration: 3000 });
    emit('close');
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Export failed';
    mode.value = 'export';
  }
}

async function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (!files || files.length === 0) return;
  
  const file = files[0];
  if (!file) return;

  selectedFile.value = file;
  
  mode.value = 'processing';
  processingMessage.value = 'Analyzing file...';
  error.value = null;

  try {
    importPreview.value = await service.analyze(file);
    mode.value = 'import_preview';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to analyze file';
    mode.value = 'menu';
  } finally {
    target.value = '';
  }
}

async function handleImportExecute() {
  const file = selectedFile.value;
  if (!file) return;

  mode.value = 'processing';
  processingMessage.value = 'Verifying integrity...';
  error.value = null;

  try {
    // 1. Verify before destructive restore
    await service.verify(file, importConfig.value);
    
    // 2. Execute
    processingMessage.value = 'Importing data...';
    await service.executeImport(file, importConfig.value);
    
    addToast({ message: 'Import successful!', duration: 3000 });
    
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Import failed';
    mode.value = 'import_config';
  }
}

</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4 transition-all">
    <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 animate-in fade-in zoom-in-95 duration-200 overflow-hidden relative">
      
      <!-- Close Button -->
      <button 
        @click="emit('close')"
        class="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors"
      >
        <X class="w-5 h-5" />
      </button>

      <!-- Header -->
      <div class="p-6 border-b border-gray-100 dark:border-gray-800 shrink-0">
        <div class="flex items-center gap-3">
          <div class="p-2.5 bg-blue-50 dark:bg-blue-900/20 rounded-xl text-blue-600 dark:text-blue-400">
            <FolderInput class="w-6 h-6" />
          </div>
          <div>
            <h2 class="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
              Import / Export
              <span class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">Experimental</span>
            </h2>
            <p class="text-xs font-medium text-gray-500 dark:text-gray-400">Portable Data</p>
          </div>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-y-auto p-6">
        
        <!-- Error Message -->
        <div v-if="error" class="mb-6 p-4 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-2xl flex items-start gap-3">
          <AlertTriangle class="w-5 h-5 text-red-500 shrink-0" />
          <div class="flex-1">
            <h4 class="text-sm font-bold text-red-800 dark:text-red-400">Error</h4>
            <p class="text-xs text-red-600 dark:text-red-300 mt-1">{{ error }}</p>
          </div>
        </div>

        <!-- MENU MODE -->
        <div v-if="mode === 'menu'" class="grid grid-cols-1 md:grid-cols-2 gap-6 h-full">
          <!-- Export Card -->
          <div class="p-6 rounded-3xl border-2 border-gray-100 dark:border-gray-800 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50/10 dark:hover:bg-blue-900/5 transition-all cursor-pointer group flex flex-col gap-4" @click="mode = 'export'">
            <div class="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-2xl w-fit text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">
              <component :is="ExportIcon" class="w-6 h-6" />
            </div>
            <div>
              <h3 class="text-lg font-bold text-gray-800 dark:text-white text-left">Export</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed text-left">Download a full backup of your chats and settings.</p>
            </div>
          </div>

          <!-- Import Card -->
          <label class="p-6 rounded-3xl border-2 border-gray-100 dark:border-gray-800 hover:border-green-500 dark:hover:border-green-500 hover:bg-green-50/10 dark:hover:bg-green-900/5 transition-all cursor-pointer group flex flex-col gap-4 relative">
            <input type="file" accept=".zip" class="hidden" @change="handleFileSelect" />
            <div class="p-3 bg-green-100 dark:bg-green-900/30 rounded-2xl w-fit text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
              <component :is="ImportIcon" class="w-6 h-6" />
            </div>
            <div>
              <h3 class="text-lg font-bold text-gray-800 dark:text-white text-left">Import</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed text-left">Upload a backup ZIP to restore or merge your data.</p>
            </div>
          </label>
        </div>

        <!-- EXPORT MODE -->
        <div v-if="mode === 'export'" class="space-y-8">
          <div class="bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/20 p-6 rounded-2xl flex flex-col items-center text-center gap-4">
            <div class="p-3 bg-white dark:bg-gray-800 rounded-full shadow-sm text-blue-600 dark:text-blue-400">
              <FileArchive class="w-8 h-8" />
            </div>
            <div class="space-y-1">
              <h3 class="text-lg font-bold text-gray-800 dark:text-white">Ready to Export</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">Prepare a ZIP file containing all your chats, groups, attachments, and configuration.</p>
            </div>

            <div class="w-full space-y-3 pt-2">
              <div class="space-y-1.5 text-left max-w-sm mx-auto">
                <label class="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Filename Tag (Optional)</label>
                <input 
                  v-model="exportName"
                  type="text" 
                  placeholder="e.g. before-update" 
                  class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-xs font-bold focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                />
              </div>
              
              <div class="flex flex-col items-center gap-4">
                <div class="w-full max-w-md bg-gray-100 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-3 flex flex-col gap-1.5 shadow-inner">
                  <span class="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] text-center">Output Filename</span>
                  <p class="text-xs font-mono font-bold text-blue-600 dark:text-blue-400 break-all text-center">
                    {{ previewFilename }}
                  </p>
                </div>
                
                <button @click="handleExport" class="w-full sm:w-auto px-10 py-4 rounded-2xl font-black bg-blue-600 hover:bg-blue-700 text-white shadow-xl shadow-blue-500/20 transition-all active:scale-95 flex items-center justify-center gap-3">
                  <component :is="ExportIcon" class="w-6 h-6" />
                  Export Now
                </button>
              </div>
            </div>
          </div>

          <div class="flex justify-start pt-4 border-t border-gray-100 dark:border-gray-800">
            <button @click="mode = 'menu'" class="px-4 py-2 text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
              &larr; Back to Menu
            </button>
          </div>
        </div>

        <!-- IMPORT PREVIEW MODE -->
        <div v-if="mode === 'import_preview' && importPreview" class="space-y-6">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
              <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.chatGroupsCount }}</div>
              <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Groups</div>
            </div>
            <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
              <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.chatsCount }}</div>
              <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Chats</div>
            </div>
            <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
              <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.attachmentsCount }}</div>
              <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Files</div>
            </div>
            <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 text-center">
              <div class="text-2xl font-black text-gray-800 dark:text-white">{{ importPreview.stats.providerProfilesCount }}</div>
              <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Profiles</div>
            </div>
          </div>

          <div class="max-h-60 overflow-y-auto p-4 border border-gray-100 dark:border-gray-700 rounded-2xl space-y-2">
            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest sticky top-0 bg-white dark:bg-gray-900 pb-2">Content Preview</h4>
            <div v-for="(item, idx) in importPreview.items" :key="idx" class="text-sm">
              <div v-if="item.type === 'chat_group'" class="font-bold text-blue-600 dark:text-blue-400 flex items-center gap-2">
                <FolderInput class="w-4 h-4" /> {{ item.data.name }} ({{ item.data.items.length }} chats)
              </div>
              <div v-else class="pl-6 text-gray-600 dark:text-gray-300 flex items-center gap-2">
                <div class="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600"></div>
                {{ item.data.title || 'Untitled Chat' }}
              </div>
            </div>
          </div>

          <div class="flex justify-end gap-3 pt-4">
            <button @click="resetState" class="px-6 py-2.5 rounded-xl font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">Cancel</button>
            <button @click="mode = 'import_config'" class="px-8 py-2.5 rounded-xl font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20 transition-all active:scale-95 flex items-center gap-2">
              Next
              <ArrowRight class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- IMPORT CONFIG MODE -->
        <div v-if="mode === 'import_config'" class="space-y-8">
          
          <!-- Data Strategy -->
          <section class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                <Database class="w-4 h-4 text-blue-500" />
                Mode & Data Strategy
              </h3>
              <div class="flex gap-2">
                <button v-if="activePreset === 'custom'" 
                        @click="applyPreset(importConfig.data.mode)"
                        class="text-[9px] font-black uppercase tracking-widest bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-800/50 hover:bg-amber-200 transition-colors">
                  Custom (Click to Reset)
                </button>
                <span v-else class="text-[9px] font-black uppercase tracking-widest bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full border border-blue-200 dark:border-blue-800/50">
                  {{ activePreset === 'append' ? 'Append Preset' : 'Restore Preset' }}
                </span>
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label class="cursor-pointer p-4 rounded-2xl border-2 transition-all flex flex-col gap-2"
                     :class="activePreset === 'append' ? 'border-blue-500 bg-blue-50/20 dark:bg-blue-900/10' : 'border-gray-100 dark:border-gray-800 hover:border-blue-300'">
                <div class="flex items-center justify-between">
                  <div class="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                    <CopyPlus class="w-4 h-4" /> Append (Merge)
                  </div>
                  <input type="radio" :checked="activePreset === 'append'" @change="applyPreset('append')" class="w-4 h-4 accent-blue-600" />
                </div>
                <p class="text-xs text-gray-500 dark:text-gray-400">Add new items from the ZIP file while keeping your current data intact.</p>
              </label>

              <label class="cursor-pointer p-4 rounded-2xl border-2 transition-all flex flex-col gap-2"
                     :class="activePreset === 'replace' ? 'border-blue-500 bg-blue-50/20 dark:bg-blue-900/10' : 'border-gray-100 dark:border-gray-800 hover:border-blue-300'">
                <div class="flex items-center justify-between">
                  <div class="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                    <RefreshCw class="w-4 h-4" /> Replace (Restore)
                  </div>
                  <input type="radio" :checked="activePreset === 'replace'" @change="applyPreset('replace')" class="w-4 h-4 accent-blue-600" />
                </div>
                <p class="text-xs text-gray-500 dark:text-gray-400">Clear current data and restore state from the ZIP file.</p>
              </label>
            </div>

            <!-- Prefix Inputs (Only for Append) -->
            <div v-if="importConfig.data.mode === 'append'" class="p-4 bg-gray-50 dark:bg-gray-800 rounded-2xl space-y-4 animate-in fade-in slide-in-from-top-2">
              <div class="grid grid-cols-2 gap-4">
                <div class="space-y-1">
                  <label class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Chat Title Prefix</label>
                  <input v-model="importConfig.data.chatTitlePrefix" class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs font-bold" />
                </div>
                <div class="space-y-1">
                  <label class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Group Name Prefix</label>
                  <input v-model="importConfig.data.chatGroupNamePrefix" class="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs font-bold" />
                </div>
              </div>
            </div>
          </section>

          <!-- Settings Strategy -->
          <section class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-bold text-gray-800 dark:text-white flex items-center gap-2">
                <Settings2 class="w-4 h-4 text-blue-500" />
                Settings & Profiles
              </h3>
            </div>
            
            <div v-if="importPreview?.stats.hasSettings" class="space-y-3 p-4 border border-gray-100 dark:border-gray-700 rounded-2xl flex flex-col gap-1">
              <!-- Endpoint -->
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-600 dark:text-gray-300">URL & HTTP Headers</span>
                <select v-model="importConfig.settings.endpoint" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                  <option value="replace">Overwrite {{ activePreset === 'replace' ? '(Default)' : '' }}</option>
                  <option value="none">Keep Current {{ activePreset === 'append' ? '(Default)' : '' }}</option>
                </select>
              </div>

              <!-- Default Model -->
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-600 dark:text-gray-300">Default Model</span>
                <select v-model="importConfig.settings.model" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                  <option value="replace">Overwrite {{ activePreset === 'replace' ? '(Default)' : '' }}</option>
                  <option value="none">Keep Current {{ activePreset === 'append' ? '(Default)' : '' }}</option>
                </select>
              </div>

              <!-- Title Model -->
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-600 dark:text-gray-300">Title Generation Model</span>
                <select v-model="importConfig.settings.titleModel" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                  <option value="replace">Overwrite {{ activePreset === 'replace' ? '(Default)' : '' }}</option>
                  <option value="none">Keep Current {{ activePreset === 'append' ? '(Default)' : '' }}</option>
                </select>
              </div>
              
              <!-- Profiles -->
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-600 dark:text-gray-300">Provider Profiles</span>
                <select v-model="importConfig.settings.providerProfiles" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                  <option value="append">Add New {{ activePreset === 'append' ? '(Default)' : '' }}</option>
                  <option value="replace">Overwrite {{ activePreset === 'replace' ? '(Default)' : '' }}</option>
                  <option value="none">Ignore</option>
                </select>
              </div>

              <!-- System Prompt -->
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-600 dark:text-gray-300">Global System Prompt</span>
                <select v-model="importConfig.settings.systemPrompt" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                  <option value="replace">Overwrite {{ activePreset === 'replace' ? '(Default)' : '' }}</option>
                  <option value="none">Keep Current {{ activePreset === 'append' ? '(Default)' : '' }}</option>
                </select>
              </div>

              <!-- LM Parameters -->
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-gray-600 dark:text-gray-300">LM Parameters (Temp, etc.)</span>
                <select v-model="importConfig.settings.lmParameters" class="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/20 min-w-[160px]">
                  <option value="replace">Overwrite {{ activePreset === 'replace' ? '(Default)' : '' }}</option>
                  <option value="none">Keep Current {{ activePreset === 'append' ? '(Default)' : '' }}</option>
                </select>
              </div>
            </div>
            <div v-else class="p-6 border-2 border-dashed border-gray-100 dark:border-gray-800 rounded-2xl text-center">
              <p class="text-xs font-bold text-gray-400">No settings or profiles found in this backup.</p>
            </div>
          </section>

          <div class="flex justify-end gap-3 pt-4">
            <button @click="mode = 'import_preview'" class="px-6 py-2.5 rounded-xl font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">Back</button>
            <button 
              @click="handleImportExecute" 
              class="px-8 py-2.5 rounded-xl font-bold text-white shadow-lg transition-all active:scale-95 flex items-center gap-2 bg-blue-600 hover:bg-blue-700 shadow-blue-500/20"
            >
              <CheckCircle2 class="w-4 h-4" />
              Import
            </button>
          </div>
        </div>

        <!-- PROCESSING MODE -->
        <div v-if="mode === 'processing'" class="h-full flex flex-col items-center justify-center space-y-6 min-h-[300px]">
          <Loader2 class="w-12 h-12 text-blue-600 animate-spin" />
          <p class="text-sm font-bold text-gray-500 dark:text-gray-400 animate-pulse">{{ processingMessage }}</p>
        </div>

      </div>
    </div>
  </div>
</template>