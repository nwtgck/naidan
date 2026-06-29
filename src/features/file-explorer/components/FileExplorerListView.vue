<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, inject, ref, watch } from 'vue';
import { ChevronUpIcon, ChevronDownIcon } from 'lucide-vue-next';
import FileExplorerEntryItem from './FileExplorerEntryItem.vue';
import FileExplorerEmptyState from './FileExplorerEmptyState.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import type { FileExplorerEntry, SortField } from '@/features/file-explorer/logic/types';
import { LIST_ROW_HEIGHT, VIRTUAL_SCROLL_OVERSCAN } from '@/features/file-explorer/logic/constants';
import { useVirtualizedFileExplorerList } from '@/features/file-explorer/composables/useVirtualizedFileExplorerList';
import { useFileExplorerLongPress } from '@/features/file-explorer/composables/useFileExplorerLongPress';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const scrollContainerRef = ref<HTMLElement | undefined>(undefined);

type FileExplorerColumn = { readonly label: string, readonly field: SortField, readonly class: string };

const columns = computed<FileExplorerColumn[]>(() => {
  const name = lazyStrings.fileExplorer__name();
  const size = lazyStrings.fileExplorer__size();
  const modified = lazyStrings.fileExplorer__modified();
  const type = lazyStrings.fileExplorer__type();
  if (name === undefined || size === undefined || modified === undefined || type === undefined) return [];

  return [
    { label: name, field: 'name', class: 'flex-1 min-w-0' },
    { label: size, field: 'size', class: 'w-16 text-right shrink-0' },
    { label: modified, field: 'dateModified', class: 'w-28 text-right shrink-0 hidden md:block' },
    { label: type, field: 'type', class: 'w-16 text-right shrink-0 hidden lg:block' },
  ];
});

const sortedFilteredEntriesRef = computed(() => ctx.sortedFilteredEntries);

const {
  visibleEntries,
  totalHeight,
  topSpacerHeight,
  bottomSpacerHeight,
  scrollEntryIntoView,
} = useVirtualizedFileExplorerList({
  containerRef: scrollContainerRef,
  entries: sortedFilteredEntriesRef,
  rowHeight: LIST_ROW_HEIGHT,
  overscan: VIRTUAL_SCROLL_OVERSCAN,
});

watch(
  () => ctx.selectionState.focusName,
  focusName => {
    scrollEntryIntoView({ entryName: focusName });
  },
  { flush: 'post' },
);

watch(
  () => ctx.renamingEntryName,
  renamingEntryName => {
    scrollEntryIntoView({ entryName: renamingEntryName });
  },
  { flush: 'post' },
);

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

function onEntryClick({ entry, event }: { entry: FileExplorerEntry, event: MouseEvent }): void {
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
    await ctx.navigateToDirectory({ path: entry.path });
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

function onContextMenu({ entry, event }: { entry: FileExplorerEntry, event: MouseEvent }): void {
  if (!isEntrySelected({ entry })) {
    ctx.applySelection({ action: { type: 'single', name: entry.name } });
  }
  ctx.showContextMenu({
    event,
    target: { kind: 'entry', entry, selectedEntries: ctx.selectedEntries },
  });
}

function onBackgroundContextMenu({ event }: { event: MouseEvent }): void {
  ctx.applySelection({ action: { type: 'clear' } });
  ctx.showContextMenu({ event, target: { kind: 'background' } });
}

const backgroundLongPress = useFileExplorerLongPress({
  onLongPress: ({ event }) => onBackgroundContextMenu({ event }),
  isEnabled: undefined,
});

function onBackgroundNativeContextMenu({ event }: { event: MouseEvent }): void {
  backgroundLongPress.cancel();
  onBackgroundContextMenu({ event });
}

function onBackgroundClick({ event }: { event: MouseEvent }): void {
  if (backgroundLongPress.consumeClick({ event })) return;
  if ((event.target as HTMLElement).dataset.listBackground) {
    ctx.applySelection({ action: { type: 'clear' } });
  }
}

const isExternalDragOver = ref(false);

function onExternalDragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer?.types.includes('Files')) {
    isExternalDragOver.value = true;
  }
}

async function onExternalDrop({ event }: { event: DragEvent }): Promise<void> {
  isExternalDragOver.value = false;
  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    await ctx.uploadFiles({ files });
  }
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div
    class="flex flex-col flex-1 overflow-hidden"
    data-testid="list-view"
    @pointerdown.self="backgroundLongPress.onPointerDown({ event: $event })"
    @contextmenu.self="onBackgroundNativeContextMenu({ event: $event })"
    @click="onBackgroundClick({ event: $event })"
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
          <ChevronUpIcon v-if="ctx.sortConfig.direction === 'ascending'" class="w-3 h-3 text-blue-500" />
          <ChevronDownIcon v-else class="w-3 h-3 text-blue-500" />
        </template>
      </div>
    </div>

    <!-- Entries -->
    <div
      ref="scrollContainerRef"
      class="flex-1 overflow-y-auto overscroll-contain p-1 transition-colors"
      :class="isExternalDragOver ? 'ring-2 ring-blue-400 ring-inset bg-blue-50/30 dark:bg-blue-900/10' : ''"
      data-list-background="true"
      data-testid="list-scroll-container"
      @pointerdown.self="backgroundLongPress.onPointerDown({ event: $event })"
      @contextmenu.self="onBackgroundNativeContextMenu({ event: $event })"
      @dragover.prevent="onExternalDragOver({ event: $event })"
      @dragleave="isExternalDragOver = false"
      @drop.prevent="onExternalDrop({ event: $event })"
    >
      <FileExplorerEmptyState
        v-if="ctx.sortedFilteredEntries.length === 0 && !ctx.isLoading"
      />

      <div
        v-if="ctx.sortedFilteredEntries.length > 0"
        :style="{ height: `${totalHeight}px` }"
        data-testid="list-virtual-spacer"
      >
        <div :style="{ height: `${topSpacerHeight}px` }" />

        <FileExplorerEntryItem
          v-for="entry in visibleEntries"
          :key="entry.path"
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

        <div :style="{ height: `${bottomSpacerHeight}px` }" />
      </div>
    </div>
  </div>
</template>
