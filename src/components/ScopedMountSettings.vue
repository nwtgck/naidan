<script lang="ts">
import type { ChatId, ChatGroupId } from '@/01-models/ids';
export type MountSettingsOwner = { type: 'chat', id: ChatId } | { type: 'chat_group', id: ChatGroupId };
</script>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { EyeIcon, PencilIcon, FolderIcon, XIcon } from 'lucide-vue-next';
import type { Mount, Volume } from '@/01-models/types';
import { idToRaw, type VolumeId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { useChatMounts } from '@/composables/chat/useChatMounts';
import { useChatGroupMounts } from '@/composables/chat/useChatGroupMounts';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import type { WeshMount } from '@/features/wesh/types';
import { settingsSourcePresentation, type SettingsSource } from '@/logic/settings-labels';
import { ensureStrings, lazyStrings } from '@/strings';
import SettingsSourceBadge from './SettingsSourceBadge.vue';
import VolumeCreator from './VolumeCreator.vue';
const props = defineProps<{ owner: MountSettingsOwner, mounts: readonly Mount[], inheritedMounts: readonly { mount: Mount, source: SettingsSource }[] }>();
const emit = defineEmits<{ (e: 'status', status: { pending: boolean, error: string | undefined }): void }>();
const chatMounts = useChatMounts();
const chatGroupMounts = useChatGroupMounts();
const { openFileExplorer } = useFileExplorerModal();
const volumes = ref<Volume[]>([]);
const errors = ref<Record<string, string | undefined>>({});
const pending = ref<Record<string, number>>({});
const busyMounts = ref<Set<string>>(new Set());
let mounted = true;
onUnmounted(() => {
  mounted = false;
});
const contexts = new Map<string, MountSettingsOwner>();
let viewRevision = 0;
const contextKey = computed(() => `${props.owner.type}:${idToRaw({ id: props.owner.id })}`);
watch(contextKey, key => {
  viewRevision++;
  contexts.set(key, { ...props.owner });
}, { immediate: true, flush: 'sync' });
watch([contextKey, errors, pending], () => {
  if (mounted) {
    emit('status', { pending: !!pending.value[contextKey.value], error: errors.value[contextKey.value] });
  }
}, { deep: true, immediate: true, flush: 'sync' });
const error = computed(() => errors.value[contextKey.value]);
const existingPaths = computed(() => props.mounts.map(mount => mount.mountPath));

async function loadVolumes() {
  const next: Volume[] = [];
  for await (const volume of storageService.listVolumes()) {
    next.push(volume);
  }
  if (mounted) {
    volumes.value = next;
  }
  return next;
}

onMounted(() => {
  void loadVolumes().catch(() => { /* Metadata is optional; mount paths remain usable. */ });
});

function volumeFor({ volumeId }: { volumeId: VolumeId }) {
  return volumes.value.find(volume => volume.id === volumeId);
}

function operationState({ operationContext, pending: isPending }: { operationContext: string | undefined, pending: boolean }) {
  if (!operationContext) {
    return;
  }
  pending.value = { ...pending.value, [operationContext]: Math.max(0, (pending.value[operationContext] ?? 0) + (isPending ? 1 : -1)) };
}

async function run({ key, action }: { key: string, action: () => Promise<void> }): Promise<{ status: 'completed' } | { status: 'failed', message: string }> {
  errors.value = { ...errors.value, [key]: undefined };
  operationState({ operationContext: key, pending: true });
  try {
    await action();
    return { status: 'completed' };
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : await ensureStrings.ScopedMountSettings__folder_operation_failed();
    if (mounted) {
      errors.value = { ...errors.value, [key]: message };
    }
    return { status: 'failed', message };
  } finally {
    operationState({ operationContext: key, pending: false });
  }
}

function mountOperationKey({ key, volumeId }: { key: string, volumeId: VolumeId }) {
  return `${key}:${idToRaw({ id: volumeId })}`;
}

function mountBusy({ mount }: { mount: Mount }) {
  return busyMounts.value.has(mountOperationKey({ key: contextKey.value, volumeId: mount.volumeId }));
}

async function runMountOperation({ key, volumeId, action }: { key: string, volumeId: VolumeId, action: () => Promise<void> }) {
  const operationKey = mountOperationKey({ key, volumeId });
  if (busyMounts.value.has(operationKey)) {
    return;
  }
  busyMounts.value = new Set([...busyMounts.value, operationKey]);
  try {
    await run({ key, action });
  } finally {
    const next = new Set(busyMounts.value);
    next.delete(operationKey);
    busyMounts.value = next;
  }
}

async function created({ volumeId, mountPath, readOnly, operationContext }: { volumeId: VolumeId, mountPath: string, readOnly: boolean, operationContext?: string }) {
  const key = operationContext;
  const owner = key ? contexts.get(key) : undefined;
  if (!owner || !key) {
    return;
  }
  const result = await run({
    key,
    action: async () => {
      const mount: Mount = { type: 'volume', volumeId, mountPath, readOnly };
      switch (owner.type) {
      case 'chat': await chatMounts.addMount({ chatId: owner.id, mount });
        break;
      case 'chat_group': await chatGroupMounts.addMount({ chatGroupId: owner.id, mount });
        break;
      default: {
        const _ex: never = owner;
        throw new Error(`Unhandled mount owner: ${_ex}`);
      }
      }
      // Metadata is cosmetic after the mount has been saved. A failed refresh
      // must not turn a successful creation into a reported save failure.
      await loadVolumes().catch(() => undefined);
    },
  });
  switch (result.status) {
  case 'completed': return;
  case 'failed': throw new Error(result.message);
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled creation result: ${_ex}`);
  }
  }
}

async function remove({ mount }: { mount: Mount }) {
  const owner = { ...props.owner };
  const key = contextKey.value;
  await runMountOperation({
    key,
    volumeId: mount.volumeId,
    action: async () => {
      switch (owner.type) {
      case 'chat': await chatMounts.removeMount({ chatId: owner.id, volumeId: mount.volumeId });
        return;
      case 'chat_group': await chatGroupMounts.removeMount({ chatGroupId: owner.id, volumeId: mount.volumeId });
        return;
      default: {
        const _ex: never = owner;
        throw new Error(`Unhandled mount owner: ${_ex}`);
      }
      }
    },
  });
}

async function setReadOnly({ mount, readOnly }: { mount: Mount, readOnly: boolean }) {
  if (readOnly === mount.readOnly) {
    return;
  }
  const owner = { ...props.owner };
  const key = contextKey.value;
  const volumeId = mount.volumeId;
  await runMountOperation({
    key,
    volumeId,
    action: async () => {
      if (!readOnly) {
        let volume = volumeFor({ volumeId });
        if (!volume) {
          volume = (await loadVolumes()).find(entry => entry.id === volumeId);
        }
        // Unknown metadata cannot establish whether a browser permission prompt
        // is required. Never treat an unavailable host as an OPFS volume.
        if (!volume) {
          throw new Error(await ensureStrings.ScopedMountSettings__folder_unavailable());
        }
        switch (volume.type) {
        case 'opfs': break;
        case 'host': {
          const handle = await storageService.getVolumeDirectoryHandle({ volumeId });
          if (!handle) {
            throw new Error(await ensureStrings.ScopedMountSettings__folder_unavailable());
          }
          type PermissionHandle = FileSystemDirectoryHandle & {
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the File System Access API contract.
            requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>,
          };
          const permission = await (handle as PermissionHandle).requestPermission({ mode: 'readwrite' });
          switch (permission) {
          case 'granted': break;
          case 'denied': case 'prompt': return;
          default: {
            const _ex: never = permission;
            throw new Error(`Unhandled permission: ${_ex}`);
          }
          }
          break;
        }
        default: {
          const _ex: never = volume.type;
          throw new Error(`Unhandled volume type: ${_ex}`);
        }
        }
      }
      switch (owner.type) {
      case 'chat': await chatMounts.updateMount({ chatId: owner.id, volumeId, readOnly });
        return;
      case 'chat_group': await chatGroupMounts.setMountReadOnly({ chatGroupId: owner.id, volumeId, readOnly });
        return;
      default: {
        const _ex: never = owner;
        throw new Error(`Unhandled mount owner: ${_ex}`);
      }
      }
    },
  });
}

async function openExplorer({ mount }: { mount: Mount }) {
  const key = contextKey.value;
  const revision = viewRevision;
  const entries = [...props.inheritedMounts.map(entry => ({ ...entry.mount })), ...props.mounts.map(entry => ({ ...entry })), { ...mount }];
  await run({
    key,
    action: async () => {
      const workerMounts = new Map<string, WeshMount>();
      for (const entry of entries) {
        const handle = await storageService.getVolumeDirectoryHandle({ volumeId: entry.volumeId });
        // As in runtime mount resolution, an unavailable child must not hide a
        // usable upstream entry. The clicked row retains its own access mode.
        if (handle) {
          workerMounts.set(entry.mountPath, { type: 'directory', path: entry.mountPath, handle, readOnly: entry.readOnly });
        }
      }
      const title = await ensureStrings.ScopedMountSettings__folders();
      const rootName = await ensureStrings.ScopedMountSettings__files();
      if (!mounted || revision !== viewRevision || contextKey.value !== key) {
        return;
      }
      openFileExplorer({ options: { kind: 'wesh-mounts', title, rootName, mounts: [...workerMounts.values()], initialPath: mount.mountPath.split('/').filter(Boolean) } });
    },
  });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-4">
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>
    <div tw-class="space-y-2">
      <div v-for="mount in mounts" :key="idToRaw({ id: mount.volumeId })" class="mount-settings-row" data-testid="own-mount-row" :aria-busy="mountBusy({ mount })" tw-class="rounded-xl border border-gray-200/60 bg-gray-50/50 px-3 py-2 dark:border-gray-700/40 dark:bg-gray-800/35">
        <button type="button" class="mount-settings-name" data-testid="mount-open" :title="mount.mountPath" tw-class="flex min-w-0 items-start gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30" @click="openExplorer({ mount })"><FolderIcon tw-class="mt-0.5 h-4 w-4 shrink-0 text-blue-500" /><span tw-class="block min-w-0"><span tw-class="flex items-center gap-2"><span tw-class="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{{ volumeFor({ volumeId: mount.volumeId })?.name ?? mount.mountPath.split('/').at(-1) }}</span><span tw-class="shrink-0 text-[11px] text-gray-400">{{ volumeFor({ volumeId: mount.volumeId })?.type }}</span></span><span tw-class="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">{{ mount.mountPath }}</span></span></button>
        <div class="mount-settings-permissions" role="group" :aria-label="lazyStrings.ScopedMountSettings__folder_permissions({ path: mount.mountPath })" tw-class="inline-flex max-w-full overflow-x-auto rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800 inset-ring-1 inset-ring-gray-200/50 dark:inset-ring-gray-700/50">
          <button v-for="readOnly in [true, false]" :key="String(readOnly)" type="button" :aria-pressed="mount.readOnly === readOnly" :data-testid="readOnly ? 'mount-read-only' : 'mount-read-write'" :disabled="mountBusy({ mount })" :tw-class="['inline-flex min-h-9 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/35', mount.readOnly === readOnly ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 inset-ring-1 inset-ring-gray-200 dark:inset-ring-gray-600' : 'text-gray-500 dark:text-gray-400 enabled:hover:bg-gray-100 dark:enabled:hover:bg-gray-700/40 enabled:hover:text-gray-700 dark:enabled:hover:text-gray-200']" @click="setReadOnly({ mount, readOnly })"><EyeIcon v-if="readOnly" tw-class="h-3.5 w-3.5 shrink-0" /><PencilIcon v-else tw-class="h-3.5 w-3.5 shrink-0" />{{ readOnly ? lazyStrings.ScopedMountSettings__read_only() : lazyStrings.ScopedMountSettings__read_and_write() }}</button>
        </div>
        <button type="button" class="mount-settings-remove" data-testid="mount-remove" :disabled="mountBusy({ mount })" :aria-label="lazyStrings.ScopedMountSettings__remove_folder({ path: mount.mountPath })" tw-class="grid h-10 w-10 place-items-center rounded-lg text-gray-400 hover:text-red-500 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30" @click="remove({ mount })"><XIcon tw-class="h-4 w-4" /></button>
      </div>
    </div>
    <VolumeCreator :existing-mount-paths="existingPaths" mount-path-prefix="/home/user/" :operation-context="contextKey" :complete-creation="created" @operation-state="operationState($event)" />
    <div v-if="inheritedMounts.length" tw-class="space-y-2 border-t border-gray-200/60 pt-4 dark:border-gray-800">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ScopedMountSettings__inherited_folders() }}</p>
      <div v-for="({ mount, source }, index) in inheritedMounts" :key="index" data-testid="inherited-mount-row" tw-class="flex min-w-0 items-start gap-2 text-xs text-gray-500 dark:text-gray-400"><SettingsSourceBadge :source="settingsSourcePresentation({ source })" /><span tw-class="min-w-0 flex-1"><button type="button" :title="mount.mountPath" data-testid="inherited-mount-open" tw-class="block max-w-full truncate rounded text-left hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30" @click="openExplorer({ mount })">{{ mount.mountPath }}</button><span v-if="existingPaths.includes(mount.mountPath)" tw-class="text-[11px] text-gray-400">{{ lazyStrings.ScopedMountSettings__overridden_here() }}</span></span><span tw-class="shrink-0">{{ mount.readOnly ? lazyStrings.ScopedMountSettings__read_only() : lazyStrings.ScopedMountSettings__read_and_write() }}</span></div>
    </div>
    <p tw-class="text-[11px] leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.ScopedMountSettings__removing_a_folder_does_not_delete_files() }}</p>
  </div>
</template>
<style scoped>
.mount-settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 0.75rem;
  row-gap: 0.5rem;
}
.mount-settings-name {
  grid-column: 1;
  grid-row: 1;
}
.mount-settings-permissions {
  grid-column: 1 / -1;
  grid-row: 2;
  justify-self: start;
}
.mount-settings-remove {
  grid-column: 2;
  grid-row: 1;
}
@container (min-width: 38rem) {
  .mount-settings-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
  .mount-settings-permissions {
    grid-column: 2;
    grid-row: 1;
  }
  .mount-settings-remove {
    grid-column: 3;
  }
}
</style>
