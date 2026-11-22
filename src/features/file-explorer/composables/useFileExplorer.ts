import { ensureStrings } from '@/strings';
import { ref, computed } from 'vue';
import type { InjectionKey } from 'vue';
import { createFileExplorerWorkerClient } from '@/features/file-explorer/worker/client';
import type { FileExplorerRemoteMount } from '@/features/file-explorer/worker/types';
import type {
  FileExplorerEntry,
  FileExplorerContext,
  SortConfig,
  ViewMode,
  SortField,
  SelectionAction,
  ContextMenuAction,
  FileExplorerTreeMenu,
} from '@/features/file-explorer/logic/types';
import { getFileViewParentPath, isFileViewPathWithin } from '@/features/file-explorer/logic/file-view';
import type { FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';
import { useFileExplorerNavigation } from './useFileExplorerNavigation';
import { useFileExplorerSelection } from './useFileExplorerSelection';
import { useFileExplorerOperations } from './useFileExplorerOperations';
import { useFileExplorerPreview } from './useFileExplorerPreview';
import { useFileExplorerClipboard } from './useFileExplorerClipboard';
import { useFileExplorerContextMenu } from './useFileExplorerContextMenu';
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop';
import { useFileExplorerDirectoryDownload } from './useFileExplorerDirectoryDownload';
import { useFileExplorerUpload } from './useFileExplorerUpload';
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
  remoteMounts,
  initialPath,
  initialLocked,
}: {
  root: FileExplorerRootDescriptor,
  remoteMounts?: readonly FileExplorerRemoteMount[],
  initialPath: string[] | undefined,
  initialLocked: boolean,
}) {
  const client = await createFileExplorerWorkerClient({ root, ...(remoteMounts === undefined ? {} : { remoteMounts }) });
  const { addToast } = useToast();
  const { showPrompt } = usePrompt();

  const viewMode = ref<ViewMode>('list');
  const sortConfig = ref<SortConfig>({ field: 'name', direction: 'ascending' });
  const filterQuery = ref('');
  const isLocked = ref(initialLocked);
  const newFileDirectoryPath = ref<string>();

  const nav = useFileExplorerNavigation({
    client,
    initialPath: buildInitialPath({ initialPath }),
    sortConfig: sortConfig as { value: SortConfig },
    filterQuery: filterQuery as { value: string },
  });

  function isDeletionOnly({ path }: { path: string }): boolean {
    // Temporary model mounts allow deleting registered files. Creation and
    // replacement still go through the model selector's import path.
    return remoteMounts?.some(mount => mount.deletionOnly === true
      && (path === mount.path || path.startsWith(`${mount.path}/`))) ?? false;
  }

  function canCreateFile({ path }: { path: string }): boolean {
    return path === nav.currentDirectoryPath.value && !isLocked.value && !nav.currentDirectoryReadOnly.value && !isDeletionOnly({ path });
  }

  function openNewFile(): void {
    const path = nav.currentDirectoryPath.value;
    if (canCreateFile({ path })) {
      newFileDirectoryPath.value = path;
    }
  }

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
  let latestEntryOpenId = 0;
  const directoryDownload = useFileExplorerDirectoryDownload({ client });
  const upload = useFileExplorerUpload({
    client,
    currentDirectoryPath: nav.currentDirectoryPath,
    currentEntries: nav.entries,
    refresh: nav.refresh,
  });
  const clipboard = useFileExplorerClipboard();
  const ctxMenu = useFileExplorerContextMenu();
  const dnd = useFileExplorerDragDrop({
    moveEntries: ops.moveEntries,
    currentDirectoryPath: nav.currentDirectoryPath,
    isMoveBlocked: ({ path }) => isLocked.value || nav.currentDirectoryReadOnly.value || isDeletionOnly({ path }),
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

  async function openEntry({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    const openId = ++latestEntryOpenId;
    switch (entry.kind) {
    case 'directory':
      await nav.navigateToDirectory({ path: entry.path });
      sel.clearSelectionForNewDirectory();
      return;
    case 'file': {
      const originalDirectory = nav.currentDirectoryPath.value;
      const originalPreview = preview.previewState.value.entry;
      const result = await nav.tryNavigateToDirectory({ path: entry.path });
      switch (result) {
      case 'navigated':
        sel.clearSelectionForNewDirectory();
        return;
      case 'not-directory':
        if (openId === latestEntryOpenId
          && nav.currentDirectoryPath.value === originalDirectory
          && !nav.isLoading.value
          && (preview.previewState.value.entry === originalPreview || preview.previewState.value.entry?.path === entry.path)) {
          await preview.loadPreview({ entry });
        }
        return;
      case 'failed':
        return;
      default: {
        const _exhaustiveCheck: never = result;
        throw new Error(`Unhandled navigation result: ${_exhaustiveCheck}`);
      }
      }
    }
    default: {
      const _exhaustiveCheck: never = entry.kind;
      throw new Error(`Unhandled entry kind: ${_exhaustiveCheck}`);
    }
    }
  }

  async function refresh(): Promise<void> {
    preview.invalidatePreviewLoad();
    await nav.refresh();
  }

  async function refreshAfterTreeMutation({
    tree,
    paths,
    relocations,
  }: {
    tree: FileExplorerTreeMenu,
    paths: readonly string[],
    relocations: ReadonlyArray<{ sourcePath: string, destinationPath: string | undefined }> | undefined,
  }): Promise<void> {
    tree.onMutation({ paths });
    const currentPath = nav.currentDirectoryPath.value;
    const relocation = relocations?.find(({ sourcePath }) => isFileViewPathWithin({ path: currentPath, directoryPath: sourcePath }));
    if (relocation === undefined) {
      await refresh();
    } else {
      const { sourcePath, destinationPath } = relocation;
      const nextPath = destinationPath === undefined
        ? getFileViewParentPath({ path: sourcePath })
        : `${destinationPath}${currentPath.slice(sourcePath.length)}`;
      await nav.navigateToDirectory({ path: nextPath });
    }
    await nav.refreshColumnPanes({ paths: new Set(paths.map(path => getFileViewParentPath({ path }))) });
  }

  async function executeContextAction({ action }: { action: ContextMenuAction }): Promise<void> {
    const targetCtx = ctxMenu.contextMenuState.value.target;
    const tree = 'tree' in targetCtx ? targetCtx.tree : undefined;
    ctxMenu.hideContextMenu();

    switch (action) {
    case 'open':
      switch (targetCtx.kind) {
      case 'entry':
        if (tree) {
          tree.open();
        } else {
          await openEntry({ entry: targetCtx.entry });
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
      case 'entry': {
        const entry = targetCtx.entry;
        if (!tree) {
          ops.startRename({ entry });
          break;
        }
        const title = await ensureStrings.fileExplorer__rename();
        const newName = await showPrompt({ title, confirmButtonText: title, defaultValue: entry.name });
        if (newName === null || newName.trim() === '' || newName.trim() === entry.name) {
          break;
        }
        const parent = getFileViewParentPath({ path: entry.path });
        const destinationPath = `${parent === '/' ? '' : parent}/${newName.trim()}`;
        const paths = [entry.path, destinationPath];
        await tree.runMutation({
          paths,
          mutate: () => ops.renameEntry({
            entry,
            newName,
            onSuccess: () => refreshAfterTreeMutation({
              tree,
              paths,
              relocations: [{ sourcePath: entry.path, destinationPath }],
            }),
          }),
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
    case 'delete':
      switch (targetCtx.kind) {
      case 'entry': {
        if (targetCtx.selectedEntries.length > 0) {
          const paths = targetCtx.selectedEntries.map(entry => entry.path);
          if (tree) {
            await tree.runMutation({
              paths,
              mutate: () => ops.deleteEntries({
                entries: targetCtx.selectedEntries,
                onSuccess: () => refreshAfterTreeMutation({
                  tree,
                  paths,
                  relocations: paths.map(sourcePath => ({ sourcePath, destinationPath: undefined })),
                }),
              }),
            });
          } else {
            await ops.deleteEntries({ entries: targetCtx.selectedEntries });
            sel.clearSelectionForNewDirectory();
          }
        }
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
    case 'copy':
      switch (targetCtx.kind) {
      case 'entry':
        clipboard.clipboardCopy({
          entries: targetCtx.selectedEntries,
          sourceDirectoryPath: tree ? getFileViewParentPath({ path: targetCtx.entry.path }) : nav.currentDirectoryPath.value,
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
          sourceDirectoryPath: tree ? getFileViewParentPath({ path: targetCtx.entry.path }) : nav.currentDirectoryPath.value,
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
      await pasteIntoDirectory({ targetPath: tree?.directoryPath ?? nav.currentDirectoryPath.value, tree });
      break;
    case 'download':
      switch (targetCtx.kind) {
      case 'entry': {
        const entry = targetCtx.selectedEntries.length === 1
          ? targetCtx.selectedEntries[0]
          : undefined;
        if (entry === undefined) {
          break;
        }
        switch (entry.kind) {
        case 'file':
          await ops.downloadEntry({ entry });
          break;
        case 'directory':
          directoryDownload.open({
            target: {
              path: entry.path,
              name: entry.name,
            },
          });
          break;
        default: {
          const _exhaustiveCheck: never = entry.kind;
          throw new Error(`Unhandled download entry kind: ${String(_exhaustiveCheck)}`);
        }
        }
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
    case 'newFile':
      openNewFile();
      break;
    case 'newFolder': {
      const name = await showPrompt({
        title: await ensureStrings.fileExplorer__new_folder(),
        message: await ensureStrings.fileExplorer__enter_a_name_for_the_new_folder(),
        confirmButtonText: await ensureStrings.fileExplorer__create(),
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
        const path = tree ? entry.path : [...nav.pathSegments.value.map(segment => segment.name), entry.name].join(' / ');
        const sizeStr = entry.size !== undefined ? await ensureStrings.fileExplorer__byte_count({ count: entry.size }) : '—';
        let kind: string;
        switch (entry.kind) {
        case 'directory':
          kind = await ensureStrings.fileExplorer__folder();
          break;
        case 'file':
          kind = await ensureStrings.fileExplorer__file();
          break;
        default: {
          const _exhaustiveCheck: never = entry.kind;
          throw new Error(`Unhandled file explorer entry kind: ${_exhaustiveCheck}`);
        }
        }
        addToast({
          message: await ensureStrings.fileExplorer__entry_info({
            name: entry.name,
            kind,
            size: sizeStr,
            path,
          }),
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
    await pasteIntoDirectory({ targetPath: nav.currentDirectoryPath.value, tree: undefined });
  }

  async function pasteIntoDirectory({ targetPath, tree }: { targetPath: string, tree: FileExplorerTreeMenu | undefined }): Promise<void> {
    const clipboardState = clipboard.clipboardState.value;
    const { operation, entries } = clipboardState;
    if (!operation || entries.length === 0 || isLocked.value
      || (tree?.directoryReadOnly ?? nav.currentDirectoryReadOnly.value) || isDeletionOnly({ path: targetPath })) {
      return;
    }

    const relocations = entries.map(entry => ({
      sourcePath: entry.path,
      destinationPath: `${targetPath === '/' ? '' : targetPath}/${entry.name}`,
    }));
    if (relocations.some(({ sourcePath }) => isFileViewPathWithin({ path: targetPath, directoryPath: sourcePath }))) {
      return;
    }
    const destinationPaths = relocations.map(({ destinationPath }) => destinationPath);

    switch (operation) {
    case 'copy': {
      if (tree) {
        const paths = relocations.flatMap(({ sourcePath, destinationPath }) => sourcePath === destinationPath ? [] : [destinationPath]);
        if (paths.length === 0) {
          return;
        }
        await tree.runMutation({
          paths,
          mutate: () => ops.copyEntriesToDir({
            entries,
            targetPath,
            onSuccess: () => refreshAfterTreeMutation({ tree, paths, relocations: undefined }),
          }),
        });
      } else {
        await ops.copyEntriesToDir({ entries, targetPath });
      }
      break;
    }
    case 'cut': {
      if (relocations.some(({ sourcePath, destinationPath }) => sourcePath === destinationPath)) {
        return;
      }
      const paths = [...relocations.map(({ sourcePath }) => sourcePath), ...destinationPaths];
      const move = () => ops.moveEntries({
        entries,
        targetPath,
        onSuccess: async () => {
          if (clipboard.clipboardState.value === clipboardState) {
            clipboard.clearClipboard();
          }
          if (tree) {
            await refreshAfterTreeMutation({ tree, paths, relocations });
          } else {
            await nav.refresh();
          }
        },
      });
      if (tree) {
        await tree.runMutation({ paths, mutate: move });
      } else {
        await move();
      }
      break;
    }
    default: {
      const _exhaustiveCheck: never = operation;
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
    get readOnlyReason() {
      if (nav.currentDirectoryReadOnly.value) {
        return 'source';
      }
      if (isLocked.value) {
        return 'lock';
      }
      return undefined;
    },
    isDeletionOnly,
    get pathSegments() {
      return nav.pathSegments.value;
    },
    navigateToDirectory: nav.navigateToDirectory,
    navigateUp: nav.navigateUp,
    jumpToBreadcrumb: nav.jumpToBreadcrumb,
    refresh,

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

    get newFileDirectoryPath() {
      return newFileDirectoryPath.value;
    },
    openNewFile,
    closeNewFile() {
      newFileDirectoryPath.value = undefined;
    },
    async createFile({ name, blob }) {
      const directoryPath = newFileDirectoryPath.value;
      return directoryPath !== undefined && canCreateFile({ path: directoryPath }) && await ops.createFile({ directoryPath, name, blob });
    },
    createFolder: ops.createFolder,
    deleteEntries: ops.deleteEntries,
    renameEntry: ops.renameEntry,
    moveEntries: ops.moveEntries,
    copyEntriesToDir: ops.copyEntriesToDir,
    downloadEntry: ops.downloadEntry,
    uploadFiles: upload.begin,
    upload,

    get renamingEntryName() {
      return ops.renamingEntryName.value;
    },
    startRename: ops.startRename,
    cancelRename: ops.cancelRename,

    get previewState() {
      return preview.previewState.value;
    },
    openEntry,
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

    directoryDownload,

    get statusBarInfo() {
      return statusBarInfo.value;
    },
  };

  return {
    context,
    client,
    _viewMode: viewMode,
    _preview: preview,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
