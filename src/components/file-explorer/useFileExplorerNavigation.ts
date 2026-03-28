import { ref, computed, shallowRef } from 'vue';
import type { FileExplorerEntry, SortConfig, ColumnPaneState } from './types';
import type { ExplorerDirectory } from './explorer-directory';
import { getFileExtension, getMimeCategory, sortEntries, filterEntries } from './utils';
import { METADATA_BATCH_SIZE } from './constants';

async function readDirectoryEntries({
  directory,
}: {
  directory: ExplorerDirectory;
}): Promise<FileExplorerEntry[]> {
  const raw: FileExplorerEntry[] = [];

  for await (const child of directory.children()) {
    switch (child.kind) {
    case 'file':
      raw.push({
        name: child.name,
        kind: 'file',
        handle: child.fileHandle,
        directory: undefined,
        size: undefined,
        lastModified: undefined,
        extension: getFileExtension({ name: child.name }),
        mimeCategory: getMimeCategory({ extension: getFileExtension({ name: child.name }) }),
        readOnly: false,
      });
      break;
    case 'directory':
      raw.push({
        name: child.name,
        kind: 'directory',
        handle: child.directory as unknown as FileSystemHandle,
        directory: child.directory,
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        readOnly: child.readOnly,
      });
      break;
    default: {
      const _ex: never = child;
      throw new Error(`Unhandled child kind: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const fileEntries = raw.filter(e => e.kind === 'file');

  for (let i = 0; i < fileEntries.length; i += METADATA_BATCH_SIZE) {
    const batch = fileEntries.slice(i, i + METADATA_BATCH_SIZE);
    await Promise.all(
      batch.map(async (e) => {
        try {
          const file = await (e.handle as FileSystemFileHandle).getFile();
          e.size = file.size;
          e.lastModified = file.lastModified;
        } catch {
          // metadata unavailable — leave as undefined
        }
      }),
    );
  }

  return raw;
}

export function useFileExplorerNavigation({
  root,
  sortConfig,
  filterQuery,
}: {
  root: ExplorerDirectory;
  sortConfig: { value: SortConfig };
  filterQuery: { value: string };
}) {
  const currentDirectory = shallowRef<ExplorerDirectory>(root);
  const pathStack = shallowRef<ExplorerDirectory[]>([]);
  const entries = ref<FileExplorerEntry[]>([]);
  const isLoading = ref(false);
  const loadError = ref<string | undefined>(undefined);

  const columnPanes = ref<ColumnPaneState[]>([
    { directory: root, entries: [], selectedEntryName: undefined, isLoading: false },
  ]);

  const pathSegments = computed(() => {
    const segs: Array<{ name: string; directory: ExplorerDirectory }> = [];
    for (const d of pathStack.value) {
      segs.push({ name: d.name || 'root', directory: d });
    }
    segs.push({ name: currentDirectory.value.name || 'root', directory: currentDirectory.value });
    return segs;
  });

  const sortedFilteredEntries = computed(() =>
    filterEntries({
      entries: sortEntries({ entries: entries.value, config: sortConfig.value }),
      query: filterQuery.value,
    }),
  );

  async function loadDirectory({ directory }: { directory: ExplorerDirectory }): Promise<void> {
    isLoading.value = true;
    loadError.value = undefined;
    try {
      entries.value = await readDirectoryEntries({ directory });
    } catch (e) {
      loadError.value = `Failed to load directory: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      isLoading.value = false;
    }
  }

  async function navigateToDirectory({ directory }: { directory: ExplorerDirectory }): Promise<void> {
    pathStack.value = [...pathStack.value, currentDirectory.value];
    currentDirectory.value = directory;
    await loadDirectory({ directory });
    syncColumnPanesToPath();
  }

  async function navigateUp(): Promise<void> {
    const stack = pathStack.value;
    if (stack.length === 0) return;
    const parent = stack[stack.length - 1]!;
    pathStack.value = stack.slice(0, -1);
    currentDirectory.value = parent;
    await loadDirectory({ directory: parent });
    syncColumnPanesToPath();
  }

  async function jumpToBreadcrumb({ index }: { index: number }): Promise<void> {
    const segs = pathSegments.value;
    if (index < 0 || index >= segs.length - 1) return;
    const target = segs[index]!.directory;
    pathStack.value = pathStack.value.slice(0, index);
    currentDirectory.value = target;
    await loadDirectory({ directory: target });
    syncColumnPanesToPath();
  }

  async function refresh(): Promise<void> {
    await loadDirectory({ directory: currentDirectory.value });
    const panes = columnPanes.value;
    if (panes.length > 0) {
      await loadColumnPane({ paneIndex: panes.length - 1, directory: currentDirectory.value });
    }
  }

  // ---- Column view helpers ----

  async function loadColumnPane({
    paneIndex,
    directory,
  }: {
    paneIndex: number;
    directory: ExplorerDirectory;
  }): Promise<void> {
    const panes = [...columnPanes.value];
    if (!panes[paneIndex]) return;
    panes[paneIndex] = { ...panes[paneIndex]!, isLoading: true };
    columnPanes.value = panes;

    let raw: FileExplorerEntry[] = [];
    try {
      raw = await readDirectoryEntries({ directory });
    } catch {
      // pane shows empty on error
    }

    const updated = [...columnPanes.value];
    if (updated[paneIndex]) {
      updated[paneIndex] = { ...updated[paneIndex]!, entries: raw, isLoading: false };
    }
    columnPanes.value = updated;
  }

  async function selectColumnEntry({
    paneIndex,
    entryName,
  }: {
    paneIndex: number;
    entryName: string;
  }): Promise<void> {
    const panes = [...columnPanes.value];
    if (!panes[paneIndex]) return;

    panes[paneIndex] = { ...panes[paneIndex]!, selectedEntryName: entryName };
    const truncated = panes.slice(0, paneIndex + 1);
    columnPanes.value = truncated;

    const entry = panes[paneIndex]!.entries.find(e => e.name === entryName);
    if (!entry) return;

    switch (entry.kind) {
    case 'directory': {
      const subDir = entry.directory!;
      columnPanes.value = [
        ...columnPanes.value,
        { directory: subDir, entries: [], selectedEntryName: undefined, isLoading: true },
      ];
      await loadColumnPane({ paneIndex: columnPanes.value.length - 1, directory: subDir });

      const lastPane = columnPanes.value[columnPanes.value.length - 1]!;
      pathStack.value = columnPanes.value.slice(0, -1).map(p => p.directory);
      currentDirectory.value = lastPane.directory;
      entries.value = lastPane.entries;
      break;
    }
    case 'file':
      columnPanes.value = truncated;
      break;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled entry kind: ${_ex}`);
    }
    }
  }

  function syncColumnPanesToPath(): void {
    const allDirs = [...pathStack.value, currentDirectory.value];
    const existingPanes = columnPanes.value;

    const newPanes: ColumnPaneState[] = allDirs.map((directory, i) => {
      const existing = existingPanes[i];
      if (existing && existing.directory === directory) {
        return existing;
      }
      return { directory, entries: [], selectedEntryName: undefined, isLoading: false };
    });

    columnPanes.value = newPanes;
    for (let i = 0; i < newPanes.length; i++) {
      if (newPanes[i]!.entries.length === 0) {
        loadColumnPane({ paneIndex: i, directory: newPanes[i]!.directory });
      }
    }
  }

  // Initial load
  void loadDirectory({ directory: root });
  void loadColumnPane({ paneIndex: 0, directory: root });

  return {
    currentDirectory,
    pathStack,
    pathSegments,
    entries,
    sortedFilteredEntries,
    isLoading,
    loadError,
    columnPanes,
    navigateToDirectory,
    navigateUp,
    jumpToBreadcrumb,
    refresh,
    selectColumnEntry,
    loadDirectory,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
