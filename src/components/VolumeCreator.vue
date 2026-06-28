<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { ensureStrings, lazyStrings } from '@/strings';
import { onClickOutside, useToggle } from '@vueuse/core';
import { storageService } from '@/00-storage/service';
import { checkOPFSSupport, checkFileSystemAccessSupport } from '@/lib/opfs-detection';
import { useToast } from '@/composables/useToast';
import {
  FolderDownIcon,
  FolderPlusIcon,
  FileDownIcon,
  LockIcon,
  PencilIcon,
  InfoIcon,
} from 'lucide-vue-next';
import type { VolumeId } from '@/01-models/ids';

const props = defineProps<{
  /** Existing mount paths used to avoid conflicts when suggesting a default path. */
  existingMountPaths: string[],
  /** Prefix prepended when generating a suggested mount path (e.g. '/' or '/home/user/'). */
  mountPathPrefix: string,
  /** CSS selector for the drag-overlay Teleport target. Omit to disable drag-drop. */
  dragOverlayTarget?: string,
}>();

const emit = defineEmits<{
  /**
   * Fired after a volume is created. The parent is responsible for mounting it
   * (globally via storageService or as a chat group mount).
   */
  created: [{ volumeId: VolumeId, mountPath: string, readOnly: boolean }],
}>();

const { addToast } = useToast();

const isCreating = ref(false);
const progress = ref<{ processed: number, total: number } | null>(null);
const copyAbortController = ref<AbortController | null>(null);
const copyingLabel = ref('');

const hasFileSystemAccess = ref(false);
const hasOPFS = ref(false);
const isDetecting = ref(true);
const isFullyUnsupported = computed(() => !isDetecting.value && !hasFileSystemAccess.value && !hasOPFS.value);

const [isAddFolderInfoOpen, toggleAddFolderInfo] = useToggle(false);
const [isAddFolderModeOpen, toggleAddFolderMode] = useToggle(false);
const addFolderInfoRef = ref<HTMLElement | null>(null);
onClickOutside(addFolderInfoRef, () => {
  isAddFolderInfoOpen.value = false;
  toggleAddFolderMode(false);
});

const [isCopyFolderInfoOpen, toggleCopyFolderInfo] = useToggle(false);
const copyFolderInfoRef = ref<HTMLElement | null>(null);
onClickOutside(copyFolderInfoRef, () => {
  isCopyFolderInfoOpen.value = false;
});

const fileInput = ref<HTMLInputElement | null>(null);
const fileInputSingle = ref<HTMLInputElement | null>(null);

// Drag-drop state (only used when dragOverlayTarget is set)
const dragCounter = ref(0);
const isDragOver = computed(() => dragCounter.value > 0);

function generateSuggestedPath({ baseName }: { baseName: string }): string {
  const sanitized = baseName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  let path = `${props.mountPathPrefix}${sanitized}`;
  const existingPaths = props.existingMountPaths;
  let suffix = 2;
  const basePath = path;
  while (existingPaths.includes(path)) {
    path = `${basePath}-${suffix}`;
    suffix++;
  }
  return path;
}

function fileListToEntries({ files }: { files: FileList }): Array<{ file: File, relativePath: string }> {
  const result: Array<{ file: File, relativePath: string }> = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    const parts = file.webkitRelativePath.split('/');
    const relativePath = parts.length > 1 ? parts.slice(1).join('/') : file.name;
    result.push({ file, relativePath });
  }
  return result;
}

async function readDirectoryEntries({ entry, basePath }: { entry: FileSystemDirectoryEntry, basePath: string }): Promise<Array<{ file: File, relativePath: string }>> {
  const result: Array<{ file: File, relativePath: string }> = [];
  const reader = entry.createReader();

  await new Promise<void>((resolve, reject) => {
    function readBatch() {
      reader.readEntries(async (batch) => {
        if (batch.length === 0) {
          resolve(); return;
        }
        for (const child of batch) {
          if (child.isFile) {
            const file = await new Promise<File>((res, rej) => (child as FileSystemFileEntry).file(res, rej));
            result.push({ file, relativePath: `${basePath}/${file.name}` });
          } else if (child.isDirectory) {
            const nested = await readDirectoryEntries({ entry: child as FileSystemDirectoryEntry, basePath: `${basePath}/${child.name}` });
            result.push(...nested);
          }
        }
        readBatch();
      }, reject);
    }
    readBatch();
  });

  return result;
}

async function startCopyAndEmit({ name, entries, label, readOnly }: {
  name: string,
  entries: Array<{ file: File, relativePath: string }>,
  label: string,
  readOnly: boolean,
}) {
  const controller = new AbortController();
  copyAbortController.value = controller;
  copyingLabel.value = label;
  isCreating.value = true;
  progress.value = null;
  try {
    const vol = await storageService.createVolumeFromFiles({
      name,
      entries,
      signal: controller.signal,
      onProgress: ({ processed, total }) => {
        progress.value = { processed, total };
      },
    });
    emit('created', { volumeId: vol.id, mountPath: generateSuggestedPath({ baseName: name }), readOnly });
    return vol;
  } finally {
    isCreating.value = false;
    progress.value = null;
    copyAbortController.value = null;
  }
}

async function handleFileSelect({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  const folderName = target.files[0]?.webkitRelativePath.split('/')[0] || await ensureStrings.volumes__imported_folder();
  const entries = fileListToEntries({ files: target.files });

  try {
    await startCopyAndEmit({ name: folderName, entries, label: await ensureStrings.volumes__copying_folder_to_browser(), readOnly: true });
    addToast({ message: await ensureStrings.volumes__folder_added_to_your_folders({ name: folderName }) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    console.error('Failed to import volume:', e);
    addToast({ message: await ensureStrings.volumes__failed_to_copy_folder({ errorMessage: (e as Error).message }) });
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function handleSingleFileSelect({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];
  if (!file) return;

  const entries = [{ file, relativePath: file.name }];
  try {
    await startCopyAndEmit({ name: file.name, entries, label: await ensureStrings.volumes__copying_file_to_browser(), readOnly: true });
    addToast({ message: await ensureStrings.volumes__file_copied_to_your_folders({ name: file.name }) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    console.error('Failed to copy file:', e);
    addToast({ message: await ensureStrings.volumes__failed_to_copy_file({ errorMessage: (e as Error).message }) });
  } finally {
    if (fileInputSingle.value) fileInputSingle.value.value = '';
  }
}

async function handleDrop({ event }: { event: DragEvent }) {
  if (isCreating.value) return;
  event.preventDefault();

  const items = Array.from(event.dataTransfer?.items ?? []).filter(i => i.kind === 'file');
  if (items.length === 0) return;

  const fsEntries = items.map(i => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  if (fsEntries.length === 0) return;

  if (fsEntries.length === 1 && fsEntries[0]!.isDirectory) {
    const dirEntry = fsEntries[0] as FileSystemDirectoryEntry;
    const folderName = dirEntry.name;
    try {
      const entries = await readDirectoryEntries({ entry: dirEntry, basePath: '' });
      const normalized = entries.map(e => ({ file: e.file, relativePath: e.relativePath.replace(/^\//, '') }));
      await startCopyAndEmit({ name: folderName, entries: normalized, label: await ensureStrings.volumes__copying_folder_to_browser(), readOnly: true });
      addToast({ message: await ensureStrings.volumes__folder_added_to_your_folders({ name: folderName }) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      addToast({ message: await ensureStrings.volumes__failed_to_copy_folder({ errorMessage: (e as Error).message }) });
    }
    return;
  }

  if (fsEntries.length === 1 && fsEntries[0]!.isFile) {
    const fileEntry = fsEntries[0] as FileSystemFileEntry;
    try {
      const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
      await startCopyAndEmit({ name: file.name, entries: [{ file, relativePath: file.name }], label: await ensureStrings.volumes__copying_file_to_browser(), readOnly: true });
      addToast({ message: await ensureStrings.volumes__file_copied_to_your_folders({ name: file.name }) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      addToast({ message: await ensureStrings.volumes__failed_to_copy_file({ errorMessage: (e as Error).message }) });
    }
    return;
  }

  const folderName = fsEntries[0]!.name;
  try {
    const allEntries: Array<{ file: File, relativePath: string }> = [];
    for (const entry of fsEntries) {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        allEntries.push({ file, relativePath: file.name });
      } else if (entry.isDirectory) {
        const nested = await readDirectoryEntries({ entry: entry as FileSystemDirectoryEntry, basePath: entry.name });
        allEntries.push(...nested.map(e => ({ file: e.file, relativePath: e.relativePath.replace(/^\//, '') })));
      }
    }
    await startCopyAndEmit({ name: folderName, entries: allEntries, label: await ensureStrings.volumes__copying_folder_to_browser(), readOnly: true });
    addToast({ message: await ensureStrings.volumes__folder_added_to_your_folders({ name: folderName }) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    addToast({ message: await ensureStrings.volumes__failed_to_copy({ errorMessage: (e as Error).message }) });
  }
}

async function pickHostVolume({ mode }: { mode: 'read' | 'readwrite' }) {
  toggleAddFolderMode(false);
  try {
    // @ts-expect-error: File System Access API
    const handle = await window.showDirectoryPicker({ mode }) as FileSystemDirectoryHandle;
    isCreating.value = true;
    const name = handle.name;
    const vol = await storageService.createVolume({ name, type: 'host', sourceHandle: handle });
    emit('created', { volumeId: vol.id, mountPath: generateSuggestedPath({ baseName: name }), readOnly: mode === 'read' });
    addToast({ message: await ensureStrings.volumes__folder_added_to_your_folders({ name }) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    addToast({ message: await ensureStrings.volumes__failed_to_add_folder_with_error({ errorMessage: (e as Error).message }) });
  } finally {
    isCreating.value = false;
  }
}

async function createVolume({ type }: { type: 'opfs' | 'host' }) {
  if (isCreating.value) return;

  switch (type) {
  case 'host': {
    // @ts-expect-error: File System Access API
    if (!window.showDirectoryPicker) {
      addToast({ message: await ensureStrings.volumes__linking_external_folders_not_supported() });
      return;
    }
    toggleAddFolderMode(true);
    break;
  }
  case 'opfs': {
    const isOPFSSupported = await checkOPFSSupport();
    if (!isOPFSSupported) {
      addToast({ message: await ensureStrings.volumes__opfs_not_supported() });
      return;
    }
    // @ts-expect-error: File System Access API
    if (window.showDirectoryPicker) {
      try {
        // @ts-expect-error: File System Access API
        const handle = await window.showDirectoryPicker({ mode: 'read' }) as FileSystemDirectoryHandle;
        isCreating.value = true;
        const name = handle.name;
        const vol = await storageService.createVolume({ name, type: 'opfs', sourceHandle: handle });
        emit('created', { volumeId: vol.id, mountPath: generateSuggestedPath({ baseName: name }), readOnly: true });
        addToast({ message: await ensureStrings.volumes__file_copied_to_your_folders({ name }) });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        addToast({ message: await ensureStrings.volumes__failed_to_copy_folder({ errorMessage: (e as Error).message }) });
      } finally {
        isCreating.value = false;
      }
    } else {
      fileInput.value?.click();
    }
    break;
  }
  default: {
    const _exhaustive: never = type;
    throw new Error(`Unhandled volume type: ${_exhaustive}`);
  }
  }
}

function onDocDragEnter() {
  dragCounter.value++;
}
function onDocDragLeave() {
  dragCounter.value = Math.max(0, dragCounter.value - 1);
}
function onDocDragOver({ event }: { event: DragEvent }) {
  event.preventDefault();
}
function onDocDrop({ event }: { event: DragEvent }) {
  event.preventDefault();
  dragCounter.value = 0;
  handleDrop({ event });
}

const handleDocumentDragOver: EventListener = (event) => {
  onDocDragOver({ event: event as DragEvent });
};

const handleDocumentDrop: EventListener = (event) => {
  onDocDrop({ event: event as DragEvent });
};

onMounted(async () => {
  hasFileSystemAccess.value = checkFileSystemAccessSupport();
  hasOPFS.value = await checkOPFSSupport();
  isDetecting.value = false;

  if (props.dragOverlayTarget) {
    document.addEventListener('dragenter', onDocDragEnter);
    document.addEventListener('dragleave', onDocDragLeave);
    document.addEventListener('dragover', handleDocumentDragOver);
    document.addEventListener('drop', handleDocumentDrop);
  }
});

onUnmounted(() => {
  if (props.dragOverlayTarget) {
    document.removeEventListener('dragenter', onDocDragEnter);
    document.removeEventListener('dragleave', onDocDragLeave);
    document.removeEventListener('dragover', handleDocumentDragOver);
    document.removeEventListener('drop', handleDocumentDrop);
  }
});


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="space-y-3">
    <!-- Drag-over overlay -->
    <Teleport v-if="dragOverlayTarget && isDragOver" :to="dragOverlayTarget ?? 'body'">
      <div
        data-testid="drag-overlay"
        class="pointer-events-none absolute inset-0 z-[200] bg-blue-500/10 dark:bg-blue-400/10 backdrop-blur-[2px] flex items-center justify-center"
      >
        <div class="flex flex-col items-center gap-4 border-2 border-dashed border-blue-400 dark:border-blue-400 rounded-3xl px-16 py-14 bg-white/80 dark:bg-gray-900/80 shadow-2xl text-blue-600 dark:text-blue-300">
          <FolderDownIcon class="w-14 h-14" />
          <div class="text-center">
            <p class="text-xl font-bold">{{ lazyStrings.volumes__drop_to_copy_to_browser() }}</p>
            <p class="text-sm font-medium text-blue-500/80 dark:text-blue-400/70 mt-1">{{ lazyStrings.volumes__folder_or_file() }}</p>
          </div>
        </div>
      </div>
    </Teleport>

    <input type="file" ref="fileInput" webkitdirectory directory multiple class="hidden" @change="handleFileSelect({ event: $event })" />
    <input type="file" ref="fileInputSingle" class="hidden" @change="handleSingleFileSelect({ event: $event })" />

    <!-- Upload Progress -->
    <div v-if="isCreating" data-testid="copy-progress" class="rounded-2xl border border-blue-200/70 dark:border-blue-800/50 bg-blue-50/80 dark:bg-blue-950/20 overflow-hidden">
      <div class="px-4 pt-4 pb-3">
        <div class="flex items-center justify-between mb-3">
          <span class="flex items-center gap-2 text-xs font-bold text-blue-700 dark:text-blue-300">
            <FolderDownIcon class="w-3.5 h-3.5 animate-pulse shrink-0" />
            {{ copyingLabel }}
          </span>
          <div class="flex items-center gap-3">
            <span v-if="progress" class="text-[11px] font-semibold text-blue-500 dark:text-blue-400 tabular-nums">
              {{ lazyStrings.volumes__file_progress({ processed: progress.processed, total: progress.total }) }}
            </span>
            <button
              data-testid="copy-cancel-btn"
              @click="copyAbortController?.abort()"
              class="text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            >
              {{ lazyStrings.volumes__cancel() }}
            </button>
          </div>
        </div>
        <div class="h-1 w-full bg-blue-200/70 dark:bg-blue-800/50 rounded-full overflow-hidden">
          <div
            class="h-full bg-blue-500 dark:bg-blue-400 rounded-full transition-all duration-200"
            :style="{ width: `${progress ? (progress.processed / progress.total) * 100 : 5}%` }"
          ></div>
        </div>
      </div>
    </div>

    <!-- Buttons row -->
    <div v-if="!isFullyUnsupported" class="flex gap-2 flex-wrap">
      <!-- Add Folder button -->
      <div class="relative" ref="addFolderInfoRef">
        <button
          v-if="isDetecting || hasFileSystemAccess"
          data-testid="add-folder-btn"
          @click="createVolume({ type: 'host' })"
          :disabled="isCreating || !hasFileSystemAccess || isDetecting"
          class="flex items-center gap-2 px-3 py-2 text-xs font-bold rounded-xl transition-all"
          :class="hasFileSystemAccess && !isDetecting
            ? (isAddFolderModeOpen ? 'bg-blue-700 text-white shadow-lg shadow-blue-500/20' : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20')
            : 'bg-gray-100 dark:bg-gray-800 text-gray-300 dark:text-gray-600 cursor-not-allowed border border-gray-200 dark:border-gray-700'"
        >
          <FolderPlusIcon class="w-4 h-4" />
          {{ lazyStrings.volumes__add_folder() }}
        </button>
        <div
          v-else
          class="flex items-stretch rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 overflow-hidden"
        >
          <button disabled class="flex items-center gap-2 px-3 py-2 text-xs font-bold text-gray-300 dark:text-gray-600 cursor-not-allowed border-r border-gray-200 dark:border-gray-700">
            <FolderPlusIcon class="w-4 h-4" />
            {{ lazyStrings.volumes__add_folder() }}
          </button>
          <button
            @click="toggleAddFolderInfo()"
            class="flex items-center px-2 transition-colors"
            :class="isAddFolderInfoOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 hover:text-blue-500 dark:hover:text-blue-400'"
            :title="lazyStrings.volumes__why_add_folder_disabled()"
          >
            <InfoIcon class="w-3.5 h-3.5" />
          </button>
        </div>
        <!-- Mode selector popover -->
        <div
          v-if="isAddFolderModeOpen"
          data-testid="add-folder-mode-panel"
          class="absolute left-0 top-full mt-2 w-64 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl overflow-hidden"
        >
          <p class="px-3 pt-3 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">{{ lazyStrings.volumes__choose_access_level() }}</p>
          <p class="px-3 pb-1.5 text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.volumes__change_access_later() }}</p>
          <button
            data-testid="add-folder-read-only-btn"
            @click="pickHostVolume({ mode: 'read' })"
            class="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
          >
            <LockIcon class="w-4 h-4 mt-0.5 shrink-0 text-green-500" />
            <div>
              <p class="text-xs font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.volumes__read_only() }}</p>
              <p class="text-[10px] text-gray-400 dark:text-gray-500 leading-tight">{{ lazyStrings.volumes__ai_can_read_not_write() }}</p>
            </div>
          </button>
          <button
            data-testid="add-folder-readwrite-btn"
            @click="pickHostVolume({ mode: 'readwrite' })"
            class="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left border-t border-gray-100 dark:border-gray-800"
          >
            <PencilIcon class="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
            <div>
              <p class="text-xs font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.volumes__read_write() }}</p>
              <p class="text-[10px] text-gray-400 dark:text-gray-500 leading-tight">{{ lazyStrings.volumes__ai_can_read_and_modify_files() }}</p>
            </div>
          </button>
        </div>
        <!-- Info popover (when unavailable) -->
        <div
          v-if="isAddFolderInfoOpen"
          class="absolute left-0 top-full mt-2 w-64 z-50 bg-white dark:bg-gray-800 border border-blue-100 dark:border-blue-900/40 rounded-xl shadow-lg p-3 space-y-1"
        >
          <p class="text-[11px] font-bold text-blue-600 dark:text-blue-400">{{ lazyStrings.volumes__add_folder_requires_chromium() }}</p>
          <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.volumes__chromium_browser_over_https() }}
          </p>
        </div>
      </div>

      <!-- Copy Folder button -->
      <div class="relative" ref="copyFolderInfoRef">
        <div
          class="flex items-stretch rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden transition-all"
          :class="hasOPFS && !isDetecting ? 'bg-white dark:bg-gray-800 shadow-sm' : 'bg-gray-100 dark:bg-gray-800'"
        >
          <button
            @click="createVolume({ type: 'opfs' })"
            :disabled="isCreating || !hasOPFS || isDetecting"
            class="flex items-center gap-2 px-3 py-2 text-xs font-bold transition-all border-r border-gray-200 dark:border-gray-700"
            :class="hasOPFS && !isDetecting
              ? 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
              : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'"
          >
            <FolderDownIcon class="w-4 h-4" />
            {{ lazyStrings.volumes__copy_folder() }}
          </button>
          <button
            @click="toggleCopyFolderInfo()"
            class="flex items-center px-2 transition-colors"
            :class="isCopyFolderInfoOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 hover:text-blue-500 dark:hover:text-blue-400'"
            :title="lazyStrings.volumes__what_is_copy_folder()"
          >
            <InfoIcon class="w-3.5 h-3.5" />
          </button>
        </div>
        <div
          v-if="isCopyFolderInfoOpen"
          class="absolute left-0 top-full mt-2 w-64 z-50 bg-white dark:bg-gray-800 border border-blue-100 dark:border-blue-900/40 rounded-xl shadow-lg p-3 space-y-1"
        >
          <p class="text-[11px] font-bold text-blue-600 dark:text-blue-400">{{ lazyStrings.volumes__original_folder_is_never_touched() }}</p>
          <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.volumes__copy_does_not_change_disk_files() }}
          </p>
          <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed pt-1 border-t border-gray-100 dark:border-gray-700">
            {{ lazyStrings.volumes__copy_is_stored_in_browser_opfs() }}
          </p>
          <div v-if="hasOPFS && !isDetecting" class="pt-1 border-t border-gray-100 dark:border-gray-700">
            <button
              @click="fileInputSingle?.click(); toggleCopyFolderInfo(false)"
              class="flex items-center gap-1.5 text-[11px] text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium transition-colors"
            >
              <FileDownIcon class="w-3 h-3" />
              {{ lazyStrings.volumes__copy_single_file_instead() }}
            </button>
          </div>
          <p v-if="!hasOPFS && !isDetecting" class="text-[11px] text-amber-600 dark:text-amber-400 font-medium pt-1">
            {{ lazyStrings.volumes__not_supported_in_browser_or_context() }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
