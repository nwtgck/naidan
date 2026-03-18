<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { storageService } from '@/services/storage';
import type { Volume } from '@/models/types';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { HardDrive, FolderInput, Copy, Trash2, FolderOpen, Loader2 } from 'lucide-vue-next';

const volumes = ref<Volume[]>([]);
const isLoading = ref(false);
const isCreating = ref(false);

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

async function createVolume(type: 'opfs' | 'host') {
  if (isCreating.value) return;
  
  try {
    // @ts-ignore - File System Access API types might be missing in some environments
    if (!window.showDirectoryPicker) {
      addToast({ message: 'Your browser does not support File System Access API', type: 'error' });
      return;
    }

    // @ts-ignore
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
    });

    isCreating.value = true;
    const name = handle.name;

    await storageService.createVolume({
      name,
      type: type,
      sourceHandle: handle,
    });

    await loadVolumes();
    addToast({ message: `Volume "${name}" added successfully` });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return; // User cancelled
    console.error('Failed to create volume:', e);
    addToast({ message: `Failed to create volume: ${(e as Error).message}`, type: 'error' });
  } finally {
    isCreating.value = false;
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
</script>

<template>
  <div class="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-400">
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
