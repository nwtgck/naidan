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
  if (!props.pathTrimPrefix) {
    return mountPath;
  }
  const trimmed = mountPath.startsWith(props.pathTrimPrefix)
    ? mountPath.slice(props.pathTrimPrefix.length)
    : mountPath;
  return trimmed || mountPath;
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
  <div tw-class="flex min-w-0 flex-wrap gap-2" data-testid="mount-badge-list">
    <div
      v-for="mount in mounts"
      :key="idToRaw({ id: mount.volumeId })"
      tw-class="inline-flex min-w-0 max-w-full items-center gap-0.5 rounded-xl border border-gray-200/90 bg-gray-50/80 p-0.5 text-xs font-medium text-gray-700 transition-colors hover:border-gray-300 dark:border-gray-600/70 dark:bg-gray-900/40 dark:text-gray-200 dark:hover:border-gray-500/80"
      data-testid="mount-badge"
    >
      <button
        v-if="showExplorer"
        type="button"
        tw-class="flex min-h-7 min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-700/50 dark:hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/50"
        :title="lazyStrings.MountBadgeList__browse_path({ path: displayPath({ mountPath: mount.mountPath }) })"
        data-testid="mount-open-explorer"
        @click="emit('open-explorer', { volumeId: mount.volumeId })"
      >
        <FolderIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
        <span tw-class="min-w-0 max-w-48 truncate">{{ displayPath({ mountPath: mount.mountPath }) }}</span>
      </button>
      <span
        v-else
        tw-class="flex min-h-7 min-w-0 items-center gap-2 px-2"
        :title="mount.mountPath"
      >
        <FolderIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
        <span tw-class="min-w-0 max-w-48 truncate" data-testid="mount-path-label">{{ displayPath({ mountPath: mount.mountPath }) }}</span>
      </span>
      <button
        type="button"
        @click="emit('toggle-read-only', { volumeId: mount.volumeId, readOnly: !mount.readOnly })"
        :title="mount.readOnly ? lazyStrings.MountBadgeList__read_only_click_to_allow_write() : lazyStrings.MountBadgeList__read_and_write_click_to_restrict()"
        tw-class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/50"
        data-testid="mount-toggle-readonly"
      >
        <LockIcon v-if="mount.readOnly" aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
        <UnlockIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400/80" />
      </button>
      <button
        type="button"
        @click="emit('remove', { volumeId: mount.volumeId })"
        :title="lazyStrings.MountBadgeList__remove()"
        tw-class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/50"
        data-testid="mount-remove-btn"
      >
        <XIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
