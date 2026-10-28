import { ensureStrings } from '@/strings';
import { ref, computed } from 'vue';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import type { FileExplorerEntry, SortConfig, ColumnPaneState, FileExplorerPathSegment } from '@/features/file-explorer/logic/types';
import { sortEntries, filterEntries } from '@/features/file-explorer/logic/utils';
import { isFileExplorerNotDirectoryError } from '@/features/file-explorer/logic/errors';

type NavigationResult = 'navigated' | 'not-directory' | 'failed';

function normalizeExplorerPath({ path }: { path: string }): string {
  if (!path || path === '/') {
    return '/';
  }
  return `/${path.split('/').filter(segment => segment.length > 0).join('/')}`;
}

function getParentPath({ path }: { path: string }): string {
  const normalizedPath = normalizeExplorerPath({ path });
  if (normalizedPath === '/') {
    return '/';
  }
  const segments = normalizedPath.slice(1).split('/');
  if (segments.length <= 1) {
    return '/';
  }
  return `/${segments.slice(0, -1).join('/')}`;
}

async function resolveDirectoryLoadError({ error }: { error: unknown }): Promise<string> {
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return await ensureStrings.fileExplorer__folder_is_no_longer_available();
  }
  return error instanceof Error ? error.message : String(error);
}

export function useFileExplorerNavigation({
  client,
  initialPath,
  sortConfig,
  filterQuery,
}: {
  client: FileExplorerWorkerClient,
  initialPath: string | undefined,
  sortConfig: { value: SortConfig },
  filterQuery: { value: string },
}) {
  const currentDirectoryPath = ref<string>(normalizeExplorerPath({ path: initialPath ?? '/' }));
  const currentDirectoryName = ref<string>('root');
  const currentDirectoryReadOnly = ref<boolean>(false);
  const pathSegments = ref<FileExplorerPathSegment[]>([]);
  const entries = ref<FileExplorerEntry[]>([]);
  const isLoading = ref(false);
  const loadError = ref<string | undefined>(undefined);
  const columnPanes = ref<ColumnPaneState[]>([]);

  const sortedFilteredEntries = computed(() =>
    filterEntries({
      entries: sortEntries({ entries: entries.value, config: sortConfig.value }),
      query: filterQuery.value,
    }),
  );

  async function loadDirectory({
    path,
    errorMode,
  }: {
    path: string,
    errorMode: 'report' | 'silent',
  }): Promise<NavigationResult> {
    const normalizedPath = normalizeExplorerPath({ path });
    isLoading.value = true;
    switch (errorMode) {
    case 'report':
      loadError.value = undefined;
      break;
    case 'silent':
      break;
    default: {
      const _exhaustiveCheck: never = errorMode;
      throw new Error(`Unhandled directory load error mode: ${_exhaustiveCheck}`);
    }
    }
    try {
      const response = await client.readDirectory({ path: normalizedPath });
      loadError.value = undefined;
      currentDirectoryPath.value = response.directoryPath;
      currentDirectoryName.value = response.directoryName;
      currentDirectoryReadOnly.value = response.readOnly;
      pathSegments.value = response.pathSegments;
      entries.value = response.entries;
      return 'navigated';
    } catch (error) {
      switch (errorMode) {
      case 'report':
        break;
      case 'silent':
        if (isFileExplorerNotDirectoryError({ error })) {
          return 'not-directory';
        }
        break;
      default: {
        const _exhaustiveCheck: never = errorMode;
        throw new Error(`Unhandled directory load error mode: ${_exhaustiveCheck}`);
      }
      }
      loadError.value = await ensureStrings.fileExplorer__failed_to_load_directory({
        errorMessage: await resolveDirectoryLoadError({ error }),
      });
      return 'failed';
    } finally {
      isLoading.value = false;
    }
  }

  async function loadColumnPane({
    paneIndex,
    path,
  }: {
    paneIndex: number,
    path: string,
  }): Promise<void> {
    const panes = [...columnPanes.value];
    const pane = panes[paneIndex];
    if (!pane) {
      return;
    }
    panes[paneIndex] = { ...pane, isLoading: true };
    columnPanes.value = panes;

    try {
      const response = await client.readDirectory({ path });
      const nextPanes = [...columnPanes.value];
      if (!nextPanes[paneIndex]) {
        return;
      }
      nextPanes[paneIndex] = {
        ...nextPanes[paneIndex]!,
        path: response.directoryPath,
        name: response.directoryName,
        readOnly: response.readOnly,
        entries: response.entries,
        isLoading: false,
      };
      columnPanes.value = nextPanes;
    } catch {
      const nextPanes = [...columnPanes.value];
      if (!nextPanes[paneIndex]) {
        return;
      }
      nextPanes[paneIndex] = {
        ...nextPanes[paneIndex]!,
        entries: [],
        isLoading: false,
      };
      columnPanes.value = nextPanes;
    }
  }

  function syncColumnPanesToPath(): void {
    const nextPanes: ColumnPaneState[] = pathSegments.value.map(segment => {
      const existingPane = columnPanes.value.find(pane => pane.path === segment.path);
      return existingPane ?? {
        path: segment.path,
        name: segment.name,
        readOnly: true,
        entries: [],
        selectedEntryName: undefined,
        isLoading: false,
      };
    });
    columnPanes.value = nextPanes;
    for (let i = 0; i < nextPanes.length; i += 1) {
      if (nextPanes[i]!.entries.length === 0) {
        void loadColumnPane({ paneIndex: i, path: nextPanes[i]!.path });
      }
    }
  }

  function syncColumnPanesAfterNavigation({ result }: { result: NavigationResult }): void {
    switch (result) {
    case 'navigated':
      syncColumnPanesToPath();
      break;
    case 'not-directory':
    case 'failed':
      break;
    default: {
      const _exhaustiveCheck: never = result;
      throw new Error(`Unhandled navigation result: ${_exhaustiveCheck}`);
    }
    }
  }

  async function navigateToDirectory({ path }: { path: string }): Promise<void> {
    const result = await loadDirectory({ path, errorMode: 'report' });
    syncColumnPanesAfterNavigation({ result });
  }

  async function tryNavigateToDirectory({ path }: { path: string }): Promise<NavigationResult> {
    const result = await loadDirectory({ path, errorMode: 'silent' });
    syncColumnPanesAfterNavigation({ result });
    return result;
  }

  async function navigateUp(): Promise<void> {
    if (currentDirectoryPath.value === '/') {
      return;
    }
    await navigateToDirectory({ path: getParentPath({ path: currentDirectoryPath.value }) });
  }

  async function jumpToBreadcrumb({ index }: { index: number }): Promise<void> {
    const segment = pathSegments.value[index];
    if (!segment || segment.path === currentDirectoryPath.value) {
      return;
    }
    await navigateToDirectory({ path: segment.path });
  }

  async function refresh(): Promise<void> {
    await loadDirectory({ path: currentDirectoryPath.value, errorMode: 'report' });
    syncColumnPanesToPath();
  }

  async function selectColumnEntry({
    paneIndex,
    entryName,
  }: {
    paneIndex: number,
    entryName: string,
  }): Promise<void> {
    const panes = [...columnPanes.value];
    const pane = panes[paneIndex];
    if (!pane) {
      return;
    }
    panes[paneIndex] = { ...pane, selectedEntryName: entryName };
    columnPanes.value = panes.slice(0, paneIndex + 1);

    const entry = pane.entries.find(candidate => candidate.name === entryName);
    if (!entry) {
      return;
    }

    switch (entry.kind) {
    case 'directory':
      await navigateToDirectory({ path: entry.path });
      break;
    case 'file':
      break;
    default: {
      const _exhaustiveCheck: never = entry.kind;
      throw new Error(`Unhandled entry kind: ${_exhaustiveCheck}`);
    }
    }
  }

  void loadDirectory({ path: currentDirectoryPath.value, errorMode: 'report' }).then((result) => {
    syncColumnPanesAfterNavigation({ result });
  });

  return {
    currentDirectoryPath,
    currentDirectoryName,
    currentDirectoryReadOnly,
    pathSegments,
    entries,
    sortedFilteredEntries,
    isLoading,
    loadError,
    columnPanes,
    navigateToDirectory,
    tryNavigateToDirectory,
    navigateUp,
    jumpToBreadcrumb,
    refresh,
    selectColumnEntry,
    loadColumnPane,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        loadDirectory,
        normalizeExplorerPath,
        getParentPath,
        resolveDirectoryLoadError,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
