<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { Mount } from '@/01-models/types';
import type { VolumeId } from '@/01-models/ids';
import { FolderIcon, LockIcon, UnlockIcon, XIcon } from 'lucide-vue-next';

const props = defineProps<{
  mounts: readonly Mount[],
  /** Path prefix stripped from display labels (e.g. '/home/user/'). */
  pathTrimPrefix: string,
  /** When true, the path label is a clickable button that emits open-explorer. */
  showExplorer: boolean,
}>();

const emit = defineEmits<{
  'toggle-read-only': [{ volumeId: VolumeId, readOnly: boolean }],
  remove: [{ volumeId: VolumeId }],
  'open-explorer': [{ volumeId: VolumeId }],
}>();

function displayPath({ mountPath }: { mountPath: string }): string {
  if (!props.pathTrimPrefix) return mountPath;
  const trimmed = mountPath.startsWith(props.pathTrimPrefix)
    ? mountPath.slice(props.pathTrimPrefix.length)
    : mountPath;
  return trimmed || mountPath;
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="flex flex-wrap gap-2" data-testid="mount-badge-list">
    <div
      v-for="mount in mounts"
      :key="idToRaw({ id: mount.volumeId })"
      class="flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-100 dark:border-blue-900 text-blue-700 dark:text-blue-300 text-xs font-medium"
      data-testid="mount-badge"
    >
      <FolderIcon class="w-3.5 h-3.5 shrink-0" />
      <button
        v-if="showExplorer"
        class="max-w-[120px] truncate mx-1 hover:underline focus:outline-none"
        :title="lazyStrings.MountBadgeList__browse_path({ path: displayPath({ mountPath: mount.mountPath }) })"
        data-testid="mount-open-explorer"
        @click="emit('open-explorer', { volumeId: mount.volumeId })"
      >{{ displayPath({ mountPath: mount.mountPath }) }}</button>
      <span
        v-else
        class="max-w-[140px] truncate mx-1"
        data-testid="mount-path-label"
      >{{ displayPath({ mountPath: mount.mountPath }) }}</span>
      <button
        @click="emit('toggle-read-only', { volumeId: mount.volumeId, readOnly: !mount.readOnly })"
        :title="mount.readOnly ? lazyStrings.MountBadgeList__read_only_click_to_allow_write() : lazyStrings.MountBadgeList__read_and_write_click_to_restrict()"
        class="p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors"
        data-testid="mount-toggle-readonly"
      >
        <LockIcon v-if="mount.readOnly" class="w-3 h-3 text-green-500 dark:text-green-400" />
        <UnlockIcon v-else class="w-3 h-3 text-amber-500 dark:text-amber-400" />
      </button>
      <button
        @click="emit('remove', { volumeId: mount.volumeId })"
        :title="lazyStrings.MountBadgeList__remove()"
        class="p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors text-blue-400 hover:text-red-500 dark:hover:text-red-400"
        data-testid="mount-remove-btn"
      >
        <XIcon class="w-3 h-3" />
      </button>
    </div>
  </div>
</template>
