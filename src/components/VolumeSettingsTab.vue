<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { onClickOutside, useToggle } from '@vueuse/core';

const vFocus = { mounted: (el: HTMLElement) => el.focus() };
import { storageService } from '@/services/storage';
import { checkOPFSSupport, checkFileSystemAccessSupport } from '@/services/storage/opfs-detection';
import type { Volume, Mount } from '@/models/types';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import {
  Folder,
  FolderInput,
  FolderDown,
  FolderSymlink,
  FolderPlus,
  FileDown,
  Trash2,
  Loader2,
  Eye,
  EyeOff,
  MoreHorizontal,
  Settings2,
  Lock,
  Unlock,
  Check,
  Pencil,
  X,
  Info,
  AlertCircle,
} from 'lucide-vue-next';

const volumes = ref<Volume[]>([]);
const mounts = ref<Mount[]>([]);
const isLoading = ref(false);
const isCreating = ref(false);
const progress = ref<{ processed: number; total: number } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const fileInputSingle = ref<HTMLInputElement | null>(null);
const copyAbortController = ref<AbortController | null>(null);
const copyingLabel = ref('');
const dragCounter = ref(0);
const isDragOver = computed(() => dragCounter.value > 0);
const dragOverlayTarget = computed(() => document.querySelector('[data-settings-main]') ?? 'body');

const hasFileSystemAccess = ref(false);
const hasOPFS = ref(false);
const isDetecting = ref(true);
const isFullyUnsupported = computed(() => !isDetecting.value && !hasFileSystemAccess.value && !hasOPFS.value);

const [isAddFolderInfoOpen, toggleAddFolderInfo] = useToggle(false);
const addFolderInfoRef = ref<HTMLElement | null>(null);
onClickOutside(addFolderInfoRef, () => {
  isAddFolderInfoOpen.value = false;
});

const [isCopyFolderInfoOpen, toggleCopyFolderInfo] = useToggle(false);
const copyFolderInfoRef = ref<HTMLElement | null>(null);
onClickOutside(copyFolderInfoRef, () => {
  isCopyFolderInfoOpen.value = false;
});

const { addToast } = useToast();
const { showConfirm } = useConfirm();

const editingMountId = ref<string | null>(null);
const editForm = ref({
  mountPath: '',
  readOnly: true
});

const editingNameId = ref<string | null>(null);
const editingNameValue = ref('');
const menuOpenVolumeId = ref<string | null>(null);

const mountedVolumes = computed(() => {
  return volumes.value.filter(vol => mounts.value.some(m => m.type === 'volume' && m.volumeId === vol.id));
});

const unmountedVolumes = computed(() => {
  return volumes.value.filter(vol => !mounts.value.some(m => m.type === 'volume' && m.volumeId === vol.id));
});

function formatDate({ timestamp }: { timestamp: number }) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

async function loadData() {
  isLoading.value = true;
  try {
    const list: Volume[] = [];
    for await (const vol of storageService.listVolumes()) {
      list.push(vol);
    }
    volumes.value = list.sort((a, b) => b.createdAt - a.createdAt);

    const settings = await storageService.loadSettings();
    mounts.value = settings?.mounts || [];
  } catch (e) {
    console.error('Failed to load volumes:', e);
    addToast({ message: 'Failed to load folders'});
  } finally {
    isLoading.value = false;
  }
}

function generateUniquePath({ baseName }: { baseName: string }): string {
  let path = `/${baseName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  let suffix = 2;
  const existingPaths = mounts.value.map(m => m.mountPath);

  const originalPath = path;
  while (existingPaths.includes(path)) {
    path = `${originalPath}-${suffix}`;
    suffix++;
  }
  return path;
}

function fileListToEntries({ files }: { files: FileList }): Array<{ file: File; relativePath: string }> {
  const result: Array<{ file: File; relativePath: string }> = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    const parts = file.webkitRelativePath.split('/');
    const relativePath = parts.length > 1 ? parts.slice(1).join('/') : file.name;
    result.push({ file, relativePath });
  }
  return result;
}

async function readDirectoryEntries({ entry, basePath }: { entry: FileSystemDirectoryEntry; basePath: string }): Promise<Array<{ file: File; relativePath: string }>> {
  const result: Array<{ file: File; relativePath: string }> = [];
  const reader = entry.createReader();

  await new Promise<void>((resolve, reject) => {
    function readBatch() {
      reader.readEntries(async (batch) => {
        if (batch.length === 0) { resolve(); return; }
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

async function startCopy({ name, entries, label }: { name: string; entries: Array<{ file: File; relativePath: string }>; label: string }) {
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
      onProgress: (p) => { progress.value = p; },
    });
    await storageService.mountVolume({
      volumeId: vol.id,
      mountPath: generateUniquePath({ baseName: name }),
      readOnly: true,
    });
    await loadData();
    return { name };
  } finally {
    isCreating.value = false;
    progress.value = null;
    copyAbortController.value = null;
  }
}

async function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  const folderName = target.files[0]?.webkitRelativePath.split('/')[0] || 'Imported Folder';
  const entries = fileListToEntries({ files: target.files });

  try {
    await startCopy({ name: folderName, entries, label: 'Copying folder to browser...' });
    addToast({ message: `"${folderName}" added to your folders` });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    console.error('Failed to import volume:', e);
    addToast({ message: `Failed to copy folder: ${(e as Error).message}` });
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function handleSingleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];
  if (!file) return;

  const entries = [{ file, relativePath: file.name }];
  try {
    await startCopy({ name: file.name, entries, label: 'Copying file to browser...' });
    addToast({ message: `"${file.name}" copied to your folders` });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    console.error('Failed to copy file:', e);
    addToast({ message: `Failed to copy file: ${(e as Error).message}` });
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

  // Single directory: copy as folder
  if (fsEntries.length === 1 && fsEntries[0]!.isDirectory) {
    const dirEntry = fsEntries[0] as FileSystemDirectoryEntry;
    const folderName = dirEntry.name;
    try {
      const entries = await readDirectoryEntries({ entry: dirEntry, basePath: '' });
      const normalized = entries.map(e => ({ file: e.file, relativePath: e.relativePath.replace(/^\//, '') }));
      await startCopy({ name: folderName, entries: normalized, label: 'Copying folder to browser...' });
      addToast({ message: `"${folderName}" added to your folders` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      addToast({ message: `Failed to copy folder: ${(e as Error).message}` });
    }
    return;
  }

  // Single file: copy as file
  if (fsEntries.length === 1 && fsEntries[0]!.isFile) {
    const fileEntry = fsEntries[0] as FileSystemFileEntry;
    try {
      const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
      await startCopy({ name: file.name, entries: [{ file, relativePath: file.name }], label: 'Copying file to browser...' });
      addToast({ message: `"${file.name}" copied to your folders` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      addToast({ message: `Failed to copy file: ${(e as Error).message}` });
    }
    return;
  }

  // Multiple items: flatten all files into one folder named after the first entry
  const folderName = fsEntries[0]!.name;
  try {
    const allEntries: Array<{ file: File; relativePath: string }> = [];
    for (const entry of fsEntries) {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        allEntries.push({ file, relativePath: file.name });
      } else if (entry.isDirectory) {
        const nested = await readDirectoryEntries({ entry: entry as FileSystemDirectoryEntry, basePath: entry.name });
        allEntries.push(...nested.map(e => ({ file: e.file, relativePath: e.relativePath.replace(/^\//, '') })));
      }
    }
    await startCopy({ name: folderName, entries: allEntries, label: 'Copying folder to browser...' });
    addToast({ message: `"${folderName}" added to your folders` });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    addToast({ message: `Failed to copy: ${(e as Error).message}` });
  }
}


async function createVolume({ type }: { type: 'opfs' | 'host' }) {
  if (isCreating.value) return;

  switch (type) {
  case 'host': {
    // @ts-expect-error: File System Access API
    if (!window.showDirectoryPicker) {
      addToast({ message: 'Linking external folders is not supported in this browser.'});
      return;
    }

    try {
      // @ts-expect-error: File System Access API
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      isCreating.value = true;
      const name = handle.name;

      const vol = await storageService.createVolume({
        name,
        type: 'host',
        sourceHandle: handle,
      });

      await storageService.mountVolume({
        volumeId: vol.id,
        mountPath: generateUniquePath({ baseName: name }),
        readOnly: true,
      });

      await loadData();
      addToast({ message: `"${name}" added to your folders` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      addToast({ message: `Failed to add folder: ${(e as Error).message}`});
    } finally {
      isCreating.value = false;
    }
    break;
  }
  case 'opfs': {
    const isOPFSSupported = await checkOPFSSupport();
    if (!isOPFSSupported) {
      addToast({ message: 'OPFS is not supported in this browser.'});
      return;
    }

    // @ts-expect-error: File System Access API
    if (window.showDirectoryPicker) {
      try {
        // @ts-expect-error: File System Access API
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        isCreating.value = true;
        const name = handle.name;

        const vol = await storageService.createVolume({
          name,
          type: 'opfs',
          sourceHandle: handle,
        });

        await storageService.mountVolume({
          volumeId: vol.id,
          mountPath: generateUniquePath({ baseName: name }),
          readOnly: true,
        });

        await loadData();
        addToast({ message: `"${name}" copied to your folders` });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        addToast({ message: `Failed to copy folder: ${(e as Error).message}`});
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

function startEditing({ volume }: { volume: Volume }) {
  const mount = mounts.value.find(m => m.type === 'volume' && m.volumeId === volume.id);
  if (!mount) return;

  editingMountId.value = volume.id;
  editForm.value = {
    mountPath: mount.mountPath,
    readOnly: mount.readOnly
  };
}

async function saveMountSettings({ volId }: { volId: string }) {
  try {
    const isCollision = mounts.value.some(m =>
      m.mountPath === editForm.value.mountPath &&
      !(m.type === 'volume' && m.volumeId === volId)
    );

    if (isCollision) {
      addToast({ message: 'Mount path already in use'});
      return;
    }

    if (!editForm.value.mountPath.startsWith('/')) {
      editForm.value.mountPath = '/' + editForm.value.mountPath;
    }

    await storageService.unmountVolume({ volumeId: volId });
    await storageService.mountVolume({
      volumeId: volId,
      mountPath: editForm.value.mountPath,
      readOnly: editForm.value.readOnly
    });

    editingMountId.value = null;
    await loadData();
    addToast({ message: 'Path settings updated' });
  } catch (e) {
    console.error('Failed to update mount settings:', e);
    addToast({ message: 'Failed to update path settings'});
  }
}

async function toggleMount({ volume }: { volume: Volume }) {
  const isCurrentlyMounted = mounts.value.some(m => m.type === 'volume' && m.volumeId === volume.id);
  try {
    if (isCurrentlyMounted) {
      await storageService.unmountVolume({ volumeId: volume.id });
      addToast({ message: `"${volume.name}" is no longer in use` });
    } else {
      await storageService.mountVolume({
        volumeId: volume.id,
        mountPath: generateUniquePath({ baseName: volume.name }),
        readOnly: true,
      });
      addToast({ message: `"${volume.name}" is now in use` });
    }
    await loadData();
  } catch (e) {
    addToast({ message: 'Failed to update'});
  }
}

async function deleteVolume({ volume }: { volume: Volume }) {
  const confirmed = await showConfirm({
    title: 'Delete Folder',
    message: `Are you sure you want to delete "${volume.name}"? This will stop using it and delete all internal data.`,
    confirmButtonText: 'Delete',
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await storageService.unmountVolume({ volumeId: volume.id });
    await storageService.deleteVolume({ volumeId: volume.id });
    await loadData();
    addToast({ message: 'Folder deleted' });
  } catch (e) {
    addToast({ message: 'Failed to delete folder'});
  }
}

function getVolumeMount({ volId }: { volId: string }) {
  return mounts.value.find(m => m.type === 'volume' && m.volumeId === volId);
}

function startEditingName({ volume }: { volume: Volume }) {
  editingNameId.value = volume.id;
  editingNameValue.value = volume.name;
}

function cancelEditingName() {
  editingNameId.value = null;
  editingNameValue.value = '';
}

async function saveVolumeName({ volId }: { volId: string }) {
  const trimmed = editingNameValue.value.trim();
  if (!trimmed) {
    addToast({ message: 'Name cannot be empty' });
    return;
  }
  try {
    await storageService.renameVolume({ volumeId: volId, name: trimmed });
    editingNameId.value = null;
    await loadData();
  } catch (e) {
    console.error('Failed to rename volume:', e);
    addToast({ message: 'Failed to rename folder' });
  }
}

function onDocDragEnter() { dragCounter.value++; }
function onDocDragLeave() { dragCounter.value = Math.max(0, dragCounter.value - 1); }
function onDocDragOver(e: DragEvent) { e.preventDefault(); }
function onDocDrop(e: DragEvent) {
  e.preventDefault();
  dragCounter.value = 0;
  handleDrop({ event: e });
}

onMounted(async () => {
  hasFileSystemAccess.value = checkFileSystemAccessSupport();
  hasOPFS.value = await checkOPFSSupport();
  isDetecting.value = false;
  loadData();

  document.addEventListener('dragenter', onDocDragEnter);
  document.addEventListener('dragleave', onDocDragLeave);
  document.addEventListener('dragover', onDocDragOver);
  document.addEventListener('drop', onDocDrop);
});

onUnmounted(() => {
  document.removeEventListener('dragenter', onDocDragEnter);
  document.removeEventListener('dragleave', onDocDragLeave);
  document.removeEventListener('dragover', onDocDragOver);
  document.removeEventListener('drop', onDocDrop);
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="relative space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <!-- Click-outside overlay for "..." menus -->
    <div v-if="menuOpenVolumeId" class="fixed inset-0 z-40" @click="menuOpenVolumeId = null"></div>

    <!-- Drag-over overlay (covers the settings content area) -->
    <Teleport :to="dragOverlayTarget">
      <div
        v-if="isDragOver"
        data-testid="drag-overlay"
        class="pointer-events-none absolute inset-0 z-[200] bg-blue-500/10 dark:bg-blue-400/10 backdrop-blur-[2px] flex items-center justify-center"
      >
        <div class="flex flex-col items-center gap-4 border-2 border-dashed border-blue-400 dark:border-blue-400 rounded-3xl px-16 py-14 bg-white/80 dark:bg-gray-900/80 shadow-2xl text-blue-600 dark:text-blue-300">
          <FolderDown class="w-14 h-14" />
          <div class="text-center">
            <p class="text-xl font-bold">Drop to copy to browser</p>
            <p class="text-sm font-medium text-blue-500/80 dark:text-blue-400/70 mt-1">Folder or file</p>
          </div>
        </div>
      </div>
    </Teleport>

    <input
      type="file"
      ref="fileInput"
      webkitdirectory
      directory
      multiple
      class="hidden"
      @change="handleFileSelect"
    />
    <input
      type="file"
      ref="fileInputSingle"
      class="hidden"
      @change="handleSingleFileSelect"
    />

    <!-- Upload Progress -->
    <div v-if="isCreating" data-testid="copy-progress" class="rounded-2xl border border-blue-200/70 dark:border-blue-800/50 bg-blue-50/80 dark:bg-blue-950/20 overflow-hidden">
      <div class="px-4 pt-4 pb-3">
        <div class="flex items-center justify-between mb-3">
          <span class="flex items-center gap-2 text-xs font-bold text-blue-700 dark:text-blue-300">
            <Loader2 class="w-3.5 h-3.5 animate-spin shrink-0" />
            {{ copyingLabel }}
          </span>
          <div class="flex items-center gap-3">
            <span v-if="progress" class="text-[11px] font-semibold text-blue-500 dark:text-blue-400 tabular-nums">
              {{ progress.processed }} / {{ progress.total }} files
            </span>
            <button
              data-testid="copy-cancel-btn"
              @click="copyAbortController?.abort()"
              class="text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            >
              Cancel
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

    <!-- Header Actions -->
    <div class="pb-3 border-b border-gray-100 dark:border-gray-800 space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Folder class="w-5 h-5" :class="isFullyUnsupported ? 'text-gray-300 dark:text-gray-600' : 'text-blue-500'" />
          <div>
            <h2 class="text-lg font-bold tracking-tight" :class="isFullyUnsupported ? 'text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-white'">Folders</h2>
            <p class="text-[10px] text-gray-400 dark:text-gray-500 font-medium leading-tight">Give the AI access to files in your folders</p>
          </div>
        </div>
        <div class="flex gap-2">
          <!-- Add Folder: requires File System Access API (Chromium) -->
          <div class="relative" ref="addFolderInfoRef">
            <!-- Single button when available -->
            <button
              v-if="isDetecting || hasFileSystemAccess"
              @click="createVolume({ type: 'host' })"
              :disabled="isCreating || !hasFileSystemAccess || isDetecting"
              class="flex items-center gap-2 px-3 py-2 text-xs font-bold rounded-xl transition-all"
              :class="hasFileSystemAccess && !isDetecting
                ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-300 dark:text-gray-600 cursor-not-allowed border border-gray-200 dark:border-gray-700'"
            >
              <FolderPlus class="w-4 h-4" />
              Add Folder
            </button>
            <!-- Split button with info when unavailable -->
            <div
              v-else
              class="flex items-stretch rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 overflow-hidden"
            >
              <button
                @click="createVolume({ type: 'host' })"
                disabled
                class="flex items-center gap-2 px-3 py-2 text-xs font-bold text-gray-300 dark:text-gray-600 cursor-not-allowed border-r border-gray-200 dark:border-gray-700"
              >
                <FolderPlus class="w-4 h-4" />
                Add Folder
              </button>
              <button
                @click="toggleAddFolderInfo()"
                class="flex items-center px-2 transition-colors"
                :class="isAddFolderInfoOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 hover:text-blue-500 dark:hover:text-blue-400'"
                title="Why is Add Folder disabled?"
              >
                <Info class="w-3.5 h-3.5" />
              </button>
            </div>
            <!-- Popover -->
            <div
              v-if="isAddFolderInfoOpen"
              class="absolute right-0 top-full mt-2 w-64 z-50 bg-white dark:bg-gray-800 border border-blue-100 dark:border-blue-900/40 rounded-xl shadow-lg p-3 space-y-1"
            >
              <p class="text-[11px] font-bold text-blue-600 dark:text-blue-400">Add Folder requires a Chromium-based browser</p>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                Chrome, Edge, Brave, Opera, Vivaldi, or Arc — over HTTPS.
              </p>
            </div>
          </div>

          <!-- Copy Folder: requires OPFS -->
          <div class="relative" ref="copyFolderInfoRef">
            <div
              class="flex items-stretch rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden transition-all"
              :class="hasOPFS && !isDetecting
                ? 'bg-white dark:bg-gray-800 shadow-sm'
                : 'bg-gray-100 dark:bg-gray-800'"
            >
              <button
                @click="createVolume({ type: 'opfs' })"
                :disabled="isCreating || !hasOPFS || isDetecting"
                class="flex items-center gap-2 px-3 py-2 text-xs font-bold transition-all border-r border-gray-200 dark:border-gray-700"
                :class="hasOPFS && !isDetecting
                  ? 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                  : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'"
              >
                <FolderDown class="w-4 h-4" />
                Copy Folder
              </button>
              <button
                @click="toggleCopyFolderInfo()"
                class="flex items-center px-2 transition-colors"
                :class="isCopyFolderInfoOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 hover:text-blue-500 dark:hover:text-blue-400'"
                title="What is Copy Folder?"
              >
                <Info class="w-3.5 h-3.5" />
              </button>
            </div>
            <!-- Popover -->
            <div
              v-if="isCopyFolderInfoOpen"
              class="absolute right-0 top-full mt-2 w-64 z-50 bg-white dark:bg-gray-800 border border-blue-100 dark:border-blue-900/40 rounded-xl shadow-lg p-3 space-y-1"
            >
              <p class="text-[11px] font-bold text-blue-600 dark:text-blue-400">Your original folder is never touched</p>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                A copy is made — your files on disk stay exactly as they are.
              </p>
              <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed pt-1 border-t border-gray-100 dark:border-gray-700">
                The copy is stored in your browser's origin-isolated private storage (OPFS), persists between sessions, and works offline.
              </p>
              <div v-if="hasOPFS && !isDetecting" class="pt-1 border-t border-gray-100 dark:border-gray-700">
                <button
                  @click="fileInputSingle?.click(); toggleCopyFolderInfo(false)"
                  class="flex items-center gap-1.5 text-[11px] text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium transition-colors"
                >
                  <FileDown class="w-3 h-3" />
                  Copy a single file instead
                </button>
              </div>
              <p v-if="!hasOPFS && !isDetecting" class="text-[11px] text-amber-600 dark:text-amber-400 font-medium pt-1">
                Not supported in this browser or context.
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Warning: Nothing is supported -->
      <div v-if="isFullyUnsupported" class="flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-900/30 rounded-xl">
        <AlertCircle class="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
        <p class="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
          Folders are not supported in this browser or context.
          Use a Chromium-based browser (Chrome, Edge, Brave, Opera, Vivaldi, Arc) over HTTPS for full support.
        </p>
      </div>
    </div>

    <div v-if="isLoading && volumes.length === 0" class="flex justify-center p-12">
      <Loader2 class="w-6 h-6 animate-spin text-gray-400" />
    </div>

    <div v-else-if="volumes.length === 0" class="text-center p-16 bg-gray-50/50 dark:bg-gray-800/30 rounded-3xl border border-dashed border-gray-200 dark:border-gray-700">
      <FolderInput class="w-12 h-12 mx-auto text-gray-300 dark:text-gray-600 mb-4" />
      <p class="text-sm font-bold text-gray-500 dark:text-gray-400">No folders configured</p>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-[240px] mx-auto">
        <template v-if="isFullyUnsupported">
          Folders require a Chromium-based browser over HTTPS.
        </template>
        <template v-else-if="!hasFileSystemAccess">
          Use <span class="font-bold">Copy Folder</span> to snapshot a folder into browser storage, or switch to Chrome, Edge, Brave, Opera, Vivaldi, or Arc to also use <span class="font-bold">Add Folder</span>.
        </template>
        <template v-else>
          Add a folder or copy one into browser storage.
        </template>
      </p>
    </div>

    <div v-else class="space-y-10">
      <!-- Mounted Section -->
      <section v-if="mountedVolumes.length > 0" class="space-y-4">
        <div class="flex items-center justify-between px-1">
          <h3 class="text-[10px] font-bold text-blue-500 dark:text-blue-400 uppercase tracking-widest flex items-center gap-2">
            <Eye class="w-3 h-3" />
            In Use
            <span class="text-[9px] font-bold text-blue-300 dark:text-blue-600 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/30 px-1.5 py-0.5 rounded-full normal-case tracking-normal">Global</span>
          </h3>
          <span class="text-[10px] font-bold text-gray-400">{{ mountedVolumes.length }} global</span>
        </div>

        <div class="grid grid-cols-1 gap-4">
          <div
            v-for="volume in mountedVolumes"
            :key="volume.id"
            class="group bg-white dark:bg-gray-800 border border-blue-100 dark:border-blue-900/30 rounded-2xl shadow-sm hover:shadow-md transition-all"
          >
            <div class="p-4 flex items-center justify-between gap-4">
              <div class="flex items-center gap-4 flex-1 min-w-0">
                <div class="p-3 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-500 dark:text-blue-400 shrink-0">
                  <FolderSymlink v-if="volume.type === 'host'" class="w-5 h-5" />
                  <FolderDown v-else class="w-5 h-5" />
                </div>

                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <template v-if="editingNameId === volume.id">
                      <input
                        data-testid="volume-name-input"
                        v-model="editingNameValue"
                        type="text"
                        class="bg-white dark:bg-gray-700 border border-blue-400 rounded px-2 py-0.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none min-w-0 flex-1"
                        @keydown.enter="saveVolumeName({ volId: volume.id })"
                        @keydown.escape="cancelEditingName()"
                        v-focus
                      />
                      <button data-testid="volume-name-save" @click="saveVolumeName({ volId: volume.id })" class="p-1 text-blue-500 hover:text-blue-700 shrink-0" title="Save"><Check class="w-3.5 h-3.5" /></button>
                      <button data-testid="volume-name-cancel" @click="cancelEditingName()" class="p-1 text-gray-400 hover:text-gray-600 shrink-0" title="Cancel"><X class="w-3.5 h-3.5" /></button>
                    </template>
                    <template v-else>
                      <h3 class="font-bold text-gray-800 dark:text-white text-sm truncate">{{ volume.name }}</h3>
                      <button data-testid="volume-rename-btn" @click="startEditingName({ volume })" class="p-1 text-gray-300 hover:text-gray-500 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" title="Rename"><Pencil class="w-3 h-3" /></button>
                    </template>
                  </div>
                  <div class="flex flex-wrap items-center gap-y-1 gap-x-2 mt-0.5">
                    <code class="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 rounded">
                      {{ getVolumeMount({ volId: volume.id })?.mountPath }}
                    </code>
                    <div v-if="getVolumeMount({ volId: volume.id })?.readOnly" class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border border-green-100 dark:border-green-900/30" title="Read Only — your original files are never modified">
                      <Lock class="w-2.5 h-2.5" />
                      <span class="text-[9px] font-bold uppercase tracking-tight">Read Only</span>
                    </div>
                    <span class="text-[10px] text-gray-400 font-medium hidden sm:inline">·</span>
                    <span class="text-[10px] text-gray-400 font-medium">{{ volume.type === 'host' ? 'Linked' : 'Copied' }}</span>
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-1 shrink-0">
                <button
                  @click="startEditing({ volume })"
                  class="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors"
                  title="Configure"
                >
                  <Settings2 class="w-4 h-4" />
                </button>
                <button
                  @click="toggleMount({ volume })"
                  class="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors"
                  title="Stop using"
                >
                  <EyeOff class="w-4 h-4" />
                </button>
                <div class="relative">
                  <button
                    @click.stop="menuOpenVolumeId = menuOpenVolumeId === volume.id ? null : volume.id"
                    class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-xl transition-colors"
                    title="More actions"
                  >
                    <MoreHorizontal class="w-4 h-4" />
                  </button>
                  <div
                    v-if="menuOpenVolumeId === volume.id"
                    class="absolute right-0 top-full mt-1 w-36 z-50 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden"
                  >
                    <button
                      @click="deleteVolume({ volume }); menuOpenVolumeId = null"
                      class="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Inline Edit Panel -->
            <div v-if="editingMountId === volume.id" class="px-4 pb-4 pt-2 border-t border-gray-50 dark:border-gray-700/50 bg-gray-50/30 dark:bg-gray-900/10 rounded-b-2xl overflow-hidden">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label class="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Path</label>
                  <div class="relative">
                    <input
                      v-model="editForm.mountPath"
                      type="text"
                      class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                      placeholder="/mnt/folder"
                    />
                  </div>
                </div>
                <div class="space-y-1.5">
                  <label class="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Access Mode</label>
                  <div class="flex gap-2">
                    <button
                      @click="editForm.readOnly = true"
                      class="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border"
                      :class="editForm.readOnly ? 'bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-800 dark:text-white' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-800 text-gray-400'"
                    >
                      <Lock class="w-3 h-3" />
                      Read Only
                    </button>
                    <button
                      @click="editForm.readOnly = false"
                      class="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border"
                      :class="!editForm.readOnly ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-800 text-gray-400'"
                    >
                      <Unlock class="w-3 h-3" />
                      Read/Write
                    </button>
                  </div>
                </div>
              </div>
              <div class="flex justify-end gap-2 mt-4">
                <button @click="editingMountId = null" class="px-3 py-1.5 text-[10px] font-bold text-gray-400 hover:text-gray-600">Cancel</button>
                <button
                  @click="saveMountSettings({ volId: volume.id })"
                  class="flex items-center gap-2 px-4 py-1.5 bg-blue-600 text-white rounded-lg text-[10px] font-bold hover:bg-blue-700 shadow-sm"
                >
                  <Check class="w-3 h-3" />
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Unmounted Section -->
      <section v-if="unmountedVolumes.length > 0" class="space-y-4">
        <h3 class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest px-1">
          Not in Use
        </h3>
        <div class="grid grid-cols-1 gap-3">
          <div
            v-for="volume in unmountedVolumes"
            :key="volume.id"
            class="group flex items-center justify-between p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-2xl hover:border-gray-200 dark:hover:border-gray-600 transition-all"
          >
            <div class="flex items-center gap-4">
              <div class="p-3 rounded-xl bg-gray-50 dark:bg-gray-700/50 text-gray-400 dark:text-gray-500">
                <FolderSymlink v-if="volume.type === 'host'" class="w-5 h-5" />
                <FolderDown v-else class="w-5 h-5" />
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <template v-if="editingNameId === volume.id">
                    <input
                      data-testid="volume-name-input"
                      v-model="editingNameValue"
                      type="text"
                      class="bg-white dark:bg-gray-700 border border-blue-400 rounded px-2 py-0.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none min-w-0 flex-1"
                      @keydown.enter="saveVolumeName({ volId: volume.id })"
                      @keydown.escape="cancelEditingName()"
                      v-focus
                    />
                    <button data-testid="volume-name-save" @click="saveVolumeName({ volId: volume.id })" class="p-1 text-blue-500 hover:text-blue-700 shrink-0" title="Save"><Check class="w-3.5 h-3.5" /></button>
                    <button data-testid="volume-name-cancel" @click="cancelEditingName()" class="p-1 text-gray-400 hover:text-gray-600 shrink-0" title="Cancel"><X class="w-3.5 h-3.5" /></button>
                  </template>
                  <template v-else>
                    <h3 class="font-bold text-gray-600 dark:text-gray-400 text-sm truncate">{{ volume.name }}</h3>
                    <button data-testid="volume-rename-btn" @click="startEditingName({ volume })" class="p-1 text-gray-300 hover:text-gray-500 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" title="Rename"><Pencil class="w-3 h-3" /></button>
                  </template>
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[10px] text-gray-400 font-medium">{{ volume.type === 'host' ? 'Linked Folder' : 'Copied Folder' }}</span>
                  <span class="text-[10px] text-gray-400 font-medium">·</span>
                  <span class="text-[10px] text-gray-400 font-medium">{{ formatDate({ timestamp: volume.createdAt }) }}</span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1 shrink-0">
              <button
                @click="toggleMount({ volume })"
                class="flex items-center gap-2 px-3 py-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-all font-bold text-[10px]"
              >
                <Eye class="w-3 h-3" />
                Use
              </button>
              <div class="relative">
                <button
                  @click.stop="menuOpenVolumeId = menuOpenVolumeId === volume.id ? null : volume.id"
                  class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-xl transition-colors"
                  title="More actions"
                >
                  <MoreHorizontal class="w-4 h-4" />
                </button>
                <div
                  v-if="menuOpenVolumeId === volume.id"
                  class="absolute right-0 top-full mt-1 w-36 z-50 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden"
                >
                  <button
                    @click="deleteVolume({ volume }); menuOpenVolumeId = null"
                    class="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
