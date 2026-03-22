import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileExplorerKeyboard } from './useFileExplorerKeyboard';
import type { FileExplorerContext, FileExplorerEntry, ContextMenuTarget } from './types';

// ---- helpers ----

function makeEntry(name: string, kind: 'file' | 'directory' = 'file'): FileExplorerEntry {
  return {
    name,
    kind,
    handle: {} as FileSystemHandle,
    size: undefined,
    lastModified: undefined,
    extension: '.txt',
    mimeCategory: 'text',
  };
}

function makeKey(key: string, opts: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
}

function makeCtx(overrides: Partial<FileExplorerContext> = {}): FileExplorerContext {
  const entries = [makeEntry('alpha'), makeEntry('bravo'), makeEntry('charlie')];
  return {
    root: {} as FileSystemDirectoryHandle,
    currentHandle: {} as FileSystemDirectoryHandle,
    pathSegments: [],
    navigateToDirectory: vi.fn().mockResolvedValue(undefined),
    navigateUp: vi.fn().mockResolvedValue(undefined),
    jumpToBreadcrumb: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    entries,
    sortedFilteredEntries: entries,
    isLoading: false,
    loadError: undefined,
    viewMode: 'list',
    setViewMode: vi.fn(),
    sortConfig: { field: 'name', direction: 'ascending' },
    toggleSortField: vi.fn(),
    filterQuery: '',
    setFilterQuery: vi.fn(),
    selectionState: { selectedNames: new Set(), anchorName: undefined, focusName: undefined },
    selectedEntries: [],
    applySelection: vi.fn(),
    moveFocus: vi.fn(),
    createFile: vi.fn().mockResolvedValue(undefined),
    createFolder: vi.fn().mockResolvedValue(undefined),
    deleteEntries: vi.fn().mockResolvedValue(undefined),
    renameEntry: vi.fn().mockResolvedValue(undefined),
    moveEntries: vi.fn().mockResolvedValue(undefined),
    copyEntriesToDir: vi.fn().mockResolvedValue(undefined),
    downloadEntry: vi.fn().mockResolvedValue(undefined),
    uploadFiles: vi.fn().mockResolvedValue(undefined),
    renamingEntryName: undefined,
    startRename: vi.fn(),
    cancelRename: vi.fn(),
    previewState: {
      visibility: 'visible',
      entry: undefined,
      textContent: undefined,
      highlightedHtml: undefined,
      objectUrl: undefined,
      jsonFormatMode: 'formatted',
      loadingState: 'idle',
      errorMessage: undefined,
      oversized: false,
    },
    loadPreview: vi.fn().mockResolvedValue(undefined),
    loadPreviewForced: vi.fn().mockResolvedValue(undefined),
    clearPreview: vi.fn(),
    togglePreviewVisibility: vi.fn(),
    toggleJsonFormat: vi.fn(),
    contextMenuState: {
      visibility: 'hidden',
      x: 0,
      y: 0,
      target: { kind: 'background' } satisfies ContextMenuTarget,
    },
    showContextMenu: vi.fn(),
    hideContextMenu: vi.fn(),
    executeContextAction: vi.fn().mockResolvedValue(undefined),
    clipboardState: { operation: undefined, sourceDirectory: undefined, entries: [] },
    clipboardCut: vi.fn(),
    clipboardCopy: vi.fn(),
    clipboardPaste: vi.fn().mockResolvedValue(undefined),
    dragState: { status: 'idle' },
    onDragStart: vi.fn(),
    onDragOverEntry: vi.fn(),
    onDragLeaveEntry: vi.fn(),
    onDropEntry: vi.fn().mockResolvedValue(undefined),
    onDragEnd: vi.fn(),
    columnPanes: [],
    selectColumnEntry: vi.fn().mockResolvedValue(undefined),
    statusBarInfo: { totalItems: 3, selectedCount: 0, totalSize: 0, selectedSize: 0 },
    ...overrides,
  };
}

describe('useFileExplorerKeyboard', () => {
  let ctx: FileExplorerContext;
  let handleKeyDown: (arg: { event: KeyboardEvent }) => Promise<void>;

  beforeEach(() => {
    ctx = makeCtx();
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
  });

  // ---- Escape ----

  it('Escape hides context menu when visible', async () => {
    ctx = makeCtx({
      contextMenuState: { visibility: 'visible', x: 0, y: 0, target: { kind: 'background' } },
    });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('Escape') });
    expect(ctx.hideContextMenu).toHaveBeenCalled();
    expect(ctx.applySelection).not.toHaveBeenCalled();
  });

  it('Escape cancels rename when renaming', async () => {
    ctx = makeCtx({ renamingEntryName: 'alpha' });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('Escape') });
    expect(ctx.cancelRename).toHaveBeenCalled();
    expect(ctx.applySelection).not.toHaveBeenCalled();
  });

  it('Escape clears selection when nothing else active', async () => {
    await handleKeyDown({ event: makeKey('Escape') });
    expect(ctx.applySelection).toHaveBeenCalledWith({ action: { type: 'clear' } });
  });

  // ---- Ctrl+A ----

  it('Ctrl+A selects all entries', async () => {
    await handleKeyDown({ event: makeKey('a', { ctrlKey: true }) });
    expect(ctx.applySelection).toHaveBeenCalledWith({
      action: { type: 'all', allEntries: ctx.sortedFilteredEntries },
    });
  });

  it('Cmd+A selects all entries', async () => {
    await handleKeyDown({ event: makeKey('a', { metaKey: true }) });
    expect(ctx.applySelection).toHaveBeenCalledWith({
      action: { type: 'all', allEntries: ctx.sortedFilteredEntries },
    });
  });

  // ---- Ctrl+C ----

  it('Ctrl+C copies selected entries', async () => {
    ctx = makeCtx({ selectedEntries: [makeEntry('alpha')] });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('c', { ctrlKey: true }) });
    expect(ctx.clipboardCopy).toHaveBeenCalledWith({ entries: ctx.selectedEntries });
  });

  it('Ctrl+C does nothing when nothing selected', async () => {
    await handleKeyDown({ event: makeKey('c', { ctrlKey: true }) });
    expect(ctx.clipboardCopy).not.toHaveBeenCalled();
  });

  // ---- Ctrl+X ----

  it('Ctrl+X cuts selected entries', async () => {
    ctx = makeCtx({ selectedEntries: [makeEntry('bravo')] });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('x', { ctrlKey: true }) });
    expect(ctx.clipboardCut).toHaveBeenCalledWith({ entries: ctx.selectedEntries });
  });

  // ---- Ctrl+V ----

  it('Ctrl+V pastes clipboard', async () => {
    await handleKeyDown({ event: makeKey('v', { ctrlKey: true }) });
    expect(ctx.clipboardPaste).toHaveBeenCalled();
  });

  // ---- Delete ----

  it('Delete deletes selected entries and clears selection', async () => {
    ctx = makeCtx({ selectedEntries: [makeEntry('alpha')] });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('Delete') });
    expect(ctx.deleteEntries).toHaveBeenCalledWith({ entries: ctx.selectedEntries });
    expect(ctx.applySelection).toHaveBeenCalledWith({ action: { type: 'clear' } });
  });

  it('Delete does nothing when nothing selected', async () => {
    await handleKeyDown({ event: makeKey('Delete') });
    expect(ctx.deleteEntries).not.toHaveBeenCalled();
  });

  it('Backspace behaves like Delete', async () => {
    ctx = makeCtx({ selectedEntries: [makeEntry('alpha')] });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('Backspace') });
    expect(ctx.deleteEntries).toHaveBeenCalled();
  });

  // ---- F2 ----

  it('F2 starts rename for focused entry', async () => {
    const focused = makeEntry('bravo');
    const entries = [makeEntry('alpha'), focused, makeEntry('charlie')];
    ctx = makeCtx({
      sortedFilteredEntries: entries,
      selectionState: { selectedNames: new Set(['bravo']), anchorName: 'bravo', focusName: 'bravo' },
    });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('F2') });
    expect(ctx.startRename).toHaveBeenCalledWith({ entry: focused });
  });

  it('F2 does nothing when no focus', async () => {
    await handleKeyDown({ event: makeKey('F2') });
    expect(ctx.startRename).not.toHaveBeenCalled();
  });

  // ---- Enter ----

  it('Enter navigates into directory', async () => {
    const dir = makeEntry('docs', 'directory');
    const entries = [dir];
    ctx = makeCtx({
      sortedFilteredEntries: entries,
      selectionState: { selectedNames: new Set(['docs']), anchorName: 'docs', focusName: 'docs' },
    });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('Enter') });
    expect(ctx.navigateToDirectory).toHaveBeenCalledWith({ handle: dir.handle });
    expect(ctx.applySelection).toHaveBeenCalledWith({ action: { type: 'clear' } });
  });

  it('Enter loads preview for file', async () => {
    const file = makeEntry('readme.txt', 'file');
    const entries = [file];
    ctx = makeCtx({
      sortedFilteredEntries: entries,
      selectionState: { selectedNames: new Set(['readme.txt']), anchorName: 'readme.txt', focusName: 'readme.txt' },
    });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('Enter') });
    expect(ctx.loadPreview).toHaveBeenCalledWith({ entry: file });
  });

  // ---- Arrow navigation ----

  it('ArrowDown calls moveFocus(next, extend=false)', async () => {
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('ArrowDown') });
    expect(ctx.moveFocus).toHaveBeenCalledWith({ direction: 'next', extend: false });
  });

  it('ArrowUp calls moveFocus(prev, extend=false)', async () => {
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('ArrowUp') });
    expect(ctx.moveFocus).toHaveBeenCalledWith({ direction: 'prev', extend: false });
  });

  it('ArrowDown with Shift calls moveFocus(next, extend=true)', async () => {
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('ArrowDown', { shiftKey: true }) });
    expect(ctx.moveFocus).toHaveBeenCalledWith({ direction: 'next', extend: true });
  });

  it('ArrowLeft calls moveFocus(prev, extend=false)', async () => {
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('ArrowLeft') });
    expect(ctx.moveFocus).toHaveBeenCalledWith({ direction: 'prev', extend: false });
  });

  it('Arrow keys do nothing on empty entry list', async () => {
    ctx = makeCtx({ sortedFilteredEntries: [] });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('ArrowDown') });
    expect(ctx.moveFocus).not.toHaveBeenCalled();
  });

  // ---- Space (Quick Look) ----

  it('Space toggles preview for focused file', async () => {
    const file = makeEntry('photo.png', 'file');
    ctx = makeCtx({
      sortedFilteredEntries: [file],
      selectionState: { selectedNames: new Set(['photo.png']), anchorName: 'photo.png', focusName: 'photo.png' },
      previewState: {
        visibility: 'hidden',
        entry: undefined,
        textContent: undefined,
        highlightedHtml: undefined,
        objectUrl: undefined,
        jsonFormatMode: 'formatted',
        loadingState: 'idle',
        errorMessage: undefined,
        oversized: false,
      },
    });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey(' ') });
    expect(ctx.togglePreviewVisibility).toHaveBeenCalled();
    expect(ctx.loadPreview).toHaveBeenCalledWith({ entry: file });
  });

  it('Space does not intercept keys while renaming', async () => {
    ctx = makeCtx({ renamingEntryName: 'alpha' });
    ({ handleKeyDown } = useFileExplorerKeyboard({ ctx }));
    await handleKeyDown({ event: makeKey('Delete') });
    expect(ctx.deleteEntries).not.toHaveBeenCalled();
  });
});
