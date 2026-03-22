import { ref, computed, shallowRef } from 'vue';
import type { FileExplorerEntry, SortConfig, ColumnPaneState } from './types';
import { getFileExtension, getMimeCategory, sortEntries, filterEntries } from './utils';
import { METADATA_BATCH_SIZE } from './constants';

async function readDirectoryEntries({
  handle,
}: {
  handle: FileSystemDirectoryHandle;
}): Promise<FileExplorerEntry[]> {
  const raw: FileExplorerEntry[] = [];

  for await (const entry of handle.values()) {
    let extension = '';
    switch (entry.kind) {
    case 'file':
      extension = getFileExtension({ name: entry.name });
      break;
    case 'directory':
      break;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }
    raw.push({
      name: entry.name,
      kind: entry.kind,
      handle: entry,
      size: undefined,
      lastModified: undefined,
      extension,
      mimeCategory: getMimeCategory({ extension }),
    });
  }

  const fileEntries = raw.filter(e => {
    switch (e.kind) {
    case 'file': return true;
    case 'directory': return false;
    default: {
      const _ex: never = e.kind;
      void _ex;
      return false;
    }
    }
  });

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
  root: FileSystemDirectoryHandle;
  sortConfig: { value: SortConfig };
  filterQuery: { value: string };
}) {
  const currentHandle = shallowRef<FileSystemDirectoryHandle>(root);
  const pathStack = shallowRef<FileSystemDirectoryHandle[]>([]);
  const entries = ref<FileExplorerEntry[]>([]);
  const isLoading = ref(false);
  const loadError = ref<string | undefined>(undefined);

  // Column view state: each pane tracks its directory handle, entries, and selection
  const columnPanes = ref<ColumnPaneState[]>([
    { handle: root, entries: [], selectedEntryName: undefined, isLoading: false },
  ]);

  const pathSegments = computed(() => {
    const segs: Array<{ name: string; handle: FileSystemDirectoryHandle }> = [];
    for (const h of pathStack.value) {
      segs.push({ name: h.name || 'root', handle: h });
    }
    segs.push({ name: currentHandle.value.name || 'root', handle: currentHandle.value });
    return segs;
  });

  const sortedFilteredEntries = computed(() =>
    filterEntries({
      entries: sortEntries({ entries: entries.value, config: sortConfig.value }),
      query: filterQuery.value,
    }),
  );

  async function loadDirectory({ handle }: { handle: FileSystemDirectoryHandle }): Promise<void> {
    isLoading.value = true;
    loadError.value = undefined;
    try {
      entries.value = await readDirectoryEntries({ handle });
    } catch (e) {
      loadError.value = `Failed to load directory: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      isLoading.value = false;
    }
  }

  async function navigateToDirectory({ handle }: { handle: FileSystemDirectoryHandle }): Promise<void> {
    pathStack.value = [...pathStack.value, currentHandle.value];
    currentHandle.value = handle;
    await loadDirectory({ handle });
    // Column view: the current directory becomes the last pane; clear panes after current
    syncColumnPanesToPath();
  }

  async function navigateUp(): Promise<void> {
    const stack = pathStack.value;
    if (stack.length === 0) return;
    const parent = stack[stack.length - 1]!;
    pathStack.value = stack.slice(0, -1);
    currentHandle.value = parent;
    await loadDirectory({ handle: parent });
    syncColumnPanesToPath();
  }

  async function jumpToBreadcrumb({ index }: { index: number }): Promise<void> {
    const segs = pathSegments.value;
    if (index < 0 || index >= segs.length - 1) return; // last segment = current, no-op
    const target = segs[index]!.handle;
    pathStack.value = pathStack.value.slice(0, index);
    currentHandle.value = target;
    await loadDirectory({ handle: target });
    syncColumnPanesToPath();
  }

  async function refresh(): Promise<void> {
    await loadDirectory({ handle: currentHandle.value });
    // Refresh the last column pane as well
    const panes = columnPanes.value;
    if (panes.length > 0) {
      await loadColumnPane({ paneIndex: panes.length - 1, handle: currentHandle.value });
    }
  }

  // ---- Column view helpers ----

  async function loadColumnPane({
    paneIndex,
    handle,
  }: {
    paneIndex: number;
    handle: FileSystemDirectoryHandle;
  }): Promise<void> {
    const panes = [...columnPanes.value];
    if (!panes[paneIndex]) return;
    panes[paneIndex] = { ...panes[paneIndex]!, isLoading: true };
    columnPanes.value = panes;

    let raw: FileExplorerEntry[] = [];
    try {
      raw = await readDirectoryEntries({ handle });
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

    // Update selected entry in this pane
    panes[paneIndex] = { ...panes[paneIndex]!, selectedEntryName: entryName };

    // Remove all panes after this index
    const truncated = panes.slice(0, paneIndex + 1);
    columnPanes.value = truncated;

    const entry = panes[paneIndex]!.entries.find(e => e.name === entryName);
    if (!entry) return;

    switch (entry.kind) {
    case 'directory': {
      const dirHandle = entry.handle as FileSystemDirectoryHandle;
      // Add new pane for the subdirectory
      columnPanes.value = [
        ...columnPanes.value,
        { handle: dirHandle, entries: [], selectedEntryName: undefined, isLoading: true },
      ];
      await loadColumnPane({ paneIndex: columnPanes.value.length - 1, handle: dirHandle });

      // Sync flat navigation state to match column panes
      const lastPane = columnPanes.value[columnPanes.value.length - 1]!;
      pathStack.value = columnPanes.value.slice(0, -1).map(p => p.handle);
      currentHandle.value = lastPane.handle;
      entries.value = lastPane.entries;
      break;
    }
    case 'file':
      // File selection — just update the pane, the parent will handle preview
      columnPanes.value = truncated;
      break;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled entry kind: ${_ex}`);
    }
    }
  }

  function syncColumnPanesToPath(): void {
    // Rebuild column panes based on current pathStack + currentHandle
    const allHandles = [...pathStack.value, currentHandle.value];
    const existingPanes = columnPanes.value;

    const newPanes: ColumnPaneState[] = allHandles.map((handle, i) => {
      const existing = existingPanes[i];
      if (existing && existing.handle === handle) {
        return existing;
      }
      return { handle, entries: [], selectedEntryName: undefined, isLoading: false };
    });

    // Load entries for panes that don't have them yet
    columnPanes.value = newPanes;
    for (let i = 0; i < newPanes.length; i++) {
      if (newPanes[i]!.entries.length === 0) {
        loadColumnPane({ paneIndex: i, handle: newPanes[i]!.handle });
      }
    }
  }

  // Initial load
  void loadDirectory({ handle: root });
  void loadColumnPane({ paneIndex: 0, handle: root });

  return {
    currentHandle,
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
