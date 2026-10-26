<script setup lang="ts">
import { ref, computed, useId } from 'vue';
import { ensureStrings, lazyStrings } from '@/strings';
import type { ObjectDirective } from 'vue';
import type { Volume, Mount } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import type { VolumeId } from '@/01-models/ids';
import { useToast } from '@/composables/useToast';
import {
  EyeIcon,
  EyeOffIcon,
  Settings2Icon,
  LockIcon,
  UnlockIcon,
  PencilIcon,
  CheckIcon,
  XIcon,
} from 'lucide-vue-next';
import ActionButton from './ActionButton.vue';
import MountAccessModeSelector from './MountAccessModeSelector.vue';
import SettingsCollapse from './SettingsCollapse.vue';
import VolumeListItem from './VolumeListItem.vue';

const { addToast } = useToast();

const vFocus: ObjectDirective<HTMLElement> = { mounted: (el) => el.focus() };

const props = defineProps<{
  volumes: Volume[],
  mounts: Mount[],
  inUseSectionLabel?: string,
  notInUseSectionLabel?: string,
  addButtonLabel?: string,
  /** Default path prefix when adding a new mount (e.g. '/home/user/' or '/'). */
  mountPathPrefix?: string,
  /** Show rename and delete actions on volume cards. */
  showVolumeManagement?: boolean,
  deletionPending: boolean,
}>();

const emit = defineEmits<{
  add: [{ volumeId: VolumeId, mountPath: string, readOnly: boolean }],
  remove: [{ volumeId: VolumeId }],
  'update-mount': [{ volumeId: VolumeId, mountPath: string, readOnly: boolean }],
  'rename-volume': [{ volumeId: VolumeId, name: string }],
  'delete-volume': [{ volumeId: VolumeId }],
}>();

const mountedVolumes = computed(() =>
  props.volumes.filter(vol => props.mounts.some(m => m.type === 'volume' && m.volumeId === vol.id)),
);

const unmountedVolumes = computed(() =>
  props.volumes.filter(vol => !props.mounts.some(m => m.type === 'volume' && m.volumeId === vol.id)),
);

const groups = computed(() => [
  { id: 'mounted' as const, label: props.inUseSectionLabel ?? lazyStrings.volumes__in_use(), volumes: mountedVolumes.value },
  { id: 'available' as const, label: props.notInUseSectionLabel ?? lazyStrings.volumes__not_in_use(), volumes: unmountedVolumes.value },
].filter(group => group.volumes.length > 0));
const listId = useId();

function getMount({ volId }: { volId: VolumeId }): Mount | undefined {
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
const editingMountId = ref<VolumeId>();
const editingMountTrigger = ref<HTMLElement>();
const editForm = ref({ mountPath: '', readOnly: true });

function startEditing({ volume, event }: { volume: Volume, event: Event }) {
  const mount = getMount({ volId: volume.id });
  if (!mount) {
    return;
  }
  editingMountId.value = volume.id;
  editingMountTrigger.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  editForm.value = { mountPath: mount.mountPath, readOnly: mount.readOnly };
}

function cancelMountEditing() {
  editingMountId.value = undefined;
}

function saveMountSettings({ volId }: { volId: VolumeId }) {
  if (editingMountId.value !== volId) {
    return;
  }
  let path = editForm.value.mountPath;
  if (!path.startsWith('/')) {
    path = '/' + path;
  }
  emit('update-mount', { volumeId: volId, mountPath: path, readOnly: editForm.value.readOnly });
  editingMountId.value = undefined;
}

// --- Inline name edit ---
const editingNameId = ref<VolumeId>();
const editingNameValue = ref('');

function startEditingName({ volume }: { volume: Volume }) {
  editingNameId.value = volume.id;
  editingNameValue.value = volume.name;
}

function cancelEditingName() {
  editingNameId.value = undefined;
  editingNameValue.value = '';
}

async function saveVolumeName({ volId }: { volId: VolumeId }): Promise<void> {
  const trimmed = editingNameValue.value.trim();
  if (!trimmed) {
    addToast({ message: await ensureStrings.volumes__name_cannot_be_empty() });
    return;
  }
  emit('rename-volume', { volumeId: volId, name: trimmed });
  editingNameId.value = undefined;
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="space-y-6">
    <section v-for="group in groups" :key="group.id" tw-class="space-y-3" :data-testid="'volume-section-' + group.id">
      <div tw-class="flex items-center justify-between gap-3 px-1">
        <h3 tw-class="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <EyeIcon v-if="group.id === 'mounted'" aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />
          <EyeOffIcon v-else aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400" />
          {{ group.label }}
        </h3>
        <span v-if="group.id === 'mounted'" tw-class="shrink-0 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.volumes__active_count({ count: group.volumes.length }) }}</span>
      </div>
      <div tw-class="space-y-2">
        <VolumeListItem v-for="volume in group.volumes" :key="idToRaw({ id: volume.id })" :data-testid="'volume-row-' + idToRaw({ id: volume.id })" :name="volume.name" :path="group.id === 'mounted' ? getMount({ volId: volume.id })?.mountPath : undefined" :source-label="undefined" activation="none" :primary-test-id="undefined">
          <template v-if="showVolumeManagement && editingNameId === volume.id" #name>
            <input data-testid="volume-name-input" v-model="editingNameValue" type="text" :aria-label="lazyStrings.volumes__rename()" tw-class="min-h-8 min-w-0 flex-1 rounded-lg border border-blue-400 bg-white px-2 py-1 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-blue-500/60 dark:bg-gray-800/40 dark:text-gray-300" @keydown.enter="saveVolumeName({ volId: volume.id })" @keydown.escape.stop.prevent="cancelEditingName" v-focus />
            <button type="button" data-testid="volume-name-save" @click="saveVolumeName({ volId: volume.id })" tw-class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-blue-500 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-blue-400 dark:hover:bg-blue-500/10" :title="lazyStrings.volumes__save()" :aria-label="lazyStrings.volumes__save()"><CheckIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
            <button type="button" data-testid="volume-name-cancel" @click="cancelEditingName" tw-class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-gray-800" :title="lazyStrings.volumes__cancel()" :aria-label="lazyStrings.volumes__cancel()"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
          </template>
          <template v-if="showVolumeManagement && editingNameId !== volume.id" #name-actions>
            <button type="button" data-testid="volume-rename-btn" @click="startEditingName({ volume })" tw-class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-gray-800 dark:hover:text-gray-300" :title="lazyStrings.volumes__rename()" :aria-label="lazyStrings.volumes__rename()"><PencilIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
          </template>
          <template #metadata>
            <span tw-class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              <span v-if="group.id === 'mounted'" tw-class="inline-flex items-center gap-1">
                <LockIcon v-if="getMount({ volId: volume.id })?.readOnly" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
                <UnlockIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
                {{ getMount({ volId: volume.id })?.readOnly ? lazyStrings.volumes__read_only() : lazyStrings.volumes__read_write() }}
              </span>
              <span>{{ volume.type === 'host' ? lazyStrings.volumes__linked_folder() : lazyStrings.volumes__copied_folder() }}</span>
              <span v-if="group.id === 'available'">{{ formatDate({ timestamp: volume.createdAt }) }}</span>
            </span>
          </template>
          <template #actions>
            <template v-if="group.id === 'mounted'">
              <button type="button" data-testid="volume-settings-btn" @click="startEditing({ volume, event: $event })" :aria-expanded="editingMountId === volume.id" :aria-controls="listId + '-edit-' + idToRaw({ id: volume.id })" :title="lazyStrings.volumes__configure()" :aria-label="lazyStrings.volumes__configure()" tw-class="inline-flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-blue-500/10 dark:hover:text-blue-400 motion-reduce:transition-none"><Settings2Icon aria-hidden="true" tw-class="h-4 w-4" /></button>
              <button type="button" data-testid="volume-stop-using-btn" @click="emit('remove', { volumeId: volume.id })" :title="lazyStrings.volumes__stop_using()" :aria-label="lazyStrings.volumes__stop_using()" tw-class="inline-flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-blue-500/10 dark:hover:text-blue-400 motion-reduce:transition-none"><EyeOffIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
            </template>
            <ActionButton v-else appearance="primary" :disabled="false" :icon-tone="undefined" :data-testid="'volume-add-btn-' + idToRaw({ id: volume.id })" tw-class="text-sm!" @click="emit('add', { volumeId: volume.id, mountPath: generateDefaultPath({ baseName: volume.name }), readOnly: true })"><EyeIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ addButtonLabel ?? lazyStrings.volumes__use() }}</ActionButton>
            <button v-if="showVolumeManagement" type="button" data-testid="volume-delete-btn" :disabled="deletionPending" @click="emit('delete-volume', { volumeId: volume.id })" :title="volume.type === 'host' ? lazyStrings.volumes__remove() : lazyStrings.volumes__delete()" :aria-label="volume.type === 'host' ? lazyStrings.volumes__remove() : lazyStrings.volumes__delete()" tw-class="grid h-10 w-10 place-items-center rounded-lg text-gray-400 hover:text-red-500 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
          </template>
          <template v-if="group.id === 'mounted'" #editor>
            <SettingsCollapse :id="listId + '-edit-' + idToRaw({ id: volume.id })" :open="editingMountId === volume.id" :return-focus="editingMountTrigger">
              <div v-if="editingMountId === volume.id" tw-class="space-y-4 border-t border-gray-200/60 p-3 dark:border-gray-700/40" @keydown.esc.stop.prevent="cancelMountEditing">
                <div tw-class="grid min-w-0 grid-cols-1 gap-4 @lg:grid-cols-2">
                  <div tw-class="min-w-0 space-y-2">
                    <label :for="listId + '-path-' + idToRaw({ id: volume.id })" tw-class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ lazyStrings.volumes__path() }}</label>
                    <input :id="listId + '-path-' + idToRaw({ id: volume.id })" data-testid="volume-path-input" v-model="editForm.mountPath" type="text" tw-class="min-h-10 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm text-gray-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-300" placeholder="/mnt/folder" />
                  </div>
                  <div tw-class="min-w-0 space-y-2">
                    <span tw-class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ lazyStrings.volumes__access_mode() }}</span>
                    <MountAccessModeSelector :model-value="editForm.readOnly ? 'read-only' : 'read-write'" :disabled="false" :label="lazyStrings.volumes__access_mode()" :read-only-label="lazyStrings.volumes__read_only()" :read-write-label="lazyStrings.volumes__read_write()" test-id-prefix="volume-access" @update:model-value="mode => editForm.readOnly = mode === 'read-only'" />
                  </div>
                </div>
                <div tw-class="flex flex-wrap justify-end gap-2">
                  <ActionButton appearance="secondary" :disabled="false" :icon-tone="undefined" data-testid="volume-settings-cancel" tw-class="text-sm!" @click="cancelMountEditing">{{ lazyStrings.volumes__cancel() }}</ActionButton>
                  <ActionButton appearance="primary" :disabled="false" :icon-tone="undefined" data-testid="mount-save-btn" tw-class="text-sm!" @click="saveMountSettings({ volId: volume.id })"><CheckIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.volumes__save_changes() }}</ActionButton>
                </div>
              </div>
            </SettingsCollapse>
          </template>
        </VolumeListItem>
      </div>
    </section>
  </div>
</template>
