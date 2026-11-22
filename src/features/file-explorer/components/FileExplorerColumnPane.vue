<script setup lang="ts">
import { inject, computed } from 'vue';
import FileExplorerEntryItem from './FileExplorerEntryItem.vue';
import FileExplorerEmptyState from './FileExplorerEmptyState.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { sortEntries } from '@/features/file-explorer/logic/utils';
import type { ColumnPaneState, FileExplorerEntry } from '@/features/file-explorer/logic/types';
import { Loader2Icon } from 'lucide-vue-next';

const props = defineProps<{
  pane: ColumnPaneState,
  paneIndex: number,
}>();

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;

const sortedEntries = computed(() =>
  sortEntries({ entries: props.pane.entries, config: ctx.sortConfig }),
);

function isSelected({ entry }: { entry: FileExplorerEntry }): boolean {
  return props.pane.selectedEntryName === entry.name;
}

function isRenaming({ entry }: { entry: FileExplorerEntry }): boolean {
  return ctx.renamingEntryName === entry.name;
}

function isEntryCut({ entry }: { entry: FileExplorerEntry }): boolean {
  return (
    ctx.clipboardState.operation === 'cut' &&
    ctx.clipboardState.entries.some(e => e.name === entry.name)
  );
}

async function onEntryDblClick({ entry }: { entry: FileExplorerEntry }): Promise<void> {
  switch (entry.kind) {
  case 'file':
    await ctx.openEntry({ entry });
    break;
  case 'directory':
    break;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled kind: ${_ex}`);
  }
  }
}

function onContextMenu({ entry, event }: { entry: FileExplorerEntry, event: MouseEvent }): void {
  ctx.showContextMenu({
    event,
    target: {
      kind: 'entry',
      entry,
      selectedEntries: ctx.selectedEntries.length > 0 ? ctx.selectedEntries : [entry],
    },
  });
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
  <div
    data-testid="file-explorer-column-pane"
    :aria-busy="pane.isLoading"
    tw-class="flex flex-col w-52 shrink-0 border-r border-gray-100 dark:border-gray-800 overflow-x-hidden overflow-y-auto overscroll-y-contain"
  >
    <div v-if="pane.isLoading && pane.entries.length === 0" tw-class="flex items-center justify-center py-8">
      <Loader2Icon tw-class="w-4 h-4 text-gray-400 animate-spin" />
    </div>
    <div v-else tw-class="p-1 space-y-0.5">
      <FileExplorerEmptyState v-if="pane.entries.length === 0" density="compact" kind="empty-folder" />
      <FileExplorerEntryItem
        v-for="entry in sortedEntries"
        :key="entry.name"
        :entry="entry"
        :is-selected="isSelected({ entry })"
        :is-focused="false"
        :is-renaming="isRenaming({ entry })"
        :is-cut="isEntryCut({ entry })"
        :is-drag-target="false"
        display-mode="column"
        @click="ctx.selectColumnEntry({ paneIndex, entryName: entry.name })"
        @dblclick="onEntryDblClick({ entry })"
        @contextmenu="onContextMenu({ entry, event: $event.event })"
        @rename-confirm="ctx.renameEntry({ entry, newName: $event.newName })"
        @rename-cancel="ctx.cancelRename()"
      />
    </div>
  </div>
</template>
