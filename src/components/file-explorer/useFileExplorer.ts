import { ref, computed } from 'vue';
import type { InjectionKey } from 'vue';
import type {
  FileExplorerEntry,
  FileExplorerContext,
  SortConfig,
  ViewMode,
  SortField,
  SelectionAction,
  ContextMenuAction,
} from './types';
import { useFileExplorerNavigation } from './useFileExplorerNavigation';
import { useFileExplorerSelection } from './useFileExplorerSelection';
import { useFileExplorerOperations } from './useFileExplorerOperations';
import { useFileExplorerPreview } from './useFileExplorerPreview';
import { useFileExplorerClipboard } from './useFileExplorerClipboard';
import { useFileExplorerContextMenu } from './useFileExplorerContextMenu';
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop';
import { useToast } from '@/composables/useToast';
import { usePrompt } from '@/composables/usePrompt';

export const FILE_EXPLORER_INJECTION_KEY: InjectionKey<FileExplorerContext> =
  Symbol('FileExplorerContext');

export function useFileExplorer({ root }: { root: FileSystemDirectoryHandle }) {
  const { addToast } = useToast();
  const { showPrompt } = usePrompt();

  // --- State ---
  const viewMode = ref<ViewMode>('list');
  const sortConfig = ref<SortConfig>({ field: 'name', direction: 'ascending' });
  const filterQuery = ref('');

  // --- Navigation ---
  const nav = useFileExplorerNavigation({
    root,
    sortConfig: sortConfig as { value: SortConfig },
    filterQuery: filterQuery as { value: string },
  });

  // --- Selection ---
  const sel = useFileExplorerSelection();

  // selectedEntries as computed from nav.sortedFilteredEntries
  const selectedEntries = computed(() =>
    sel.getSelectedEntries({ allEntries: nav.sortedFilteredEntries.value }),
  );

  // Status bar
  const statusBarInfo = computed(() => {
    const all = nav.sortedFilteredEntries.value;
    const selected = selectedEntries.value;
    return {
      totalItems: all.length,
      selectedCount: selected.length,
      totalSize: all.reduce((s, e) => s + (e.size ?? 0), 0),
      selectedSize: selected.reduce((s, e) => s + (e.size ?? 0), 0),
    };
  });

  // --- Operations ---
  const ops = useFileExplorerOperations({
    currentHandle: nav.currentHandle as { readonly value: FileSystemDirectoryHandle },
    refresh: nav.refresh,
  });

  // --- Preview ---
  const preview = useFileExplorerPreview();

  // --- Clipboard ---
  const clipboard = useFileExplorerClipboard();

  // --- Context menu ---
  const ctxMenu = useFileExplorerContextMenu();

  // --- Drag and drop ---
  const dnd = useFileExplorerDragDrop({
    moveEntries: ops.moveEntries,
    currentHandle: nav.currentHandle as { readonly value: FileSystemDirectoryHandle },
  });

  // --- View mode ---
  function setViewMode({ mode }: { mode: ViewMode }): void {
    viewMode.value = mode;
  }

  // --- Sort ---
  function toggleSortField({ field }: { field: SortField }): void {
    const cur = sortConfig.value;
    if (cur.field === field) {
      switch (cur.direction) {
      case 'ascending':
        sortConfig.value = { field, direction: 'descending' };
        break;
      case 'descending':
        sortConfig.value = { field, direction: 'ascending' };
        break;
      default: {
        const _ex: never = cur.direction;
        throw new Error(`Unhandled direction: ${_ex}`);
      }
      }
    } else {
      sortConfig.value = { field, direction: 'ascending' };
    }
  }

  // --- Filter ---
  function setFilterQuery({ query }: { query: string }): void {
    filterQuery.value = query;
  }

  // --- Selection ---
  function applySelection({ action }: { action: SelectionAction }): void {
    sel.applySelection({ action });
  }

  // --- Context menu execution ---
  async function executeContextAction({ action }: { action: ContextMenuAction }): Promise<void> {
    const targetCtx = ctxMenu.contextMenuState.value.target;
    ctxMenu.hideContextMenu();

    switch (action) {
    case 'open': {
      switch (targetCtx.kind) {
      case 'entry': {
        const entry = targetCtx.entry;
        switch (entry.kind) {
        case 'directory':
          await nav.navigateToDirectory({ handle: entry.handle as FileSystemDirectoryHandle });
          sel.clearSelectionForNewDirectory();
          break;
        case 'file':
          await preview.loadPreview({ entry });
          break;
        default: {
          const _ex: never = entry.kind;
          throw new Error(`Unhandled kind: ${_ex}`);
        }
        }
        break;
      }
      case 'background':
        break;
      default: {
        const _ex: never = targetCtx;
        throw new Error(`Unhandled target: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'rename': {
      switch (targetCtx.kind) {
      case 'entry':
        ops.startRename({ entry: targetCtx.entry });
        break;
      case 'background':
        break;
      default: {
        const _ex: never = targetCtx;
        throw new Error(`Unhandled target: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'delete': {
      switch (targetCtx.kind) {
      case 'entry': {
        const entriesToDelete = targetCtx.selectedEntries;
        if (entriesToDelete.length > 0) {
          await ops.deleteEntries({ entries: entriesToDelete });
          sel.clearSelectionForNewDirectory();
        }
        break;
      }
      case 'background':
        break;
      default: {
        const _ex: never = targetCtx;
        throw new Error(`Unhandled target: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'copy': {
      switch (targetCtx.kind) {
      case 'entry':
        clipboard.clipboardCopy({ entries: targetCtx.selectedEntries, sourceDirectory: nav.currentHandle.value });
        break;
      case 'background':
        break;
      default: {
        const _ex: never = targetCtx;
        throw new Error(`Unhandled target: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'cut': {
      switch (targetCtx.kind) {
      case 'entry':
        clipboard.clipboardCut({ entries: targetCtx.selectedEntries, sourceDirectory: nav.currentHandle.value });
        break;
      case 'background':
        break;
      default: {
        const _ex: never = targetCtx;
        throw new Error(`Unhandled target: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'paste': {
      await clipboardPaste();
      break;
    }
    case 'download': {
      switch (targetCtx.kind) {
      case 'entry':
        for (const entry of targetCtx.selectedEntries) {
          await ops.downloadEntry({ entry });
        }
        break;
      case 'background':
        break;
      default: {
        const _ex: never = targetCtx;
        throw new Error(`Unhandled target: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'newFile': {
      const name = await showPrompt({
        title: 'New File',
        message: 'Enter a name for the new file:',
        confirmButtonText: 'Create',
      });
      if (name) await ops.createFile({ name });
      break;
    }
    case 'newFolder': {
      const name = await showPrompt({
        title: 'New Folder',
        message: 'Enter a name for the new folder:',
        confirmButtonText: 'Create',
      });
      if (name) await ops.createFolder({ name });
      break;
    }
    case 'getInfo': {
      switch (targetCtx.kind) {
      case 'entry': {
        const entry = targetCtx.entry;
        const path = [...nav.pathSegments.value.map(s => s.name), entry.name].join(' / ');
        const sizeStr = entry.size !== undefined ? `${entry.size.toLocaleString()} bytes` : '—';
        addToast({
          message: `${entry.name}\nKind: ${entry.kind}\nSize: ${sizeStr}\nPath: ${path}`,
          duration: 10000,
        });
        break;
      }
      case 'background':
        break;
      default: {
        const _ex: never = targetCtx;
        throw new Error(`Unhandled target: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'selectAll': {
      applySelection({
        action: { type: 'all', allEntries: nav.sortedFilteredEntries.value },
      });
      break;
    }
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled context action: ${_ex}`);
    }
    }
  }

  // --- Clipboard paste ---
  async function clipboardPaste(): Promise<void> {
    const cb = clipboard.clipboardState.value;
    if (!cb.operation || cb.entries.length === 0) return;

    switch (cb.operation) {
    case 'copy':
      await ops.copyEntriesToDir({ entries: cb.entries, targetDir: nav.currentHandle.value });
      break;
    case 'cut':
      await ops.moveEntries({ entries: cb.entries, targetDir: nav.currentHandle.value });
      clipboard.clearClipboard();
      break;
    default: {
      const _ex: never = cb.operation;
      throw new Error(`Unhandled clipboard operation: ${_ex}`);
    }
    }
  }

  const context: FileExplorerContext = {
    // Navigation
    root,
    get currentHandle() {
      return nav.currentHandle.value;
    },
    get pathSegments() {
      return nav.pathSegments.value;
    },
    navigateToDirectory: nav.navigateToDirectory,
    navigateUp: nav.navigateUp,
    jumpToBreadcrumb: nav.jumpToBreadcrumb,
    refresh: nav.refresh,

    // Entries
    get entries() {
      return nav.entries.value;
    },
    get sortedFilteredEntries() {
      return nav.sortedFilteredEntries.value;
    },
    get isLoading() {
      return nav.isLoading.value;
    },
    get loadError() {
      return nav.loadError.value;
    },

    // View mode
    get viewMode() {
      return viewMode.value;
    },
    setViewMode,

    // Sort
    get sortConfig() {
      return sortConfig.value;
    },
    toggleSortField,

    // Filter
    get filterQuery() {
      return filterQuery.value;
    },
    setFilterQuery,

    // Selection
    get selectionState() {
      return sel.selectionState.value;
    },
    get selectedEntries() {
      return selectedEntries.value;
    },
    applySelection,
    moveFocus: ({ direction, extend }: { direction: 'prev' | 'next'; extend: boolean }) =>
      sel.moveFocus({ direction, extend, allEntries: nav.sortedFilteredEntries.value }),

    // Operations
    createFile: ops.createFile,
    createFolder: ops.createFolder,
    deleteEntries: ops.deleteEntries,
    renameEntry: ops.renameEntry,
    moveEntries: ops.moveEntries,
    copyEntriesToDir: ops.copyEntriesToDir,
    downloadEntry: ops.downloadEntry,
    uploadFiles: ops.uploadFiles,
    get renamingEntryName() {
      return ops.renamingEntryName.value;
    },
    startRename: ops.startRename,
    cancelRename: ops.cancelRename,

    // Preview
    get previewState() {
      return preview.previewState.value;
    },
    loadPreview: preview.loadPreview,
    loadPreviewForced: preview.loadPreviewForced,
    clearPreview: preview.clearPreview,
    togglePreviewVisibility: preview.togglePreviewVisibility,
    toggleJsonFormat: preview.toggleJsonFormat,

    // Context menu
    get contextMenuState() {
      return ctxMenu.contextMenuState.value;
    },
    showContextMenu: ctxMenu.showContextMenu,
    hideContextMenu: ctxMenu.hideContextMenu,
    executeContextAction,

    // Clipboard
    get clipboardState() {
      return clipboard.clipboardState.value;
    },
    clipboardCut: ({ entries }: { entries: FileExplorerEntry[] }) =>
      clipboard.clipboardCut({ entries, sourceDirectory: nav.currentHandle.value }),
    clipboardCopy: ({ entries }: { entries: FileExplorerEntry[] }) =>
      clipboard.clipboardCopy({ entries, sourceDirectory: nav.currentHandle.value }),
    clipboardPaste,

    // Drag and drop
    get dragState() {
      return dnd.dragState.value;
    },
    onDragStart: dnd.onDragStart,
    onDragOverEntry: dnd.onDragOverEntry,
    onDragLeaveEntry: dnd.onDragLeaveEntry,
    onDropEntry: dnd.onDropEntry,
    onDragEnd: dnd.onDragEnd,

    // Column view
    get columnPanes() {
      return nav.columnPanes.value;
    },
    selectColumnEntry: nav.selectColumnEntry,

    // Status bar
    get statusBarInfo() {
      return statusBarInfo.value;
    },
  };

  return {
    context,
    // Expose reactive refs for the provide/inject mechanism
    _nav: nav,
    _sel: sel,
    _clipboard: clipboard,
    _ops: ops,
    _preview: preview,
    _ctxMenu: ctxMenu,
    _dnd: dnd,
    _viewMode: viewMode,
    _sortConfig: sortConfig,
    _filterQuery: filterQuery,
    _selectedEntries: selectedEntries,
    _statusBarInfo: statusBarInfo,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
