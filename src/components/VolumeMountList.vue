<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Volume, Mount } from '@/models/types';
import { useToast } from '@/composables/useToast';
import {
  FolderSymlinkIcon,
  FolderDownIcon,
  EyeIcon,
  EyeOffIcon,
  Settings2Icon,
  LockIcon,
  UnlockIcon,
  PencilIcon,
  CheckIcon,
  XIcon,
  Trash2Icon,
  MoreHorizontalIcon,
} from 'lucide-vue-next';

const { addToast } = useToast();

// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Vue directive hooks receive the element as a positional hook argument.
const vFocus = { mounted: (el: HTMLElement) => el.focus() };

const props = defineProps<{
  volumes: Volume[];
  mounts: Mount[];
  inUseSectionLabel?: string;
  notInUseSectionLabel?: string;
  addButtonLabel?: string;
  /** Default path prefix when adding a new mount (e.g. '/home/user/' or '/'). */
  mountPathPrefix?: string;
  /** Show rename and delete actions on volume cards. */
  showVolumeManagement?: boolean;
}>();

const emit = defineEmits<{
  add: [{ volumeId: string; mountPath: string; readOnly: boolean }];
  remove: [{ volumeId: string }];
  'update-mount': [{ volumeId: string; mountPath: string; readOnly: boolean }];
  'rename-volume': [{ volumeId: string; name: string }];
  'delete-volume': [{ volumeId: string }];
}>();

const mountedVolumes = computed(() =>
  props.volumes.filter(vol => props.mounts.some(m => m.type === 'volume' && m.volumeId === vol.id))
);

const unmountedVolumes = computed(() =>
  props.volumes.filter(vol => !props.mounts.some(m => m.type === 'volume' && m.volumeId === vol.id))
);

function getMount({ volId }: { volId: string }): Mount | undefined {
  return props.mounts.find(m => m.type === 'volume' && m.volumeId === volId);
}

function generateDefaultPath({ baseName }: { baseName: string }): string {
  const sanitized = baseName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const prefix = props.mountPathPrefix ?? '/home/user/';
  let path = `${prefix}${sanitized}`;
  const existingPaths = props.mounts.map(m => m.mountPath);
  let suffix = 2;
  const basePath = path;
  while (existingPaths.includes(path)) {
    path = `${basePath}-${suffix}`;
    suffix++;
  }
  return path;
}

function formatDate({ timestamp }: { timestamp: number }) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// --- Inline mount edit form ---
const editingMountId = ref<string | null>(null);
const editForm = ref({ mountPath: '', readOnly: true });

function startEditing({ volume }: { volume: Volume }) {
  const mount = getMount({ volId: volume.id });
  if (!mount) return;
  editingMountId.value = volume.id;
  editForm.value = { mountPath: mount.mountPath, readOnly: mount.readOnly };
}

function saveMountSettings({ volId }: { volId: string }) {
  let path = editForm.value.mountPath;
  if (!path.startsWith('/')) path = '/' + path;
  emit('update-mount', { volumeId: volId, mountPath: path, readOnly: editForm.value.readOnly });
  editingMountId.value = null;
}

// --- Inline name edit ---
const editingNameId = ref<string | null>(null);
const editingNameValue = ref('');

function startEditingName({ volume }: { volume: Volume }) {
  editingNameId.value = volume.id;
  editingNameValue.value = volume.name;
}

function cancelEditingName() {
  editingNameId.value = null;
  editingNameValue.value = '';
}

function saveVolumeName({ volId }: { volId: string }) {
  const trimmed = editingNameValue.value.trim();
  if (!trimmed) {
    addToast({ message: 'Name cannot be empty' });
    return;
  }
  emit('rename-volume', { volumeId: volId, name: trimmed });
  editingNameId.value = null;
}

// --- More menu ---
const menuOpenVolumeId = ref<string | null>(null);


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="space-y-10">
    <!-- Click-outside overlay for "..." menus -->
    <div v-if="menuOpenVolumeId" class="fixed inset-0 z-40" @click="menuOpenVolumeId = null"></div>

    <!-- Mounted section -->
    <section v-if="mountedVolumes.length > 0" class="space-y-4">
      <div class="flex items-center justify-between px-1">
        <h3 class="text-[10px] font-bold text-blue-500 dark:text-blue-400 uppercase tracking-widest flex items-center gap-2">
          <EyeIcon class="w-3 h-3" />
          {{ inUseSectionLabel ?? 'In Use' }}
        </h3>
        <span class="text-[10px] font-bold text-gray-400">{{ mountedVolumes.length }} active</span>
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
                <FolderSymlinkIcon v-if="volume.type === 'host'" class="w-5 h-5" />
                <FolderDownIcon v-else class="w-5 h-5" />
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <template v-if="showVolumeManagement && editingNameId === volume.id">
                    <input
                      data-testid="volume-name-input"
                      v-model="editingNameValue"
                      type="text"
                      class="bg-white dark:bg-gray-700 border border-blue-400 rounded px-2 py-0.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none min-w-0 flex-1"
                      @keydown.enter="saveVolumeName({ volId: volume.id })"
                      @keydown.escape="cancelEditingName()"
                      v-focus
                    />
                    <button data-testid="volume-name-save" @click="saveVolumeName({ volId: volume.id })" class="p-1 text-blue-500 hover:text-blue-700 shrink-0" title="Save"><CheckIcon class="w-3.5 h-3.5" /></button>
                    <button data-testid="volume-name-cancel" @click="cancelEditingName()" class="p-1 text-gray-400 hover:text-gray-600 shrink-0" title="Cancel"><XIcon class="w-3.5 h-3.5" /></button>
                  </template>
                  <template v-else>
                    <h3 class="font-bold text-gray-800 dark:text-white text-sm truncate">{{ volume.name }}</h3>
                    <button
                      v-if="showVolumeManagement"
                      data-testid="volume-rename-btn"
                      @click="startEditingName({ volume })"
                      class="p-1 text-gray-300 hover:text-gray-500 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      title="Rename"
                    ><PencilIcon class="w-3 h-3" /></button>
                  </template>
                </div>
                <div class="flex flex-wrap items-center gap-y-1 gap-x-2 mt-0.5">
                  <code class="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 rounded">
                    {{ getMount({ volId: volume.id })?.mountPath }}
                  </code>
                  <div v-if="getMount({ volId: volume.id })?.readOnly" class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border border-green-100 dark:border-green-900/30" title="Read Only">
                    <LockIcon class="w-2.5 h-2.5" />
                    <span class="text-[9px] font-bold uppercase tracking-tight">Read Only</span>
                  </div>
                  <span class="text-[10px] text-gray-400 font-medium hidden sm:inline">·</span>
                  <span class="text-[10px] text-gray-400 font-medium">{{ volume.type === 'host' ? 'Linked' : 'Copied' }}</span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1 shrink-0">
              <button
                data-testid="volume-settings-btn"
                @click="startEditing({ volume })"
                class="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors"
                title="Configure"
              >
                <Settings2Icon class="w-4 h-4" />
              </button>
              <button
                @click="emit('remove', { volumeId: volume.id })"
                class="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors"
                title="Stop using"
              >
                <EyeOffIcon class="w-4 h-4" />
              </button>
              <div v-if="showVolumeManagement" class="relative">
                <button
                  @click.stop="menuOpenVolumeId = menuOpenVolumeId === volume.id ? null : volume.id"
                  class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-xl transition-colors"
                  title="More actions"
                >
                  <MoreHorizontalIcon class="w-4 h-4" />
                </button>
                <div
                  v-if="menuOpenVolumeId === volume.id"
                  class="absolute right-0 top-full mt-1 w-36 z-50 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden"
                >
                  <button
                    @click="emit('delete-volume', { volumeId: volume.id }); menuOpenVolumeId = null"
                    class="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <Trash2Icon class="w-3.5 h-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Inline edit panel -->
          <div v-if="editingMountId === volume.id" class="px-4 pb-4 pt-2 border-t border-gray-50 dark:border-gray-700/50 bg-gray-50/30 dark:bg-gray-900/10 rounded-b-2xl overflow-hidden">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <label class="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Path</label>
                <input
                  v-model="editForm.mountPath"
                  type="text"
                  class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="/mnt/folder"
                />
              </div>
              <div class="space-y-1.5">
                <label class="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Access Mode</label>
                <div class="flex gap-2">
                  <button
                    @click="editForm.readOnly = true"
                    class="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border"
                    :class="editForm.readOnly ? 'bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-800 dark:text-white' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-800 text-gray-400'"
                  >
                    <LockIcon class="w-3 h-3" />
                    Read Only
                  </button>
                  <button
                    @click="editForm.readOnly = false"
                    class="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border"
                    :class="!editForm.readOnly ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-800 text-gray-400'"
                  >
                    <UnlockIcon class="w-3 h-3" />
                    Read/Write
                  </button>
                </div>
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-4">
              <button @click="editingMountId = null" class="px-3 py-1.5 text-[10px] font-bold text-gray-400 hover:text-gray-600">Cancel</button>
              <button
                data-testid="mount-save-btn"
                @click="saveMountSettings({ volId: volume.id })"
                class="flex items-center gap-2 px-4 py-1.5 bg-blue-600 text-white rounded-lg text-[10px] font-bold hover:bg-blue-700 shadow-sm"
              >
                <CheckIcon class="w-3 h-3" />
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Unmounted section -->
    <section v-if="unmountedVolumes.length > 0" class="space-y-4">
      <h3 class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest px-1">
        {{ notInUseSectionLabel ?? 'Not in Use' }}
      </h3>
      <div class="grid grid-cols-1 gap-3">
        <div
          v-for="volume in unmountedVolumes"
          :key="volume.id"
          class="group flex items-center justify-between p-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-2xl hover:border-gray-200 dark:hover:border-gray-600 transition-all"
        >
          <div class="flex items-center gap-4">
            <div class="p-3 rounded-xl bg-gray-50 dark:bg-gray-700/50 text-gray-400 dark:text-gray-500">
              <FolderSymlinkIcon v-if="volume.type === 'host'" class="w-5 h-5" />
              <FolderDownIcon v-else class="w-5 h-5" />
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <template v-if="showVolumeManagement && editingNameId === volume.id">
                  <input
                    data-testid="volume-name-input"
                    v-model="editingNameValue"
                    type="text"
                    class="bg-white dark:bg-gray-700 border border-blue-400 rounded px-2 py-0.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none min-w-0 flex-1"
                    @keydown.enter="saveVolumeName({ volId: volume.id })"
                    @keydown.escape="cancelEditingName()"
                    v-focus
                  />
                  <button data-testid="volume-name-save" @click="saveVolumeName({ volId: volume.id })" class="p-1 text-blue-500 hover:text-blue-700 shrink-0" title="Save"><CheckIcon class="w-3.5 h-3.5" /></button>
                  <button data-testid="volume-name-cancel" @click="cancelEditingName()" class="p-1 text-gray-400 hover:text-gray-600 shrink-0" title="Cancel"><XIcon class="w-3.5 h-3.5" /></button>
                </template>
                <template v-else>
                  <h3 class="font-bold text-gray-600 dark:text-gray-400 text-sm truncate">{{ volume.name }}</h3>
                  <button
                    v-if="showVolumeManagement"
                    data-testid="volume-rename-btn"
                    @click="startEditingName({ volume })"
                    class="p-1 text-gray-300 hover:text-gray-500 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    title="Rename"
                  ><PencilIcon class="w-3 h-3" /></button>
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
              :data-testid="`volume-add-btn-${volume.id}`"
              @click="emit('add', { volumeId: volume.id, mountPath: generateDefaultPath({ baseName: volume.name }), readOnly: true })"
              class="flex items-center gap-2 px-3 py-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-all font-bold text-[10px]"
            >
              <EyeIcon class="w-3 h-3" />
              {{ addButtonLabel ?? 'Use' }}
            </button>
            <div v-if="showVolumeManagement" class="relative">
              <button
                @click.stop="menuOpenVolumeId = menuOpenVolumeId === volume.id ? null : volume.id"
                class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-xl transition-colors"
                title="More actions"
              >
                <MoreHorizontalIcon class="w-4 h-4" />
              </button>
              <div
                v-if="menuOpenVolumeId === volume.id"
                class="absolute right-0 top-full mt-1 w-36 z-50 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden"
              >
                <button
                  @click="emit('delete-volume', { volumeId: volume.id }); menuOpenVolumeId = null"
                  class="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  <Trash2Icon class="w-3.5 h-3.5" />
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
