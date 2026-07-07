import type {
  WeshCommandContext,
  WeshEntryRef,
  WeshFileHandle,
  WeshFileType,
  WeshStat,
} from '@/features/wesh/types';

export type TreeCharset = 'utf8' | 'ascii';
export type TreeNameDisplayMode = 'escaped' | 'question' | 'literal';
export type TreeSortMode = 'name' | 'version' | 'mtime' | 'size' | 'none';
export type TreeGroupingMode = 'mixed' | 'directories-first' | 'files-first';

export interface TreeOptions {
  showAll: boolean,
  directoriesOnly: boolean,
  fullPath: boolean,
  followLinks: boolean,
  maxDepth: number | undefined,
  noReport: boolean,
  fileLimit: number | undefined,
  includePatterns: CompiledTreePattern[],
  excludePatterns: CompiledTreePattern[],
  ignoreCase: boolean,
  matchDirectories: boolean,
  prune: boolean,
  reverse: boolean,
  sortMode: TreeSortMode,
  groupingMode: TreeGroupingMode,
  charset: TreeCharset,
  indentMode: 'tree' | 'none',
  quoteNames: boolean,
  nameDisplayMode: TreeNameDisplayMode,
  classify: boolean,
  showPermissions: boolean,
  showUid: boolean,
  showGid: boolean,
  showSize: 'none' | 'bytes' | 'human-1024' | 'human-1000',
  showDiskUsage: boolean,
  showDate: boolean,
  showInodes: boolean,
  outputPath: string | undefined,
}

export interface TreePatternToken {
  rawPattern: string,
  directoryOnly: boolean,
  matcher: RegExp,
  scope: 'name' | 'path',
}

export type CompiledTreePattern = TreePatternToken;

export interface TreeOutputWriter {
  write({ text }: { text: string }): Promise<void>,
  close(): Promise<void>,
  abort({ reason }: { reason: unknown }): Promise<void>,
}

export interface TreeEntryInfo {
  entry: WeshEntryRef,
  displayPath: string,
  matchPath: string,
  name: string,
  stat: WeshStat,
  linkTarget: string | undefined,
  targetEntry: WeshEntryRef | undefined,
  targetStat: WeshStat | undefined,
  originalIndex: number,
  displayType: WeshFileType,
}

export interface TreeRenderNode {
  info: TreeEntryInfo,
  children: TreeRenderNode[] | undefined,
  recursiveLink: boolean,
  readError: string | undefined,
  fileLimitExceeded: boolean,
  diskUsageSize: number,
  hasIncludedDescendant: boolean,
}

export interface TreeSummary {
  directories: number,
  files: number,
  bytesUsed: number,
  traversalErrors: number,
}

export interface TreeTraversalState {
  context: WeshCommandContext,
  options: TreeOptions,
  summary: TreeSummary,
}

export interface TreeResolvedOperand {
  displayPath: string,
  matchPath: string,
  entry: WeshEntryRef,
  stat: WeshStat,
  linkTarget: string | undefined,
  targetEntry: WeshEntryRef | undefined,
  targetStat: WeshStat | undefined,
}

export type TreeWritableHandle = WeshFileHandle;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
