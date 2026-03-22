import { ref } from 'vue';
import type { FileExplorerEntry, DragState } from './types';

export function useFileExplorerDragDrop({
  moveEntries,
  currentHandle,
}: {
  moveEntries: ({ entries, targetDir }: { entries: FileExplorerEntry[]; targetDir: FileSystemDirectoryHandle }) => Promise<void>;
  currentHandle: { readonly value: FileSystemDirectoryHandle };
}) {
  const dragState = ref<DragState>({ status: 'idle' });

  function onDragStart({
    event,
    entries,
  }: {
    event: DragEvent;
    entries: FileExplorerEntry[];
  }): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', entries.map(e => e.name).join('\n'));
    dragState.value = {
      status: 'dragging',
      entries,
      sourceDirectory: currentHandle.value,
    };
  }

  function onDragOverEntry({
    event,
    entry,
  }: {
    event: DragEvent;
    entry: FileExplorerEntry;
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
      dragState.value = {
        status: 'dragging',
        entries: [],
        sourceDirectory: currentHandle.value,
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

    const state = dragState.value;
    let entriesToMove: FileExplorerEntry[] = [];

    switch (state.status) {
    case 'dragging':
      entriesToMove = state.entries;
      break;
    case 'over-target':
    case 'idle':
      break;
    default: {
      const _ex: never = state;
      void _ex;
    }
    }

    const targetDir = entry.handle as FileSystemDirectoryHandle;
    dragState.value = { status: 'idle' };

    if (entriesToMove.length > 0) {
      await moveEntries({ entries: entriesToMove, targetDir });
    }
  }

  function onDragEnd(): void {
    dragState.value = { status: 'idle' };
  }

  return {
    dragState,
    onDragStart,
    onDragOverEntry,
    onDragLeaveEntry,
    onDropEntry,
    onDragEnd,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
