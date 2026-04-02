<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { storageService } from '@/services/storage';
import type { Volume, Mount } from '@/models/types';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { FolderIcon, FolderInputIcon, Loader2Icon } from 'lucide-vue-next';
import VolumeCreator from './VolumeCreator.vue';
import VolumeMountList from './VolumeMountList.vue';

const volumes = ref<Volume[]>([]);
const mounts = ref<Mount[]>([]);
const isLoading = ref(false);

const { addToast } = useToast();
const { showConfirm } = useConfirm();

const existingMountPaths = computed(() => mounts.value.map(m => m.mountPath));

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
    addToast({ message: 'Failed to load folders' });
  } finally {
    isLoading.value = false;
  }
}

// --- VolumeCreator event handler ---

async function handleVolumeCreated({ volumeId, mountPath, readOnly }: { volumeId: string; mountPath: string; readOnly: boolean }) {
  try {
    await storageService.mountVolume({ volumeId, mountPath, readOnly });
    await loadData();
  } catch (e) {
    addToast({ message: 'Failed to add folder' });
  }
}

// --- VolumeMountList event handlers ---

async function handleMountAdd({ volumeId, mountPath, readOnly }: { volumeId: string; mountPath: string; readOnly: boolean }) {
  try {
    await storageService.mountVolume({ volumeId, mountPath, readOnly });
    const vol = volumes.value.find(v => v.id === volumeId);
    if (vol) addToast({ message: `"${vol.name}" is now in use` });
    await loadData();
  } catch (e) {
    addToast({ message: 'Failed to add folder' });
  }
}

async function handleMountRemove({ volumeId }: { volumeId: string }) {
  try {
    const vol = volumes.value.find(v => v.id === volumeId);
    await storageService.unmountVolume({ volumeId });
    if (vol) addToast({ message: `"${vol.name}" is no longer in use` });
    await loadData();
  } catch (e) {
    addToast({ message: 'Failed to remove folder' });
  }
}

async function handleMountUpdate({ volumeId, mountPath, readOnly }: { volumeId: string; mountPath: string; readOnly: boolean }) {
  try {
    const isCollision = mounts.value.some(m =>
      m.mountPath === mountPath && !(m.type === 'volume' && m.volumeId === volumeId)
    );
    if (isCollision) {
      addToast({ message: 'Mount path already in use' });
      return;
    }
    await storageService.unmountVolume({ volumeId });
    await storageService.mountVolume({ volumeId, mountPath, readOnly });
    await loadData();
    addToast({ message: 'Path settings updated' });

    const volume = volumes.value.find(v => v.id === volumeId);
    if (volume) {
      switch (volume.type) {
      case 'host': {
        const handle = await storageService.getVolumeDirectoryHandle({ volumeId });
        if (handle) {
          const mode = readOnly ? 'read' : 'readwrite';
          // @ts-expect-error: File System Access API
          const current = await handle.queryPermission({ mode });
          if (current !== 'granted') {
            // @ts-expect-error: File System Access API
            const result = await handle.requestPermission({ mode });
            if (result !== 'granted') {
              addToast({ message: 'Permission denied. The folder may not be accessible.' });
            }
          }
        }
        break;
      }
      case 'opfs':
        break;
      default: {
        const _ex: never = volume.type;
        throw new Error(`Unhandled volume type: ${_ex}`);
      }
      }
    }
  } catch (e) {
    console.error('Failed to update mount settings:', e);
    addToast({ message: 'Failed to update path settings' });
  }
}

async function handleVolumeRename({ volumeId, name }: { volumeId: string; name: string }) {
  try {
    await storageService.renameVolume({ volumeId, name });
    await loadData();
  } catch (e) {
    console.error('Failed to rename volume:', e);
    addToast({ message: 'Failed to rename folder' });
  }
}

async function handleVolumeDelete({ volumeId }: { volumeId: string }) {
  const volume = volumes.value.find(v => v.id === volumeId);
  if (!volume) return;

  let title: string;
  let message: string;
  let confirmButtonText: string;
  let successMessage: string;
  let errorMessage: string;

  switch (volume.type) {
  case 'opfs':
    title = 'Delete Folder';
    message = `Are you sure you want to delete "${volume.name}"? This will permanently delete all copied data from the browser.`;
    confirmButtonText = 'Delete';
    successMessage = 'Folder deleted';
    errorMessage = 'Failed to delete folder';
    break;
  case 'host':
    title = 'Remove Folder';
    message = `Are you sure you want to remove "${volume.name}"? This will stop using it. Your original files will not be affected.`;
    confirmButtonText = 'Remove';
    successMessage = 'Folder removed';
    errorMessage = 'Failed to remove folder';
    break;
  default: {
    const _ex: never = volume.type;
    throw new Error(`Unhandled volume type: ${_ex}`);
  }
  }

  const confirmed = await showConfirm({
    title,
    message,
    confirmButtonText,
    confirmButtonVariant: 'danger',
  });
  if (!confirmed) return;

  try {
    await storageService.unmountVolume({ volumeId });
    await storageService.deleteVolume({ volumeId });
    await loadData();
    addToast({ message: successMessage });
  } catch (e) {
    addToast({ message: errorMessage });
  }
}

onMounted(() => {
  loadData();
});

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="relative space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-400" data-settings-main>
    <!-- Header -->
    <div class="pb-3 border-b border-gray-100 dark:border-gray-800 space-y-3">
      <div class="flex items-center gap-2">
        <FolderIcon class="w-5 h-5 text-blue-500" />
        <div>
          <h2 class="text-lg font-bold tracking-tight text-gray-800 dark:text-white">Folders</h2>
          <p class="text-[10px] text-gray-400 dark:text-gray-500 font-medium leading-tight">Give the AI access to files in your folders</p>
        </div>
      </div>
      <!-- Add Folder / Copy Folder buttons + progress bar + drag-drop -->
      <VolumeCreator
        :existing-mount-paths="existingMountPaths"
        mount-path-prefix="/"
        drag-overlay-target="[data-settings-main]"
        @created="handleVolumeCreated"
      />
    </div>

    <div v-if="isLoading && volumes.length === 0" class="flex justify-center p-12">
      <Loader2Icon class="w-6 h-6 animate-spin text-gray-400" />
    </div>

    <div v-else-if="volumes.length === 0" class="text-center p-16 bg-gray-50/50 dark:bg-gray-800/30 rounded-3xl border border-dashed border-gray-200 dark:border-gray-700">
      <FolderInputIcon class="w-12 h-12 mx-auto text-gray-300 dark:text-gray-600 mb-4" />
      <p class="text-sm font-bold text-gray-500 dark:text-gray-400">No folders configured</p>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-[240px] mx-auto">
        Add a folder or copy one into browser storage.
      </p>
    </div>

    <VolumeMountList
      v-else
      :volumes="volumes"
      :mounts="mounts"
      in-use-section-label="In Use Globally"
      not-in-use-section-label="Not in Use Globally"
      mount-path-prefix="/"
      :show-volume-management="true"
      @add="handleMountAdd"
      @remove="handleMountRemove"
      @update-mount="handleMountUpdate"
      @rename-volume="handleVolumeRename"
      @delete-volume="handleVolumeDelete"
    />
  </div>
</template>
