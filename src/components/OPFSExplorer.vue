<script setup lang="ts">
import { ref, watch } from 'vue';
import { 
  Folder, FileText, Trash2, ChevronLeft, X, 
  ChevronRight, HardDrive, AlertCircle, Braces
} from 'lucide-vue-next';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

interface OPFSEntry {
  name: string;
  kind: 'file' | 'directory';
  handle: FileSystemHandle;
  size?: number;
  lastModified?: number;
}

const TEXT_EXTENSIONS = [
  '.txt', '.md', '.json', '.ts', '.js', '.vue', '.css', '.html', 
  '.xml', '.yaml', '.yml', '.svg', '.gitignore', '.env', '.jsonl'
];

function isTextFile(filename: string): boolean {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  return TEXT_EXTENSIONS.includes(ext) || !filename.includes('.');
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

const currentHandle = ref<FileSystemDirectoryHandle | null>(null);
const pathStack = ref<FileSystemDirectoryHandle[]>([]);
const entries = ref<OPFSEntry[]>([]);
const selectedFile = ref<{ name: string; size: number; isText: boolean; lastModified?: number } | null>(null);
const fileContent = ref<string>('');
const rawFileContent = ref<string>('');
const isFormatted = ref(false);
const error = ref<string | null>(null);

async function loadDirectory(handle: FileSystemDirectoryHandle) {
  try {
    error.value = null;
    const newEntries: OPFSEntry[] = [];
    // @ts-expect-error: values() is not in the standard TS lib for FileSystemDirectoryHandle yet
    for await (const entry of handle.values()) {
      let size: number | undefined;
      let lastModified: number | undefined;
      if (entry.kind === 'file') {
        const file = await (entry as FileSystemFileHandle).getFile();
        size = file.size;
        lastModified = file.lastModified;
      }
      newEntries.push({
        name: entry.name,
        kind: entry.kind,
        handle: entry,
        size,
        lastModified
      });
    }
    // Sort: directories first, then files
    entries.value = newEntries.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return (() => {
        switch (a.kind) {
        case 'directory': return -1;
        case 'file': return 1;
        default: {
          const _ex: never = a.kind;
          return _ex;
        }
        }
      })();
    });
    currentHandle.value = handle;
    selectedFile.value = null;
    fileContent.value = '';
    rawFileContent.value = '';
    isFormatted.value = false;
  } catch (e) {
    error.value = `Failed to load directory: ${e}`;
  }
}

async function navigateTo(entry: OPFSEntry) {
  switch (entry.kind) {
  case 'directory':
    pathStack.value.push(currentHandle.value!);
    await loadDirectory(entry.handle as FileSystemDirectoryHandle);
    break;
  case 'file':
    await viewFile(entry);
    break;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled entry kind: ${_ex}`);
  }
  }
}

async function goUp() {
  const parent = pathStack.value.pop();
  if (parent) {
    await loadDirectory(parent);
  }
}

async function viewFile(entry: OPFSEntry) {
  try {
    const handle = entry.handle as FileSystemFileHandle;
    const file = await handle.getFile();
    const isText = isTextFile(entry.name);
    
    selectedFile.value = {
      name: entry.name,
      size: file.size,
      isText,
      lastModified: file.lastModified
    };

    if (isText) {
      const text = await file.text();
      rawFileContent.value = text;
      
      if (entry.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(text);
          fileContent.value = JSON.stringify(parsed, null, 2);
          isFormatted.value = true;
        } catch (e) {
          fileContent.value = text;
          isFormatted.value = false;
        }
      } else {
        fileContent.value = text;
        isFormatted.value = false;
      }
    } else {
      fileContent.value = '';
      rawFileContent.value = '';
      isFormatted.value = false;
    }
  } catch (e) {
    fileContent.value = `Error reading file: ${e}`;
    isFormatted.value = false;
  }
}

function toggleFormat() {
  if (isFormatted.value) {
    fileContent.value = rawFileContent.value;
    isFormatted.value = false;
  } else {
    try {
      const parsed = JSON.parse(rawFileContent.value);
      fileContent.value = JSON.stringify(parsed, null, 2);
      isFormatted.value = true;
    } catch (e) {
      console.warn('Failed to format as JSON:', e);
    }
  }
}

async function deleteEntry(entry: OPFSEntry) {
  try {
    await currentHandle.value!.removeEntry(entry.name, { recursive: true });
    await loadDirectory(currentHandle.value!);
  } catch (e) {
    error.value = `Failed to delete: ${e}`;
  }
}

async function init() {
  const root = await navigator.storage.getDirectory();
  await loadDirectory(root);
}

watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    init();
  }
}, { immediate: true });

function close() {
  emit('update:modelValue', false);
}
</script>

<template>
  <div v-if="modelValue" class="fixed inset-0 z-[120] flex items-center justify-center p-2 md:p-6 bg-black/50 backdrop-blur-[2px] transition-all">
    <div class="bg-white dark:bg-gray-900 w-full max-w-[95vw] h-[95vh] md:h-[90vh] rounded-3xl shadow-2xl border border-gray-100 dark:border-gray-800 flex flex-col overflow-hidden font-mono animate-in fade-in zoom-in-95 duration-200">
      
      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
            <HardDrive class="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-white leading-none">OPFS Explorer</h3>
            <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-1 uppercase tracking-widest">Debug Tool</p>
          </div>
        </div>
        <button @click="close" class="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-colors">
          <X class="w-5 h-5 text-gray-500" />
        </button>
      </div>

      <!-- Toolbar / Breadcrumbs -->
      <div class="flex items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
        <button 
          @click="goUp" 
          :disabled="pathStack.length === 0"
          class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors"
          data-testid="opfs-back-button"
        >
          <ChevronLeft class="w-4 h-4" />
        </button>
        <div class="flex items-center text-[11px] text-gray-500 dark:text-gray-400 truncate" data-testid="opfs-breadcrumbs">
          <template v-for="(h, i) in pathStack" :key="i">
            <span class="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded" data-testid="breadcrumb-item">{{ h.name || 'root' }}</span>
            <ChevronRight class="w-3 h-3 mx-1 opacity-50" />
          </template>
          <template v-if="currentHandle">
            <span class="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded font-bold" data-testid="breadcrumb-current">{{ currentHandle.name || 'root' }}</span>
          </template>
        </div>
      </div>

      <!-- Main Content -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Explorer Sidebar -->
        <div class="w-72 border-r border-gray-100 dark:border-gray-800 overflow-y-auto bg-gray-50/30 dark:bg-black/20 flex-shrink-0 overscroll-contain">
          <div v-if="error" class="p-4 m-4 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/50 rounded-xl flex gap-3 text-red-600 dark:text-red-400">
            <AlertCircle class="w-4 h-4 shrink-0" />
            <p class="text-xs font-bold">{{ error }}</p>
          </div>

          <div class="p-2 space-y-0.5">
            <div 
              v-for="entry in entries" 
              :key="entry.name"
              @click="navigateTo(entry)"
              class="group flex items-center justify-between p-2 rounded-lg cursor-pointer hover:bg-white dark:hover:bg-gray-800 hover:shadow-sm border border-transparent hover:border-gray-100 dark:hover:border-gray-700 transition-all"
              data-testid="opfs-entry"
            >
              <div class="flex items-center gap-3 min-w-0 flex-1">
                <component :is="entry.kind === 'directory' ? Folder : FileText" 
                           class="w-4 h-4 shrink-0" 
                           :class="entry.kind === 'directory' ? 'text-amber-500' : 'text-blue-500'"
                />
                <div class="flex flex-col min-w-0">
                  <span class="text-xs truncate" :class="selectedFile?.name === entry.name ? 'font-bold text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'">
                    {{ entry.name }}
                  </span>
                  <span v-if="entry.kind === 'file'" class="text-[9px] text-gray-400 font-bold uppercase tracking-tighter flex gap-2">
                    <span>{{ formatSize(entry.size) }}</span>
                    <span v-if="entry.lastModified" class="opacity-60">•</span>
                    <span v-if="entry.lastModified">{{ formatDate(entry.lastModified) }}</span>
                  </span>
                </div>
              </div>
              <button 
                @click.stop="deleteEntry(entry)"
                class="p-1.5 opacity-0 group-hover:opacity-100 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md transition-all"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>

            <div v-if="entries.length === 0" class="p-8 text-center">
              <p class="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Empty Directory</p>
            </div>
          </div>
        </div>

        <!-- File Viewer -->
        <div class="flex-1 overflow-hidden flex flex-col bg-white dark:bg-gray-900 min-w-0">
          <div v-if="selectedFile" class="flex-1 flex flex-col overflow-hidden">
            <div class="px-4 py-2 bg-gray-50 dark:bg-gray-800/30 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between flex-shrink-0">
              <div class="flex items-center gap-3">
                <FileText class="w-3.5 h-3.5 text-blue-500" />
                <div class="flex flex-col">
                  <span class="text-xs font-bold text-gray-600 dark:text-gray-400 leading-none">{{ selectedFile.name }}</span>
                  <div class="flex items-center gap-2 mt-1">
                    <span class="text-[9px] text-gray-400 font-bold uppercase tracking-widest">{{ formatSize(selectedFile.size) }}</span>
                    <span v-if="selectedFile.lastModified" class="text-[9px] text-gray-400 font-bold uppercase tracking-widest opacity-60">•</span>
                    <span v-if="selectedFile.lastModified" class="text-[9px] text-gray-400 font-bold uppercase tracking-widest">{{ formatDate(selectedFile.lastModified) }}</span>
                  </div>
                </div>
              </div>
              <button 
                v-if="selectedFile.isText && selectedFile.name.endsWith('.json')"
                @click="toggleFormat"
                class="px-2 py-1 text-[10px] font-bold border rounded transition-colors flex items-center gap-1.5"
                :class="isFormatted 
                  ? 'bg-blue-600 border-blue-600 text-white shadow-sm' 
                  : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'"
                :title="isFormatted ? 'Show Raw JSON' : 'Format JSON'"
              >
                <Braces class="w-3.5 h-3.5" />
                {{ isFormatted ? 'Formatted' : 'Format JSON' }}
              </button>
            </div>
            <div v-if="selectedFile.isText" class="flex-1 overflow-auto bg-white dark:bg-gray-900 overscroll-contain">
              <pre class="p-6 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300 whitespace-pre selection:bg-blue-100 dark:selection:bg-blue-900/50 min-w-max">{{ fileContent }}</pre>
            </div>
            <div v-else class="flex-1 flex flex-col items-center justify-center text-gray-400 p-8 text-center">
              <div class="p-4 bg-gray-50 dark:bg-gray-800 rounded-3xl mb-4 border border-gray-100 dark:border-gray-700">
                <FileText class="w-12 h-12 opacity-20" />
              </div>
              <p class="text-sm font-bold text-gray-600 dark:text-gray-400 mb-1">Binary File</p>
              <p class="text-[10px] uppercase tracking-widest opacity-50 font-bold">Preview not available for this file type</p>
              <div class="mt-6 px-4 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl">
                <span class="text-[10px] font-bold font-mono">Size: {{ formatSize(selectedFile.size) }} ({{ selectedFile.size.toLocaleString() }} bytes)</span>
              </div>
            </div>
          </div>
          <div v-else class="flex-1 flex flex-col items-center justify-center text-gray-300 dark:text-gray-700">
            <FileText class="w-12 h-12 mb-4 opacity-20" />
            <p class="text-xs font-bold uppercase tracking-widest opacity-50">Select a file to view</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in-95 {
  animation-name: zoom-in;
}
</style>
