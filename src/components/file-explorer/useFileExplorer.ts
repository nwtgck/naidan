import { ref, computed } from 'vue';
import type { InjectionKey } from 'vue';
import { createFileExplorerWorkerClient } from '@/services/file-explorer-worker-client';
import type {
  FileExplorerEntry,
  FileExplorerContext,
  SortConfig,
  ViewMode,
  SortField,
  SelectionAction,
  ContextMenuAction,
} from './types';
import type { FileExplorerRootDescriptor } from '@/services/file-explorer.worker.types';
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

function buildInitialPath({ initialPath }: { initialPath: string[] | undefined }): string | undefined {
  if (!initialPath || initialPath.length === 0) {
    return undefined;
  }
  return `/${initialPath.join('/')}`;
}

export async function useFileExplorer({
  root,
  initialPath,
  initialLocked,
}: {
  root: FileExplorerRootDescriptor;
  initialPath: string[] | undefined;
  initialLocked: boolean;
}) {
  const client = await createFileExplorerWorkerClient({ root });
  const { addToast } = useToast();
  const { showPrompt } = usePrompt();

  const viewMode = ref<ViewMode>('list');
  const sortConfig = ref<SortConfig>({ field: 'name', direction: 'ascending' });
  const filterQuery = ref('');
  const isLocked = ref(initialLocked);

  const nav = useFileExplorerNavigation({
    client,
    initialPath: buildInitialPath({ initialPath }),
    sortConfig: sortConfig as { value: SortConfig },
    filterQuery: filterQuery as { value: string },
  });

  const sel = useFileExplorerSelection();

  const selectedEntries = computed(() =>
    sel.getSelectedEntries({ allEntries: nav.sortedFilteredEntries.value }),
  );

  const statusBarInfo = computed(() => {
    const allEntries = nav.sortedFilteredEntries.value;
    const selected = selectedEntries.value;
    return {
      totalItems: allEntries.length,
      selectedCount: selected.length,
      totalSize: allEntries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
      selectedSize: selected.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    };
  });

  const ops = useFileExplorerOperations({
    client,
    currentDirectoryPath: nav.currentDirectoryPath,
    refresh: nav.refresh,
  });

  const preview = useFileExplorerPreview({ client });
  const clipboard = useFileExplorerClipboard();
  const ctxMenu = useFileExplorerContextMenu();
  const dnd = useFileExplorerDragDrop({
    moveEntries: ops.moveEntries,
    currentDirectoryPath: nav.currentDirectoryPath,
    isReadOnly: () => isLocked.value || nav.currentDirectoryReadOnly.value,
  });

  function setViewMode({ mode }: { mode: ViewMode }): void {
    viewMode.value = mode;
  }

  function toggleSortField({ field }: { field: SortField }): void {
    const current = sortConfig.value;
    if (current.field === field) {
      sortConfig.value = {
        field,
        direction: (() => {
          switch (current.direction) {
          case 'ascending':
            return 'descending';
          case 'descending':
            return 'ascending';
          default: {
            const _exhaustiveCheck: never = current.direction;
            throw new Error(`Unhandled sort direction: ${_exhaustiveCheck}`);
          }
          }
        })(),
      };
      return;
    }
    sortConfig.value = { field, direction: 'ascending' };
  }

  function setFilterQuery({ query }: { query: string }): void {
    filterQuery.value = query;
  }

  function toggleLock(): void {
    isLocked.value = !isLocked.value;
  }

  function applySelection({ action }: { action: SelectionAction }): void {
    sel.applySelection({ action });
  }

  async function executeContextAction({ action }: { action: ContextMenuAction }): Promise<void> {
    const targetCtx = ctxMenu.contextMenuState.value.target;
    ctxMenu.hideContextMenu();

    switch (action) {
    case 'open':
      switch (targetCtx.kind) {
      case 'entry':
        switch (targetCtx.entry.kind) {
        case 'directory':
          await nav.navigateToDirectory({ path: targetCtx.entry.path });
          sel.clearSelectionForNewDirectory();
          break;
        case 'file':
          await preview.loadPreview({ entry: targetCtx.entry });
          break;
        default: {
          const _exhaustiveCheck: never = targetCtx.entry.kind;
          throw new Error(`Unhandled entry kind: ${_exhaustiveCheck}`);
        }
        }
        break;
      case 'background':
        break;
      default: {
        const _exhaustiveCheck: never = targetCtx;
        throw new Error(`Unhandled context menu target: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      }
      break;
    case 'rename':
      switch (targetCtx.kind) {
      case 'entry':
        ops.startRename({ entry: targetCtx.entry });
        break;
      case 'background':
        break;
      default: {
        const _exhaustiveCheck: never = targetCtx;
        throw new Error(`Unhandled context menu target: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      }
      break;
    case 'delete':
      switch (targetCtx.kind) {
      case 'entry':
        if (targetCtx.selectedEntries.length > 0) {
          await ops.deleteEntries({ entries: targetCtx.selectedEntries });
          sel.clearSelectionForNewDirectory();
        }
        break;
      case 'background':
        break;
      default: {
        const _exhaustiveCheck: never = targetCtx;
        throw new Error(`Unhandled context menu target: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      }
      break;
    case 'copy':
      switch (targetCtx.kind) {
      case 'entry':
        clipboard.clipboardCopy({
          entries: targetCtx.selectedEntries,
          sourceDirectoryPath: nav.currentDirectoryPath.value,
        });
        break;
      case 'background':
        break;
      default: {
        const _exhaustiveCheck: never = targetCtx;
        throw new Error(`Unhandled context menu target: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      }
      break;
    case 'cut':
      switch (targetCtx.kind) {
      case 'entry':
        clipboard.clipboardCut({
          entries: targetCtx.selectedEntries,
          sourceDirectoryPath: nav.currentDirectoryPath.value,
        });
        break;
      case 'background':
        break;
      default: {
        const _exhaustiveCheck: never = targetCtx;
        throw new Error(`Unhandled context menu target: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      }
      break;
    case 'paste':
      await clipboardPaste();
      break;
    case 'download':
      switch (targetCtx.kind) {
      case 'entry':
        for (const entry of targetCtx.selectedEntries) {
          await ops.downloadEntry({ entry });
        }
        break;
      case 'background':
        break;
      default: {
        const _exhaustiveCheck: never = targetCtx;
        throw new Error(`Unhandled context menu target: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      }
      break;
    case 'newFile': {
      const name = await showPrompt({
        title: 'New File',
        message: 'Enter a name for the new file:',
        confirmButtonText: 'Create',
      });
      if (name) {
        await ops.createFile({ name });
      }
      break;
    }
    case 'newFolder': {
      const name = await showPrompt({
        title: 'New Folder',
        message: 'Enter a name for the new folder:',
        confirmButtonText: 'Create',
      });
      if (name) {
        await ops.createFolder({ name });
      }
      break;
    }
    case 'getInfo':
      switch (targetCtx.kind) {
      case 'entry': {
        const entry = targetCtx.entry;
        const path = [...nav.pathSegments.value.map(segment => segment.name), entry.name].join(' / ');
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
        const _exhaustiveCheck: never = targetCtx;
        throw new Error(`Unhandled context menu target: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      }
      break;
    case 'selectAll':
      applySelection({
        action: { type: 'all', allEntries: nav.sortedFilteredEntries.value },
      });
      break;
    default: {
      const _exhaustiveCheck: never = action;
      throw new Error(`Unhandled context action: ${_exhaustiveCheck}`);
    }
    }
  }

  async function clipboardPaste(): Promise<void> {
    const clipboardState = clipboard.clipboardState.value;
    if (!clipboardState.operation || clipboardState.entries.length === 0) {
      return;
    }

    switch (clipboardState.operation) {
    case 'copy':
      await ops.copyEntriesToDir({
        entries: clipboardState.entries,
        targetPath: nav.currentDirectoryPath.value,
      });
      break;
    case 'cut':
      await ops.moveEntries({
        entries: clipboardState.entries,
        targetPath: nav.currentDirectoryPath.value,
      });
      clipboard.clearClipboard();
      break;
    default: {
      const _exhaustiveCheck: never = clipboardState.operation;
      throw new Error(`Unhandled clipboard operation: ${_exhaustiveCheck}`);
    }
    }
  }

  const context: FileExplorerContext = {
    root,
    get currentDirectoryPath() {
      return nav.currentDirectoryPath.value;
    },
    get readOnly() {
      return isLocked.value || nav.currentDirectoryReadOnly.value;
    },
    get pathSegments() {
      return nav.pathSegments.value;
    },
    navigateToDirectory: nav.navigateToDirectory,
    navigateUp: nav.navigateUp,
    jumpToBreadcrumb: nav.jumpToBreadcrumb,
    refresh: nav.refresh,

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

    get viewMode() {
      return viewMode.value;
    },
    setViewMode,

    get sortConfig() {
      return sortConfig.value;
    },
    toggleSortField,

    get filterQuery() {
      return filterQuery.value;
    },
    setFilterQuery,

    get selectionState() {
      return sel.selectionState.value;
    },
    get selectedEntries() {
      return selectedEntries.value;
    },
    applySelection,
    moveFocus: ({ direction, extend }) => {
      sel.moveFocus({
        direction,
        extend,
        allEntries: nav.sortedFilteredEntries.value,
      });
    },

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

    get previewState() {
      return preview.previewState.value;
    },
    loadPreview: preview.loadPreview,
    loadPreviewForced: preview.loadPreviewForced,
    clearPreview: preview.clearPreview,
    togglePreviewVisibility: preview.togglePreviewVisibility,
    toggleJsonFormat: preview.toggleJsonFormat,

    get contextMenuState() {
      return ctxMenu.contextMenuState.value;
    },
    showContextMenu: ctxMenu.showContextMenu,
    hideContextMenu: ctxMenu.hideContextMenu,
    executeContextAction,

    get clipboardState() {
      return clipboard.clipboardState.value;
    },
    clipboardCut: ({ entries }: { entries: FileExplorerEntry[] }) => {
      clipboard.clipboardCut({ entries, sourceDirectoryPath: nav.currentDirectoryPath.value });
    },
    clipboardCopy: ({ entries }: { entries: FileExplorerEntry[] }) => {
      clipboard.clipboardCopy({ entries, sourceDirectoryPath: nav.currentDirectoryPath.value });
    },
    clipboardPaste,

    get dragState() {
      return dnd.dragState.value;
    },
    onDragStart: dnd.onDragStart,
    onDragOverEntry: dnd.onDragOverEntry,
    onDragLeaveEntry: dnd.onDragLeaveEntry,
    onDropEntry: dnd.onDropEntry,
    onDragEnd: dnd.onDragEnd,

    get isLocked() {
      return isLocked.value;
    },
    toggleLock,

    get columnPanes() {
      return nav.columnPanes.value;
    },
    selectColumnEntry: nav.selectColumnEntry,

    get statusBarInfo() {
      return statusBarInfo.value;
    },
  };

  return {
    context,
    client,
    _viewMode: viewMode,
    _preview: preview,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
