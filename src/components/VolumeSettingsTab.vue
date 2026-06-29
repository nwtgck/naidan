<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { storageService } from '@/00-storage/service';
import type { Volume, Mount } from '@/01-models/types';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { FolderIcon, FolderInputIcon, Loader2Icon } from 'lucide-vue-next';
import VolumeCreator from './VolumeCreator.vue';
import VolumeMountList from './VolumeMountList.vue';
import type { VolumeId } from '@/01-models/ids';
import { lazyStrings, ensureStrings } from '@/strings';

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
    addToast({ message: await ensureStrings.volumes__failed_to_load_folders() });
  } finally {
    isLoading.value = false;
  }
}

// --- VolumeCreator event handler ---

async function handleVolumeCreated({ volumeId, mountPath, readOnly }: { volumeId: VolumeId, mountPath: string, readOnly: boolean }) {
  try {
    await storageService.mountVolume({ volumeId: volumeId, mountPath, readOnly });
    await loadData();
  } catch (e) {
    addToast({ message: await ensureStrings.volumes__failed_to_add_folder() });
  }
}

// --- VolumeMountList event handlers ---

async function handleMountAdd({ volumeId, mountPath, readOnly }: { volumeId: VolumeId, mountPath: string, readOnly: boolean }) {
  try {
    await storageService.mountVolume({ volumeId: volumeId, mountPath, readOnly });
    const vol = volumes.value.find(v => v.id === volumeId);
    if (vol) addToast({ message: await ensureStrings.volumes__folder_is_now_in_use({ name: vol.name }) });
    await loadData();
  } catch (e) {
    addToast({ message: await ensureStrings.volumes__failed_to_add_folder() });
  }
}

async function handleMountRemove({ volumeId }: { volumeId: VolumeId }) {
  try {
    const vol = volumes.value.find(v => v.id === volumeId);
    await storageService.unmountVolume({ volumeId: volumeId });
    if (vol) addToast({ message: await ensureStrings.volumes__folder_is_no_longer_in_use({ name: vol.name }) });
    await loadData();
  } catch (e) {
    addToast({ message: await ensureStrings.volumes__failed_to_remove_folder() });
  }
}

async function handleMountUpdate({ volumeId, mountPath, readOnly }: { volumeId: VolumeId, mountPath: string, readOnly: boolean }) {
  try {
    const isCollision = mounts.value.some(m =>
      m.mountPath === mountPath && !(m.type === 'volume' && m.volumeId === volumeId),
    );
    if (isCollision) {
      addToast({ message: await ensureStrings.volumes__mount_path_already_in_use() });
      return;
    }
    await storageService.unmountVolume({ volumeId: volumeId });
    await storageService.mountVolume({ volumeId: volumeId, mountPath, readOnly });
    await loadData();
    addToast({ message: await ensureStrings.volumes__path_settings_updated() });

    const volume = volumes.value.find(v => v.id === volumeId);
    if (volume) {
      switch (volume.type) {
      case 'host': {
        const handle = await storageService.getVolumeDirectoryHandle({ volumeId: volumeId });
        if (handle) {
          const mode = readOnly ? 'read' : 'readwrite';
          // @ts-expect-error: File System Access API
          const current = await handle.queryPermission({ mode });
          if (current !== 'granted') {
            // @ts-expect-error: File System Access API
            const result = await handle.requestPermission({ mode });
            if (result !== 'granted') {
              addToast({ message: await ensureStrings.volumes__permission_denied_folder_may_not_be_accessible() });
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
    addToast({ message: await ensureStrings.volumes__failed_to_update_path_settings() });
  }
}

async function handleVolumeRename({ volumeId, name }: { volumeId: VolumeId, name: string }) {
  try {
    await storageService.renameVolume({ volumeId: volumeId, name });
    await loadData();
  } catch (e) {
    console.error('Failed to rename volume:', e);
    addToast({ message: await ensureStrings.volumes__failed_to_rename_folder() });
  }
}

async function handleVolumeDelete({ volumeId }: { volumeId: VolumeId }) {
  const volume = volumes.value.find(v => v.id === volumeId);
  if (!volume) return;

  let title: string;
  let message: string;
  let confirmButtonText: string;
  let successMessage: string;
  let errorMessage: string;

  switch (volume.type) {
  case 'opfs':
    title = await ensureStrings.volumes__delete_folder();
    message = await ensureStrings.volumes__delete_folder_warning({ name: volume.name });
    confirmButtonText = await ensureStrings.volumes__delete();
    successMessage = await ensureStrings.volumes__folder_deleted();
    errorMessage = await ensureStrings.volumes__failed_to_delete_folder();
    break;
  case 'host':
    title = await ensureStrings.volumes__remove_folder();
    message = await ensureStrings.volumes__remove_folder_warning({ name: volume.name });
    confirmButtonText = await ensureStrings.volumes__remove();
    successMessage = await ensureStrings.volumes__folder_removed();
    errorMessage = await ensureStrings.volumes__failed_to_remove_folder();
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
    await storageService.unmountVolume({ volumeId: volumeId });
    await storageService.deleteVolume({ volumeId: volumeId });
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
  },
});
</script>

<template>
  <div class="relative space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-400" data-settings-main>
    <!-- Header -->
    <div class="pb-3 border-b border-gray-100 dark:border-gray-800 space-y-3">
      <div class="flex items-center gap-2">
        <FolderIcon class="w-5 h-5 text-blue-500" />
        <div>
          <h2 class="text-lg font-bold tracking-tight text-gray-800 dark:text-white">{{ lazyStrings.volumes__folders() }}</h2>
          <p class="text-[10px] text-gray-400 dark:text-gray-500 font-medium leading-tight">{{ lazyStrings.volumes__give_ai_access_to_files_in_your_folders() }}</p>
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
      <p class="text-sm font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.volumes__no_folders_configured() }}</p>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-[240px] mx-auto">
        {{ lazyStrings.volumes__add_or_copy_folder_into_browser_storage() }}
      </p>
    </div>

    <VolumeMountList
      v-else
      :volumes="volumes"
      :mounts="mounts"
      :in-use-section-label="lazyStrings.volumes__in_use_globally()"
      :not-in-use-section-label="lazyStrings.volumes__not_in_use_globally()"
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
