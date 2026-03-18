<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { storageService } from '@/services/storage';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import type { Volume } from '@/models/types';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { HardDrive, FolderInput, Copy, Trash2, FolderOpen, Loader2 } from 'lucide-vue-next';

const volumes = ref<Volume[]>([]);
const isLoading = ref(false);
const isCreating = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const { addToast } = useToast();
const { showConfirm } = useConfirm();

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

async function loadVolumes() {
  isLoading.value = true;
  try {
    const list: Volume[] = [];
    for await (const vol of storageService.listVolumes()) {
      list.push(vol);
    }
    volumes.value = list.sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    console.error('Failed to load volumes:', e);
    addToast({ message: 'Failed to load volumes', type: 'error' });
  } finally {
    isLoading.value = false;
  }
}

async function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  isCreating.value = true;
  try {
    const files = target.files;
    // webkitRelativePath is like "FolderName/Sub/File.txt"
    const firstFile = files[0];
    const folderName = firstFile.webkitRelativePath.split('/')[0] || 'Imported Folder';

    await storageService.createVolumeFromFiles({
      name: folderName,
      files: files
    });

    await loadVolumes();
    addToast({ message: `Volume "${folderName}" imported successfully` });
  } catch (e) {
    console.error('Failed to import volume:', e);
    addToast({ message: `Failed to import volume: ${(e as Error).message}`, type: 'error' });
  } finally {
    isCreating.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function createVolume(type: 'opfs' | 'host') {
  if (isCreating.value) return;

  switch (type) {
  case 'host': {
    // @ts-expect-error: File System Access API
    if (!window.showDirectoryPicker) {
      addToast({ message: 'Linking external folders is not supported in this browser (File System Access API required).', type: 'error' });
      return;
    }

    try {
      // @ts-expect-error: File System Access API
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
      });

      isCreating.value = true;
      const name = handle.name;

      await storageService.createVolume({
        name,
        type: 'host',
        sourceHandle: handle,
      });

      await loadVolumes();
      addToast({ message: `Volume "${name}" linked successfully` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      console.error('Failed to link volume:', e);
      addToast({ message: `Failed to link volume: ${(e as Error).message}`, type: 'error' });
    } finally {
      isCreating.value = false;
    }
    return;
  }
  case 'opfs':
    // OPFS Import Logic continues...
    break;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled volume type: ${(_ex as { type: string }).type}`);
  }
  }

  // OPFS Import Logic
  const isOPFSSupported = await checkOPFSSupport();
  if (!isOPFSSupported) {
    addToast({ message: 'Origin Private File System is not supported in this browser.', type: 'error' });
    return;
  }

  // @ts-expect-error: File System Access API
  if (window.showDirectoryPicker) {
    // Use File System Access API for better UX
    try {
      // @ts-expect-error: File System Access API
      const handle = await window.showDirectoryPicker({
        mode: 'read', // Read-only is enough for copy source
      });

      isCreating.value = true;
      const name = handle.name;

      await storageService.createVolume({
        name,
        type: 'opfs',
        sourceHandle: handle,
      });

      await loadVolumes();
      addToast({ message: `Volume "${name}" imported successfully` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      console.error('Failed to import volume:', e);
      addToast({ message: `Failed to import volume: ${(e as Error).message}`, type: 'error' });
    } finally {
      isCreating.value = false;
    }
  } else {
    // Fallback to <input type="file" webkitdirectory>
    fileInput.value?.click();
  }
}

async function deleteVolume(vol: Volume) {
  const confirmed = await showConfirm({
    title: 'Delete Volume',
    message: `Are you sure you want to delete volume "${vol.name}"? This cannot be undone.`,
    confirmButtonText: 'Delete',
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await storageService.deleteVolume({ volumeId: vol.id });
    await loadVolumes();
    addToast({ message: 'Volume deleted' });
  } catch (e) {
    console.error('Failed to delete volume:', e);
    addToast({ message: 'Failed to delete volume', type: 'error' });
  }
}

onMounted(() => {
  loadVolumes();
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <input
      type="file"
      ref="fileInput"
      webkitdirectory
      directory
      multiple
      class="hidden"
      @change="handleFileSelect"
    />

    <div v-if="isCreating" class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-100 dark:border-blue-900/30">
      <div class="flex items-center justify-between text-xs font-bold text-blue-700 dark:text-blue-300 mb-2">
        <span>Copying files...</span>
        <span>{{ progress?.processed }} / {{ progress?.total }}</span>
      </div>
      <div class="h-1.5 w-full bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
        <div
          class="h-full bg-blue-600 transition-all duration-300"
          :style="{ width: `${progress ? (progress.processed / progress.total) * 100 : 0}%` }"
        ></div>
      </div>
    </div>

    <div class="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
      <div class="flex items-center gap-2">
        <HardDrive class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Volumes</h2>
      </div>
      <div class="flex gap-2">
        <button
          @click="createVolume('host')"
          :disabled="isCreating"
          class="flex items-center gap-2 px-3 py-2 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-xl text-xs font-bold transition-all"
        >
          <FolderOpen class="w-4 h-4" />
          Link Folder
        </button>
        <button
          @click="createVolume('opfs')"
          :disabled="isCreating"
          class="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-blue-500/20"
        >
          <Copy class="w-4 h-4" />
          Import (Copy)
        </button>
      </div>
    </div>

    <div v-if="isLoading && volumes.length === 0" class="flex justify-center p-12">
      <Loader2 class="w-6 h-6 animate-spin text-gray-400" />
    </div>

    <div v-else-if="volumes.length === 0" class="text-center p-12 bg-gray-50/50 dark:bg-gray-800/30 rounded-3xl border border-dashed border-gray-200 dark:border-gray-700">
      <FolderInput class="w-12 h-12 mx-auto text-gray-300 dark:text-gray-600 mb-3" />
      <p class="text-sm font-bold text-gray-500 dark:text-gray-400">No volumes configured</p>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">Link an external folder or copy one to internal storage.</p>
    </div>

    <div v-else class="grid grid-cols-1 gap-4">
      <div
        v-for="vol in volumes"
        :key="vol.id"
        class="group flex items-center justify-between p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-2xl hover:border-blue-200 dark:hover:border-blue-900/50 transition-all"
      >
        <div class="flex items-center gap-4">
          <div class="p-3 rounded-xl bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
            <FolderOpen v-if="vol.type === 'host'" class="w-5 h-5" />
            <HardDrive v-else class="w-5 h-5" />
          </div>
          <div>
            <h3 class="font-bold text-gray-800 dark:text-white text-sm">{{ vol.name }}</h3>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md"
                    :class="vol.type === 'host'
                      ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'
                      : 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'"
              >
                {{ vol.type === 'host' ? 'Linked' : 'Copied' }}
              </span>
              <span class="text-xs text-gray-400">{{ formatDate(vol.createdAt) }}</span>
            </div>
          </div>
        </div>

        <button
          @click="deleteVolume(vol)"
          class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors opacity-0 group-hover:opacity-100"
          title="Delete Volume"
        >
          <Trash2 class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>
