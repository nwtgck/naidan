<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { storageService } from '@/services/storage';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import type { Volume, Mount } from '@/models/types';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import {
  HardDrive,
  FolderInput,
  Copy,
  Trash2,
  FolderOpen,
  Loader2,
  Pin,
  PinOff,
  Settings2,
  Lock,
  Unlock,
  AlertCircle,
  Check
} from 'lucide-vue-next';

const volumes = ref<Volume[]>([]);
const mounts = ref<Mount[]>([]);
const isLoading = ref(false);
const isCreating = ref(false);
const progress = ref<{ processed: number; total: number } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const { addToast } = useToast();
const { showConfirm } = useConfirm();

const editingMountId = ref<string | null>(null);
const editForm = ref({
  mountPath: '',
  readOnly: true
});

const mountedVolumes = computed(() => {
  return volumes.value.filter(vol => mounts.value.some(m => m.type === 'volume' && m.volumeId === vol.id));
});

const unmountedVolumes = computed(() => {
  return volumes.value.filter(vol => !mounts.value.some(m => m.type === 'volume' && m.volumeId === vol.id));
});

function formatDate(timestamp: number) {
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
    addToast({ message: 'Failed to load volumes', type: 'error' });
  } finally {
    isLoading.value = false;
  }
}

function generateUniquePath(baseName: string): string {
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

async function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  isCreating.value = true;
  progress.value = null;
  try {
    const files = target.files;
    const firstFile = files[0];
    const folderName = firstFile.webkitRelativePath.split('/')[0] || 'Imported Folder';

    const vol = await storageService.createVolumeFromFiles({
      name: folderName,
      files: files,
      onProgress: (p) => {
        progress.value = p;
      }
    });

    await storageService.mountVolume({
      volumeId: vol.id,
      mountPath: generateUniquePath(folderName),
      readOnly: true,
    });

    await loadData();
    addToast({ message: `Volume "${folderName}" imported and mounted` });
  } catch (e) {
    console.error('Failed to import volume:', e);
    addToast({ message: `Failed to import volume: ${(e as Error).message}`, type: 'error' });
  } finally {
    isCreating.value = false;
    progress.value = null;
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function createVolume(type: 'opfs' | 'host') {
  if (isCreating.value) return;

  if (type === 'host') {
    // @ts-expect-error: File System Access API
    if (!window.showDirectoryPicker) {
      addToast({ message: 'Linking external folders is not supported in this browser.', type: 'error' });
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
        mountPath: generateUniquePath(name),
        readOnly: true,
      });

      await loadData();
      addToast({ message: `Volume "${name}" linked and mounted` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      addToast({ message: `Failed to link volume: ${(e as Error).message}`, type: 'error' });
    } finally {
      isCreating.value = false;
    }
    return;
  }

  const isOPFSSupported = await checkOPFSSupport();
  if (!isOPFSSupported) {
    addToast({ message: 'OPFS is not supported in this browser.', type: 'error' });
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
        mountPath: generateUniquePath(name),
        readOnly: true,
      });

      await loadData();
      addToast({ message: `Volume "${name}" imported and mounted` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      addToast({ message: `Failed to import volume: ${(e as Error).message}`, type: 'error' });
    } finally {
      isCreating.value = false;
    }
  } else {
    fileInput.value?.click();
  }
}

function startEditing(vol: Volume) {
  const mount = mounts.value.find(m => m.type === 'volume' && m.volumeId === vol.id);
  if (!mount) return;

  editingMountId.value = vol.id;
  editForm.value = {
    mountPath: mount.mountPath,
    readOnly: mount.readOnly
  };
}

async function saveMountSettings(volId: string) {
  try {
    const isCollision = mounts.value.some(m =>
      m.mountPath === editForm.value.mountPath &&
      !(m.type === 'volume' && m.volumeId === volId)
    );

    if (isCollision) {
      addToast({ message: 'Mount path already in use', type: 'error' });
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
    addToast({ message: 'Mount settings updated' });
  } catch (e) {
    console.error('Failed to update mount settings:', e);
    addToast({ message: 'Failed to update mount settings', type: 'error' });
  }
}

async function toggleMount(vol: Volume) {
  const isCurrentlyMounted = mounts.value.some(m => m.type === 'volume' && m.volumeId === vol.id);
  try {
    if (isCurrentlyMounted) {
      await storageService.unmountVolume({ volumeId: vol.id });
      addToast({ message: `Volume "${vol.name}" unmounted` });
    } else {
      await storageService.mountVolume({
        volumeId: vol.id,
        mountPath: generateUniquePath(vol.name),
        readOnly: true,
      });
      addToast({ message: `Volume "${vol.name}" mounted` });
    }
    await loadData();
  } catch (e) {
    addToast({ message: 'Failed to update mount status', type: 'error' });
  }
}

async function deleteVolume(vol: Volume) {
  const confirmed = await showConfirm({
    title: 'Delete Volume',
    message: `Are you sure you want to delete "${vol.name}"? This will also unmount it and delete all internal data.`,
    confirmButtonText: 'Delete',
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) return;

  try {
    await storageService.unmountVolume({ volumeId: vol.id });
    await storageService.deleteVolume({ volumeId: vol.id });
    await loadData();
    addToast({ message: 'Volume deleted' });
  } catch (e) {
    addToast({ message: 'Failed to delete volume', type: 'error' });
  }
}

function getVolumeMount(volId: string) {
  return mounts.value.find(m => m.type === 'volume' && m.volumeId === volId);
}

onMounted(() => {
  loadData();
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

    <!-- Upload Progress -->
    <div v-if="isCreating" class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-2xl border border-blue-100 dark:border-blue-900/30">
      <div class="flex items-center justify-between text-xs font-bold text-blue-700 dark:text-blue-300 mb-2">
        <span class="flex items-center gap-2">
          <Loader2 class="w-3 h-3 animate-spin" />
          Processing Volume...
        </span>
        <span v-if="progress">{{ progress.processed }} / {{ progress.total }}</span>
      </div>
      <div class="h-1.5 w-full bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
        <div
          class="h-full bg-blue-600 transition-all duration-300"
          :style="{ width: `${progress ? (progress.processed / progress.total) * 100 : 0}%` }"
        ></div>
      </div>
    </div>

    <!-- Header Actions -->
    <div class="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
      <div class="flex items-center gap-2">
        <HardDrive class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Storage Volumes</h2>
      </div>
      <div class="flex gap-2">
        <button
          @click="createVolume('host')"
          :disabled="isCreating"
          class="flex items-center gap-2 px-3 py-2 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-xl text-xs font-bold transition-all shadow-sm"
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
          Import Folder
        </button>
      </div>
    </div>

    <div v-if="isLoading && volumes.length === 0" class="flex justify-center p-12">
      <Loader2 class="w-6 h-6 animate-spin text-gray-400" />
    </div>

    <div v-else-if="volumes.length === 0" class="text-center p-16 bg-gray-50/50 dark:bg-gray-800/30 rounded-3xl border border-dashed border-gray-200 dark:border-gray-700">
      <FolderInput class="w-12 h-12 mx-auto text-gray-300 dark:text-gray-600 mb-4" />
      <p class="text-sm font-bold text-gray-500 dark:text-gray-400">No storage volumes configured</p>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-[240px] mx-auto">
        Mount external folders via File System API or import them to internal storage.
      </p>
    </div>

    <div v-else class="space-y-10">
      <!-- Mounted Section -->
      <section v-if="mountedVolumes.length > 0" class="space-y-4">
        <div class="flex items-center justify-between px-1">
          <h3 class="text-[10px] font-bold text-blue-500 dark:text-blue-400 uppercase tracking-widest flex items-center gap-2">
            <Pin class="w-3 h-3" />
            Active Mounts
          </h3>
          <span class="text-[10px] font-bold text-gray-400">{{ mountedVolumes.length }} active</span>
        </div>

        <div class="grid grid-cols-1 gap-4">
          <div
            v-for="vol in mountedVolumes"
            :key="vol.id"
            class="group bg-white dark:bg-gray-800 border border-blue-100 dark:border-blue-900/30 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all"
          >
            <div class="p-4 flex items-center justify-between gap-4">
              <div class="flex items-center gap-4 flex-1 min-w-0">
                <div class="p-3 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-500 dark:text-blue-400 shrink-0">
                  <FolderOpen v-if="vol.type === 'host'" class="w-5 h-5" />
                  <HardDrive v-else class="w-5 h-5" />
                </div>

                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <h3 class="font-bold text-gray-800 dark:text-white text-sm truncate">{{ vol.name }}</h3>
                  </div>
                  <div class="flex flex-wrap items-center gap-y-1 gap-x-2 mt-0.5">
                    <code class="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 rounded">
                      {{ getVolumeMount(vol.id)?.mountPath }}
                    </code>
                    <div v-if="getVolumeMount(vol.id)?.readOnly" class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-amber-100 dark:border-amber-900/30" title="Read Only">
                      <Lock class="w-2.5 h-2.5" />
                      <span class="text-[9px] font-bold uppercase tracking-tight">Read Only</span>
                    </div>
                    <span class="text-[10px] text-gray-400 font-medium hidden sm:inline">·</span>
                    <span class="text-[10px] text-gray-400 font-medium">{{ vol.type === 'host' ? 'Linked' : 'OPFS' }}</span>
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-1 shrink-0">
                <button
                  @click="startEditing(vol)"
                  class="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors"
                  title="Configure Mount"
                >
                  <Settings2 class="w-4 h-4" />
                </button>
                <button
                  @click="toggleMount(vol)"
                  class="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors"
                  title="Unmount"
                >
                  <PinOff class="w-4 h-4" />
                </button>
                <button
                  @click="deleteVolume(vol)"
                  class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors"
                  title="Delete Volume"
                >
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
            </div>

            <!-- Inline Edit Panel -->
            <div v-if="editingMountId === vol.id" class="px-4 pb-4 pt-2 border-t border-gray-50 dark:border-gray-700/50 bg-gray-50/30 dark:bg-gray-900/10">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label class="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Mount Path</label>
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
                  @click="saveMountSettings(vol.id)"
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
          Available Volumes
        </h3>
        <div class="grid grid-cols-1 gap-3">
          <div
            v-for="vol in unmountedVolumes"
            :key="vol.id"
            class="group flex items-center justify-between p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-2xl hover:border-gray-200 dark:hover:border-gray-600 transition-all"
          >
            <div class="flex items-center gap-4">
              <div class="p-3 rounded-xl bg-gray-50 dark:bg-gray-700/50 text-gray-400 dark:text-gray-500">
                <FolderOpen v-if="vol.type === 'host'" class="w-5 h-5" />
                <HardDrive v-else class="w-5 h-5" />
              </div>
              <div>
                <h3 class="font-bold text-gray-600 dark:text-gray-400 text-sm">{{ vol.name }}</h3>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[10px] text-gray-400 font-medium">{{ vol.type === 'host' ? 'Linked Folder' : 'OPFS Snapshot' }}</span>
                  <span class="text-[10px] text-gray-400 font-medium">·</span>
                  <span class="text-[10px] text-gray-400 font-medium">{{ formatDate(vol.createdAt) }}</span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1 shrink-0">
              <button
                @click="toggleMount(vol)"
                class="flex items-center gap-2 px-3 py-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-all font-bold text-[10px]"
              >
                <Pin class="w-3 h-3" />
                Mount Volume
              </button>
              <button
                @click="deleteVolume(vol)"
                class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
