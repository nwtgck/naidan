import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { createHighlightWorker } from '@/features/highlight/worker/impl';
import type { FileExplorerContext, FileExplorerEntry } from '@/features/file-explorer/logic/types';
import { sanitizeHighlightHtml } from '@/lib/security/allowedHtml';
import type { AllowedHtml } from '@/lib/security/allowedHtml';
import type { FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';

const rootDescriptor: FileExplorerRootDescriptor = {
  kind: 'opfs-root',
  rootName: 'Root',
};

function createEntry(): FileExplorerEntry {
  return {
    path: '/hostile.html',
    name: 'hostile.html',
    kind: 'file',
    size: 10,
    lastModified: 1,
    extension: '.html',
    mimeCategory: 'text',
    readOnly: false,
    canNavigate: false,
    canMutate: true,
  };
}

function createContext({
  highlightedHtml,
}: {
  highlightedHtml: AllowedHtml,
}): FileExplorerContext {
  const entry = createEntry();

  return {
    root: rootDescriptor,
    currentDirectoryPath: '/',
    pathSegments: [],
    navigateToDirectory: async () => undefined,
    navigateUp: async () => undefined,
    jumpToBreadcrumb: async () => undefined,
    refresh: async () => undefined,
    entries: [],
    sortedFilteredEntries: [],
    isLoading: false,
    loadError: undefined,
    viewMode: 'list',
    setViewMode: () => undefined,
    sortConfig: { field: 'name', direction: 'ascending' },
    toggleSortField: () => undefined,
    filterQuery: '',
    setFilterQuery: () => undefined,
    selectionState: {
      selectedNames: new Set(),
      anchorName: undefined,
      focusName: undefined,
    },
    selectedEntries: [],
    applySelection: () => undefined,
    moveFocus: () => undefined,
    createFile: async () => undefined,
    createFolder: async () => undefined,
    deleteEntries: async () => undefined,
    renameEntry: async () => undefined,
    moveEntries: async () => undefined,
    copyEntriesToDir: async () => undefined,
    downloadEntry: async () => undefined,
    uploadFiles: async () => undefined,
    renamingEntryName: undefined,
    startRename: () => undefined,
    cancelRename: () => undefined,
    previewState: {
      visibility: 'visible',
      entry,
      rawTextContent: '<img src=x onerror=alert(1)>',
      textContent: '<img src=x onerror=alert(1)>',
      highlightedHtml,
      objectUrl: undefined,
      jsonFormatMode: 'formatted',
      loadingState: 'loaded',
      errorMessage: undefined,
      oversized: false,
    },
    loadPreview: async () => undefined,
    loadPreviewForced: async () => undefined,
    clearPreview: () => undefined,
    togglePreviewVisibility: () => undefined,
    toggleJsonFormat: () => undefined,
    contextMenuState: {
      visibility: 'hidden',
      x: 0,
      y: 0,
      target: { kind: 'background' },
    },
    showContextMenu: () => undefined,
    hideContextMenu: () => undefined,
    executeContextAction: async () => undefined,
    clipboardState: {
      operation: undefined,
      sourceDirectoryPath: undefined,
      sourceDirectory: undefined,
      entries: [],
    },
    clipboardCut: () => undefined,
    clipboardCopy: () => undefined,
    clipboardPaste: async () => undefined,
    dragState: { status: 'idle' },
    onDragStart: () => undefined,
    onDragOverEntry: () => undefined,
    onDragLeaveEntry: () => undefined,
    onDropEntry: async () => undefined,
    onDragEnd: () => undefined,
    readOnly: false,
    isLocked: false,
    toggleLock: () => undefined,
    columnPanes: [],
    selectColumnEntry: async () => undefined,
    statusBarInfo: {
      totalItems: 0,
      selectedCount: 0,
      totalSize: 0,
      selectedSize: 0,
    },
  };
}

vi.mock('../logic/utils', () => ({
  formatSize: vi.fn(() => '10 bytes'),
  formatDate: vi.fn(() => '1970-01-01'),
}));

describe('FileExplorerPreviewPanel security', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not materialize hostile html from highlighted preview output', async () => {
    const worker = createHighlightWorker();
    const probe = vi.fn();
    vi.stubGlobal('__xssProbe', probe);
    const response = await worker.highlight({
      request: {
        code: '<img src=x onerror="globalThis.__xssProbe?.(\'img-error\')"><svg onload="globalThis.__xssProbe?.(\'svg-load\')"></svg><a href="javascript:globalThis.__xssProbe?.(\'link-click\')">click</a><script>globalThis.__xssProbe?.(\'script-run\')</script>',
        language: 'html',
        mode: 'named-language',
      },
    });

    const wrapper = mount(FileExplorerPreviewPanel, {
      global: {
        provide: {
          [FILE_EXPLORER_INJECTION_KEY as symbol]: createContext({
            highlightedHtml: sanitizeHighlightHtml({ html: response.html }),
          }),
        },
      },
    });

    const pre = wrapper.find('pre').element as HTMLElement;
    expect(pre.querySelector('img')).toBeNull();
    expect(pre.querySelector('svg')).toBeNull();
    expect(pre.querySelector('a')).toBeNull();
    expect(pre.querySelector('script')).toBeNull();
    pre.dispatchEvent(new Event('error'));
    pre.dispatchEvent(new Event('load'));
    expect(probe).not.toHaveBeenCalled();
  });
});
