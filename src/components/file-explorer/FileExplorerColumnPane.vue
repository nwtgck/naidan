<script setup lang="ts">
import { inject, computed } from 'vue';
import FileExplorerEntryItem from './FileExplorerEntryItem.vue';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import { sortEntries } from './utils';
import type { ColumnPaneState, FileExplorerEntry } from './types';
import { Loader2 } from 'lucide-vue-next';

const props = defineProps<{
  pane: ColumnPaneState;
  paneIndex: number;
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

async function onEntryClick({ entry }: { entry: FileExplorerEntry }): Promise<void> {
  await ctx.selectColumnEntry({ paneIndex: props.paneIndex, entryName: entry.name });
  switch (entry.kind) {
  case 'file':
    await ctx.loadPreview({ entry });
    break;
  case 'directory':
    break;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled kind: ${_ex}`);
  }
  }
}

async function onEntryDblClick({ entry }: { entry: FileExplorerEntry }): Promise<void> {
  // In column view, dblclick is same as single click (navigation already happened)
  switch (entry.kind) {
  case 'file':
    await ctx.loadPreview({ entry });
    break;
  case 'directory':
    break;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled kind: ${_ex}`);
  }
  }
}

function onContextMenu({ entry, event }: { entry: FileExplorerEntry; event: MouseEvent }): void {
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
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex flex-col w-52 shrink-0 border-r border-gray-100 dark:border-gray-800 overflow-y-auto overscroll-contain">
    <div v-if="pane.isLoading" class="flex items-center justify-center py-8">
      <Loader2 class="w-4 h-4 text-gray-400 animate-spin" />
    </div>
    <div v-else class="p-1 space-y-0.5">
      <p v-if="pane.entries.length === 0" class="text-[10px] text-gray-400 text-center py-6 uppercase tracking-widest font-bold">
        Empty
      </p>
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
        @click="onEntryClick({ entry })"
        @dblclick="onEntryDblClick({ entry })"
        @contextmenu="onContextMenu({ entry, event: $event.event })"
        @rename-confirm="ctx.renameEntry({ entry, newName: $event.newName })"
        @rename-cancel="ctx.cancelRename()"
      />
    </div>
  </div>
</template>
