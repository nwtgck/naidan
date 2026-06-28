import { ref } from 'vue';
import type { FileExplorerEntry, DragState } from '@/features/file-explorer/logic/types';

export function useFileExplorerDragDrop({
  moveEntries,
  currentDirectoryPath,
  isReadOnly,
}: {
  moveEntries: ({ entries, targetPath }: { entries: FileExplorerEntry[], targetPath: string }) => Promise<void>,
  currentDirectoryPath: { readonly value: string },
  isReadOnly: () => boolean,
}) {
  const dragState = ref<DragState>({ status: 'idle' });

  // Entries being dragged — persisted through status transitions so they survive
  // the idle→dragging→over-target→drop cycle without loss.
  const activeDragEntries = ref<FileExplorerEntry[]>([]);

  function onDragStart({
    event,
    entries,
  }: {
    event: DragEvent,
    entries: FileExplorerEntry[],
  }): void {
    if (isReadOnly()) return;
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', entries.map(e => e.name).join('\n'));
    activeDragEntries.value = entries;
    dragState.value = {
      status: 'dragging',
      entries,
      sourceDirectoryPath: currentDirectoryPath.value,
    };
  }

  function onDragOverEntry({
    event,
    entry,
  }: {
    event: DragEvent,
    entry: FileExplorerEntry,
  }): void {
    switch (dragState.value.status) {
    case 'dragging':
      break;
    case 'idle':
    case 'over-target':
      return;
    default: {
      const _ex: never = dragState.value;
      void _ex;
      return;
    }
    }

    switch (entry.kind) {
    case 'directory':
      break;
    case 'file':
      return;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dragState.value = { status: 'over-target', targetEntryName: entry.name };
  }

  function onDragLeaveEntry(): void {
    switch (dragState.value.status) {
    case 'over-target':
      // Restore dragging state, re-using the preserved active entries
      dragState.value = {
        status: 'dragging',
        entries: activeDragEntries.value,
        sourceDirectoryPath: currentDirectoryPath.value,
      };
      break;
    case 'dragging':
    case 'idle':
      break;
    default: {
      const _ex: never = dragState.value;
      void _ex;
    }
    }
  }

  async function onDropEntry({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    if (isReadOnly()) {
      activeDragEntries.value = [];
      dragState.value = { status: 'idle' };
      return;
    }

    switch (entry.kind) {
    case 'directory':
      break;
    case 'file':
      return;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }

    // Use activeDragEntries which persists regardless of the current status
    const entriesToMove = activeDragEntries.value;
    activeDragEntries.value = [];
    dragState.value = { status: 'idle' };

    if (entriesToMove.length > 0) {
      await moveEntries({ entries: entriesToMove, targetPath: entry.path });
    }
  }

  function onDragEnd(): void {
    activeDragEntries.value = [];
    dragState.value = { status: 'idle' };
  }

  return {
    dragState,
    onDragStart,
    onDragOverEntry,
    onDragLeaveEntry,
    onDropEntry,
    onDragEnd,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
