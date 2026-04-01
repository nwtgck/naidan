<script setup lang="ts">
import { inject, ref } from 'vue';
import FileExplorerEntryItem from './FileExplorerEntryItem.vue';
import FileExplorerEmptyState from './FileExplorerEmptyState.vue';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import type { FileExplorerEntry } from './types';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;

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
    await ctx.navigateToDirectory({ directory: entry.directory! });
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

const isExternalDragOver = ref(false);

function onExternalDragOver(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) {
    isExternalDragOver.value = true;
  }
}

async function onExternalDrop(event: DragEvent): Promise<void> {
  isExternalDragOver.value = false;
  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    await ctx.uploadFiles({ files });
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
    class="flex-1 overflow-y-auto overscroll-contain p-3 transition-colors"
    :class="isExternalDragOver ? 'ring-2 ring-blue-400 ring-inset bg-blue-50/30 dark:bg-blue-900/10' : ''"
    data-testid="icon-view"
    @contextmenu.self="onBackgroundContextMenu"
    @click.self="ctx.applySelection({ action: { type: 'clear' } })"
    @dragover.prevent="onExternalDragOver"
    @dragleave="isExternalDragOver = false"
    @drop.prevent="onExternalDrop"
  >
    <FileExplorerEmptyState
      v-if="ctx.sortedFilteredEntries.length === 0 && !ctx.isLoading"
    />

    <div class="flex flex-wrap gap-2 content-start">
      <FileExplorerEntryItem
        v-for="entry in ctx.sortedFilteredEntries"
        :key="entry.name"
        :entry="entry"
        :is-selected="isEntrySelected({ entry })"
        :is-focused="isEntryFocused({ entry })"
        :is-renaming="isEntryRenaming({ entry })"
        :is-cut="isEntryCut({ entry })"
        :is-drag-target="isEntryDragTarget({ entry })"
        display-mode="icon"
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
