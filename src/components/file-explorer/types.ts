import type { FileExplorerRootDescriptor } from '@/services/file-explorer/worker/types';
import type { AllowedHtml } from '@/lib/security/allowedHtml';

export type EntryKind = 'file' | 'directory';
export type MimeCategory = 'text' | 'image' | 'video' | 'audio' | 'binary';
export type ViewMode = 'icon' | 'list' | 'column';
export type SortField = 'name' | 'size' | 'dateModified' | 'type';
export type SortDirection = 'ascending' | 'descending';
export type PreviewVisibility = 'visible' | 'hidden';
export type ClipboardOperation = 'cut' | 'copy';
export type PathBarMode = 'breadcrumb' | 'editable';
export type RenameState = 'idle' | 'renaming';

export interface FileExplorerEntry {
  path: string;
  name: string;
  kind: EntryKind;
  handle?: FileSystemHandle | undefined;
  directory?: string | undefined;
  size: number | undefined;
  lastModified: number | undefined;
  extension: string;
  mimeCategory: MimeCategory;
  readOnly: boolean;
  canNavigate: boolean;
  canMutate: boolean;
}

export interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

export interface SelectionState {
  selectedNames: Set<string>;
  anchorName: string | undefined;
  focusName: string | undefined;
}

export type SelectionAction =
  | { type: 'single'; name: string }
  | { type: 'toggle'; name: string }
  | { type: 'range'; name: string; allEntries: FileExplorerEntry[] }
  | { type: 'all'; allEntries: FileExplorerEntry[] }
  | { type: 'clear' };

export interface ColumnPaneState {
  path: string;
  name: string;
  readOnly: boolean;
  entries: FileExplorerEntry[];
  selectedEntryName: string | undefined;
  isLoading: boolean;
}

export type ContextMenuTarget =
  | { kind: 'entry'; entry: FileExplorerEntry; selectedEntries: FileExplorerEntry[] }
  | { kind: 'background' };

export interface ContextMenuState {
  visibility: 'visible' | 'hidden';
  x: number;
  y: number;
  target: ContextMenuTarget;
}

export interface ClipboardState {
  operation: ClipboardOperation | undefined;
  sourceDirectoryPath: string | undefined;
  sourceDirectory?: string | undefined;
  entries: FileExplorerEntry[];
}

export interface PreviewState {
  visibility: PreviewVisibility;
  entry: FileExplorerEntry | undefined;
  rawTextContent?: string | undefined;
  textContent: string | undefined;
  highlightedHtml: AllowedHtml | undefined;
  objectUrl: string | undefined;
  jsonFormatMode: 'formatted' | 'raw';
  loadingState: 'idle' | 'loading' | 'loaded' | 'error';
  errorMessage: string | undefined;
  oversized: boolean;
}

export type DragState =
  | { status: 'idle' }
  | { status: 'dragging'; entries: FileExplorerEntry[]; sourceDirectoryPath: string }
  | { status: 'over-target'; targetEntryName: string };

export type ContextMenuAction =
  | 'open'
  | 'rename'
  | 'delete'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'download'
  | 'newFile'
  | 'newFolder'
  | 'getInfo'
  | 'selectAll';

export interface StatusBarInfo {
  totalItems: number;
  selectedCount: number;
  totalSize: number;
  selectedSize: number;
}

export interface FileExplorerPathSegment {
  name: string;
  path: string;
}

export interface FileExplorerContext {
  root: FileExplorerRootDescriptor;
  currentDirectoryPath: string;
  pathSegments: FileExplorerPathSegment[];
  navigateToDirectory: ({ path }: { path: string }) => Promise<void>;
  navigateUp: () => Promise<void>;
  jumpToBreadcrumb: ({ index }: { index: number }) => Promise<void>;
  refresh: () => Promise<void>;

  entries: FileExplorerEntry[];
  sortedFilteredEntries: FileExplorerEntry[];
  isLoading: boolean;
  loadError: string | undefined;

  viewMode: ViewMode;
  setViewMode: ({ mode }: { mode: ViewMode }) => void;

  sortConfig: SortConfig;
  toggleSortField: ({ field }: { field: SortField }) => void;

  filterQuery: string;
  setFilterQuery: ({ query }: { query: string }) => void;

  selectionState: SelectionState;
  selectedEntries: FileExplorerEntry[];
  applySelection: ({ action }: { action: SelectionAction }) => void;
  moveFocus: ({ direction, extend }: { direction: 'prev' | 'next'; extend: boolean }) => void;

  createFile: ({ name }: { name: string }) => Promise<void>;
  createFolder: ({ name }: { name: string }) => Promise<void>;
  deleteEntries: ({ entries }: { entries: FileExplorerEntry[] }) => Promise<void>;
  renameEntry: ({ entry, newName }: { entry: FileExplorerEntry; newName: string }) => Promise<void>;
  moveEntries: ({ entries, targetPath }: { entries: FileExplorerEntry[]; targetPath: string }) => Promise<void>;
  copyEntriesToDir: ({ entries, targetPath }: { entries: FileExplorerEntry[]; targetPath: string }) => Promise<void>;
  downloadEntry: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  uploadFiles: ({ files }: { files: FileList | File[] }) => Promise<void>;

  renamingEntryName: string | undefined;
  startRename: ({ entry }: { entry: FileExplorerEntry }) => void;
  cancelRename: () => void;

  previewState: PreviewState;
  loadPreview: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  loadPreviewForced: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  clearPreview: () => void;
  togglePreviewVisibility: () => void;
  toggleJsonFormat: () => void;

  contextMenuState: ContextMenuState;
  showContextMenu: ({ event, target }: { event: MouseEvent; target: ContextMenuTarget }) => void;
  hideContextMenu: () => void;
  executeContextAction: ({ action }: { action: ContextMenuAction }) => Promise<void>;

  clipboardState: ClipboardState;
  clipboardCut: ({ entries }: { entries: FileExplorerEntry[] }) => void;
  clipboardCopy: ({ entries }: { entries: FileExplorerEntry[] }) => void;
  clipboardPaste: () => Promise<void>;

  dragState: DragState;
  onDragStart: ({ event, entries }: { event: DragEvent; entries: FileExplorerEntry[] }) => void;
  onDragOverEntry: ({ event, entry }: { event: DragEvent; entry: FileExplorerEntry }) => void;
  onDragLeaveEntry: () => void;
  onDropEntry: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  onDragEnd: () => void;

  readOnly: boolean;

  isLocked: boolean;
  toggleLock: () => void;

  columnPanes: ColumnPaneState[];
  selectColumnEntry: ({ paneIndex, entryName }: { paneIndex: number; entryName: string }) => Promise<void>;

  statusBarInfo: StatusBarInfo;
}
