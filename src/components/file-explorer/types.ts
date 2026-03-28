import type { ExplorerDirectory } from './explorer-directory';

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
  name: string;
  kind: EntryKind;
  handle: FileSystemHandle;
  directory: ExplorerDirectory | undefined;  // set for directory entries
  size: number | undefined;
  lastModified: number | undefined;
  extension: string;
  mimeCategory: MimeCategory;
  readOnly: boolean;  // true for read-only directories; always false for files
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
  directory: ExplorerDirectory;
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
  sourceDirectory: ExplorerDirectory | undefined;
  entries: FileExplorerEntry[];
}

export interface PreviewState {
  visibility: PreviewVisibility;
  entry: FileExplorerEntry | undefined;
  textContent: string | undefined;
  highlightedHtml: string | undefined;
  objectUrl: string | undefined;
  jsonFormatMode: 'formatted' | 'raw';
  loadingState: 'idle' | 'loading' | 'loaded' | 'error';
  errorMessage: string | undefined;
  oversized: boolean;
}

export type DragState =
  | { status: 'idle' }
  | { status: 'dragging'; entries: FileExplorerEntry[]; sourceDirectory: ExplorerDirectory }
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

export interface FileExplorerContext {
  // Navigation
  root: ExplorerDirectory;
  currentDirectory: ExplorerDirectory;
  pathSegments: Array<{ name: string; directory: ExplorerDirectory }>;
  navigateToDirectory: ({ directory }: { directory: ExplorerDirectory }) => Promise<void>;
  navigateUp: () => Promise<void>;
  jumpToBreadcrumb: ({ index }: { index: number }) => Promise<void>;
  refresh: () => Promise<void>;

  // Entries
  entries: FileExplorerEntry[];
  sortedFilteredEntries: FileExplorerEntry[];
  isLoading: boolean;
  loadError: string | undefined;

  // View mode
  viewMode: ViewMode;
  setViewMode: ({ mode }: { mode: ViewMode }) => void;

  // Sort
  sortConfig: SortConfig;
  toggleSortField: ({ field }: { field: SortField }) => void;

  // Filter
  filterQuery: string;
  setFilterQuery: ({ query }: { query: string }) => void;

  // Selection
  selectionState: SelectionState;
  selectedEntries: FileExplorerEntry[];
  applySelection: ({ action }: { action: SelectionAction }) => void;
  moveFocus: ({ direction, extend }: { direction: 'prev' | 'next'; extend: boolean }) => void;

  // Operations
  createFile: ({ name }: { name: string }) => Promise<void>;
  createFolder: ({ name }: { name: string }) => Promise<void>;
  deleteEntries: ({ entries }: { entries: FileExplorerEntry[] }) => Promise<void>;
  renameEntry: ({ entry, newName }: { entry: FileExplorerEntry; newName: string }) => Promise<void>;
  moveEntries: ({ entries, targetDir }: { entries: FileExplorerEntry[]; targetDir: ExplorerDirectory }) => Promise<void>;
  copyEntriesToDir: ({ entries, targetDir }: { entries: FileExplorerEntry[]; targetDir: ExplorerDirectory }) => Promise<void>;
  downloadEntry: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  uploadFiles: ({ files }: { files: FileList | File[] }) => Promise<void>;

  // Rename UI state
  renamingEntryName: string | undefined;
  startRename: ({ entry }: { entry: FileExplorerEntry }) => void;
  cancelRename: () => void;

  // Preview
  previewState: PreviewState;
  loadPreview: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  loadPreviewForced: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  clearPreview: () => void;
  togglePreviewVisibility: () => void;
  toggleJsonFormat: () => void;

  // Context menu
  contextMenuState: ContextMenuState;
  showContextMenu: ({ event, target }: { event: MouseEvent; target: ContextMenuTarget }) => void;
  hideContextMenu: () => void;
  executeContextAction: ({ action }: { action: ContextMenuAction }) => Promise<void>;

  // Clipboard
  clipboardState: ClipboardState;
  clipboardCut: ({ entries }: { entries: FileExplorerEntry[] }) => void;
  clipboardCopy: ({ entries }: { entries: FileExplorerEntry[] }) => void;
  clipboardPaste: () => Promise<void>;

  // Drag and drop
  dragState: DragState;
  onDragStart: ({ event, entries }: { event: DragEvent; entries: FileExplorerEntry[] }) => void;
  onDragOverEntry: ({ event, entry }: { event: DragEvent; entry: FileExplorerEntry }) => void;
  onDragLeaveEntry: () => void;
  onDropEntry: ({ entry }: { entry: FileExplorerEntry }) => Promise<void>;
  onDragEnd: () => void;

  // Read-only state of the current directory
  readOnly: boolean;

  // Lock state (user-togglable; overrides readOnly to true when active)
  isLocked: boolean;
  toggleLock: () => void;

  // Column view
  columnPanes: ColumnPaneState[];
  selectColumnEntry: ({ paneIndex, entryName }: { paneIndex: number; entryName: string }) => Promise<void>;

  // Status bar
  statusBarInfo: StatusBarInfo;
}
