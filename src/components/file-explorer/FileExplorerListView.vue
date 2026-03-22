<script setup lang="ts">
import { inject } from 'vue';
import { ChevronUp, ChevronDown } from 'lucide-vue-next';
import FileExplorerEntryItem from './FileExplorerEntryItem.vue';
import FileExplorerEmptyState from './FileExplorerEmptyState.vue';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import type { FileExplorerEntry, SortField } from './types';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;

const columns: Array<{ label: string; field: SortField; class: string }> = [
  { label: 'Name', field: 'name', class: 'flex-1 min-w-0' },
  { label: 'Size', field: 'size', class: 'w-16 text-right shrink-0' },
  { label: 'Modified', field: 'dateModified', class: 'w-28 text-right shrink-0 hidden md:block' },
  { label: 'Type', field: 'type', class: 'w-16 text-right shrink-0 hidden lg:block' },
];

function isEntrySelected({ entry }: { entry: FileExplorerEntry }): boolean {
  return ctx.selectionState.selectedNames.has(entry.name);
}

function isEntryFocused({ entry }: { entry: FileExplorerEntry }): boolean {
  return ctx.selectionState.focusName === entry.name;
}

function isEntryRenaming({ entry }: { entry: FileExplorerEntry }): boolean {
  return ctx.renamingEntryName === entry.name;
}

function isEntryDragTarget({ entry }: { entry: FileExplorerEntry }): boolean {
  return ctx.dragState.status === 'over-target' && ctx.dragState.targetEntryName === entry.name;
}

function isEntryCut({ entry }: { entry: FileExplorerEntry }): boolean {
  return (
    ctx.clipboardState.operation === 'cut' &&
    ctx.clipboardState.entries.some(e => e.name === entry.name)
  );
}

function onEntryClick({ entry, event }: { entry: FileExplorerEntry; event: MouseEvent }): void {
  if (event.shiftKey) {
    ctx.applySelection({
      action: { type: 'range', name: entry.name, allEntries: ctx.sortedFilteredEntries },
    });
  } else if (event.ctrlKey || event.metaKey) {
    ctx.applySelection({ action: { type: 'toggle', name: entry.name } });
  } else {
    ctx.applySelection({ action: { type: 'single', name: entry.name } });
  }
}

async function onEntryDblClick({ entry }: { entry: FileExplorerEntry }): Promise<void> {
  switch (entry.kind) {
  case 'directory':
    await ctx.navigateToDirectory({ handle: entry.handle as FileSystemDirectoryHandle });
    ctx.applySelection({ action: { type: 'clear' } });
    break;
  case 'file':
    await ctx.loadPreview({ entry });
    break;
  default: {
    const _ex: never = entry.kind;
    throw new Error(`Unhandled kind: ${_ex}`);
  }
  }
}

function onContextMenu({ entry, event }: { entry: FileExplorerEntry; event: MouseEvent }): void {
  if (!isEntrySelected({ entry })) {
    ctx.applySelection({ action: { type: 'single', name: entry.name } });
  }
  ctx.showContextMenu({
    event,
    target: { kind: 'entry', entry, selectedEntries: ctx.selectedEntries },
  });
}

function onBackgroundContextMenu(event: MouseEvent): void {
  ctx.applySelection({ action: { type: 'clear' } });
  ctx.showContextMenu({ event, target: { kind: 'background' } });
}

function onBackgroundClick(event: MouseEvent): void {
  if ((event.target as HTMLElement).dataset.listBackground) {
    ctx.applySelection({ action: { type: 'clear' } });
  }
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div
    class="flex flex-col flex-1 overflow-hidden"
    data-testid="list-view"
    @contextmenu.self="onBackgroundContextMenu"
    @click="onBackgroundClick"
  >
    <!-- Column Headers -->
    <div class="flex items-center gap-3 px-3 py-1.5 border-b border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/80 flex-shrink-0">
      <div class="w-4 shrink-0" />
      <div
        v-for="col in columns"
        :key="col.field"
        :class="col.class"
        class="flex items-center gap-1 cursor-pointer hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
        @click="ctx.toggleSortField({ field: col.field })"
      >
        <span class="text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500">
          {{ col.label }}
        </span>
        <template v-if="ctx.sortConfig.field === col.field">
          <ChevronUp v-if="ctx.sortConfig.direction === 'ascending'" class="w-3 h-3 text-blue-500" />
          <ChevronDown v-else class="w-3 h-3 text-blue-500" />
        </template>
      </div>
    </div>

    <!-- Entries -->
    <div
      class="flex-1 overflow-y-auto overscroll-contain p-1"
      data-list-background="true"
      @contextmenu.self="onBackgroundContextMenu"
    >
      <FileExplorerEmptyState
        v-if="ctx.sortedFilteredEntries.length === 0 && !ctx.isLoading"
      />

      <FileExplorerEntryItem
        v-for="entry in ctx.sortedFilteredEntries"
        :key="entry.name"
        :entry="entry"
        :is-selected="isEntrySelected({ entry })"
        :is-focused="isEntryFocused({ entry })"
        :is-renaming="isEntryRenaming({ entry })"
        :is-cut="isEntryCut({ entry })"
        :is-drag-target="isEntryDragTarget({ entry })"
        display-mode="list"
        @click="onEntryClick({ entry, event: $event.event })"
        @dblclick="onEntryDblClick({ entry })"
        @contextmenu="onContextMenu({ entry, event: $event.event })"
        @rename-confirm="ctx.renameEntry({ entry, newName: $event.newName })"
        @rename-cancel="ctx.cancelRename()"
        @dragstart="ctx.onDragStart({ event: $event.event, entries: ctx.selectedEntries.length > 0 ? ctx.selectedEntries : [entry] })"
        @dragover="ctx.onDragOverEntry({ event: $event.event, entry })"
        @dragleave="ctx.onDragLeaveEntry()"
        @drop="ctx.onDropEntry({ entry })"
      />
    </div>
  </div>
</template>
