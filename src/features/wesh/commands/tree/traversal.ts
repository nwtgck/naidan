import type { WeshCommandContext, WeshEntryRef, WeshStat } from '@/features/wesh/types';
import { matchesTreePattern } from './pattern';
import { sortTreeEntries } from './sorting';
import type {
  TreeEntryInfo,
  TreeOptions,
  TreeOutputWriter,
  TreeRenderNode,
  TreeResolvedOperand,
  TreeSummary,
  TreeTraversalState,
} from './types';
import { childPrefix, renderSummary, renderTreeLine } from './format-text';

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function isDotHidden({ name }: { name: string }): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..';
}

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

function isDisplayDirectory({ info }: { info: TreeEntryInfo }): boolean {
  return info.displayType === 'directory';
}

function shouldExclude({
  info,
  options,
}: {
  info: TreeEntryInfo,
  options: TreeOptions,
}): boolean {
  if (!options.showAll && isDotHidden({ name: info.name })) {
    return true;
  }
  return options.excludePatterns.some((pattern) => matchesTreePattern({
    compiled: pattern,
    name: info.name,
    path: info.matchPath,
    isDirectory: isDisplayDirectory({ info }),
  }));
}

function includeMatch({
  info,
  options,
}: {
  info: TreeEntryInfo,
  options: TreeOptions,
}): 'matched' | 'not-matched' | 'no-include-patterns' {
  if (options.includePatterns.length === 0) {
    return 'no-include-patterns';
  }
  const matched = options.includePatterns.some((pattern) => matchesTreePattern({
    compiled: pattern,
    name: info.name,
    path: info.matchPath,
    isDirectory: isDisplayDirectory({ info }),
  }));
  return matched ? 'matched' : 'not-matched';
}

function shouldDisplayEntry({
  info,
  options,
  inheritedDirectoryMatch,
}: {
  info: TreeEntryInfo,
  options: TreeOptions,
  inheritedDirectoryMatch: boolean,
}): boolean {
  if (options.directoriesOnly && !isDisplayDirectory({ info })) {
    return false;
  }
  if (inheritedDirectoryMatch) {
    return true;
  }
  const match = includeMatch({ info, options });
  switch (match) {
  case 'matched':
  case 'no-include-patterns':
    return true;
  case 'not-matched':
    return isDisplayDirectory({ info });
  default: {
    const _ex: never = match;
    throw new Error(`Unhandled include match: ${_ex}`);
  }
  }
}

function directoryMatchShouldApplyToChildren({
  info,
  options,
  inheritedDirectoryMatch,
}: {
  info: TreeEntryInfo,
  options: TreeOptions,
  inheritedDirectoryMatch: boolean,
}): boolean {
  if (inheritedDirectoryMatch) {
    return true;
  }
  if (!options.matchDirectories || !isDisplayDirectory({ info })) {
    return false;
  }
  return includeMatch({ info, options }) === 'matched';
}

async function resolveSymlinkTarget({
  context,
  entry,
}: {
  context: WeshCommandContext,
  entry: WeshEntryRef<'symlink'>,
}): Promise<{ linkTarget: string, targetEntry: WeshEntryRef | undefined, targetStat: WeshStat | undefined }> {
  const linkTarget = await context.files.readlinkEntry({ entry });
  try {
    const targetEntry = await context.files.resolveEntry({
      path: entry.fullPath,
      finalSymlinkTreatment: 'follow',
    });
    const targetStat = await context.files.statEntry({ entry: targetEntry });
    return { linkTarget, targetEntry, targetStat };
  } catch {
    return { linkTarget, targetEntry: undefined, targetStat: undefined };
  }
}

async function prepareEntryInfo({
  context,
  entry,
  displayPath,
  matchPath,
  originalIndex,
}: {
  context: WeshCommandContext,
  entry: WeshEntryRef,
  displayPath: string,
  matchPath: string,
  originalIndex: number,
}): Promise<TreeEntryInfo> {
  const stat = await context.files.statEntry({ entry });
  switch (entry.type) {
  case 'symlink': {
    const symlink = await resolveSymlinkTarget({
      context,
      entry: entry as WeshEntryRef<'symlink'>,
    });
    return {
      entry,
      displayPath,
      matchPath,
      name: entry.name,
      stat,
      linkTarget: symlink.linkTarget,
      targetEntry: symlink.targetEntry,
      targetStat: symlink.targetStat,
      originalIndex,
      displayType: symlink.targetStat?.type ?? 'symlink',
    };
  }
  case 'directory':
  case 'file':
  case 'fifo':
  case 'chardev':
    return {
      entry,
      displayPath,
      matchPath,
      name: entry.name,
      stat,
      linkTarget: undefined,
      targetEntry: undefined,
      targetStat: undefined,
      originalIndex,
      displayType: stat.type,
    };
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${JSON.stringify(_ex)}`);
  }
  }
}

async function readDirectoryChildren({
  state,
  directoryEntry,
  parentMatchPath,
}: {
  state: TreeTraversalState,
  directoryEntry: WeshEntryRef<'directory'>,
  parentMatchPath: string,
}): Promise<TreeEntryInfo[]> {
  const rawEntries: WeshEntryRef[] = [];
  for await (const child of state.context.files.readDirEntry({ entry: directoryEntry })) {
    rawEntries.push(child);
  }
  const prepared: TreeEntryInfo[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const child = rawEntries[index];
    if (child === undefined) {
      continue;
    }
    const displayPath = state.options.fullPath
      ? child.fullPath.replace(/^\//, '') || '/'
      : child.name;
    const matchPath = parentMatchPath === '.' || parentMatchPath === ''
      ? child.name
      : `${parentMatchPath}/${child.name}`;
    const info = await prepareEntryInfo({
      context: state.context,
      entry: child,
      displayPath,
      matchPath,
      originalIndex: index,
    });
    if (!shouldExclude({ info, options: state.options })) {
      prepared.push(info);
    }
  }
  return sortTreeEntries({
    entries: prepared,
    options: state.options,
  });
}

function shouldDescend({
  info,
  options,
  depth,
}: {
  info: TreeEntryInfo,
  options: TreeOptions,
  depth: number,
}): { kind: 'yes', entry: WeshEntryRef<'directory'>, inode: number } | { kind: 'no' } {
  if (options.maxDepth !== undefined && depth >= options.maxDepth) {
    return { kind: 'no' };
  }
  switch (info.entry.type) {
  case 'directory':
    return {
      kind: 'yes',
      entry: info.entry as WeshEntryRef<'directory'>,
      inode: info.stat.ino,
    };
  case 'symlink':
    if (
      options.followLinks
      && info.targetEntry?.type === 'directory'
      && info.targetStat !== undefined
    ) {
      return {
        kind: 'yes',
        entry: info.targetEntry as WeshEntryRef<'directory'>,
        inode: info.targetStat.ino,
      };
    }
    return { kind: 'no' };
  case 'file':
  case 'fifo':
  case 'chardev':
    return { kind: 'no' };
  default: {
    const _ex: never = info.entry;
    throw new Error(`Unhandled entry type: ${JSON.stringify(_ex)}`);
  }
  }
}

function countNode({
  node,
  state,
}: {
  node: TreeRenderNode,
  state: TreeTraversalState,
}): void {
  switch (node.info.displayType) {
  case 'directory':
    state.summary.directories += 1;
    return;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    state.summary.files += 1;
    return;
  default: {
    const _ex: never = node.info.displayType;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

async function buildNode({
  state,
  info,
  depth,
  ancestorInodes,
  inheritedDirectoryMatch,
  isRoot,
}: {
  state: TreeTraversalState,
  info: TreeEntryInfo,
  depth: number,
  ancestorInodes: Set<number>,
  inheritedDirectoryMatch: boolean,
  isRoot: boolean,
}): Promise<TreeRenderNode | undefined> {
  if (!isRoot && !shouldDisplayEntry({ info, options: state.options, inheritedDirectoryMatch })) {
    return undefined;
  }

  const childDirectoryMatch = directoryMatchShouldApplyToChildren({
    info,
    options: state.options,
    inheritedDirectoryMatch,
  });
  const descent = shouldDescend({
    info,
    options: state.options,
    depth,
  });
  let recursiveLink = false;
  let readError: string | undefined;
  let fileLimitExceeded = false;
  let children: TreeRenderNode[] | undefined;

  switch (descent.kind) {
  case 'yes':
    if (ancestorInodes.has(descent.inode)) {
      recursiveLink = true;
      break;
    }
    try {
      const childInfos = await readDirectoryChildren({
        state,
        directoryEntry: descent.entry,
        parentMatchPath: info.matchPath,
      });
      if (state.options.fileLimit !== undefined && childInfos.length > state.options.fileLimit) {
        fileLimitExceeded = true;
      } else {
        const nextAncestors = new Set(ancestorInodes);
        nextAncestors.add(descent.inode);
        const builtChildren: TreeRenderNode[] = [];
        for (const childInfo of childInfos) {
          const child = await buildNode({
            state,
            info: childInfo,
            depth: depth + 1,
            ancestorInodes: nextAncestors,
            inheritedDirectoryMatch: childDirectoryMatch,
            isRoot: false,
          });
          if (child !== undefined) {
            builtChildren.push(child);
          }
        }
        children = builtChildren;
      }
    } catch (error: unknown) {
      readError = errorMessage({ error });
      state.summary.traversalErrors += 1;
    }
    break;
  case 'no':
    break;
  default: {
    const _ex: never = descent;
    throw new Error(`Unhandled descent result: ${JSON.stringify(_ex)}`);
  }
  }

  const hasIncludedDescendant = children?.some((child) => child.hasIncludedDescendant) ?? false;
  const selfMatchesInclude = includeMatch({ info, options: state.options }) !== 'not-matched' || inheritedDirectoryMatch || isRoot;
  if (
    !isRoot
    && state.options.prune
    && info.displayType === 'directory'
    && !selfMatchesInclude
    && !hasIncludedDescendant
    && readError === undefined
  ) {
    return undefined;
  }

  const node: TreeRenderNode = {
    info,
    children,
    recursiveLink,
    readError,
    fileLimitExceeded,
    diskUsageSize: info.stat.size,
    hasIncludedDescendant: selfMatchesInclude || hasIncludedDescendant,
  };
  node.diskUsageSize = info.stat.size + (children ?? []).reduce((sum, child) => sum + child.diskUsageSize, 0);
  countNode({ node, state });
  return node;
}

export async function resolveTreeOperand({
  context,
  operand,
  options,
}: {
  context: WeshCommandContext,
  operand: string,
  options: TreeOptions,
}): Promise<TreeResolvedOperand> {
  const absolutePath = resolvePath({ cwd: context.cwd, path: operand });
  const entry = await context.files.resolveEntry({
    path: absolutePath,
    finalSymlinkTreatment: 'no-follow',
  });
  const stat = await context.files.statEntry({ entry });
  const displayPath = options.fullPath ? absolutePath.replace(/^\//, '') || '/' : operand;
  const matchPath = '.';

  switch (entry.type) {
  case 'symlink': {
    const symlink = await resolveSymlinkTarget({
      context,
      entry: entry as WeshEntryRef<'symlink'>,
    });
    return {
      displayPath,
      matchPath,
      entry,
      stat,
      linkTarget: symlink.linkTarget,
      targetEntry: symlink.targetEntry,
      targetStat: symlink.targetStat,
    };
  }
  case 'directory':
  case 'file':
  case 'fifo':
  case 'chardev':
    return {
      displayPath,
      matchPath,
      entry,
      stat,
      linkTarget: undefined,
      targetEntry: undefined,
      targetStat: undefined,
    };
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${JSON.stringify(_ex)}`);
  }
  }
}

export async function buildTreeForOperand({
  state,
  operand,
}: {
  state: TreeTraversalState,
  operand: TreeResolvedOperand,
}): Promise<TreeRenderNode | undefined> {
  const targetIsDirectory = operand.targetEntry?.type === 'directory' && operand.targetStat !== undefined;
  const rootEntry = targetIsDirectory ? operand.targetEntry! : operand.entry;
  const rootStat = targetIsDirectory ? operand.targetStat! : operand.stat;
  const rootInfo: TreeEntryInfo = {
    entry: rootEntry,
    displayPath: operand.displayPath,
    matchPath: operand.matchPath,
    name: operand.displayPath.split('/').filter(Boolean).pop() ?? operand.displayPath,
    stat: rootStat,
    linkTarget: targetIsDirectory ? undefined : operand.linkTarget,
    targetEntry: targetIsDirectory ? undefined : operand.targetEntry,
    targetStat: targetIsDirectory ? undefined : operand.targetStat,
    originalIndex: 0,
    displayType: rootStat.type,
  };
  const ancestors = new Set<number>();
  const node = await buildNode({
    state,
    info: rootInfo,
    depth: 0,
    ancestorInodes: ancestors,
    inheritedDirectoryMatch: false,
    isRoot: true,
  });
  if (node !== undefined) {
    state.summary.bytesUsed += node.diskUsageSize;
  }
  return node;
}

export async function renderTreeNode({
  node,
  options,
  writer,
  ancestorHasMoreSiblings,
  isRoot,
  isLast,
}: {
  node: TreeRenderNode,
  options: TreeOptions,
  writer: TreeOutputWriter,
  ancestorHasMoreSiblings: boolean[],
  isRoot: boolean,
  isLast: boolean,
}): Promise<void> {
  const prefix = isRoot ? '' : childPrefix({ options, ancestorHasMoreSiblings, isLast });
  await writer.write({ text: renderTreeLine({ node, options, prefix }) });
  const children = node.children ?? [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) {
      continue;
    }
    await renderTreeNode({
      node: child,
      options,
      writer,
      ancestorHasMoreSiblings: isRoot ? [] : [...ancestorHasMoreSiblings, !isLast],
      isRoot: false,
      isLast: index === children.length - 1,
    });
  }
}

export function createTreeSummary(): TreeSummary {
  return {
    directories: 0,
    files: 0,
    bytesUsed: 0,
    traversalErrors: 0,
  };
}

export async function writeTreeReport({
  writer,
  summary,
  options,
}: {
  writer: TreeOutputWriter,
  summary: TreeSummary,
  options: TreeOptions,
}): Promise<void> {
  if (options.noReport) {
    return;
  }
  await writer.write({ text: '\n' });
  await writer.write({ text: renderSummary({ summary, options }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  resolvePath,
};
