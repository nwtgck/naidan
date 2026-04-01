import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop';
import type { FileExplorerEntry } from './types';
import type { ExplorerDirectory } from './explorer-directory';

function makeEntry(name: string, kind: 'file' | 'directory' = 'file'): FileExplorerEntry {
  return {
    name,
    kind,
    handle: {} as FileSystemHandle,
    directory: undefined,
    size: undefined,
    lastModified: undefined,
    extension: '',
    mimeCategory: 'binary',
    readOnly: false,
  };
}

function makeDirEntry(name: string, directory: ExplorerDirectory): FileExplorerEntry {
  return { ...makeEntry(name, 'directory'), directory };
}

function makeDragEvent(opts: { dataTransfer?: boolean } = {}): DragEvent {
  const dt = opts.dataTransfer !== false
    ? {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    }
    : null;
  return {
    preventDefault: vi.fn(),
    dataTransfer: dt,
  } as unknown as DragEvent;
}

const fakeDir = { name: 'root', readOnly: false } as unknown as ExplorerDirectory;

describe('useFileExplorerDragDrop', () => {
  let moveEntries: ({ entries, targetDir }: { entries: FileExplorerEntry[]; targetDir: ExplorerDirectory }) => Promise<void>;
  let currentDirectory: { readonly value: ExplorerDirectory };

  beforeEach(() => {
    moveEntries = vi.fn().mockResolvedValue(undefined);
    currentDirectory = ref(fakeDir) as unknown as { readonly value: ExplorerDirectory };
  });

  function makeDnd({ isReadOnly = () => false }: { isReadOnly?: () => boolean } = {}) {
    return useFileExplorerDragDrop({ moveEntries, currentDirectory, isReadOnly });
  }

  // ---- initial state ----

  it('starts idle', () => {
    const { dragState } = makeDnd();
    expect(dragState.value.status).toBe('idle');
  });

  // ---- onDragStart ----

  it('onDragStart sets dragging state', () => {
    const { dragState, onDragStart } = makeDnd();
    const entries = [makeEntry('a.txt')];
    onDragStart({ event: makeDragEvent(), entries });
    expect(dragState.value.status).toBe('dragging');
  });

  it('onDragStart sets effectAllowed and data', () => {
    const { onDragStart } = makeDnd();
    const event = makeDragEvent();
    onDragStart({ event, entries: [makeEntry('a.txt'), makeEntry('b.txt')] });
    expect(event.dataTransfer!.effectAllowed).toBe('move');
    expect((event.dataTransfer!.setData as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      'text/plain', `\
a.txt
b.txt`,
    ]);
  });

  it('onDragStart does nothing without dataTransfer', () => {
    const { dragState, onDragStart } = makeDnd();
    onDragStart({ event: makeDragEvent({ dataTransfer: false }), entries: [makeEntry('a.txt')] });
    expect(dragState.value.status).toBe('idle');
  });

  // ---- onDragOverEntry ----

  it('onDragOverEntry on a directory transitions to over-target', () => {
    const { dragState, onDragStart, onDragOverEntry } = makeDnd();
    onDragStart({ event: makeDragEvent(), entries: [makeEntry('a.txt')] });
    const dir = makeEntry('subdir', 'directory');
    onDragOverEntry({ event: makeDragEvent(), entry: dir });
    expect(dragState.value.status).toBe('over-target');
    if (dragState.value.status === 'over-target') {
      expect(dragState.value.targetEntryName).toBe('subdir');
    }
  });

  it('onDragOverEntry on a file does not transition', () => {
    const { dragState, onDragStart, onDragOverEntry } = makeDnd();
    onDragStart({ event: makeDragEvent(), entries: [makeEntry('a.txt')] });
    const file = makeEntry('b.txt', 'file');
    onDragOverEntry({ event: makeDragEvent(), entry: file });
    expect(dragState.value.status).toBe('dragging');
  });

  it('onDragOverEntry does nothing when idle', () => {
    const { dragState, onDragOverEntry } = makeDnd();
    const dir = makeEntry('subdir', 'directory');
    onDragOverEntry({ event: makeDragEvent(), entry: dir });
    expect(dragState.value.status).toBe('idle');
  });

  // ---- onDragLeaveEntry ----

  it('onDragLeaveEntry restores dragging state with original entries', () => {
    const { dragState, onDragStart, onDragOverEntry, onDragLeaveEntry } = makeDnd();
    const entries = [makeEntry('a.txt'), makeEntry('b.txt')];
    onDragStart({ event: makeDragEvent(), entries });
    onDragOverEntry({ event: makeDragEvent(), entry: makeEntry('subdir', 'directory') });
    expect(dragState.value.status).toBe('over-target');

    onDragLeaveEntry();

    expect(dragState.value.status).toBe('dragging');
    if (dragState.value.status === 'dragging') {
      // Entries must be preserved — this was the bug
      expect(dragState.value.entries).toHaveLength(2);
      expect(dragState.value.entries.map(e => e.name)).toEqual(['a.txt', 'b.txt']);
    }
  });

  it('onDragLeaveEntry does nothing when idle', () => {
    const { dragState, onDragLeaveEntry } = makeDnd();
    onDragLeaveEntry();
    expect(dragState.value.status).toBe('idle');
  });

  // ---- onDropEntry ----

  it('onDropEntry calls moveEntries with original entries — even after over-target transition', async () => {
    const { onDragStart, onDragOverEntry, onDropEntry } = makeDnd();
    const entries = [makeEntry('a.txt'), makeEntry('b.txt')];
    const subDir = { name: 'subdir', readOnly: false } as unknown as ExplorerDirectory;
    const targetDir = makeDirEntry('subdir', subDir);

    onDragStart({ event: makeDragEvent(), entries });
    onDragOverEntry({ event: makeDragEvent(), entry: targetDir });
    // State is now over-target — the old bug would have lost the entries here

    await onDropEntry({ entry: targetDir });

    expect(moveEntries).toHaveBeenCalledWith({
      entries,
      targetDir: subDir,
    });
  });

  it('onDropEntry resets to idle after drop', async () => {
    const { dragState, onDragStart, onDropEntry } = makeDnd();
    onDragStart({ event: makeDragEvent(), entries: [makeEntry('a.txt')] });
    await onDropEntry({ entry: makeEntry('subdir', 'directory') });
    expect(dragState.value.status).toBe('idle');
  });

  it('onDropEntry on a file does nothing', async () => {
    const { onDragStart, onDropEntry } = makeDnd();
    onDragStart({ event: makeDragEvent(), entries: [makeEntry('a.txt')] });
    await onDropEntry({ entry: makeEntry('other.txt', 'file') });
    expect(moveEntries).not.toHaveBeenCalled();
  });

  it('onDropEntry does not call moveEntries when no entries dragged', async () => {
    const { onDropEntry } = makeDnd();
    // Start without a drag — entries are empty
    await onDropEntry({ entry: makeEntry('subdir', 'directory') });
    expect(moveEntries).not.toHaveBeenCalled();
  });

  // ---- onDragEnd ----

  it('onDragEnd resets to idle', () => {
    const { dragState, onDragStart, onDragEnd } = makeDnd();
    onDragStart({ event: makeDragEvent(), entries: [makeEntry('a.txt')] });
    onDragEnd();
    expect(dragState.value.status).toBe('idle');
  });

  it('onDragEnd clears active entries so a subsequent drop has nothing', async () => {
    const { onDragStart, onDragEnd, onDropEntry } = makeDnd();
    onDragStart({ event: makeDragEvent(), entries: [makeEntry('a.txt')] });
    onDragEnd();
    await onDropEntry({ entry: makeEntry('subdir', 'directory') });
    expect(moveEntries).not.toHaveBeenCalled();
  });
});
