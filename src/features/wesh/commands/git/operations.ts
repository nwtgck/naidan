import { normalizePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { readTextFromHandle } from '@/features/wesh/commands/_shared/text';
import { loadWorktreeAttributes } from './attributes';
import { applyCheckoutTreePlan, planCheckoutTree } from './checkout';
import type { GitCheckoutConflict } from './checkout';
import { commitSubject, createCommit, parseCommitAuthor, readCommit } from './commits';
import { addGlobalConfigValue, addLocalConfigValue, getBooleanConfigValue, getConfigValue, readEffectiveConfig, readEffectiveConfigEntries, readWorktreeContentConfig, readGlobalConfigEntries, readLocalConfigEntries, renameLocalConfigSection, setGlobalConfigValue, setLocalConfigValue, unsetGlobalConfigValue, unsetLocalConfigValue } from './config';
import { revisionDiffMatchesSearch, writeRevisionPatch, writeRevisionStat } from './diff';
import { pathExists, readFileText, writeHandleBytes } from './files';
import { fastForwardHead } from './fast-forward';
import { isExclusionPathspec, matchRepositoryPaths, pathspecSelectsDirectory, selectRepositoryPaths } from './pathspec';
import { quoteGitPath, quoteNonAsciiFromConfig } from './path-output';
import { sortGitPaths } from './path-order';
import { sortGitUtf8Strings } from './utf8-order';
import { findExactRenames } from './renames';
import { gitPathspecGlobSource } from './wildmatch';
import { collectRebaseCommits, findMergeBases, isAncestor } from './graph';
import { collectCommitHistory, collectGraphCommitHistory, collectPathLimitedHistory, formatCommitTemplate } from './history';
import { renderGitLogGraph } from './log-graph';
import { loadIgnoreMatcher } from './ignore';
import { assertLocalRepositoryLocation, deleteLocalRemoteBranch, fetchLocalRemote, pushLocalBranch } from './local-transport';
import { applyMergedIndexWithConflicts } from './merge-apply';
import { formatPreparedMergeConflict, prepareMergeConflicts } from './merge-conflict';
import type { GitPreparedMergeConflict } from './merge-conflict';
import { clearMergeState, readMergeState, writeMergeState } from './merge-state';
import { mergeThreeTrees } from './merge-tree';
import { resolveGitIdentity, resolveGitReflogIdentity, resolveGitTimestamp } from './identity';
import type { GitIndexEntry } from './index-file';
import { readIndex, writeIndex } from './index-file';
import { forceReplaceIndexAndWorktree } from './index-worktree';
import { readObject } from './objects';
import { transferReachableObjects } from './object-transfer';
import { branchNameFromHead, createRef, deleteRef, listRefs, moveHeadReference, readHead, readRef, renameRef, setHeadSymbolic, updateHead, updateRef, writeOrigHead, writeRef, writeSymbolicRef } from './refs';
import { assertRepositoryHasUsableWorktree, discoverRepository, discoverRepositoryAtPath, initializeBareRepository, initializeRepository, joinPath, relativeToWorktree, repositoryCwdIsInsideWorktree, repositoryHasWorktree, discoverRepositoryFromContext } from './repository';
import type { GitRepository } from './repository';
import { peelToCommitObjectId, resolveCommitRevision, resolveRevision, resolveRevisionPath } from './revision';
import { beginRebaseStep, clearRebaseState, clearRebaseStoppedState, readRebaseState, writeRebaseState, writeRebaseStoppedState } from './rebase-state';
import { prepareCommitReplay } from './replay';
import type { GitPreparedReplay } from './replay';
import type { GitReplayKind } from './replay-state';
import { clearReplayState, readReplayState, writeReplayState } from './replay-state';
import { advanceSequencer, clearSequencerState, readSequencerState, writeSequencerState } from './sequencer-state';
import { appendReflog, readReflog } from './reflog';
import { readTreeIntoIndex, readTreeRecursively, writeTreeFromIndex } from './tree';
import { stageWorktreePaths } from './stage';
import { parseAnnotatedTagObject } from './tag-object';
import { applyStash, clearStashes, createStash, dropStash, listStashes, parseStashIndex, resolveStash } from './stash';
import { autoMergeTextConflicts } from './text-merge';
import { collectPathsForAdd, hashWorktreeEntry, listWorktreeEntries, removeWorktreePaths, replaceTrackedWorktree, worktreeAbsolutePath } from './worktree';

async function resolveContentConfigForContext({ context, repository }: {
  context: WeshCommandContext,
  repository: GitRepository,
}) {
  return readWorktreeContentConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    env: context.env,
  });
}

interface GitStatusEntry {
  path: string,
  indexStatus: ' ' | 'A' | 'M' | 'D' | 'U',
  worktreeStatus: ' ' | 'M' | 'D' | '?' | 'U',
  headObjectId: string | undefined,
  headMode: number | undefined,
  indexObjectId: string | undefined,
  indexMode: number | undefined,
  worktreeMode: number | undefined,
  unmergedEntries: readonly GitIndexEntry[] | undefined,
  renameSourcePath: string | undefined,
}

function firstLine({ text }: { text: string }): string {
  return text.split('\n', 1)[0] ?? '';
}

function regularFileModeFromIndex({ entry }: { entry: GitIndexEntry | undefined }): 0o100644 | 0o100755 | undefined {
  if (entry === undefined) return undefined;
  switch (entry.mode) {
  case 0o100644:
  case 0o100755:
    return entry.mode;
  default:
    return undefined;
  }
}

async function readHeadTreeMap({ context, repository }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
}): Promise<Map<string, { objectId: string, mode: number }>> {
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) return new Map();
  const commit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  const entries = await readTreeRecursively({
    files: context.files,
    repository,
    treeObjectId: commit.treeObjectId,
  });
  return new Map(entries.map(entry => [entry.path, { objectId: entry.objectId, mode: entry.mode }]));
}

async function collectStatus({ context }: { context: WeshCommandContext }): Promise<{
  repository: GitRepository,
  branchName: string | undefined,
  headObjectId: string | undefined,
  hasCommits: boolean,
  upstreamName: string | undefined,
  upstreamObjectId: string | undefined,
  ahead: number | undefined,
  behind: number | undefined,
  quoteNonAscii: boolean,
  entries: GitStatusEntry[],
}> {
  const repository = await discoverRepositoryFromContext({ context });
  assertRepositoryHasUsableWorktree({ context, repository });
  const head = await readHead({ files: context.files, repository });
  const headTree = await readHeadTreeMap({ context, repository });
  const indexEntries = await readIndex({ files: context.files, repository });
  const index = new Map(indexEntries.filter(entry => entry.stage === 0).map(entry => [entry.path, entry]));
  const unmergedByPath = new Map<string, GitIndexEntry[]>();
  for (const entry of indexEntries) {
    if (entry.stage === 0) continue;
    const entries = unmergedByPath.get(entry.path) ?? [];
    entries.push(entry);
    unmergedByPath.set(entry.path, entries);
  }
  const ignoreMatcher = await loadIgnoreMatcher({ files: context.files, repository });
  const attributes = await loadWorktreeAttributes({
    files: context.files,
    repository,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  const gitlinkPaths = new Set([...index.values()].filter(entry => entry.mode === 0o160000).map(entry => entry.path));
  const isInsideGitlink = ({ path }: { path: string }): boolean => (
    [...gitlinkPaths].some(gitlinkPath => path.startsWith(`${gitlinkPath}/`))
  );
  const worktreePaths = new Set(
    (await listWorktreeEntries({ files: context.files, repository })).filter(path => !isInsideGitlink({ path })),
  );
  for (const gitlinkPath of gitlinkPaths) {
    const absolutePath = worktreeAbsolutePath({ repository, path: gitlinkPath });
    if (!await pathExists({ files: context.files, path: absolutePath })) continue;
    const stat = await context.files.lstat({ path: absolutePath });
    switch (stat.type) {
    case 'directory':
      if (await pathExists({ files: context.files, path: joinPath({ base: absolutePath, child: '.git' }) })) {
        throw new Error(`initialized gitlink worktree is not supported yet: ${gitlinkPath}`);
      }
      worktreePaths.add(gitlinkPath);
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      break;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled gitlink worktree type: ${_ex}`);
    }
    }
  }
  const paths = new Set([...headTree.keys(), ...index.keys(), ...unmergedByPath.keys(), ...worktreePaths]);
  const statusEntries: GitStatusEntry[] = [];

  for (const path of sortGitPaths({ paths })) {
    const headEntry = headTree.get(path);
    const indexEntry = index.get(path);
    const unmergedEntries = unmergedByPath.get(path);
    const inWorktree = worktreePaths.has(path);
    if (unmergedEntries !== undefined) {
      let worktreeMode: number | undefined;
      if (inWorktree) {
        const stat = await context.files.lstat({ path: worktreeAbsolutePath({ repository, path }) });
        switch (stat.type) {
        case 'file':
          worktreeMode = 0o100644;
          break;
        case 'symlink':
          worktreeMode = 0o120000;
          break;
        case 'directory':
        case 'fifo':
        case 'chardev':
          break;
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled unmerged worktree type: ${_ex}`);
        }
        }
      }
      statusEntries.push({
        path,
        indexStatus: 'U',
        worktreeStatus: 'U',
        headObjectId: headEntry?.objectId,
        headMode: headEntry?.mode,
        indexObjectId: undefined,
        indexMode: undefined,
        worktreeMode,
        unmergedEntries,
        renameSourcePath: undefined,
      });
      continue;
    }
    if (headEntry === undefined && indexEntry === undefined && inWorktree
      && ignoreMatcher.isIgnored({ path, isDirectory: false })) continue;

    if (headEntry !== undefined && indexEntry === undefined && inWorktree) {
      statusEntries.push({
        path,
        indexStatus: 'D',
        worktreeStatus: ' ',
        headObjectId: headEntry.objectId,
        headMode: headEntry.mode,
        indexObjectId: undefined,
        indexMode: undefined,
        worktreeMode: undefined,
        unmergedEntries: undefined,
        renameSourcePath: undefined,
      });
      if (!ignoreMatcher.isIgnored({ path, isDirectory: false })) {
        const stat = await context.files.lstat({ path: worktreeAbsolutePath({ repository, path }) });
        let untrackedMode: number | undefined;
        switch (stat.type) {
        case 'file':
          untrackedMode = 0o100644;
          break;
        case 'symlink':
          untrackedMode = 0o120000;
          break;
        case 'directory':
        case 'fifo':
        case 'chardev':
          break;
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled untracked worktree type: ${_ex}`);
        }
        }
        statusEntries.push({
          path,
          indexStatus: ' ',
          worktreeStatus: '?',
          headObjectId: undefined,
          headMode: undefined,
          indexObjectId: undefined,
          indexMode: undefined,
          worktreeMode: untrackedMode,
          unmergedEntries: undefined,
          renameSourcePath: undefined,
        });
      }
      continue;
    }

    let indexStatus: GitStatusEntry['indexStatus'] = ' ';
    if (headEntry === undefined && indexEntry !== undefined) indexStatus = 'A';
    else if (headEntry !== undefined && indexEntry === undefined) indexStatus = 'D';
    else if (headEntry !== undefined && indexEntry !== undefined
      && (headEntry.objectId !== indexEntry.objectId || headEntry.mode !== indexEntry.mode)) indexStatus = 'M';

    let worktreeStatus: GitStatusEntry['worktreeStatus'] = ' ';
    let worktreeMode: number | undefined;
    if (indexEntry === undefined && inWorktree) {
      const stat = await context.files.lstat({ path: worktreeAbsolutePath({ repository, path }) });
      switch (stat.type) {
      case 'file':
        worktreeMode = 0o100644;
        break;
      case 'symlink':
        worktreeMode = 0o120000;
        break;
      case 'directory':
      case 'fifo':
      case 'chardev':
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled status worktree type: ${_ex}`);
      }
      }
      worktreeStatus = '?';
    } else if (indexEntry !== undefined && !inWorktree) {
      worktreeStatus = 'D';
    } else if (indexEntry !== undefined && inWorktree) {
      if (indexEntry.mode === 0o160000) {
        const stat = await context.files.lstat({ path: worktreeAbsolutePath({ repository, path }) });
        switch (stat.type) {
        case 'directory':
          worktreeMode = 0o160000;
          break;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          throw new Error(`gitlink worktree path is not a directory: ${path}`);
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled gitlink worktree type: ${_ex}`);
        }
        }
      } else {
        const worktreeEntry = await hashWorktreeEntry({
          files: context.files,
          repository,
          path,
          write: false,
          regularFileMode: regularFileModeFromIndex({ entry: indexEntry }),
          attributes,
          indexObjectId: indexEntry.objectId,
        });
        worktreeMode = worktreeEntry.mode;
        if (worktreeEntry.objectId !== indexEntry.objectId || worktreeEntry.mode !== indexEntry.mode) {
          worktreeStatus = 'M';
        }
      }
    }

    if (indexStatus !== ' ' || worktreeStatus !== ' ') {
      statusEntries.push({
        path,
        indexStatus,
        worktreeStatus,
        headObjectId: headEntry?.objectId,
        headMode: headEntry?.mode,
        indexObjectId: indexEntry?.objectId,
        indexMode: indexEntry?.mode,
        worktreeMode,
        unmergedEntries: undefined,
        renameSourcePath: undefined,
      });
    }
  }

  const statusEntriesByPath = new Map(statusEntries.map(entry => [entry.path, entry]));
  const exactRenames = findExactRenames({
    deleted: statusEntries.flatMap(entry => (
      entry.indexStatus === 'D' && entry.headObjectId !== undefined && entry.headMode !== undefined
        ? [{ path: entry.path, objectId: entry.headObjectId, mode: entry.headMode }]
        : []
    )),
    added: statusEntries.flatMap(entry => (
      entry.indexStatus === 'A' && entry.indexObjectId !== undefined && entry.indexMode !== undefined
        ? [{ path: entry.path, objectId: entry.indexObjectId, mode: entry.indexMode }]
        : []
    )),
  });
  for (const rename of exactRenames) {
    const source = statusEntriesByPath.get(rename.sourcePath)!;
    const destination = statusEntriesByPath.get(rename.destinationPath)!;
    destination.headObjectId = source.headObjectId;
    destination.headMode = source.headMode;
    destination.renameSourcePath = source.path;
  }

  const branchName = branchNameFromHead({ head });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  let upstreamName: string | undefined;
  let upstreamObjectId: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  if (branchName !== undefined) {
    const remoteName = getConfigValue({ config, key: `branch.${branchName}.remote` });
    const mergeRefName = getConfigValue({ config, key: `branch.${branchName}.merge` });
    if (remoteName !== undefined && mergeRefName?.startsWith('refs/heads/') === true) {
      const upstreamBranchName = mergeRefName.slice('refs/heads/'.length);
      const upstreamRefName = remoteName === '.'
        ? mergeRefName
        : `refs/remotes/${remoteName}/${upstreamBranchName}`;
      upstreamName = remoteName === '.' ? upstreamBranchName : `${remoteName}/${upstreamBranchName}`;
      upstreamObjectId = await readRef({ files: context.files, repository, refName: upstreamRefName });
      if (head.objectId !== undefined && upstreamObjectId !== undefined) {
        ahead = (await collectCommitHistory({
          files: context.files,
          repository,
          includeObjectIds: [head.objectId],
          excludeObjectIds: [upstreamObjectId],
        })).length;
        behind = (await collectCommitHistory({
          files: context.files,
          repository,
          includeObjectIds: [upstreamObjectId],
          excludeObjectIds: [head.objectId],
        })).length;
      }
    }
  }

  return {
    repository,
    branchName,
    headObjectId: head.objectId,
    hasCommits: head.objectId !== undefined,
    upstreamName,
    upstreamObjectId,
    ahead,
    behind,
    quoteNonAscii: quoteNonAsciiFromConfig({ config }),
    entries: statusEntries,
  };
}

function visibleStatusEntries({ entries }: { entries: readonly GitStatusEntry[] }): readonly GitStatusEntry[] {
  const renameSources = new Map<string, { objectId: string | undefined, mode: number | undefined }>();
  for (const entry of entries) {
    if (entry.renameSourcePath === undefined) continue;
    renameSources.set(entry.renameSourcePath, { objectId: entry.indexObjectId, mode: entry.indexMode });
  }
  const visible = entries.filter(entry => {
    const source = renameSources.get(entry.path);
    if (source === undefined) return true;
    return !(entry.indexStatus === 'D'
      && entry.headObjectId === source.objectId
      && entry.headMode === source.mode);
  });
  const sortPath = ({ entry }: { entry: GitStatusEntry }): string => entry.renameSourcePath ?? entry.path;
  const pathOrder = new Map(sortGitPaths({ paths: new Set(visible.map(entry => sortPath({ entry }))) })
    .map((path, index) => [path, index]));
  return visible.map((entry, index) => ({ entry, index }))
    .sort((left, right) => (pathOrder.get(sortPath({ entry: left.entry }))! - pathOrder.get(sortPath({ entry: right.entry }))!)
      || (left.entry.renameSourcePath === undefined ? 1 : 0) - (right.entry.renameSourcePath === undefined ? 1 : 0)
      || left.index - right.index)
    .map(({ entry }) => entry);
}

function statusPathFromCwd({ context, repository, path }: {
  context: WeshCommandContext,
  repository: GitRepository,
  path: string,
}): string {
  if (!repositoryCwdIsInsideWorktree({ context, repository })) return path;
  const cwdRelative = relativeToWorktree({ repository, absolutePath: context.cwd });
  if (cwdRelative.length === 0) return path;
  const from = cwdRelative.split('/');
  const to = path.split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

function renderShortStatus({ context, repository, entries, quoteNonAscii }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entries: readonly GitStatusEntry[],
  quoteNonAscii: boolean,
}): string {
  return visibleStatusEntries({ entries }).map(entry => {
    const path = quoteGitPath({ path: statusPathFromCwd({ context, repository, path: entry.path }), quoteNonAscii, quoteSpaces: true });
    if (entry.worktreeStatus === '?' && entry.indexStatus === ' ') return `?? ${path}\n`;
    if (entry.renameSourcePath !== undefined) {
      const source = quoteGitPath({ path: statusPathFromCwd({ context, repository, path: entry.renameSourcePath }), quoteNonAscii, quoteSpaces: true });
      return `R${entry.worktreeStatus} ${source} -> ${path}\n`;
    }
    return `${entry.indexStatus}${entry.worktreeStatus} ${path}\n`;
  }).join('');
}


function renderPorcelainV1({ entries, nul, quoteNonAscii }: {
  entries: readonly GitStatusEntry[],
  nul: boolean,
  quoteNonAscii: boolean,
}): string {
  const separator = nul ? '\0' : '\n';
  return visibleStatusEntries({ entries }).map(entry => {
    const prefix = entry.renameSourcePath !== undefined
      ? `R${entry.worktreeStatus}`
      : entry.worktreeStatus === '?' && entry.indexStatus === ' '
        ? '??'
        : `${entry.indexStatus}${entry.worktreeStatus}`;
    const path = nul ? entry.path : quoteGitPath({ path: entry.path, quoteNonAscii, quoteSpaces: true });
    if (entry.renameSourcePath !== undefined) {
      if (nul) return `${prefix} ${path}\0${entry.renameSourcePath}\0`;
      const source = quoteGitPath({ path: entry.renameSourcePath, quoteNonAscii, quoteSpaces: true });
      return `${prefix} ${source} -> ${path}\n`;
    }
    return `${prefix} ${path}${separator}`;
  }).join('');
}

function porcelainMode({ mode }: { mode: number | undefined }): string {
  return mode === undefined ? '000000' : mode.toString(8).padStart(6, '0');
}

function porcelainObjectId({ objectId }: { objectId: string | undefined }): string {
  return objectId ?? '0000000000000000000000000000000000000000';
}

function porcelainIndexStatus({ status }: { status: GitStatusEntry['indexStatus'] }): string {
  switch (status) {
  case ' ':
    return '.';
  case 'A':
  case 'M':
  case 'D':
  case 'U':
    return status;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled index status: ${_ex}`);
  }
  }
}

function porcelainWorktreeStatus({ status }: { status: GitStatusEntry['worktreeStatus'] }): string {
  switch (status) {
  case ' ':
    return '.';
  case 'M':
  case 'D':
  case '?':
  case 'U':
    return status;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled worktree status: ${_ex}`);
  }
  }
}

function renderPorcelainV2({ context, repository, entries, nul, quoteNonAscii }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entries: readonly GitStatusEntry[],
  nul: boolean,
  quoteNonAscii: boolean,
}): string {
  const separator = nul ? '\0' : '\n';
  return visibleStatusEntries({ entries }).map(entry => {
    const displayPath = nul ? entry.path : statusPathFromCwd({ context, repository, path: entry.path });
    const path = nul ? displayPath : quoteGitPath({ path: displayPath, quoteNonAscii, quoteSpaces: false });
    if (entry.worktreeStatus === '?' && entry.indexStatus === ' ') return `? ${path}${separator}`;
    if (entry.unmergedEntries !== undefined) {
      const byStage = new Map(entry.unmergedEntries.map(stageEntry => [stageEntry.stage, stageEntry]));
      const base = byStage.get(1);
      const ours = byStage.get(2);
      const theirs = byStage.get(3);
      return `u UU N... ${porcelainMode({ mode: base?.mode })} ${porcelainMode({ mode: ours?.mode })} ${porcelainMode({ mode: theirs?.mode })} ${porcelainMode({ mode: entry.worktreeMode })} ${porcelainObjectId({ objectId: base?.objectId })} ${porcelainObjectId({ objectId: ours?.objectId })} ${porcelainObjectId({ objectId: theirs?.objectId })} ${path}${separator}`;
    }
    if (entry.renameSourcePath !== undefined) {
      const displaySource = nul ? entry.renameSourcePath : statusPathFromCwd({ context, repository, path: entry.renameSourcePath });
      const source = nul ? displaySource : quoteGitPath({ path: displaySource, quoteNonAscii, quoteSpaces: false });
      const pathSeparator = nul ? '\0' : '\t';
      return `2 R${porcelainWorktreeStatus({ status: entry.worktreeStatus })} N... ${porcelainMode({ mode: entry.headMode })} ${porcelainMode({ mode: entry.indexMode })} ${porcelainMode({ mode: entry.worktreeMode })} ${porcelainObjectId({ objectId: entry.headObjectId })} ${porcelainObjectId({ objectId: entry.indexObjectId })} R100 ${path}${pathSeparator}${source}${separator}`;
    }
    return `1 ${porcelainIndexStatus({ status: entry.indexStatus })}${porcelainWorktreeStatus({ status: entry.worktreeStatus })} N... ${porcelainMode({ mode: entry.headMode })} ${porcelainMode({ mode: entry.indexMode })} ${porcelainMode({ mode: entry.worktreeMode })} ${porcelainObjectId({ objectId: entry.headObjectId })} ${porcelainObjectId({ objectId: entry.indexObjectId })} ${path}${separator}`;
  }).join('');
}

export async function runInit({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let quiet = false;
  let bare = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '-q' || arg === '--quiet') quiet = true;
    else if (arg === '--bare') bare = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length > 1) throw new Error('too many arguments');
  const targetPath = normalizePath({ cwd: context.cwd, path: operands[0] ?? '.' });
  const { repository, reinitialized } = bare
    ? await initializeBareRepository({ files: context.files, targetPath })
    : await initializeRepository({ files: context.files, targetPath });
  if (!quiet) {
    await context.text().print({
      text: `${reinitialized ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${repository.gitDirPath}/\n`,
    });
  }
  return { exitCode: 0 };
}

function localCloneDestinationName({ sourcePath }: { sourcePath: string }): string {
  const trimmed = sourcePath.replace(/\/+$/u, '');
  const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1).replace(/\.git$/u, '');
  if (basename.length === 0) throw new Error(`cannot derive destination directory from '${sourcePath}'`);
  return basename;
}

async function assertCloneDestinationAvailable({ context, destinationPath, displayName }: {
  context: WeshCommandContext,
  destinationPath: string,
  displayName: string,
}): Promise<boolean> {
  if (!await pathExists({ files: context.files, path: destinationPath })) return false;
  const stat = await context.files.stat({ path: destinationPath });
  switch (stat.type) {
  case 'directory': {
    for await (const _entry of context.files.readDir({ path: destinationPath })) {
      void _entry;
      throw new Error(`destination path '${displayName}' already exists and is not an empty directory.`);
    }
    return true;
  }
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`destination path '${displayName}' already exists and is not an empty directory.`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled clone destination type: ${_ex}`);
  }
  }
}


async function cleanupCloneDestination({ context, destinationPath, removeRoot }: {
  context: WeshCommandContext,
  destinationPath: string,
  removeRoot: boolean,
}): Promise<void> {
  const removeRecursively = async ({ path }: { path: string }): Promise<void> => {
    if (!await pathExists({ files: context.files, path })) return;
    const stat = await context.files.lstat({ path });
    switch (stat.type) {
    case 'directory':
      for await (const entry of context.files.readDir({ path })) {
        await removeRecursively({ path: entry.fullPath });
      }
      await context.files.rmdir({ path });
      return;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      await context.files.unlink({ path });
      return;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled clone cleanup entry type: ${_ex}`);
    }
    }
  };

  if (removeRoot) {
    await removeRecursively({ path: destinationPath });
    return;
  }
  if (!await pathExists({ files: context.files, path: destinationPath })) return;
  for await (const entry of context.files.readDir({ path: destinationPath })) {
    await removeRecursively({ path: entry.fullPath });
  }
}


export async function runClone({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let quiet = false;
  let branchOption: string | undefined;
  let depthOption: number | undefined;
  const operands: string[] = [];
  let parsingOptions = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-q' || arg === '--quiet')) {
      quiet = true;
      continue;
    }
    if (parsingOptions && (arg === '-b' || arg === '--branch')) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      branchOption = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--branch=')) {
      branchOption = arg.slice('--branch='.length);
      if (branchOption.length === 0) throw new Error("option '--branch' requires a value");
      continue;
    }
    if (parsingOptions && arg === '--depth') {
      const value = args[index + 1];
      if (value === undefined) throw new Error("option '--depth' requires a value");
      if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`depth ${value} is not a positive number`);
      depthOption = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--depth=')) {
      const value = arg.slice('--depth='.length);
      if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`depth ${value} is not a positive number`);
      depthOption = Number.parseInt(value, 10);
      continue;
    }
    if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    operands.push(arg);
  }
  if (operands.length < 1) throw new Error('You must specify a repository to clone.');
  if (operands.length > 2) throw new Error('Too many arguments.');
  const sourceLocation = operands[0]!;
  assertLocalRepositoryLocation({ location: sourceLocation });
  const sourcePath = normalizePath({ cwd: context.cwd, path: sourceLocation });
  const { repository: sourceRepository } = await discoverRepositoryAtPath({ files: context.files, path: sourcePath });
  const sourceHead = await readHead({ files: context.files, repository: sourceRepository });
  const sourceSymbolicBranch = branchNameFromHead({ head: sourceHead });
  const sourceHeads = await listRefs({ files: context.files, repository: sourceRepository, prefix: 'refs/heads' });
  const sourceTags = await listRefs({ files: context.files, repository: sourceRepository, prefix: 'refs/tags' });
  const matchingDetachedHeadRefs = sourceHead.objectId === undefined
    ? []
    : sourceHeads.filter(ref => ref.objectId === sourceHead.objectId);
  const sourceDefaultBranch = sourceSymbolicBranch
    ?? (matchingDetachedHeadRefs.length === 1
      ? matchingDetachedHeadRefs[0]!.refName.slice('refs/heads/'.length)
      : undefined);

  let checkoutBranch = sourceDefaultBranch;
  let checkoutObjectId = sourceHead.objectId;
  if (branchOption !== undefined) {
    const branchRef = sourceHeads.find(ref => ref.refName === `refs/heads/${branchOption}`);
    if (branchRef !== undefined) {
      checkoutBranch = branchOption;
      checkoutObjectId = branchRef.objectId;
    } else {
      const tagRef = sourceTags.find(ref => ref.refName === `refs/tags/${branchOption}`);
      if (tagRef === undefined) throw new Error(`Remote branch ${branchOption} not found in upstream origin`);
      checkoutBranch = undefined;
      checkoutObjectId = await peelToCommitObjectId({
        files: context.files,
        repository: sourceRepository,
        objectId: tagRef.objectId,
      });
    }
  }

  const destinationOperand = operands[1] ?? localCloneDestinationName({ sourcePath });
  const destinationPath = normalizePath({ cwd: context.cwd, path: destinationOperand });
  const destinationExisted = await assertCloneDestinationAvailable({ context, destinationPath, displayName: destinationOperand });
  if (!quiet) await context.text().error({ text: `Cloning into '${destinationOperand}'...\n` });
  if (depthOption !== undefined) {
    await context.text().error({ text: 'warning: --depth is ignored in local clones; use file:// instead.\n' });
  }

  try {
    const { repository: destinationRepository } = await initializeRepository({
      files: context.files,
      targetPath: destinationPath,
    });
    const rootObjectIds = [...sourceHeads, ...sourceTags].map(ref => ref.objectId);
    if (sourceHead.objectId !== undefined) rootObjectIds.push(sourceHead.objectId);
    await transferReachableObjects({
      files: context.files,
      sourceRepository,
      destinationRepository,
      rootObjectIds,
    });

    for (const ref of sourceHeads) {
      const branchName = ref.refName.slice('refs/heads/'.length);
      await writeRef({
        files: context.files,
        repository: destinationRepository,
        refName: `refs/remotes/origin/${branchName}`,
        objectId: ref.objectId,
      });
    }
    for (const ref of sourceTags) {
      await writeRef({ files: context.files, repository: destinationRepository, refName: ref.refName, objectId: ref.objectId });
    }
    if (checkoutBranch !== undefined) {
      if (checkoutObjectId !== undefined) {
        await writeRef({
          files: context.files,
          repository: destinationRepository,
          refName: `refs/heads/${checkoutBranch}`,
          objectId: checkoutObjectId,
        });
      }
      await setHeadSymbolic({ files: context.files, repository: destinationRepository, refName: `refs/heads/${checkoutBranch}` });
    } else if (checkoutObjectId !== undefined) {
      const config = await readEffectiveConfig({ files: context.files, repository: destinationRepository, homePath: context.env.get('HOME') ?? '/', env: context.env });
      await moveHeadReference({
        files: context.files,
        repository: destinationRepository,
        target: { type: 'detached', objectId: checkoutObjectId },
        reflog: {
          identity: resolveGitReflogIdentity({ env: context.env, config }),
          timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
          message: `clone: from ${sourcePath}`,
        },
      });
    }
    if (sourceDefaultBranch !== undefined && sourceHead.objectId !== undefined) {
      await writeSymbolicRef({
        files: context.files,
        repository: destinationRepository,
        refName: 'refs/remotes/origin/HEAD',
        targetRefName: `refs/remotes/origin/${sourceDefaultBranch}`,
      });
    }
    await setLocalConfigValue({ files: context.files, repository: destinationRepository, key: 'remote.origin.url', value: sourcePath });
    await setLocalConfigValue({
      files: context.files,
      repository: destinationRepository,
      key: 'remote.origin.fetch',
      value: '+refs/heads/*:refs/remotes/origin/*',
    });
    if (checkoutBranch !== undefined) {
      await setLocalConfigValue({ files: context.files, repository: destinationRepository, key: `branch.${checkoutBranch}.remote`, value: 'origin' });
      await setLocalConfigValue({
        files: context.files,
        repository: destinationRepository,
        key: `branch.${checkoutBranch}.merge`,
        value: `refs/heads/${checkoutBranch}`,
      });
    }
    if (checkoutObjectId === undefined) {
      await context.text().error({ text: 'warning: You appear to have cloned an empty repository.\n' });
    } else {
      const sourceCommit = await readCommit({ files: context.files, repository: destinationRepository, objectId: checkoutObjectId });
      const targetEntries = await readTreeIntoIndex({
        files: context.files,
        repository: destinationRepository,
        treeObjectId: sourceCommit.treeObjectId,
      });
      await forceReplaceIndexAndWorktree({
        files: context.files,
        repository: destinationRepository,
        currentIndexEntries: [],
        targetEntries,
        contentConfig: await resolveContentConfigForContext({ context, repository: destinationRepository }),
      });
    }
  } catch (error) {
    await cleanupCloneDestination({ context, destinationPath, removeRoot: !destinationExisted });
    throw error;
  }
  if (!quiet) await context.text().error({ text: 'done.\n' });
  return { exitCode: 0 };
}

export async function runFetch({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let quiet = false;
  let all = false;
  let prune = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '-q' || arg === '--quiet') quiet = true;
    else if (arg === '--all') all = true;
    else if (arg === '--prune' || arg === '-p') prune = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length > 1) throw new Error('too many arguments');
  if (all && operands.length > 0) throw new Error('fetch --all does not take a repository argument');
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    env: context.env,
  });
  let remoteNames: string[];
  if (all) {
    const names = new Set<string>();
    for (const key of config.keys()) {
      const match = /^remote\.(.+)\.url$/u.exec(key);
      if (match !== null) names.add(match[1]!);
    }
    remoteNames = sortGitUtf8Strings({ values: names });
  } else {
    remoteNames = [operands[0] ?? 'origin'];
  }

  for (const remoteName of remoteNames) {
    const result = await fetchLocalRemote({ files: context.files, repository, remoteName, prune, config });
    if (quiet) continue;
    const changed = result.branchUpdates.filter(update => update.oldObjectId !== update.newObjectId);
    if (changed.length > 0 || result.prunedBranches.length > 0) await context.text().error({ text: `From ${result.sourcePath}\n` });
    for (const update of changed) {
      if (update.oldObjectId === undefined) {
        await context.text().error({
          text: ` * [new branch]      ${update.branchName} -> ${result.remoteName}/${update.branchName}\n`,
        });
      } else {
        await context.text().error({
          text: `   ${update.oldObjectId.slice(0, 7)}..${update.newObjectId.slice(0, 7)}  ${update.branchName} -> ${result.remoteName}/${update.branchName}\n`,
        });
      }
    }
    for (const deleted of result.prunedBranches) {
      await context.text().error({
        text: ` - [deleted]         (none)     -> ${result.remoteName}/${deleted.branchName}\n`,
      });
    }
  }
  return { exitCode: 0 };
}

export async function runPull({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let ffOnly = false;
  let rebase = false;
  let quiet = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '--ff-only') ffOnly = true;
    else if (arg === '--rebase') rebase = true;
    else if (arg === '--no-rebase') rebase = false;
    else if (arg === '-q' || arg === '--quiet') quiet = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  if (ffOnly && rebase) throw new Error('cannot combine --ff-only and --rebase');
  if (operands.length > 2) throw new Error('too many arguments');
  const repository = await discoverRepositoryFromContext({ context });
  const head = await readHead({ files: context.files, repository });
  const currentBranch = branchNameFromHead({ head });
  if (head.objectId === undefined || currentBranch === undefined) throw new Error('pull currently requires an attached branch with commits');
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const configuredRemote = getConfigValue({ config, key: `branch.${currentBranch}.remote` });
  const configuredMerge = getConfigValue({ config, key: `branch.${currentBranch}.merge` });
  const remoteName = operands[0] ?? configuredRemote ?? 'origin';
  const remoteBranch = operands[1]
    ?? configuredMerge?.replace(/^refs\/heads\//u, '')
    ?? currentBranch;
  const fetchResult = await fetchLocalRemote({ files: context.files, repository, remoteName, config });
  if (!quiet) {
    const changed = fetchResult.branchUpdates.filter(update => update.oldObjectId !== update.newObjectId);
    if (changed.length > 0) await context.text().error({ text: `From ${fetchResult.sourcePath}\n` });
  }
  const targetObjectId = await readRef({
    files: context.files,
    repository,
    refName: `refs/remotes/${remoteName}/${remoteBranch}`,
  });
  if (targetObjectId === undefined) throw new Error(`couldn't find remote ref ${remoteBranch}`);
  if (await isAncestor({ files: context.files, repository, ancestorObjectId: targetObjectId, descendantObjectId: head.objectId })) {
    if (!quiet) await context.text().print({ text: 'Already up to date.\n' });
    return { exitCode: 0 };
  }
  const canFastForward = await isAncestor({
    files: context.files,
    repository,
    ancestorObjectId: head.objectId,
    descendantObjectId: targetObjectId,
  });
  if (!canFastForward) {
    if (ffOnly) {
      await context.text().error({ text: 'fatal: Not possible to fast-forward, aborting.\n' });
      return { exitCode: 128 };
    }
    if (rebase) {
      const preflightFailure = await validateRebaseStartWorktree({ context, repository, headObjectId: head.objectId });
      if (preflightFailure !== undefined) return preflightFailure;
      const bases = await findMergeBases({
        files: context.files,
        repository,
        leftObjectId: head.objectId,
        rightObjectId: targetObjectId,
      });
      if (bases.length !== 1) {
        await context.text().error({ text: `fatal: expected one merge base, found ${bases.length}\n` });
        return { exitCode: 128 };
      }
      return startRebaseSequence({
        context,
        repository,
        headRefName: `refs/heads/${currentBranch}`,
        origHeadObjectId: head.objectId,
        checkoutHeadObjectId: head.objectId,
        ontoObjectId: targetObjectId,
        replayBaseObjectId: targetObjectId,
        ontoDisplay: targetObjectId,
        reflogAction: 'pull --rebase',
      });
    }
    return integrateDivergentMerge({
      context,
      repository,
      headObjectId: head.objectId,
      targetObjectId,
      targetLabel: remoteBranch,
      commitMessage: `Merge branch '${remoteBranch}' of ${fetchResult.sourcePath}`,
      reflogMessage: `pull --no-rebase: Merge made by the 'ort' strategy.`,
    });
  }
  const result = await fastForwardHead({
    files: context.files,
    repository,
    targetObjectId,
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `pull ${remoteName} ${remoteBranch}: Fast-forward`,
    },
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  switch (result.type) {
  case 'checkout-conflict':
    await printCheckoutConflicts({ context, conflicts: result.conflicts });
    return { exitCode: 1 };
  case 'updated':
    if (!quiet) {
      await context.text().print({
        text: `Updating ${result.oldObjectId.slice(0, 7)}..${result.newObjectId.slice(0, 7)}\nFast-forward\n`,
      });
    }
    return { exitCode: 0 };
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled pull fast-forward result: ${String(_ex)}`);
  }
  }
}

export async function runPush({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let setUpstream = false;
  let forceWithLease = false;
  let deleteBranch = false;
  let quiet = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '-u' || arg === '--set-upstream') setUpstream = true;
    else if (arg === '--force-with-lease') forceWithLease = true;
    else if (arg === '--delete') deleteBranch = true;
    else if (arg === '-q' || arg === '--quiet') quiet = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  const repository = await discoverRepositoryFromContext({ context });
  const head = await readHead({ files: context.files, repository });
  const currentBranch = branchNameFromHead({ head });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  // TODO: Real Git's pre-push hook is active only when executable. Correct hook gating needs executable-mode visibility from the filesystem layer.
  const configuredRemote = currentBranch === undefined
    ? undefined
    : getConfigValue({ config, key: `branch.${currentBranch}.remote` });
  const remoteName = operands[0] ?? configuredRemote ?? 'origin';

  if (deleteBranch) {
    if (operands.length !== 2) throw new Error('usage: git push --delete <remote> <branch>');
    const branchName = operands[1]!;
    const result = await deleteLocalRemoteBranch({ files: context.files, repository, remoteName, branchName, config });
    if (!quiet) {
      await context.text().error({ text: `To ${result.remotePath}\n - [deleted]         ${branchName}\n` });
    }
    return { exitCode: 0 };
  }
  if (operands.length > 2) throw new Error('too many arguments');
  if (currentBranch === undefined && operands.length < 2) throw new Error('You are not currently on a branch.');
  const refspec = operands[1] ?? currentBranch!;
  const colonIndex = refspec.indexOf(':');
  const sourceBranch = (colonIndex < 0 ? refspec : refspec.slice(0, colonIndex)).replace(/^refs\/heads\//u, '');
  const destinationBranch = (colonIndex < 0 ? refspec : refspec.slice(colonIndex + 1)).replace(/^refs\/heads\//u, '');
  if (sourceBranch.length === 0 || destinationBranch.length === 0) throw new Error(`invalid refspec '${refspec}'`);
  const result = await pushLocalBranch({
    files: context.files,
    repository,
    remoteName,
    sourceBranch,
    destinationBranch,
    forceWithLease,
    config,
  });
  if (setUpstream) {
    await setLocalConfigValue({ files: context.files, repository, key: `branch.${sourceBranch}.remote`, value: remoteName });
    await setLocalConfigValue({
      files: context.files,
      repository,
      key: `branch.${sourceBranch}.merge`,
      value: `refs/heads/${destinationBranch}`,
    });
    await context.text().print({ text: `branch '${sourceBranch}' set up to track '${remoteName}/${destinationBranch}'.\n` });
  }
  if (!quiet) {
    let updateLine: string;
    if (result.oldObjectId === undefined) {
      updateLine = ` * [new branch]      ${sourceBranch} -> ${destinationBranch}\n`;
    } else if (result.oldObjectId === result.newObjectId) {
      updateLine = ` = [up to date]      ${sourceBranch} -> ${destinationBranch}\n`;
    } else if (result.forced) {
      updateLine = ` + ${result.oldObjectId.slice(0, 7)}...${result.newObjectId.slice(0, 7)} ${sourceBranch} -> ${destinationBranch} (forced update)\n`;
    } else {
      updateLine = `   ${result.oldObjectId.slice(0, 7)}..${result.newObjectId.slice(0, 7)}  ${sourceBranch} -> ${destinationBranch}\n`;
    }
    await context.text().error({ text: `To ${result.remotePath}\n${updateLine}` });
  }
  return { exitCode: 0 };
}

export async function runConfig({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let scope: 'effective' | 'global' | 'local' = 'effective';
  let commandArgs = [...args];
  switch (commandArgs[0]) {
  case '--global':
    scope = 'global';
    commandArgs = commandArgs.slice(1);
    break;
  case '--local':
    scope = 'local';
    commandArgs = commandArgs.slice(1);
    break;
  default:
    break;
  }
  const homePath = context.env.get('HOME') ?? '/';
  const access = await (async () => {
    switch (scope) {
    case 'effective': {
      const repository = await discoverRepositoryFromContext({ context });
      return {
        readEntries: () => readEffectiveConfigEntries({
          files: context.files,
          repository,
          homePath,
          env: context.env,
        }),
        setValue: ({ key, value }: { key: string, value: string }) =>
          setLocalConfigValue({ files: context.files, repository, key, value }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addLocalConfigValue({ files: context.files, repository, key, value }),
        unsetValue: ({ key, all }: { key: string, all: boolean }) =>
          unsetLocalConfigValue({ files: context.files, repository, key, all }),
      };
    }
    case 'global':
      return {
        readEntries: () => readGlobalConfigEntries({ files: context.files, homePath }),
        setValue: ({ key, value }: { key: string, value: string }) =>
          setGlobalConfigValue({ files: context.files, homePath, key, value }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addGlobalConfigValue({ files: context.files, homePath, key, value }),
        unsetValue: ({ key, all }: { key: string, all: boolean }) =>
          unsetGlobalConfigValue({ files: context.files, homePath, key, all }),
      };
    case 'local': {
      const repository = await discoverRepositoryFromContext({ context });
      return {
        readEntries: () => readLocalConfigEntries({ files: context.files, repository }),
        setValue: ({ key, value }: { key: string, value: string }) =>
          setLocalConfigValue({ files: context.files, repository, key, value }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addLocalConfigValue({ files: context.files, repository, key, value }),
        unsetValue: ({ key, all }: { key: string, all: boolean }) =>
          unsetLocalConfigValue({ files: context.files, repository, key, all }),
      };
    }
    default: {
      const _ex: never = scope;
      throw new Error(`Unhandled config scope: ${_ex}`);
    }
    }
  })();

  switch (commandArgs[0]) {
  case '--list': {
    if (commandArgs.length !== 1) throw new Error('wrong number of arguments');
    for (const entry of await access.readEntries()) {
      await context.text().print({ text: `${entry.key}=${entry.value}\n` });
    }
    return { exitCode: 0 };
  }
  case '--get': {
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments, should be from 1 to 2');
    const key = commandArgs[1]!.toLowerCase();
    const values = (await access.readEntries()).filter(entry => entry.key.toLowerCase() === key).map(entry => entry.value);
    if (values.length === 0) return { exitCode: 1 };
    await context.text().print({ text: `${values[values.length - 1]!}\n` });
    return { exitCode: 0 };
  }
  case '--get-all': {
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments, should be from 1 to 2');
    const key = commandArgs[1]!.toLowerCase();
    const values = (await access.readEntries()).filter(entry => entry.key.toLowerCase() === key).map(entry => entry.value);
    if (values.length === 0) return { exitCode: 1 };
    for (const value of values) await context.text().print({ text: `${value}\n` });
    return { exitCode: 0 };
  }
  case '--unset': {
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments');
    const result = await access.unsetValue({ key: commandArgs[1]!, all: false });
    switch (result) {
    case 'missing':
      return { exitCode: 5 };
    case 'multiple':
      await context.text().error({ text: `warning: ${commandArgs[1]} has multiple values\n` });
      return { exitCode: 5 };
    case 'removed':
      return { exitCode: 0 };
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled config unset result: ${_ex}`);
    }
    }
  }
  case '--unset-all': {
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments');
    const result = await access.unsetValue({ key: commandArgs[1]!, all: true });
    switch (result) {
    case 'missing':
      return { exitCode: 5 };
    case 'multiple':
      throw new Error('Unexpected multiple result while unsetting all config values');
    case 'removed':
      return { exitCode: 0 };
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled config unset-all result: ${_ex}`);
    }
    }
  }
  case '--add':
    if (commandArgs.length !== 3) throw new Error('wrong number of arguments');
    await access.addValue({ key: commandArgs[1]!, value: commandArgs[2]! });
    return { exitCode: 0 };
  default:
    break;
  }

  if (commandArgs.length === 1) {
    const entries = await access.readEntries();
    const key = commandArgs[0]!.toLowerCase();
    const values = entries.filter(entry => entry.key.toLowerCase() === key).map(entry => entry.value);
    if (values.length === 0) return { exitCode: 1 };
    await context.text().print({ text: `${values[values.length - 1]!}\n` });
    return { exitCode: 0 };
  }
  if (commandArgs.length === 2) {
    await access.setValue({ key: commandArgs[0]!, value: commandArgs[1]! });
    return { exitCode: 0 };
  }
  throw new Error('wrong number of arguments');
}

export async function runAdd({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  let mode: 'paths' | 'all' | 'update' = 'paths';
  let force = false;
  let parsingOptions = true;
  const operands: string[] = [];
  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-A' || arg === '--all')) {
      mode = 'all';
      continue;
    }
    if (parsingOptions && (arg === '-u' || arg === '--update')) {
      mode = 'update';
      continue;
    }
    if (parsingOptions && (arg === '-f' || arg === '--force')) {
      force = true;
      continue;
    }
    if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    operands.push(arg);
  }

  const currentEntries = await readIndex({ files: context.files, repository });
  const trackedPaths = new Set(currentEntries.map(entry => entry.path));
  let selected: Set<string>;
  switch (mode) {
  case 'all':
    selected = new Set([...await listWorktreeEntries({ files: context.files, repository }), ...trackedPaths]);
    break;
  case 'update':
    selected = new Set(trackedPaths);
    break;
  case 'paths':
    if (operands.length === 0) {
      await context.text().error({ text: 'Nothing specified, nothing added.\n' });
      return { exitCode: 128 };
    }
    selected = await collectPathsForAdd({
      files: context.files,
      repository,
      cwd: context.cwd,
      operands,
    });
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled add mode: ${_ex}`);
  }
  }

  const trackedGitlinks = currentEntries.filter(entry => entry.stage === 0 && entry.mode === 0o160000);
  for (const gitlink of trackedGitlinks) {
    const prefix = `${gitlink.path}/`;
    for (const path of [...selected]) {
      if (path.startsWith(prefix)) selected.delete(path);
    }
    if (!selected.has(gitlink.path)) continue;
    const absolutePath = worktreeAbsolutePath({ repository, path: gitlink.path });
    if (!await pathExists({ files: context.files, path: absolutePath })) continue;
    const stat = await context.files.lstat({ path: absolutePath });
    switch (stat.type) {
    case 'directory':
      if (await pathExists({ files: context.files, path: joinPath({ base: absolutePath, child: '.git' }) })) {
        throw new Error(`initialized gitlink worktree is not supported yet: ${gitlink.path}`);
      }
      selected.delete(gitlink.path);
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      break;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled gitlink worktree type: ${_ex}`);
    }
    }
  }

  if (!force) {
    const ignoreMatcher = await loadIgnoreMatcher({ files: context.files, repository });
    switch (mode) {
    case 'paths': {
      const explicitIgnored: string[] = [];
      for (const operand of operands) {
        const absolutePath = normalizePath({ cwd: context.cwd, path: operand });
        let stat;
        try {
          stat = await context.files.lstat({ path: absolutePath });
        } catch {
          continue;
        }
        const relativePath = relativeToWorktree({ repository, absolutePath });
        if (relativePath.length === 0) continue;
        let isDirectory: boolean;
        switch (stat.type) {
        case 'directory':
          isDirectory = true;
          break;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          isDirectory = false;
          break;
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled add path type: ${_ex}`);
        }
        }
        if (ignoreMatcher.isIgnored({ path: relativePath, isDirectory }) && !trackedPaths.has(relativePath)) {
          explicitIgnored.push(relativePath);
        }
      }
      if (explicitIgnored.length > 0) {
        await context.text().error({ text: 'The following paths are ignored by one of your .gitignore files:\n' });
        for (const path of explicitIgnored) await context.text().error({ text: `${path}\n` });
        await context.text().error({ text: 'hint: Use -f if you really want to add them.\n' });
        await context.text().error({ text: 'hint: Disable this message with "git config advice.addIgnoredFile false"\n' });
        return { exitCode: 1 };
      }
      break;
    }
    case 'all':
    case 'update':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled add mode: ${_ex}`);
    }
    }
    selected = new Set([...selected].filter(path => trackedPaths.has(path)
      || !ignoreMatcher.isIgnored({ path, isDirectory: false })));
  }

  const stagedEntries = await stageWorktreePaths({
    files: context.files,
    repository,
    currentEntries,
    paths: selected,
    trackedOnly: mode === 'update',
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: stagedEntries });
  return { exitCode: 0 };
}

function longStatusPath({ path, quoteNonAscii }: { path: string, quoteNonAscii: boolean }): string {
  return quoteGitPath({ path, quoteNonAscii, quoteSpaces: false });
}

function stagedLongStatusLabel({ status }: { status: GitStatusEntry['indexStatus'] }): string {
  switch (status) {
  case 'A': return 'new file:   ';
  case 'M': return 'modified:   ';
  case 'D': return 'deleted:    ';
  case ' ':
  case 'U': throw new Error(`invalid staged long-status code: ${status}`);
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled staged long-status code: ${_ex}`);
  }
  }
}

function unstagedLongStatusLabel({ status }: { status: GitStatusEntry['worktreeStatus'] }): string {
  switch (status) {
  case 'M': return 'modified:   ';
  case 'D': return 'deleted:    ';
  case ' ':
  case '?':
  case 'U': throw new Error(`invalid unstaged long-status code: ${status}`);
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled unstaged long-status code: ${_ex}`);
  }
  }
}

function unmergedLongStatusLabel({ entry }: { entry: GitStatusEntry }): string {
  const stages = new Set(entry.unmergedEntries?.map(indexEntry => indexEntry.stage) ?? []);
  const has1 = stages.has(1);
  const has2 = stages.has(2);
  const has3 = stages.has(3);
  if (has1 && has2 && has3) return 'both modified:   ';
  if (!has1 && has2 && has3) return 'both added:      ';
  if (has1 && has2 && !has3) return 'deleted by them: ';
  if (has1 && !has2 && has3) return 'deleted by us:   ';
  if (has1 && !has2 && !has3) return 'both deleted:    ';
  if (!has1 && has2 && !has3) return 'added by us:     ';
  if (!has1 && !has2 && has3) return 'added by them:   ';
  throw new Error(`invalid unmerged index stages for ${entry.path}`);
}

async function printLongStatus({ context, status }: {
  context: WeshCommandContext,
  status: Awaited<ReturnType<typeof collectStatus>>,
}): Promise<void> {
  const text = context.text();
  if (status.branchName === undefined) await text.print({ text: 'HEAD detached\n' });
  else await text.print({ text: `On branch ${status.branchName}\n` });

  if (!status.hasCommits) await text.print({ text: '\nNo commits yet\n' });
  else if (status.upstreamName !== undefined) {
    if (status.upstreamObjectId === undefined) {
      await text.print({
        text: `Your branch is based on '${status.upstreamName}', but the upstream is gone.\n`
          + '  (use "git branch --unset-upstream" to fixup)\n\n',
      });
    } else {
      const ahead = status.ahead ?? 0;
      const behind = status.behind ?? 0;
      if (ahead === 0 && behind === 0) {
        await text.print({ text: `Your branch is up to date with '${status.upstreamName}'.\n\n` });
      } else if (ahead > 0 && behind === 0) {
        await text.print({
          text: `Your branch is ahead of '${status.upstreamName}' by ${ahead} commit${ahead === 1 ? '' : 's'}.\n`
            + '  (use "git push" to publish your local commits)\n\n',
        });
      } else if (ahead === 0 && behind > 0) {
        await text.print({
          text: `Your branch is behind '${status.upstreamName}' by ${behind} commit${behind === 1 ? '' : 's'}, and can be fast-forwarded.\n`
            + '  (use "git pull" to update your local branch)\n\n',
        });
      } else {
        await text.print({
          text: `Your branch and '${status.upstreamName}' have diverged,\n`
            + `and have ${ahead} and ${behind} different commits each, respectively.\n`
            + '  (use "git pull" if you want to integrate the remote branch with yours)\n\n',
        });
      }
    }
  }
  if (status.entries.length === 0) {
    await text.print({
      text: status.hasCommits
        ? 'nothing to commit, working tree clean\n'
        : '\nnothing to commit (create/copy files and use "git add" to track)\n',
    });
    return;
  }

  const visibleEntries = visibleStatusEntries({ entries: status.entries });
  const staged = visibleEntries.filter(entry => entry.indexStatus !== ' ' && entry.indexStatus !== 'U');
  const unstaged = visibleEntries.filter(entry => entry.worktreeStatus === 'M' || entry.worktreeStatus === 'D');
  const untracked = visibleEntries.filter(entry => entry.indexStatus === ' ' && entry.worktreeStatus === '?');
  const unmerged = visibleEntries.filter(entry => entry.indexStatus === 'U' || entry.worktreeStatus === 'U');
  const renderPath = ({ path }: { path: string }): string => longStatusPath({
    path: statusPathFromCwd({ context, repository: status.repository, path }),
    quoteNonAscii: status.quoteNonAscii,
  });

  if (unmerged.length > 0) {
    const repository = await discoverRepositoryFromContext({ context });
    if (await readMergeState({ files: context.files, repository }) !== undefined) {
      await text.print({
        text: 'You have unmerged paths.\n'
          + '  (fix conflicts and run "git commit")\n'
          + '  (use "git merge --abort" to abort the merge)\n',
      });
    }
  }

  if (staged.length > 0) {
    await text.print({ text: `\

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
` });
    for (const entry of staged) {
      const path = entry.renameSourcePath !== undefined
        ? `${renderPath({ path: entry.renameSourcePath })} -> ${renderPath({ path: entry.path })}`
        : renderPath({ path: entry.path });
      const label = entry.renameSourcePath !== undefined
        ? 'renamed:    '
        : stagedLongStatusLabel({ status: entry.indexStatus });
      await text.print({ text: `\t${label}${path}\n` });
    }
  }
  if (unmerged.length > 0) {
    await text.print({ text: `\

Unmerged paths:
  (use "git add <file>..." to mark resolution)
` });
    for (const entry of unmerged) {
      await text.print({ text: `\t${unmergedLongStatusLabel({ entry })}${renderPath({ path: entry.path })}\n` });
    }
  }
  if (unstaged.length > 0) {
    await text.print({
      text: '\nChanges not staged for commit:\n'
        + '  (use "git add/rm <file>..." to update what will be committed)\n'
        + '  (use "git restore <file>..." to discard changes in working directory)\n',
    });
    for (const entry of unstaged) {
      await text.print({ text: `\t${unstagedLongStatusLabel({ status: entry.worktreeStatus })}${renderPath({ path: entry.path })}\n` });
    }
  }
  if (untracked.length > 0) {
    await text.print({ text: `\

Untracked files:
  (use "git add <file>..." to include in what will be committed)
` });
    for (const entry of untracked) await text.print({ text: `\t${renderPath({ path: entry.path })}\n` });
  }

  if (staged.length === 0) {
    await text.print({
      text: untracked.length > 0 && unstaged.length === 0 && unmerged.length === 0
        ? '\nnothing added to commit but untracked files present (use "git add" to track)\n'
        : '\nno changes added to commit (use "git add" and/or "git commit -a")\n',
    });
  } else {
    await text.print({ text: '\n' });
  }
}

function formatPorcelainV1Branch({ status }: {
  status: Awaited<ReturnType<typeof collectStatus>>,
}): string {
  if (status.branchName === undefined) return 'HEAD (no branch)';
  const prefix = status.hasCommits ? status.branchName : `No commits yet on ${status.branchName}`;
  if (status.upstreamName === undefined) return prefix;
  let suffix = `${prefix}...${status.upstreamName}`;
  if (status.upstreamObjectId === undefined) return `${suffix} [gone]`;
  const divergence: string[] = [];
  if ((status.ahead ?? 0) > 0) divergence.push(`ahead ${status.ahead}`);
  if ((status.behind ?? 0) > 0) divergence.push(`behind ${status.behind}`);
  if (divergence.length > 0) suffix += ` [${divergence.join(', ')}]`;
  return suffix;
}

export async function runStatus({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let format: 'long' | 'short' | 'porcelain-v1' | 'porcelain-v2' = 'long';
  let branch = false;
  let nul = false;
  for (const arg of args) {
    switch (arg) {
    case '-s':
    case '--short':
      format = 'short';
      break;
    case '--porcelain':
    case '--porcelain=v1':
      format = 'porcelain-v1';
      break;
    case '--porcelain=v2':
      format = 'porcelain-v2';
      break;
    case '-b':
    case '--branch':
      branch = true;
      break;
    case '-z':
      nul = true;
      break;
    default:
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (nul && format === 'long') throw new Error('option -z requires --porcelain or --short');

  const status = await collectStatus({ context });
  const text = context.text();
  const separator = nul ? '\0' : '\n';
  switch (format) {
  case 'short':
  case 'porcelain-v1':
    if (branch) await text.print({ text: `## ${formatPorcelainV1Branch({ status })}${separator}` });
    await text.print({ text: format === 'short' && !nul
      ? renderShortStatus({ context, repository: status.repository, entries: status.entries, quoteNonAscii: status.quoteNonAscii })
      : renderPorcelainV1({ entries: status.entries, nul, quoteNonAscii: status.quoteNonAscii }) });
    return { exitCode: 0 };
  case 'porcelain-v2':
    if (branch) {
      await text.print({ text: `# branch.oid ${status.headObjectId ?? '(initial)'}${separator}` });
      await text.print({ text: `# branch.head ${status.branchName ?? '(detached)'}${separator}` });
      if (status.upstreamName !== undefined) {
        await text.print({ text: `# branch.upstream ${status.upstreamName}${separator}` });
      }
      if (status.ahead !== undefined && status.behind !== undefined) {
        await text.print({ text: `# branch.ab +${status.ahead} -${status.behind}${separator}` });
      }
    }
    await text.print({ text: renderPorcelainV2({ context, repository: status.repository, entries: status.entries, nul, quoteNonAscii: status.quoteNonAscii }) });
    return { exitCode: 0 };
  case 'long':
    break;
  default: {
    const _ex: never = format;
    throw new Error(`Unhandled status format: ${_ex}`);
  }
  }

  await printLongStatus({ context, status });
  return { exitCode: 0 };
}

export async function runRm({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let force = false;
  let cached = false;
  let recursive = false;
  let parsingOptions = true;
  const operands: string[] = [];
  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-f' || arg === '--force')) force = true;
    else if (parsingOptions && arg === '--cached') cached = true;
    else if (parsingOptions && (arg === '-r' || arg === '-rf' || arg === '-fr')) {
      recursive = true;
      if (arg.includes('f')) force = true;
    } else if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length === 0) throw new Error('No pathspec was given. Which files should I remove?');
  const repository = await discoverRepositoryFromContext({ context });
  const currentEntries = await readIndex({ files: context.files, repository });
  const availablePaths = [...new Set(currentEntries.map(entry => entry.path))];
  const selected = selectRepositoryPaths({ repository, cwd: context.cwd, operands, availablePaths });
  const hasPositiveOperand = operands.some(operand => !isExclusionPathspec({ operand }));
  if (!recursive && !hasPositiveOperand && selected.size > 0) {
    throw new Error("not removing '.' recursively without -r");
  }
  const matches = matchRepositoryPaths({ repository, cwd: context.cwd, operands, availablePaths });
  for (const [operand, operandMatches] of matches) {
    if (!recursive && pathspecSelectsDirectory({
      repository,
      cwd: context.cwd,
      operand,
      matchedPaths: operandMatches,
    })) {
      throw new Error(`not removing '${operand}' recursively without -r`);
    }
  }
  const unmergedPaths = new Set(currentEntries.filter(entry => entry.stage !== 0).map(entry => entry.path));
  if (!force) {
    const status = await collectStatus({ context });
    const statusByPath = new Map(status.entries.map(entry => [entry.path, entry]));
    const changed = [...selected].filter(path => {
      if (unmergedPaths.has(path)) return false;
      const entry = statusByPath.get(path);
      if (entry === undefined) return false;
      return cached ? entry.indexStatus !== ' ' : entry.indexStatus !== ' ' || entry.worktreeStatus !== ' ';
    });
    if (changed.length > 0) {
      await context.text().error({ text: 'error: the following files have local modifications:\n' });
      for (const path of sortGitPaths({ paths: changed })) await context.text().error({ text: `    ${path}\n` });
      await context.text().error({ text: '(use --cached to keep the file, or -f to force removal)\n' });
      return { exitCode: 1 };
    }
  }
  await writeIndex({
    files: context.files,
    repository,
    entries: currentEntries.filter(entry => !selected.has(entry.path)),
  });
  if (!cached) await removeWorktreePaths({ files: context.files, repository, paths: selected });
  for (const path of sortGitPaths({ paths: selected })) await context.text().print({ text: `rm '${path}'\n` });
  return { exitCode: 0 };
}

export async function runClean({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let dryRun = false;
  let force = false;
  let directories = false;
  let parsingOptions = true;
  const operands: string[] = [];
  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg === '--dry-run') dryRun = true;
    else if (parsingOptions && arg === '--force') force = true;
    else if (parsingOptions && /^-[nfd]+$/u.test(arg)) {
      for (const option of arg.slice(1)) {
        if (option === 'n') dryRun = true;
        else if (option === 'f') force = true;
        else if (option === 'd') directories = true;
      }
    } else if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  if (!dryRun && !force) {
    await context.text().error({
      text: 'fatal: clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean\n',
    });
    return { exitCode: 128 };
  }
  const repository = await discoverRepositoryFromContext({ context });
  const status = await collectStatus({ context });
  const indexEntries = await readIndex({ files: context.files, repository });
  const trackedPaths = indexEntries.filter(entry => entry.stage === 0).map(entry => entry.path);
  const hasUntrackedDirectoryAncestor = ({ path }: { path: string }): boolean => {
    const segments = path.split('/');
    for (let count = 1; count < segments.length; count += 1) {
      const ancestor = segments.slice(0, count).join('/');
      if (!trackedPaths.some(tracked => tracked.startsWith(`${ancestor}/`))) return true;
    }
    return false;
  };
  const untrackedPaths = status.entries
    .filter(entry => entry.worktreeStatus === '?')
    .map(entry => entry.path);
  let candidates: string[];
  if (operands.length === 0) {
    const cwdRelative = repositoryCwdIsInsideWorktree({ context, repository })
      ? relativeToWorktree({ repository, absolutePath: context.cwd })
      : '';
    const scopedUntrackedPaths = cwdRelative.length === 0
      ? untrackedPaths
      : untrackedPaths.filter(path => path.startsWith(`${cwdRelative}/`));
    candidates = scopedUntrackedPaths.filter(path => directories || !hasUntrackedDirectoryAncestor({ path }));
  } else {
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands,
      availablePaths: untrackedPaths,
    });
    const selected = new Set<string>();
    for (const paths of matches.values()) for (const path of paths) selected.add(path);
    candidates = [...selected];
  }
  candidates = sortGitPaths({ paths: candidates });
  for (const path of candidates) {
    await context.text().print({
      text: `${dryRun ? 'Would remove' : 'Removing'} ${statusPathFromCwd({ context, repository, path })}\n`,
    });
  }
  if (!dryRun) await removeWorktreePaths({ files: context.files, repository, paths: candidates });
  return { exitCode: 0 };
}

export async function runCommit({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let message: string | undefined;
  let messageFile: string | undefined;
  let allowEmpty = false;
  let all = false;
  let amend = false;
  let noEdit = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-m' || arg === '--message') {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      message = message === undefined ? value : `${message}\n\n${value}`;
      index += 1;
    } else if (arg.startsWith('--message=')) {
      const value = arg.slice('--message='.length);
      message = message === undefined ? value : `${message}\n\n${value}`;
    } else if (arg === '-F' || arg === '--file') {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      messageFile = value;
      index += 1;
    } else if (arg.startsWith('--file=')) {
      messageFile = arg.slice('--file='.length);
    } else if (arg === '-a' || arg === '--all') {
      all = true;
    } else if (arg === '--amend') {
      amend = true;
    } else if (arg === '--no-edit') {
      noEdit = true;
    } else if (arg === '--allow-empty') {
      allowEmpty = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (message !== undefined && messageFile !== undefined) throw new Error('options -m and -F cannot be used together');

  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    env: context.env,
  });
  if (getBooleanConfigValue({ config, key: 'commit.gpgsign' }) === true) {
    throw new Error('commit signing is not supported yet');
  }
  // TODO: Real Git ignores non-executable hooks and runs executable hooks. Do not treat hook-file existence alone as activation; correct hook gating needs executable-mode visibility from the filesystem layer.
  if (messageFile !== undefined) {
    message = messageFile === '-'
      ? await readTextFromHandle({ handle: context.stdin })
      : await readFileText({ files: context.files, path: normalizePath({ cwd: context.cwd, path: messageFile }) });
  }

  const head = await readHead({ files: context.files, repository });
  const previousCommit = head.objectId === undefined
    ? undefined
    : await readCommit({ files: context.files, repository, objectId: head.objectId });
  if (amend && previousCommit === undefined) throw new Error('You have nothing to amend.');
  if (message === undefined && amend && noEdit) message = previousCommit!.message;
  if (message === undefined) throw new Error('no commit message specified');

  const authorOverride = amend ? parseCommitAuthor({ value: previousCommit!.author }) : undefined;
  if (authorOverride === undefined) resolveGitIdentity({ env: context.env, config, role: 'AUTHOR' });
  resolveGitIdentity({ env: context.env, config, role: 'COMMITTER' });
  if (authorOverride === undefined) resolveGitTimestamp({ env: context.env, role: 'AUTHOR' });
  resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });

  let indexEntries = await readIndex({ files: context.files, repository });
  if (all) {
    indexEntries = await stageWorktreePaths({
      files: context.files,
      repository,
      currentEntries: indexEntries,
      paths: indexEntries.map(entry => entry.path),
      trackedOnly: true,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    await writeIndex({ files: context.files, repository, entries: indexEntries });
  }

  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: indexEntries });
  if (!amend && previousCommit !== undefined && !allowEmpty && previousCommit.treeObjectId === treeObjectId) {
    await context.text().print({ text: 'nothing to commit, working tree clean\n' });
    return { exitCode: 1 };
  }
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: amend ? previousCommit!.parentObjectIds : head.objectId === undefined ? [] : [head.objectId],
    message,
    authorOverride,
  });
  const reflogPrefix = amend
    ? 'commit (amend)'
    : head.objectId === undefined ? 'commit (initial)' : 'commit';
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: `${reflogPrefix}: ${firstLine({ text: message })}`,
    },
  });
  const objectId = created.objectId;
  const updatedHead = await readHead({ files: context.files, repository });
  const branchName = branchNameFromHead({ head: updatedHead });
  const rootMarker = head.objectId === undefined ? ' (root-commit)' : '';
  await context.text().print({
    text: `[${branchName ?? 'detached HEAD'}${rootMarker} ${objectId.slice(0, 7)}] ${firstLine({ text: message })}\n`,
  });
  return { exitCode: 0 };
}

function parseAuthorForLog({ author }: { author: string }): { identity: string, timestamp: number, timezone: string } {
  const match = /^(.* <[^>]*>) ([0-9]+) ([+-][0-9]{4})$/u.exec(author);
  if (match === null) return { identity: author, timestamp: 0, timezone: '+0000' };
  return { identity: match[1]!, timestamp: Number.parseInt(match[2]!, 10), timezone: match[3]! };
}

function formatLogDate({ timestamp, timezone }: { timestamp: number, timezone: string }): string {
  const sign = timezone.startsWith('-') ? -1 : 1;
  const hours = Number.parseInt(timezone.slice(1, 3), 10);
  const minutes = Number.parseInt(timezone.slice(3, 5), 10);
  const adjusted = new Date((timestamp + sign * (hours * 60 + minutes) * 60) * 1000);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[adjusted.getUTCDay()]} ${months[adjusted.getUTCMonth()]} ${adjusted.getUTCDate()} ${adjusted.getUTCHours().toString().padStart(2, '0')}:${adjusted.getUTCMinutes().toString().padStart(2, '0')}:${adjusted.getUTCSeconds().toString().padStart(2, '0')} ${adjusted.getUTCFullYear()} ${timezone}`;
}


type ResetMode = 'soft' | 'mixed' | 'hard';

function parseResetArguments({ args }: { args: readonly string[] }): {
  mode: ResetMode,
  revisionExpression: string,
  pathOperands: readonly string[] | undefined,
} {
  let mode: ResetMode = 'mixed';
  let revisionExpression = 'HEAD';
  let hasRevision = false;
  let pathOperands: readonly string[] | undefined;
  const separatorIndex = args.indexOf('--');
  const optionAndRevisionArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  if (separatorIndex >= 0) pathOperands = args.slice(separatorIndex + 1);
  for (const arg of optionAndRevisionArgs) {
    if (arg === '--soft') mode = 'soft';
    else if (arg === '--mixed') mode = 'mixed';
    else if (arg === '--hard') mode = 'hard';
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (!hasRevision) {
      revisionExpression = arg;
      hasRevision = true;
    } else {
      throw new Error('too many revisions');
    }
  }
  if (pathOperands !== undefined && mode !== 'mixed') throw new Error(`Cannot do ${mode} reset with paths.`);
  return { mode, revisionExpression, pathOperands };
}


interface RestoreArguments {
  staged: boolean,
  worktree: boolean,
  sourceExpression: string | undefined,
  operands: string[],
}

function parseRestoreArguments({ args }: { args: readonly string[] }): RestoreArguments {
  let staged = false;
  let worktree = false;
  let sourceExpression: string | undefined;
  let parsingOptions = true;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '--staged' || arg === '-S')) {
      staged = true;
      continue;
    }
    if (parsingOptions && (arg === '--worktree' || arg === '-W')) {
      worktree = true;
      continue;
    }
    if (parsingOptions && (arg === '--source' || arg === '-s')) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      sourceExpression = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--source=')) {
      sourceExpression = arg.slice('--source='.length);
      if (sourceExpression.length === 0) throw new Error("option '--source' requires a value");
      continue;
    }
    if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    operands.push(arg);
  }
  if (!staged && !worktree) worktree = true;
  if (operands.length === 0) throw new Error('you must specify path(s) to restore');
  return { staged, worktree, sourceExpression, operands };
}

async function readCommitIndex({ context, repository, revisionExpression }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  revisionExpression: string,
}): Promise<GitIndexEntry[]> {
  const objectId = await resolveCommitRevision({
    files: context.files,
    repository,
    expression: revisionExpression,
  });
  const commit = await readCommit({ files: context.files, repository, objectId });
  return readTreeIntoIndex({ files: context.files, repository, treeObjectId: commit.treeObjectId });
}

export async function runRestore({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const parsed = parseRestoreArguments({ args });
  const currentIndex = await readIndex({ files: context.files, repository });
  for (const entry of currentIndex) {
    if (entry.stage !== 0) throw new Error(`unmerged index entry is not supported yet: ${entry.path}`);
  }
  const sourceEntries = parsed.sourceExpression !== undefined
    ? await readCommitIndex({ context, repository, revisionExpression: parsed.sourceExpression })
    : parsed.staged
      ? await readCommitIndex({ context, repository, revisionExpression: 'HEAD' })
      : currentIndex;
  const sourceByPath = new Map(sourceEntries.map(entry => [entry.path, entry]));
  const currentByPath = new Map(currentIndex.map(entry => [entry.path, entry]));
  const selectedPaths = selectRepositoryPaths({
    repository,
    cwd: context.cwd,
    operands: parsed.operands,
    availablePaths: [...currentByPath.keys(), ...sourceByPath.keys()],
  });
  const selectedCurrentEntries = [...selectedPaths]
    .map(path => currentByPath.get(path))
    .filter((entry): entry is GitIndexEntry => entry !== undefined);
  const selectedSourceEntries = [...selectedPaths]
    .map(path => sourceByPath.get(path))
    .filter((entry): entry is GitIndexEntry => entry !== undefined);

  if (parsed.worktree) {
    await replaceTrackedWorktree({
      files: context.files,
      repository,
      previousEntries: selectedCurrentEntries,
      targetEntries: selectedSourceEntries,
      attributeEntries: sourceEntries,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
  }
  if (parsed.staged) {
    for (const path of selectedPaths) {
      const sourceEntry = sourceByPath.get(path);
      if (sourceEntry === undefined) currentByPath.delete(path);
      else currentByPath.set(path, sourceEntry);
    }
    await writeIndex({ files: context.files, repository, entries: [...currentByPath.values()] });
  }
  return { exitCode: 0 };
}

export async function runReset({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const { mode, revisionExpression, pathOperands } = parseResetArguments({ args });
  if (pathOperands !== undefined) {
    const currentIndex = await readIndex({ files: context.files, repository });
    const sourceEntries = await readCommitIndex({ context, repository, revisionExpression });
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: [...currentIndex.map(entry => entry.path), ...sourceEntries.map(entry => entry.path)],
    });
    const selectedPaths = new Set<string>();
    for (const paths of matches.values()) for (const path of paths) selectedPaths.add(path);
    const sourceByPath = new Map(sourceEntries.map(entry => [entry.path, entry]));
    const nextEntries = currentIndex.filter(entry => !selectedPaths.has(entry.path));
    for (const path of selectedPaths) {
      const sourceEntry = sourceByPath.get(path);
      if (sourceEntry !== undefined) nextEntries.push(sourceEntry);
    }
    await writeIndex({ files: context.files, repository, entries: nextEntries });
    const status = await collectStatus({ context });
    const unstaged = status.entries.filter(entry => entry.worktreeStatus === 'M' || entry.worktreeStatus === 'D');
    if (unstaged.length > 0) {
      await context.text().print({ text: 'Unstaged changes after reset:\n' });
      for (const entry of unstaged) await context.text().print({ text: `${entry.worktreeStatus}\t${entry.path}\n` });
    }
    return { exitCode: 0 };
  }
  const oldHead = await readHead({ files: context.files, repository });
  if (oldHead.objectId === undefined) throw new Error('ambiguous argument HEAD: unknown revision');
  const targetObjectId = await resolveCommitRevision({
    files: context.files,
    repository,
    expression: revisionExpression,
  });
  const targetCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  let previousIndex: GitIndexEntry[];
  let targetIndex: GitIndexEntry[];
  switch (mode) {
  case 'soft':
    previousIndex = [];
    targetIndex = [];
    break;
  case 'mixed':
  case 'hard':
    previousIndex = await readIndex({ files: context.files, repository });
    targetIndex = await readTreeIntoIndex({
      files: context.files,
      repository,
      treeObjectId: targetCommit.treeObjectId,
    });
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled reset mode: ${_ex}`);
  }
  }

  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const identity = resolveGitReflogIdentity({ env: context.env, config });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  await writeOrigHead({ files: context.files, repository, objectId: oldHead.objectId });
  await updateHead({
    files: context.files,
    repository,
    objectId: targetObjectId,
    reflog: {
      identity,
      timestamp,
      message: `reset: moving to ${revisionExpression}`,
    },
  });

  switch (mode) {
  case 'soft':
    return { exitCode: 0 };
  case 'mixed': {
    await writeIndex({ files: context.files, repository, entries: targetIndex });
    const status = await collectStatus({ context });
    const unstaged = status.entries.filter(entry => entry.worktreeStatus === 'M' || entry.worktreeStatus === 'D');
    if (unstaged.length > 0) {
      await context.text().print({ text: 'Unstaged changes after reset:\n' });
      for (const entry of unstaged) {
        await context.text().print({ text: `${entry.worktreeStatus}\t${entry.path}\n` });
      }
    }
    return { exitCode: 0 };
  }
  case 'hard':
    await replaceTrackedWorktree({
      files: context.files,
      repository,
      previousEntries: previousIndex,
      targetEntries: targetIndex,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    await writeIndex({ files: context.files, repository, entries: targetIndex });
    await context.text().print({
      text: `HEAD is now at ${targetObjectId.slice(0, 7)} ${commitSubject({ commit: targetCommit })}\n`,
    });
    return { exitCode: 0 };
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled reset mode: ${_ex}`);
  }
  }
}

async function continueMerge({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readMergeState({ files: context.files, repository });
  if (state === undefined) {
    await context.text().error({ text: 'fatal: There is no merge in progress (MERGE_HEAD missing).\n' });
    return { exitCode: 128 };
  }
  const entries = await readIndex({ files: context.files, repository });
  const unmergedPaths = sortGitPaths({ paths: new Set(entries.filter(entry => entry.stage !== 0).map(entry => entry.path)) });
  if (unmergedPaths.length > 0) {
    for (const path of unmergedPaths) await context.text().print({ text: `U\t${path}\n` });
    await context.text().error({ text: 'error: Committing is not possible because you have unmerged files.\n' });
    await context.text().error({ text: 'fatal: Exiting because of an unresolved conflict.\n' });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error('cannot continue merge on an unborn branch');
  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: [head.objectId, state.mergeHeadObjectId],
    message: state.message,
    authorOverride: undefined,
  });
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: `commit (merge): ${firstLine({ text: state.message })}`,
    },
  });
  await clearMergeState({ files: context.files, repository });
  const updatedHead = await readHead({ files: context.files, repository });
  await context.text().print({
    text: `[${branchNameFromHead({ head: updatedHead }) ?? 'detached HEAD'} ${created.objectId.slice(0, 7)}] ${firstLine({ text: state.message })}\n`,
  });
  return { exitCode: 0 };
}

async function abortMerge({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readMergeState({ files: context.files, repository });
  if (state === undefined) {
    await context.text().error({ text: 'fatal: There is no merge to abort (MERGE_HEAD missing).\n' });
    return { exitCode: 128 };
  }
  const origHeadText = (await readFileText({
    files: context.files,
    path: joinPath({ base: repository.gitDirPath, child: 'ORIG_HEAD' }),
  })).trim();
  if (!/^[0-9a-f]{40}$/u.test(origHeadText)) throw new Error('invalid ORIG_HEAD');
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error('cannot abort merge on an unborn branch');
  const currentEntries = await readIndex({ files: context.files, repository });
  const origCommit = await readCommit({ files: context.files, repository, objectId: origHeadText });
  const origEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: origCommit.treeObjectId });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: currentEntries,
    targetEntries: origEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await clearMergeState({ files: context.files, repository });
  return { exitCode: 0 };
}

async function integrateDivergentMerge({ context, repository, headObjectId, targetObjectId, targetLabel, commitMessage, reflogMessage }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  headObjectId: string,
  targetObjectId: string,
  targetLabel: string,
  commitMessage: string,
  reflogMessage: string,
}): Promise<WeshCommandResult> {
  const status = await collectStatus({ context });
  const dirtyTracked = status.entries.filter(entry => !(entry.indexStatus === ' ' && entry.worktreeStatus === '?'));
  if (dirtyTracked.length > 0) {
    await context.text().error({ text: 'fatal: local tracked changes must be committed or stashed before merge\n' });
    return { exitCode: 1 };
  }
  const bases = await findMergeBases({
    files: context.files,
    repository,
    leftObjectId: headObjectId,
    rightObjectId: targetObjectId,
  });
  if (bases.length !== 1) {
    await context.text().error({ text: `fatal: expected one merge base, found ${bases.length}\n` });
    return { exitCode: 128 };
  }
  const baseCommit = await readCommit({ files: context.files, repository, objectId: bases[0]! });
  const oursCommit = await readCommit({ files: context.files, repository, objectId: headObjectId });
  const theirsCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  const baseEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: baseCommit.treeObjectId });
  const oursEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: oursCommit.treeObjectId });
  const theirsEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: theirsCommit.treeObjectId });
  const merged = mergeThreeTrees({ baseEntries, oursEntries, theirsEntries });
  const autoMerged = await autoMergeTextConflicts({
    files: context.files,
    repository,
    conflicts: merged.conflicts,
  });
  const mergedEntries = [...merged.entries, ...autoMerged.entries];
  const message = commitMessage;
  if (autoMerged.conflicts.length > 0) {
    let preparedConflicts;
    try {
      preparedConflicts = await prepareMergeConflicts({
        files: context.files,
        repository,
        conflicts: autoMerged.conflicts,
        oursLabel: 'HEAD',
        theirsLabel: targetLabel,
        contentConfig: await resolveContentConfigForContext({ context, repository }),
      });
    } catch (error) {
      await context.text().error({ text: `fatal: ${error instanceof Error ? error.message : String(error)}\n` });
      return { exitCode: 1 };
    }
    const currentIndexEntries = await readIndex({ files: context.files, repository });
    const appliedConflict = await applyMergedIndexWithConflicts({
      files: context.files,
      repository,
      currentHeadEntries: oursEntries,
      currentIndexEntries,
      mergedEntries,
      preparedConflicts,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    if (appliedConflict.checkoutConflicts.length > 0) {
      await printCheckoutConflicts({ context, conflicts: appliedConflict.checkoutConflicts });
      return { exitCode: 1 };
    }
    await writeOrigHead({ files: context.files, repository, objectId: headObjectId });
    await writeMergeState({
      files: context.files,
      repository,
      mergeHeadObjectId: targetObjectId,
      message,
      conflictPaths: preparedConflicts.map(conflict => conflict.path),
    });
    for (const conflict of preparedConflicts) {
      for (const text of formatPreparedMergeConflict({ conflict, oursLabel: 'HEAD', theirsLabel: targetLabel })) {
        await context.text().print({ text });
      }
    }
    await context.text().print({ text: 'Automatic merge failed; fix conflicts and then commit the result.\n' });
    return { exitCode: 1 };
  }
  for (const entry of autoMerged.entries) {
    await context.text().print({ text: `Auto-merging ${entry.path}\n` });
  }
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries: oursEntries,
    currentIndexEntries,
    targetEntries: mergedEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) {
    await printCheckoutConflicts({ context, conflicts: plan.conflicts });
    return { exitCode: 1 };
  }
  await writeOrigHead({ files: context.files, repository, objectId: headObjectId });
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: [headObjectId, targetObjectId],
    message,
    authorOverride: undefined,
  });
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: reflogMessage,
    },
  });
  await context.text().print({ text: "Merge made by the 'ort' strategy.\n" });
  return { exitCode: 0 };
}

export async function runMerge({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  if (args.length === 1 && args[0] === '--continue') return continueMerge({ context });
  if (args.length === 1 && args[0] === '--abort') return abortMerge({ context });

  let ffOnly = false;
  let noFf = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '--ff-only') ffOnly = true;
    else if (arg === '--no-ff') noFf = true;
    else if (arg === '--ff') continue;
    else if (arg.startsWith('-')) throw new Error(`unsupported merge option: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length !== 1) throw new Error('git merge requires exactly one revision');

  if (ffOnly && noFf) throw new Error('cannot combine --ff-only and --no-ff');

  const repository = await discoverRepositoryFromContext({ context });
  const existingMergeState = await readMergeState({ files: context.files, repository });
  if (existingMergeState !== undefined) {
    const unmergedPaths = sortGitPaths({ paths: new Set((await readIndex({ files: context.files, repository }))
      .filter(entry => entry.stage !== 0)
      .map(entry => entry.path)) });
    if (unmergedPaths.length > 0) {
      await context.text().error({ text: 'error: Merging is not possible because you have unmerged files.\n' });
      await context.text().error({ text: 'fatal: Exiting because of an unresolved conflict.\n' });
    } else {
      await context.text().error({ text: 'fatal: You have not concluded your merge (MERGE_HEAD exists).\n' });
      await context.text().error({ text: 'Please, commit your changes before you merge.\n' });
    }
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error('cannot merge on an unborn branch');
  const targetExpression = operands[0]!;
  const targetObjectId = await resolveCommitRevision({ files: context.files, repository, expression: targetExpression });
  await readCommit({ files: context.files, repository, objectId: targetObjectId });

  if (await isAncestor({ files: context.files, repository, ancestorObjectId: targetObjectId, descendantObjectId: head.objectId })) {
    await context.text().print({ text: 'Already up to date.\n' });
    return { exitCode: 0 };
  }
  const fastForward = await isAncestor({
    files: context.files,
    repository,
    ancestorObjectId: head.objectId,
    descendantObjectId: targetObjectId,
  });
  if (!fastForward) {
    if (ffOnly) {
      await context.text().error({ text: 'fatal: Not possible to fast-forward, aborting.\n' });
      return { exitCode: 128 };
    }
    return integrateDivergentMerge({
      context,
      repository,
      headObjectId: head.objectId,
      targetObjectId,
      targetLabel: targetExpression,
      commitMessage: `Merge branch '${targetExpression}'`,
      reflogMessage: `merge ${targetExpression}: Merge made by the 'ort' strategy.`,
    });
  }

  if (noFf) {
    return integrateDivergentMerge({
      context,
      repository,
      headObjectId: head.objectId,
      targetObjectId,
      targetLabel: targetExpression,
      commitMessage: `Merge branch '${targetExpression}'`,
      reflogMessage: `merge ${targetExpression}: Merge made by the 'ort' strategy.`,
    });
  }

  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const result = await fastForwardHead({
    files: context.files,
    repository,
    targetObjectId,
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `merge ${targetExpression}: Fast-forward`,
    },
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  switch (result.type) {
  case 'checkout-conflict':
    await printCheckoutConflicts({ context, conflicts: result.conflicts });
    return { exitCode: 1 };
  case 'updated':
    await context.text().print({
      text: `Updating ${result.oldObjectId.slice(0, 7)}..${result.newObjectId.slice(0, 7)}\nFast-forward\n`,
    });
    return { exitCode: 0 };
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled fast-forward result: ${String(_ex)}`);
  }
  }
}

async function createReplayCommit({ context, repository, kind, sourceObjectId, message, reflogPrefix }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  kind: GitReplayKind,
  sourceObjectId: string,
  message: string,
  reflogPrefix: string,
}): Promise<{ objectId: string, subject: string }> {
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error(`cannot ${kind} on an unborn branch`);
  const entries = await readIndex({ files: context.files, repository });
  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries });
  const sourceCommit = await readCommit({ files: context.files, repository, objectId: sourceObjectId });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  let authorOverride;
  switch (kind) {
  case 'cherry-pick':
    authorOverride = parseCommitAuthor({ value: sourceCommit.author });
    break;
  case 'revert':
    authorOverride = undefined;
    break;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled replay kind: ${_ex}`);
  }
  }
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: [head.objectId],
    message,
    authorOverride,
  });
  const subject = firstLine({ text: message });
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: `${reflogPrefix}: ${subject}`,
    },
  });
  return { objectId: created.objectId, subject };
}

type GitReplayStepResult =
  | {
    type: 'committed',
    objectId: string,
    subject: string,
    autoMergedPaths: string[],
  }
  | {
    type: 'conflicted',
    replay: GitPreparedReplay,
    preparedConflicts: GitPreparedMergeConflict[],
  }
  | {
    type: 'checkout-conflict',
    conflicts: GitCheckoutConflict[],
  };

async function applyReplayStep({ context, repository, kind, sourceObjectId, reflogPrefix, mainlineParentNumber }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  kind: GitReplayKind,
  sourceObjectId: string,
  reflogPrefix: string,
  mainlineParentNumber?: number,
}): Promise<GitReplayStepResult> {
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error(`cannot ${kind} on an unborn branch`);
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const replay = await prepareCommitReplay({
    files: context.files,
    repository,
    kind,
    sourceObjectId,
    currentHeadObjectId: head.objectId,
    mainlineParentNumber,
  });
  if (replay.conflicts.length > 0) {
    const preparedConflicts = await prepareMergeConflicts({
      files: context.files,
      repository,
      conflicts: replay.conflicts,
      oursLabel: 'HEAD',
      theirsLabel: replay.theirsLabel,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    const applied = await applyMergedIndexWithConflicts({
      files: context.files,
      repository,
      currentHeadEntries: replay.currentHeadEntries,
      currentIndexEntries,
      mergedEntries: replay.mergedEntries,
      preparedConflicts,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    if (applied.checkoutConflicts.length > 0) {
      return { type: 'checkout-conflict', conflicts: applied.checkoutConflicts };
    }
    return { type: 'conflicted', replay, preparedConflicts };
  }

  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries: replay.currentHeadEntries,
    currentIndexEntries,
    targetEntries: replay.mergedEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) return { type: 'checkout-conflict', conflicts: plan.conflicts };
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const created = await createReplayCommit({
    context,
    repository,
    kind,
    sourceObjectId,
    message: replay.message,
    reflogPrefix,
  });
  return {
    type: 'committed',
    objectId: created.objectId,
    subject: created.subject,
    autoMergedPaths: replay.autoMergedPaths,
  };
}

async function printReplayCommit({ context, objectId, subject }: {
  context: WeshCommandContext,
  objectId: string,
  subject: string,
}): Promise<void> {
  const repository = await discoverRepositoryFromContext({ context });
  const updatedHead = await readHead({ files: context.files, repository });
  await context.text().print({
    text: `[${branchNameFromHead({ head: updatedHead }) ?? 'detached HEAD'} ${objectId.slice(0, 7)}] ${subject}\n`,
  });
}

async function applyReplayObject({ context, repository, kind, sourceObjectId, mainlineParentNumber }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  kind: GitReplayKind,
  sourceObjectId: string,
  mainlineParentNumber?: number,
}): Promise<WeshCommandResult> {
  let result: GitReplayStepResult;
  try {
    result = await applyReplayStep({
      context,
      repository,
      kind,
      sourceObjectId,
      reflogPrefix: kind,
      mainlineParentNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^commit [0-9a-f]{40} (?:is a merge but no -m option was given\.|does not have parent [0-9]+)$/u.test(message)) {
      await context.text().error({ text: `error: ${message}\n` });
      await context.text().error({ text: `fatal: ${kind} failed\n` });
      return { exitCode: 128 };
    }
    await context.text().error({ text: `fatal: ${message}\n` });
    return { exitCode: 1 };
  }

  switch (result.type) {
  case 'checkout-conflict':
    await printCheckoutConflicts({ context, conflicts: result.conflicts });
    return { exitCode: 1 };
  case 'conflicted': {
    await writeReplayState({
      files: context.files,
      repository,
      kind,
      sourceObjectId,
      message: result.replay.message,
      conflictPaths: result.preparedConflicts.map(conflict => conflict.path),
    });
    for (const path of result.replay.autoMergedPaths) await context.text().print({ text: `Auto-merging ${path}\n` });
    for (const conflict of result.preparedConflicts) {
      for (const text of formatPreparedMergeConflict({ conflict, oursLabel: 'HEAD', theirsLabel: result.replay.theirsLabel })) {
        await context.text().print({ text });
      }
    }
    let action: 'apply' | 'revert';
    switch (kind) {
    case 'cherry-pick':
      action = 'apply';
      break;
    case 'revert':
      action = 'revert';
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled replay kind: ${_ex}`);
    }
    }
    await context.text().error({
      text: `error: could not ${action} ${sourceObjectId.slice(0, 7)}... ${commitSubject({ commit: result.replay.sourceCommit })}\n`,
    });
    return { exitCode: 1 };
  }
  case 'committed':
    for (const path of result.autoMergedPaths) await context.text().print({ text: `Auto-merging ${path}\n` });
    await printReplayCommit({ context, objectId: result.objectId, subject: result.subject });
    return { exitCode: 0 };
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled replay result: ${String(_ex)}`);
  }
  }
}

async function runSequencerSteps({ context, repository, kind }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  kind: GitReplayKind,
}): Promise<WeshCommandResult> {
  while (true) {
    const state = await readSequencerState({ files: context.files, repository });
    if (state === undefined) return { exitCode: 0 };
    const step = state.todo[0];
    if (step === undefined) {
      await clearSequencerState({ files: context.files, repository });
      return { exitCode: 0 };
    }
    if (step.kind !== kind) throw new Error(`sequencer kind mismatch: expected ${kind}, found ${step.kind}`);
    const result = await applyReplayObject({
      context,
      repository,
      kind,
      sourceObjectId: step.objectId,
      mainlineParentNumber: state.mainlineParentNumber,
    });
    if (result.exitCode !== 0) return result;
    await advanceSequencer({ files: context.files, repository });
  }
}

async function continueReplay({ context, kind }: {
  context: WeshCommandContext,
  kind: GitReplayKind,
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const sequence = await readSequencerState({ files: context.files, repository });
  const state = await readReplayState({ files: context.files, repository });
  if (state === undefined) {
    if (sequence !== undefined && sequence.todo[0]?.kind === kind) {
      return runSequencerSteps({ context, repository, kind });
    }
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (state.kind !== kind) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (sequence !== undefined) {
    const current = sequence.todo[0];
    if (current === undefined || current.kind !== kind || current.objectId !== state.sourceObjectId) {
      throw new Error('replay state does not match sequencer todo');
    }
  }
  const entries = await readIndex({ files: context.files, repository });
  const unmergedPaths = sortGitPaths({ paths: new Set(entries.filter(entry => entry.stage !== 0).map(entry => entry.path)) });
  if (unmergedPaths.length > 0) {
    for (const path of unmergedPaths) await context.text().print({ text: `U\t${path}\n` });
    await context.text().error({ text: 'error: Committing is not possible because you have unmerged files.\n' });
    await context.text().error({ text: 'fatal: Exiting because of an unresolved conflict.\n' });
    return { exitCode: 128 };
  }
  const created = await createReplayCommit({
    context,
    repository,
    kind,
    sourceObjectId: state.sourceObjectId,
    message: state.message,
    reflogPrefix: kind,
  });
  await clearReplayState({ files: context.files, repository, kind });
  await printReplayCommit({ context, objectId: created.objectId, subject: created.subject });
  if (sequence === undefined) return { exitCode: 0 };
  await advanceSequencer({ files: context.files, repository });
  return runSequencerSteps({ context, repository, kind });
}

async function restoreReplayHead({ context, repository, objectId }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  objectId: string,
}): Promise<void> {
  const targetCommit = await readCommit({ files: context.files, repository, objectId });
  const targetEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: targetCommit.treeObjectId });
  const currentEntries = await readIndex({ files: context.files, repository });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: currentEntries,
    targetEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  await updateHead({
    files: context.files,
    repository,
    objectId,
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `reset: moving to ${objectId}`,
    },
  });
}

async function abortReplay({ context, kind }: {
  context: WeshCommandContext,
  kind: GitReplayKind,
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const sequence = await readSequencerState({ files: context.files, repository });
  const state = await readReplayState({ files: context.files, repository });
  if (state !== undefined && state.kind !== kind) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (state === undefined && sequence === undefined) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (sequence !== undefined) {
    if (sequence.todo.some(entry => entry.kind !== kind)) throw new Error('mixed sequencer kinds are not supported');
    await restoreReplayHead({ context, repository, objectId: sequence.headObjectId });
  } else {
    const head = await readHead({ files: context.files, repository });
    if (head.objectId === undefined) throw new Error(`cannot abort ${kind} on an unborn branch`);
    const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
    const headEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: headCommit.treeObjectId });
    const currentEntries = await readIndex({ files: context.files, repository });
    await forceReplaceIndexAndWorktree({
      files: context.files,
      repository,
      currentIndexEntries: currentEntries,
      targetEntries: headEntries,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
  }
  if (state !== undefined) await clearReplayState({ files: context.files, repository, kind });
  if (sequence !== undefined) await clearSequencerState({ files: context.files, repository });
  return { exitCode: 0 };
}

async function skipReplay({ context, kind }: {
  context: WeshCommandContext,
  kind: GitReplayKind,
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const sequence = await readSequencerState({ files: context.files, repository });
  const state = await readReplayState({ files: context.files, repository });
  if (sequence === undefined) return abortReplay({ context, kind });
  const current = sequence.todo[0];
  if (current === undefined || current.kind !== kind) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error(`cannot skip ${kind} on an unborn branch`);
  const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  const headEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: headCommit.treeObjectId });
  const currentEntries = await readIndex({ files: context.files, repository });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: currentEntries,
    targetEntries: headEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (state !== undefined) await clearReplayState({ files: context.files, repository, kind });
  await advanceSequencer({ files: context.files, repository });
  return runSequencerSteps({ context, repository, kind });
}

async function runReplay({ context, args, kind }: {
  context: WeshCommandContext,
  args: readonly string[],
  kind: GitReplayKind,
}): Promise<WeshCommandResult> {
  if (args.length === 1 && args[0] === '--continue') return continueReplay({ context, kind });
  if (args.length === 1 && args[0] === '--abort') return abortReplay({ context, kind });
  if (args.length === 1 && args[0] === '--skip') return skipReplay({ context, kind });

  const operands: string[] = [];
  let mainlineParentNumber: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--no-edit') continue;
    if (arg === '-m' || arg === '--mainline') {
      const value = args[index + 1];
      if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`option '${arg}' requires a positive parent number`);
      mainlineParentNumber = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (/^-m[1-9][0-9]*$/u.test(arg)) {
      mainlineParentNumber = Number.parseInt(arg.slice(2), 10);
      continue;
    }
    if (arg.startsWith('--mainline=')) {
      const value = arg.slice('--mainline='.length);
      if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("option '--mainline' requires a positive parent number");
      mainlineParentNumber = Number.parseInt(value, 10);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unsupported ${kind} option: ${arg}`);
    operands.push(arg);
  }
  if (operands.length === 0) throw new Error(`${kind} requires at least one commit`);

  const repository = await discoverRepositoryFromContext({ context });
  if (await readMergeState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: 'fatal: cannot replay commits while a merge is in progress\n' });
    return { exitCode: 128 };
  }
  if (await readReplayState({ files: context.files, repository }) !== undefined || await readSequencerState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: `fatal: a ${kind} or revert is already in progress\n` });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error(`cannot ${kind} on an unborn branch`);
  const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  let currentIndexTreeObjectId: string;
  try {
    currentIndexTreeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: currentIndexEntries });
  } catch {
    await context.text().error({ text: `fatal: ${kind} requires a resolved index\n` });
    return { exitCode: 128 };
  }
  if (currentIndexTreeObjectId !== headCommit.treeObjectId) {
    await context.text().error({ text: `fatal: ${kind} requires the index to match HEAD\n` });
    return { exitCode: 128 };
  }

  const todo = [];
  for (const operand of operands) {
    const objectId = await resolveCommitRevision({ files: context.files, repository, expression: operand });
    const commit = await readCommit({ files: context.files, repository, objectId });
    todo.push({ kind, objectId, subject: commitSubject({ commit }) });
  }
  if (todo.length === 1) {
    return applyReplayObject({
      context,
      repository,
      kind,
      sourceObjectId: todo[0]!.objectId,
      mainlineParentNumber,
    });
  }
  await writeSequencerState({
    files: context.files,
    repository,
    headObjectId: head.objectId,
    todo,
    mainlineParentNumber,
  });
  return runSequencerSteps({ context, repository, kind });
}

export async function runCherryPick({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  return runReplay({ context, args, kind: 'cherry-pick' });
}

export async function runRevert({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  return runReplay({ context, args, kind: 'revert' });
}

async function finishRebase({ context, repository, reflogAction }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  reflogAction: string,
}): Promise<WeshCommandResult> {
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined) throw new Error('no rebase in progress');
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error('rebase HEAD is unborn');
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const identity = resolveGitReflogIdentity({ env: context.env, config });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  await updateRef({
    files: context.files,
    repository,
    refName: state.headRefName,
    objectId: head.objectId,
    reflog: {
      identity,
      timestamp,
      message: `${reflogAction} (finish): ${state.headRefName} onto ${state.ontoObjectId}`,
    },
  });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'symbolic', refName: state.headRefName, objectId: head.objectId },
    reflog: {
      identity,
      timestamp,
      message: `${reflogAction} (finish): returning to ${state.headRefName}`,
    },
  });
  await clearRebaseState({ files: context.files, repository });
  await context.text().error({ text: `Successfully rebased and updated ${state.headRefName}.\n` });
  return { exitCode: 0 };
}

async function runRemainingRebaseSteps({ context, repository, reflogAction }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  reflogAction: string,
}): Promise<WeshCommandResult> {
  while (true) {
    const step = await beginRebaseStep({ files: context.files, repository });
    if (step === undefined) return finishRebase({ context, repository, reflogAction });
    let result: GitReplayStepResult;
    try {
      result = await applyReplayStep({
        context,
        repository,
        kind: 'cherry-pick',
        sourceObjectId: step.objectId,
        reflogPrefix: `${reflogAction} (pick)`,
      });
    } catch (error) {
      await context.text().error({ text: `fatal: ${error instanceof Error ? error.message : String(error)}\n` });
      return { exitCode: 1 };
    }
    switch (result.type) {
    case 'checkout-conflict':
      await printCheckoutConflicts({ context, conflicts: result.conflicts });
      return { exitCode: 1 };
    case 'conflicted':
      await writeRebaseStoppedState({
        files: context.files,
        repository,
        sourceObjectId: step.objectId,
        message: result.replay.message,
        conflictPaths: result.preparedConflicts.map(conflict => conflict.path),
      });
      for (const path of result.replay.autoMergedPaths) await context.text().print({ text: `Auto-merging ${path}\n` });
      for (const conflict of result.preparedConflicts) {
        for (const text of formatPreparedMergeConflict({ conflict, oursLabel: 'HEAD', theirsLabel: result.replay.theirsLabel })) {
          await context.text().print({ text });
        }
      }
      await context.text().error({
        text: `error: could not apply ${step.objectId.slice(0, 7)}... ${step.subject}\n`,
      });
      await context.text().error({
        text: `Could not apply ${step.objectId.slice(0, 7)}... ${step.subject}\n`,
      });
      return { exitCode: 1 };
    case 'committed':
      continue;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled rebase replay result: ${String(_ex)}`);
    }
    }
  }
}

async function continueRebase({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined || state.stoppedObjectId === undefined || state.message === undefined) {
    await context.text().error({ text: 'fatal: No rebase in progress?\n' });
    return { exitCode: 128 };
  }
  const entries = await readIndex({ files: context.files, repository });
  const unmergedPaths = sortGitPaths({ paths: new Set(entries.filter(entry => entry.stage !== 0).map(entry => entry.path)) });
  if (unmergedPaths.length > 0) {
    await context.text().error({ text: `\
You must edit all merge conflicts and then
mark them as resolved using git add
` });
    return { exitCode: 1 };
  }
  const created = await createReplayCommit({
    context,
    repository,
    kind: 'cherry-pick',
    sourceObjectId: state.stoppedObjectId,
    message: state.message,
    reflogPrefix: 'rebase (continue)',
  });
  await clearRebaseStoppedState({ files: context.files, repository });
  await context.text().print({ text: `[detached HEAD ${created.objectId.slice(0, 7)}] ${created.subject}\n` });
  return runRemainingRebaseSteps({ context, repository, reflogAction: 'rebase' });
}

async function skipRebase({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined || state.stoppedObjectId === undefined) {
    await context.text().error({ text: 'fatal: No rebase in progress?\n' });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) throw new Error('rebase HEAD is unborn');
  const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  const headEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: headCommit.treeObjectId });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: await readIndex({ files: context.files, repository }),
    targetEntries: headEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await clearRebaseStoppedState({ files: context.files, repository });
  return runRemainingRebaseSteps({ context, repository, reflogAction: 'rebase' });
}

async function abortRebase({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined) {
    await context.text().error({ text: 'fatal: No rebase in progress?\n' });
    return { exitCode: 128 };
  }
  const origCommit = await readCommit({ files: context.files, repository, objectId: state.origHeadObjectId });
  const origEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: origCommit.treeObjectId });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: await readIndex({ files: context.files, repository }),
    targetEntries: origEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'symbolic', refName: state.headRefName, objectId: state.origHeadObjectId },
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `rebase (abort): returning to ${state.headRefName}`,
    },
  });
  await clearRebaseState({ files: context.files, repository });
  return { exitCode: 0 };
}

async function validateRebaseStartWorktree({ context, repository, headObjectId }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  headObjectId: string,
}): Promise<WeshCommandResult | undefined> {
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const headCommit = await readCommit({ files: context.files, repository, objectId: headObjectId });
  const currentIndexTreeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: currentIndexEntries });
  if (currentIndexTreeObjectId !== headCommit.treeObjectId) {
    await context.text().error({ text: 'error: cannot rebase: Your index contains uncommitted changes.\n' });
    return { exitCode: 1 };
  }
  const status = await collectStatus({ context });
  const dirtyTracked = status.entries.filter(entry => entry.worktreeStatus !== ' ' && entry.worktreeStatus !== '?');
  if (dirtyTracked.length > 0) {
    await context.text().error({ text: 'error: cannot rebase: You have unstaged changes.\n' });
    return { exitCode: 1 };
  }
  return undefined;
}

async function checkoutRebaseTargetBranch({ context, repository, currentHeadObjectId, targetRefName, targetObjectId, branchDisplay }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  currentHeadObjectId: string,
  targetRefName: string,
  targetObjectId: string,
  branchDisplay: string,
}): Promise<WeshCommandResult | undefined> {
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const currentCommit = await readCommit({ files: context.files, repository, objectId: currentHeadObjectId });
  const targetCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  const currentHeadEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: currentCommit.treeObjectId });
  const targetEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: targetCommit.treeObjectId });
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) {
    await printCheckoutConflicts({ context, conflicts: plan.conflicts });
    return { exitCode: 1 };
  }
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'symbolic', refName: targetRefName, objectId: targetObjectId },
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `rebase: checkout ${branchDisplay}`,
    },
  });
  return undefined;
}

async function startRebaseSequence({ context, repository, headRefName, origHeadObjectId, checkoutHeadObjectId, ontoObjectId, replayBaseObjectId, ontoDisplay, reflogAction }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  headRefName: string,
  origHeadObjectId: string,
  checkoutHeadObjectId: string,
  ontoObjectId: string,
  replayBaseObjectId: string,
  ontoDisplay: string,
  reflogAction: string,
}): Promise<WeshCommandResult> {
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const replayObjectIds = await collectRebaseCommits({
    files: context.files,
    repository,
    upstreamObjectId: replayBaseObjectId,
    descendantObjectId: origHeadObjectId,
  });
  const todo = [];
  for (const objectId of replayObjectIds) {
    const commit = await readCommit({ files: context.files, repository, objectId });
    todo.push({ objectId, subject: commitSubject({ commit }) });
  }
  const ontoCommit = await readCommit({ files: context.files, repository, objectId: ontoObjectId });
  const ontoEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: ontoCommit.treeObjectId });
  const checkoutHeadCommit = await readCommit({ files: context.files, repository, objectId: checkoutHeadObjectId });
  const currentHeadEntries = await readTreeIntoIndex({
    files: context.files,
    repository,
    treeObjectId: checkoutHeadCommit.treeObjectId,
  });
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries: ontoEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) {
    await printCheckoutConflicts({ context, conflicts: plan.conflicts });
    return { exitCode: 1 };
  }
  await writeRebaseState({
    files: context.files,
    repository,
    headRefName,
    origHeadObjectId,
    ontoObjectId,
    todo,
  });
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'detached', objectId: ontoObjectId },
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `${reflogAction} (start): checkout ${ontoDisplay}`,
    },
  });
  return runRemainingRebaseSteps({ context, repository, reflogAction });
}

export async function runRebase({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  if (args.length === 1 && args[0] === '--continue') return continueRebase({ context });
  if (args.length === 1 && args[0] === '--abort') return abortRebase({ context });
  if (args.length === 1 && args[0] === '--skip') return skipRebase({ context });

  let upstreamExpression: string;
  let ontoExpression: string;
  let branchExpression: string | undefined;
  let explicitOnto = false;
  if (args[0] === '--onto') {
    if (args.length !== 3 && args.length !== 4) {
      throw new Error('git rebase --onto requires <newbase> <upstream> [<branch>]');
    }
    ontoExpression = args[1]!;
    upstreamExpression = args[2]!;
    branchExpression = args[3];
    explicitOnto = true;
  } else {
    if ((args.length !== 1 && args.length !== 2) || args[0]!.startsWith('-')) {
      throw new Error('git rebase requires <upstream> [<branch>]');
    }
    upstreamExpression = args[0]!;
    ontoExpression = upstreamExpression;
    branchExpression = args[1];
  }

  const repository = await discoverRepositoryFromContext({ context });
  if (await readRebaseState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: 'fatal: It seems that there is already a rebase-merge directory\n' });
    return { exitCode: 128 };
  }
  if (await readMergeState({ files: context.files, repository }) !== undefined
    || await readReplayState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: 'fatal: cannot rebase while another Git operation is in progress\n' });
    return { exitCode: 128 };
  }
  const currentHead = await readHead({ files: context.files, repository });
  if (currentHead.objectId === undefined) throw new Error('rebase requires HEAD to reference a commit');
  const preflightFailure = await validateRebaseStartWorktree({ context, repository, headObjectId: currentHead.objectId });
  if (preflightFailure !== undefined) return preflightFailure;

  let headRefName: string;
  let origHeadObjectId: string;
  let branchDisplay: string;
  if (branchExpression === undefined) {
    if (currentHead.symbolicRef === undefined || !currentHead.symbolicRef.startsWith('refs/heads/')) {
      throw new Error('rebase requires an attached branch unless a branch operand is specified');
    }
    headRefName = currentHead.symbolicRef;
    origHeadObjectId = currentHead.objectId;
    branchDisplay = branchNameFromHead({ head: currentHead }) ?? 'HEAD';
  } else {
    headRefName = branchExpression.startsWith('refs/heads/') ? branchExpression : `refs/heads/${branchExpression}`;
    const branchObjectId = await readRef({ files: context.files, repository, refName: headRefName });
    if (branchObjectId === undefined) throw new Error(`invalid branch: ${branchExpression}`);
    await readCommit({ files: context.files, repository, objectId: branchObjectId });
    origHeadObjectId = branchObjectId;
    branchDisplay = headRefName.slice('refs/heads/'.length);
  }

  const upstreamObjectId = await resolveCommitRevision({ files: context.files, repository, expression: upstreamExpression });
  await readCommit({ files: context.files, repository, objectId: upstreamObjectId });
  const ontoObjectId = await resolveCommitRevision({ files: context.files, repository, expression: ontoExpression });
  await readCommit({ files: context.files, repository, objectId: ontoObjectId });

  if (!explicitOnto && await isAncestor({
    files: context.files,
    repository,
    ancestorObjectId: upstreamObjectId,
    descendantObjectId: origHeadObjectId,
  })) {
    if (currentHead.symbolicRef !== headRefName || currentHead.objectId !== origHeadObjectId) {
      const checkoutFailure = await checkoutRebaseTargetBranch({
        context,
        repository,
        currentHeadObjectId: currentHead.objectId,
        targetRefName: headRefName,
        targetObjectId: origHeadObjectId,
        branchDisplay,
      });
      if (checkoutFailure !== undefined) return checkoutFailure;
    }
    await context.text().print({ text: `Current branch ${branchDisplay} is up to date.\n` });
    return { exitCode: 0 };
  }

  let replayBaseObjectId: string;
  if (explicitOnto) {
    replayBaseObjectId = upstreamObjectId;
  } else {
    const bases = await findMergeBases({
      files: context.files,
      repository,
      leftObjectId: origHeadObjectId,
      rightObjectId: upstreamObjectId,
    });
    if (bases.length !== 1) throw new Error(`rebase expected one merge base, found ${bases.length}`);
    replayBaseObjectId = upstreamObjectId;
  }
  return startRebaseSequence({
    context,
    repository,
    headRefName,
    origHeadObjectId,
    checkoutHeadObjectId: currentHead.objectId,
    ontoObjectId,
    replayBaseObjectId,
    ontoDisplay: ontoExpression,
    reflogAction: 'rebase',
  });
}

type GitLogDecorationMode = 'none' | 'short' | 'full';

function logDecorationRefName({ refName, mode }: {
  refName: string,
  mode: Exclude<GitLogDecorationMode, 'none'>,
}): string {
  switch (mode) {
  case 'full':
    return refName;
  case 'short':
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled log decoration mode: ${_ex}`);
  }
  }
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (refName.startsWith(prefix)) return refName.slice(prefix.length);
  }
  return refName;
}

async function collectLogDecorations({ context, repository, mode }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  mode: Exclude<GitLogDecorationMode, 'none'>,
}): Promise<Map<string, string>> {
  const labelsByObjectId = new Map<string, string[]>();
  const add = ({ objectId, label }: { objectId: string, label: string }) => {
    const labels = labelsByObjectId.get(objectId) ?? [];
    labels.push(label);
    labelsByObjectId.set(objectId, labels);
  };

  const head = await readHead({ files: context.files, repository });
  if (head.objectId !== undefined) {
    add({
      objectId: head.objectId,
      label: head.symbolicRef === undefined
        ? 'HEAD'
        : `HEAD -> ${logDecorationRefName({ refName: head.symbolicRef, mode })}`,
    });
  }

  const tags = await listRefs({ files: context.files, repository, prefix: 'refs/tags' });
  for (const ref of [...tags].reverse()) {
    let objectId: string;
    try {
      objectId = await peelToCommitObjectId({ files: context.files, repository, objectId: ref.objectId });
    } catch {
      continue;
    }
    add({
      objectId,
      label: `tag: ${logDecorationRefName({ refName: ref.refName, mode })}`,
    });
  }

  const remoteRefs = await listRefs({ files: context.files, repository, prefix: 'refs/remotes' });
  for (const ref of [...remoteRefs].reverse()) {
    add({ objectId: ref.objectId, label: logDecorationRefName({ refName: ref.refName, mode }) });
  }

  const localRefs = await listRefs({ files: context.files, repository, prefix: 'refs/heads' });
  for (const ref of [...localRefs].reverse()) {
    if (ref.refName === head.symbolicRef) continue;
    add({ objectId: ref.objectId, label: logDecorationRefName({ refName: ref.refName, mode }) });
  }

  return new Map([...labelsByObjectId].map(([objectId, labels]) => [objectId, ` (${labels.join(', ')})`]));
}

function parseLogDateBoundary({ value }: { value: string }): number {
  if (/^@-?[0-9]+$/u.test(value)) return Number.parseInt(value.slice(1), 10);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid date format: ${value}`);
  return Math.floor(milliseconds / 1000);
}

export async function runLog({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let format: string | undefined;
  let oneline = false;
  let decorationMode: GitLogDecorationMode = 'none';
  let graph = false;
  let maxCount = Number.POSITIVE_INFINITY;
  let allRefs = false;
  let showStat = false;
  let showPatch = false;
  let sinceTimestamp: number | undefined;
  let untilTimestamp: number | undefined;
  let grepPattern: RegExp | undefined;
  let pickaxeString: string | undefined;
  let pickaxeRegex: RegExp | undefined;
  let parsingOptions = true;
  let readingPaths = false;
  const revisionTerms: string[] = [];
  const pathOperands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      readingPaths = true;
      continue;
    }
    if (readingPaths) {
      pathOperands.push(arg);
      continue;
    }
    if (parsingOptions && arg === '--oneline') {
      format = '%h %s';
      oneline = true;
    } else if (parsingOptions && arg === '--graph') {
      graph = true;
    } else if (parsingOptions && arg === '--decorate') {
      decorationMode = 'short';
    } else if (parsingOptions && arg === '--decorate=short') {
      decorationMode = 'short';
    } else if (parsingOptions && arg === '--decorate=full') {
      decorationMode = 'full';
    } else if (parsingOptions && arg === '--no-decorate') {
      decorationMode = 'none';
    } else if (parsingOptions && arg === '--all') {
      allRefs = true;
    } else if (parsingOptions && arg === '--stat') {
      showStat = true;
    } else if (parsingOptions && (arg === '-p' || arg === '--patch')) {
      showPatch = true;
    } else if (parsingOptions && arg === '--no-color') {
      // Output is uncolored by Wesh Git.
    } else if (parsingOptions && (arg === '-n' || arg === '--max-count')) {
      const value = args[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) throw new Error(`option '${arg}' requires a numeric value`);
      maxCount = Number.parseInt(value, 10);
      index += 1;
    } else if (parsingOptions && /^-[0-9]+$/u.test(arg)) {
      maxCount = Number.parseInt(arg.slice(1), 10);
    } else if (parsingOptions && arg.startsWith('--max-count=')) {
      const value = arg.slice('--max-count='.length);
      if (!/^[0-9]+$/u.test(value)) throw new Error(`invalid max-count: ${value}`);
      maxCount = Number.parseInt(value, 10);
    } else if (parsingOptions && (arg === '--format' || arg === '--pretty')) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      format = value.startsWith('format:') ? value.slice('format:'.length) : value;
      oneline = false;
      index += 1;
    } else if (parsingOptions && (arg.startsWith('--format=') || arg.startsWith('--pretty='))) {
      const value = arg.slice(arg.indexOf('=') + 1);
      if (value === 'oneline') {
        format = '%H %s';
        oneline = true;
      } else {
        format = value.startsWith('format:') ? value.slice('format:'.length) : value;
        oneline = false;
      }
    } else if (parsingOptions && (arg === '--since' || arg === '--after' || arg === '--until' || arg === '--before')) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      const timestamp = parseLogDateBoundary({ value });
      if (arg === '--since' || arg === '--after') sinceTimestamp = timestamp;
      else untilTimestamp = timestamp;
      index += 1;
    } else if (parsingOptions && (arg.startsWith('--since=') || arg.startsWith('--after='))) {
      sinceTimestamp = parseLogDateBoundary({ value: arg.slice(arg.indexOf('=') + 1) });
    } else if (parsingOptions && (arg.startsWith('--until=') || arg.startsWith('--before='))) {
      untilTimestamp = parseLogDateBoundary({ value: arg.slice(arg.indexOf('=') + 1) });
    } else if (parsingOptions && arg === '-S') {
      const value = args[index + 1];
      if (value === undefined) throw new Error("option '-S' requires a value");
      pickaxeString = value;
      index += 1;
    } else if (parsingOptions && arg.startsWith('-S')) {
      pickaxeString = arg.slice(2);
    } else if (parsingOptions && arg === '-G') {
      const value = args[index + 1];
      if (value === undefined) throw new Error("option '-G' requires a value");
      pickaxeRegex = new RegExp(value, 'u');
      index += 1;
    } else if (parsingOptions && arg.startsWith('-G')) {
      pickaxeRegex = new RegExp(arg.slice(2), 'u');
    } else if (parsingOptions && (arg === '--grep')) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      grepPattern = new RegExp(value, 'u');
      index += 1;
    } else if (parsingOptions && arg.startsWith('--grep=')) {
      grepPattern = new RegExp(arg.slice('--grep='.length), 'u');
    } else if (parsingOptions && arg.startsWith('-')) {
      throw new Error(`unsupported log argument: ${arg}`);
    } else {
      revisionTerms.push(arg);
    }
  }
  if (graph && (showStat || showPatch || pathOperands.length > 0 || sinceTimestamp !== undefined
    || untilTimestamp !== undefined || grepPattern !== undefined || pickaxeString !== undefined
    || pickaxeRegex !== undefined)) {
    throw new Error('log --graph does not support diff or history filtering options yet');
  }
  const repository = await discoverRepositoryFromContext({ context });
  const logConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const logQuoteNonAscii = quoteNonAsciiFromConfig({ config: logConfig });
  const includeExpressions: string[] = [];
  const excludeExpressions: string[] = [];
  const symmetricRanges: Array<{ left: string, right: string }> = [];
  for (const term of revisionTerms) {
    const symmetricIndex = term.indexOf('...');
    if (symmetricIndex >= 0) {
      symmetricRanges.push({
        left: term.slice(0, symmetricIndex) || 'HEAD',
        right: term.slice(symmetricIndex + 3) || 'HEAD',
      });
      continue;
    }
    const rangeIndex = term.indexOf('..');
    if (rangeIndex >= 0) {
      const left = term.slice(0, rangeIndex) || 'HEAD';
      const right = term.slice(rangeIndex + 2) || 'HEAD';
      excludeExpressions.push(left);
      includeExpressions.push(right);
    } else if (term.startsWith('^')) {
      if (term.length === 1) throw new Error('empty excluded revision');
      excludeExpressions.push(term.slice(1));
    } else {
      includeExpressions.push(term);
    }
  }

  const includeObjectIds: string[] = [];
  const excludeObjectIds: string[] = [];
  if (allRefs) {
    for (const prefix of ['refs/heads', 'refs/remotes', 'refs/tags']) {
      for (const ref of await listRefs({ files: context.files, repository, prefix })) includeObjectIds.push(ref.objectId);
    }
  }
  for (const expression of includeExpressions) {
    includeObjectIds.push(await resolveCommitRevision({ files: context.files, repository, expression }));
  }
  for (const range of symmetricRanges) {
    const leftObjectId = await resolveCommitRevision({ files: context.files, repository, expression: range.left });
    const rightObjectId = await resolveCommitRevision({ files: context.files, repository, expression: range.right });
    includeObjectIds.push(leftObjectId, rightObjectId);
    const bases = await findMergeBases({
      files: context.files,
      repository,
      leftObjectId,
      rightObjectId,
    });
    excludeObjectIds.push(...bases);
  }
  if (includeObjectIds.length === 0 && !allRefs) {
    const head = await readHead({ files: context.files, repository });
    if (head.objectId === undefined) {
      const branchName = branchNameFromHead({ head }) ?? 'HEAD';
      await context.text().error({ text: `fatal: your current branch '${branchName}' does not have any commits yet\n` });
      return { exitCode: 128 };
    }
    includeObjectIds.push(head.objectId);
  }
  excludeObjectIds.push(...await Promise.all(excludeExpressions.map(expression => resolveCommitRevision({
    files: context.files,
    repository,
    expression,
  }))));
  const history = pathOperands.length === 0
    ? await (graph ? collectGraphCommitHistory : collectCommitHistory)({
      files: context.files,
      repository,
      includeObjectIds,
      excludeObjectIds,
    })
    : await collectPathLimitedHistory({
      files: context.files,
      repository,
      includeObjectIds,
      excludeObjectIds,
      cwd: context.cwd,
      pathOperands,
    });

  let decorations: Map<string, string>;
  switch (decorationMode) {
  case 'none':
    decorations = new Map<string, string>();
    break;
  case 'short':
  case 'full':
    decorations = await collectLogDecorations({ context, repository, mode: decorationMode });
    break;
  default: {
    const _ex: never = decorationMode;
    throw new Error(`Unhandled log decoration mode: ${_ex}`);
  }
  }

  if (graph) {
    const graphHistory = history.slice(0, maxCount);
    const graphEntries = graphHistory.map((entry, entryIndex) => {
      const decoration = decorations.get(entry.objectId) ?? '';
      if (format !== undefined) {
        const formatted = oneline
          ? `${entry.objectId.slice(0, 7)}${decoration} ${commitSubject({ commit: entry.commit })}`
          : formatCommitTemplate({ objectId: entry.objectId, commit: entry.commit, format });
        return {
          objectId: entry.objectId,
          parentObjectIds: entry.commit.parentObjectIds,
          lines: formatted.split('\n'),
        };
      }
      const author = parseAuthorForLog({ author: entry.commit.author });
      const messageLines = entry.commit.message.replace(/\n+$/u, '').split('\n').map(line => `    ${line}`);
      const lines = [
        `commit ${entry.objectId}${decoration}`,
        ...(entry.commit.parentObjectIds.length > 1
          ? [`Merge: ${entry.commit.parentObjectIds.map(parent => parent.slice(0, 7)).join(' ')}`]
          : []),
        `Author: ${author.identity}`,
        `Date:   ${formatLogDate({ timestamp: author.timestamp, timezone: author.timezone })}`,
        '',
        ...messageLines,
      ];
      if (entryIndex + 1 < graphHistory.length) lines.push('');
      return {
        objectId: entry.objectId,
        parentObjectIds: entry.commit.parentObjectIds,
        lines,
      };
    });
    await context.text().print({ text: renderGitLogGraph({ entries: graphEntries }) });
    return { exitCode: 0 };
  }

  let count = 0;
  for (const entry of history) {
    const committerTimestamp = parseAuthorForLog({ author: entry.commit.committer }).timestamp;
    if (sinceTimestamp !== undefined && committerTimestamp < sinceTimestamp) continue;
    if (untilTimestamp !== undefined && committerTimestamp > untilTimestamp) continue;
    if (grepPattern !== undefined && !grepPattern.test(entry.commit.message)) continue;
    if (pickaxeString !== undefined || pickaxeRegex !== undefined) {
      if (entry.commit.parentObjectIds.length > 1) continue;
      const search = pickaxeString !== undefined
        ? { type: 'string' as const, bytes: new TextEncoder().encode(pickaxeString) }
        : { type: 'regex' as const, pattern: pickaxeRegex! };
      if (!await revisionDiffMatchesSearch({
        context,
        repository,
        leftRevision: entry.commit.parentObjectIds[0],
        rightRevision: entry.objectId,
        pathOperands,
        search,
      })) continue;
    }
    if (count >= maxCount) break;
    const decoration = decorations.get(entry.objectId) ?? '';
    if (format !== undefined) {
      const formatted = oneline
        ? `${entry.objectId.slice(0, 7)}${decoration} ${commitSubject({ commit: entry.commit })}`
        : formatCommitTemplate({ objectId: entry.objectId, commit: entry.commit, format });
      await context.text().print({ text: `${formatted}\n` });
    } else {
      const author = parseAuthorForLog({ author: entry.commit.author });
      const message = entry.commit.message.replace(/\n+$/u, '').split('\n').map(line => `    ${line}`).join('\n');
      await context.text().print({
        text: `commit ${entry.objectId}${decoration}\nAuthor: ${author.identity}\nDate:   ${formatLogDate({ timestamp: author.timestamp, timezone: author.timezone })}\n\n${message}\n\n`,
      });
    }
    if (entry.commit.parentObjectIds.length <= 1) {
      const leftRevision = entry.commit.parentObjectIds[0];
      if (showStat) {
        await writeRevisionStat({
          context,
          repository,
          leftRevision,
          rightRevision: entry.objectId,
          pathOperands,
          quoteNonAscii: logQuoteNonAscii,
        });
      }
      if (showPatch) {
        await writeRevisionPatch({
          context,
          repository,
          leftRevision,
          rightRevision: entry.objectId,
          pathOperands,
          quoteNonAscii: logQuoteNonAscii,
        });
      }
    }
    count += 1;
  }
  return { exitCode: 0 };
}

function branchRefName({ name }: { name: string }): string {
  return `refs/heads/${name}`;
}

type BranchDeleteMode = 'none' | 'safe' | 'force';
type BranchListMode = 'local' | 'remote' | 'all';

function matchesBranchPatterns({ name, patterns }: { name: string, patterns: readonly string[] }): boolean {
  if (patterns.length === 0) return true;
  return patterns.some(pattern => new RegExp(`^${gitPathspecGlobSource({ pattern })}$`, 'u').test(name));
}

function isBranchDeleteMode({ mode }: { mode: BranchDeleteMode }): boolean {
  switch (mode) {
  case 'none':
    return false;
  case 'safe':
  case 'force':
    return true;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled branch delete mode: ${_ex}`);
  }
  }
}

function requiresMergedBranch({ mode }: { mode: BranchDeleteMode }): boolean {
  switch (mode) {
  case 'none':
  case 'force':
    return false;
  case 'safe':
    return true;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled branch delete mode: ${_ex}`);
  }
  }
}

async function deleteBranchReflog({ context, repository, refName }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  refName: string,
}): Promise<void> {
  const path = joinPath({ base: repository.commonDirPath, child: `logs/${refName}` });
  if (await pathExists({ files: context.files, path })) await context.files.unlink({ path });
}

export async function runBranch({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const head = await readHead({ files: context.files, repository });
  const currentBranch = branchNameFromHead({ head });
  let showCurrent = false;
  let move = false;
  let deleteMode: BranchDeleteMode = 'none';
  let listMode: BranchListMode = 'local';
  let listOnly = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '--show-current') showCurrent = true;
    else if (arg === '-m' || arg === '--move') move = true;
    else if (arg === '-d' || arg === '--delete') deleteMode = 'safe';
    else if (arg === '-D') deleteMode = 'force';
    else if (arg === '-r' || arg === '--remotes') listMode = 'remote';
    else if (arg === '-a' || arg === '--all') listMode = 'all';
    else if (arg === '--list') listOnly = true;
    else if (arg === '--no-color') continue;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }

  if (showCurrent) {
    if (operands.length > 0 || isBranchDeleteMode({ mode: deleteMode }) || listMode !== 'local') {
      throw new Error('options are incompatible');
    }
    if (currentBranch !== undefined) await context.text().print({ text: `${currentBranch}\n` });
    return { exitCode: 0 };
  }

  if (move) {
    if (showCurrent || isBranchDeleteMode({ mode: deleteMode })) throw new Error('options are incompatible');
    if (operands.length === 0 || operands.length > 2) throw new Error('branch name required');
    const oldName = operands.length === 1 ? currentBranch : operands[0];
    const newName = operands.length === 1 ? operands[0]! : operands[1]!;
    if (oldName === undefined) throw new Error('cannot rename the current branch while not on any branch');
    const oldRefName = branchRefName({ name: oldName });
    const newRefName = branchRefName({ name: newName });
    if (await readRef({ files: context.files, repository, refName: newRefName }) !== undefined) {
      throw new Error(`a branch named '${newName}' already exists`);
    }
    const objectId = await readRef({ files: context.files, repository, refName: oldRefName });
    const renamingCurrent = head.symbolicRef === oldRefName;
    if (objectId === undefined) {
      if (!renamingCurrent) throw new Error(`branch '${oldName}' not found`);
      await setHeadSymbolic({ files: context.files, repository, refName: newRefName });
      await renameLocalConfigSection({
        files: context.files,
        repository,
        section: 'branch',
        oldSubsection: oldName,
        newSubsection: newName,
      });
      return { exitCode: 0 };
    }

    const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
    const logAllRefUpdates = getConfigValue({ config, key: 'core.logallrefupdates' }) !== 'false';
    const identity = resolveGitReflogIdentity({ env: context.env, config });
    const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
    const message = `Branch: renamed ${oldRefName} to ${newRefName}`;
    if (!await renameRef({
      files: context.files,
      repository,
      oldRefName,
      newRefName,
      reflog: logAllRefUpdates ? { identity, timestamp, message } : undefined,
    })) throw new Error(`branch '${oldName}' not found`);

    if (renamingCurrent) {
      await setHeadSymbolic({ files: context.files, repository, refName: newRefName });
      if (logAllRefUpdates) {
        const headLogPath = joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' });
        const zero = '0000000000000000000000000000000000000000';
        await appendReflog({
          files: context.files, path: headLogPath, oldObjectId: objectId, newObjectId: zero, identity, timestamp, message,
        });
        await appendReflog({
          files: context.files, path: headLogPath, oldObjectId: zero, newObjectId: objectId, identity, timestamp, message,
        });
      }
    }
    await renameLocalConfigSection({
      files: context.files,
      repository,
      section: 'branch',
      oldSubsection: oldName,
      newSubsection: newName,
    });
    return { exitCode: 0 };
  }

  if (isBranchDeleteMode({ mode: deleteMode })) {
    if (operands.length === 0) throw new Error('branch name required');
    let exitCode = 0;
    for (const name of operands) {
      if (name === currentBranch) {
        await context.text().error({
          text: `error: cannot delete branch '${name}' used by worktree at '${repository.worktreePath}'\n`,
        });
        exitCode = 1;
        continue;
      }
      const refName = branchRefName({ name });
      const objectId = await readRef({ files: context.files, repository, refName });
      if (objectId === undefined) {
        await context.text().error({ text: `error: branch '${name}' not found.\n` });
        exitCode = 1;
        continue;
      }
      if (requiresMergedBranch({ mode: deleteMode }) && (head.objectId === undefined || !await isAncestor({
        files: context.files,
        repository,
        ancestorObjectId: objectId,
        descendantObjectId: head.objectId,
      }))) {
        await context.text().error({ text: `error: the branch '${name}' is not fully merged\n` });
        exitCode = 1;
        continue;
      }
      await deleteRef({ files: context.files, repository, refName });
      await deleteBranchReflog({ context, repository, refName });
      await context.text().print({ text: `Deleted branch ${name} (was ${objectId.slice(0, 7)}).\n` });
    }
    return { exitCode };
  }

  if (operands.length === 0 || listOnly) {
    const patterns = listOnly ? operands : [];
    if (listMode === 'local' || listMode === 'all') {
      if (patterns.length === 0 && currentBranch === undefined && head.objectId !== undefined) {
        await context.text().print({ text: '* (no branch)\n' });
      }
      const refs = await listRefs({ files: context.files, repository, prefix: 'refs/heads' });
      for (const ref of refs) {
        const name = ref.refName.slice('refs/heads/'.length);
        if (!matchesBranchPatterns({ name, patterns })) continue;
        await context.text().print({ text: `${name === currentBranch ? '*' : ' '} ${name}\n` });
      }
    }
    if (listMode === 'remote' || listMode === 'all') {
      const refs = await listRefs({ files: context.files, repository, prefix: 'refs/remotes' });
      for (const ref of refs) {
        const shortName = ref.refName.slice('refs/remotes/'.length);
        const displayName = (() => {
          switch (listMode) {
          case 'all': return `remotes/${shortName}`;
          case 'remote': return shortName;
          default: {
            const _ex: never = listMode;
            throw new Error(`Unhandled branch list mode: ${_ex}`);
          }
          }
        })();
        if (!matchesBranchPatterns({ name: displayName, patterns })) continue;
        const targetSuffix = ref.symbolicTargetRefName === undefined
          ? ''
          : ` -> ${ref.symbolicTargetRefName.slice('refs/remotes/'.length)}`;
        await context.text().print({ text: `  ${displayName}${targetSuffix}\n` });
      }
    }
    return { exitCode: 0 };
  }

  switch (listMode) {
  case 'local':
    break;
  case 'remote':
  case 'all':
    throw new Error("the -a, and -r, options to 'git branch' do not take a branch name; use --list with patterns");
  default: {
    const _ex: never = listMode;
    throw new Error(`Unhandled branch list mode: ${_ex}`);
  }
  }
  if (operands.length > 2) throw new Error('too many arguments');
  const name = operands[0]!;
  const refName = branchRefName({ name });
  if (await readRef({ files: context.files, repository, refName }) !== undefined) {
    throw new Error(`a branch named '${name}' already exists`);
  }
  let startObjectId: string;
  let startDescription: string;
  if (operands[1] !== undefined) {
    startDescription = operands[1];
    startObjectId = await resolveCommitRevision({ files: context.files, repository, expression: operands[1] });
  } else {
    startDescription = currentBranch ?? 'HEAD';
    if (head.objectId === undefined) throw new Error(`not a valid object name: '${startDescription}'`);
    startObjectId = head.objectId;
  }
  await readCommit({ files: context.files, repository, objectId: startObjectId });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const reflog = getConfigValue({ config, key: 'core.logallrefupdates' }) === 'false'
    ? undefined
    : {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `branch: Created from ${startDescription}`,
    };
  await createRef({ files: context.files, repository, refName, objectId: startObjectId, reflog });
  return { exitCode: 0 };
}

interface CheckoutLikeArguments {
  createBranchName: string | undefined,
  detach: boolean,
  targetExpression: string,
}

function parseCheckoutLikeArguments({ args, command }: {
  args: readonly string[],
  command: 'checkout' | 'switch',
}): CheckoutLikeArguments {
  let createBranchName: string | undefined;
  let detach = false;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-c' && command === 'switch' || arg === '-b' && command === 'checkout') {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      createBranchName = value;
      index += 1;
      continue;
    }
    if (arg === '--detach') {
      detach = true;
      continue;
    }
    if (arg === '--') throw new Error(`path checkout is not supported by git ${command} yet`);
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    operands.push(arg);
  }
  if (createBranchName !== undefined) {
    if (detach) throw new Error('options are incompatible');
    if (operands.length > 1) throw new Error('too many arguments');
    return { createBranchName, detach: false, targetExpression: operands[0] ?? 'HEAD' };
  }
  if (operands.length !== 1) throw new Error(`git ${command} requires exactly one branch or revision`);
  return { createBranchName: undefined, detach, targetExpression: operands[0]! };
}

async function readHeadIndex({ context, repository }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
}): Promise<GitIndexEntry[]> {
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined) return [];
  const commit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  return readTreeIntoIndex({ files: context.files, repository, treeObjectId: commit.treeObjectId });
}

async function printCheckoutConflicts({ context, conflicts }: {
  context: WeshCommandContext,
  conflicts: readonly { type: 'tracked' | 'untracked' | 'untracked-directory', path: string }[],
}): Promise<void> {
  const tracked = conflicts.filter(conflict => conflict.type === 'tracked');
  const untracked = conflicts.filter(conflict => conflict.type === 'untracked');
  const untrackedDirectories = conflicts.filter(conflict => conflict.type === 'untracked-directory');
  if (tracked.length > 0) {
    await context.text().error({ text: 'error: Your local changes to the following files would be overwritten by checkout:\n' });
    for (const conflict of tracked) await context.text().error({ text: `\t${conflict.path}\n` });
    await context.text().error({ text: 'Please commit your changes or stash them before you switch branches.\n' });
  }
  if (untracked.length > 0) {
    await context.text().error({ text: 'error: The following untracked working tree files would be overwritten by checkout:\n' });
    for (const conflict of untracked) await context.text().error({ text: `\t${conflict.path}\n` });
    await context.text().error({ text: 'Please move or remove them before you switch branches.\n' });
  }
  if (untrackedDirectories.length > 0) {
    await context.text().error({ text: 'error: Updating the following directories would lose untracked files in them:\n' });
    for (const conflict of untrackedDirectories) await context.text().error({ text: `\t${conflict.path}\n` });
    await context.text().error({ text: '\n' });
  }
  await context.text().error({ text: 'Aborting\n' });
}

async function printPreservedCheckoutChanges({ context }: { context: WeshCommandContext }): Promise<void> {
  const status = await collectStatus({ context });
  for (const entry of status.entries) {
    switch (entry.worktreeStatus) {
    case '?':
      continue;
    case ' ':
    case 'M':
    case 'D':
      break;
    case 'U':
      throw new Error(`cannot report preserved checkout changes for unmerged path: ${entry.path}`);
    default: {
      const _ex: never = entry.worktreeStatus;
      throw new Error(`Unhandled worktree status: ${_ex}`);
    }
    }
    let code: 'A' | 'M' | 'D' | ' ';
    switch (entry.indexStatus) {
    case 'A':
    case 'M':
    case 'D':
      code = entry.indexStatus;
      break;
    case ' ':
      code = entry.worktreeStatus;
      break;
    case 'U':
      throw new Error(`cannot report preserved checkout changes for unmerged path: ${entry.path}`);
    default: {
      const _ex: never = entry.indexStatus;
      throw new Error(`Unhandled index status: ${_ex}`);
    }
    }
    switch (code) {
    case 'A':
    case 'M':
    case 'D':
      await context.text().print({ text: `${code}\t${entry.path}\n` });
      break;
    case ' ':
      break;
    default: {
      const _ex: never = code;
      throw new Error(`Unhandled checkout status: ${_ex}`);
    }
    }
  }
}

async function runCheckoutLike({ context, args, command }: {
  context: WeshCommandContext,
  args: readonly string[],
  command: 'checkout' | 'switch',
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const parsed = parseCheckoutLikeArguments({ args, command });
  const oldHead = await readHead({ files: context.files, repository });
  if (oldHead.objectId === undefined) throw new Error('you are on a branch yet to be born');
  const oldBranch = branchNameFromHead({ head: oldHead });

  let targetObjectId: string;
  let targetBranchName: string | undefined;
  let targetDescription = parsed.targetExpression;
  if (parsed.createBranchName !== undefined) {
    targetObjectId = await resolveCommitRevision({
      files: context.files,
      repository,
      expression: parsed.targetExpression,
    });
    targetBranchName = parsed.createBranchName;
    targetDescription = parsed.createBranchName;
  } else if (!parsed.detach) {
    const localRefName = `refs/heads/${parsed.targetExpression}`;
    const localObjectId = await readRef({ files: context.files, repository, refName: localRefName });
    if (localObjectId !== undefined) {
      targetObjectId = localObjectId;
      targetBranchName = parsed.targetExpression;
    } else {
      switch (command) {
      case 'checkout':
        targetObjectId = await resolveCommitRevision({ files: context.files, repository, expression: parsed.targetExpression });
        break;
      case 'switch':
        throw new Error(`invalid reference: ${parsed.targetExpression}`);
      default: {
        const _ex: never = command;
        throw new Error(`Unhandled checkout command: ${_ex}`);
      }
      }
    }
  } else {
    targetObjectId = await resolveCommitRevision({ files: context.files, repository, expression: parsed.targetExpression });
  }

  const targetCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  const currentHeadEntries = await readHeadIndex({ context, repository });
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const targetEntries = await readTreeIntoIndex({
    files: context.files,
    repository,
    treeObjectId: targetCommit.treeObjectId,
  });
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) {
    await printCheckoutConflicts({ context, conflicts: plan.conflicts });
    return { exitCode: 1 };
  }

  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const identity = resolveGitReflogIdentity({ env: context.env, config });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  if (parsed.createBranchName !== undefined) {
    const refName = branchRefName({ name: parsed.createBranchName });
    if (await readRef({ files: context.files, repository, refName }) !== undefined) {
      throw new Error(`a branch named '${parsed.createBranchName}' already exists`);
    }
    await createRef({
      files: context.files,
      repository,
      refName,
      objectId: targetObjectId,
      reflog: getConfigValue({ config, key: 'core.logallrefupdates' }) === 'false'
        ? undefined
        : { identity, timestamp, message: `branch: Created from ${parsed.targetExpression}` },
    });
  }

  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  await moveHeadReference({
    files: context.files,
    repository,
    target: targetBranchName === undefined
      ? { type: 'detached', objectId: targetObjectId }
      : { type: 'symbolic', refName: branchRefName({ name: targetBranchName }), objectId: targetObjectId },
    reflog: {
      identity,
      timestamp,
      message: `checkout: moving from ${oldBranch ?? oldHead.objectId.slice(0, 7)} to ${targetDescription}`,
    },
  });
  await printPreservedCheckoutChanges({ context });

  if (targetBranchName !== undefined) {
    await context.text().error({
      text: parsed.createBranchName !== undefined
        ? `Switched to a new branch '${targetBranchName}'\n`
        : `Switched to branch '${targetBranchName}'\n`,
    });
  } else {
    await context.text().error({
      text: `HEAD is now at ${targetObjectId.slice(0, 7)} ${commitSubject({ commit: targetCommit })}\n`,
    });
  }
  return { exitCode: 0 };
}

export async function runSwitch({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  return runCheckoutLike({ context, args, command: 'switch' });
}

export async function runCheckout({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex < 0) return runCheckoutLike({ context, args, command: 'checkout' });
  const before = args.slice(0, separatorIndex);
  const paths = args.slice(separatorIndex + 1);
  if (paths.length === 0) throw new Error('you must specify path(s) to restore');
  if (before.length === 0) {
    return runRestore({ context, args: ['--worktree', '--', ...paths] });
  }
  if (before.length === 1 && !before[0]!.startsWith('-')) {
    return runRestore({
      context,
      args: [`--source=${before[0]!}`, '--staged', '--worktree', '--', ...paths],
    });
  }
  throw new Error('unsupported checkout path arguments');
}

export async function runRevParse({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  let short = false;
  let verify = false;
  let printedSpecial = false;
  const expressions: string[] = [];
  for (const arg of args) {
    if (arg === '--is-inside-work-tree') {
      await context.text().print({ text: repositoryCwdIsInsideWorktree({ context, repository }) ? 'true\n' : 'false\n' });
      printedSpecial = true;
      continue;
    }
    if (arg === '--is-bare-repository') {
      await context.text().print({ text: repositoryHasWorktree({ repository }) ? 'false\n' : 'true\n' });
      printedSpecial = true;
      continue;
    }
    if (arg === '--verify') {
      verify = true;
      continue;
    }
    if (arg === '--show-toplevel') {
      assertRepositoryHasUsableWorktree({ context, repository });
      await context.text().print({ text: `${repository.worktreePath}\n` });
      printedSpecial = true;
      continue;
    }
    if (arg === '--git-dir') {
      const relative = context.cwd === repository.gitDirPath
        ? '.'
        : repository.gitDirPath === `${repository.worktreePath}/.git` && context.cwd === repository.worktreePath
          ? '.git'
          : repository.gitDirPath;
      await context.text().print({ text: `${relative}\n` });
      printedSpecial = true;
      continue;
    }
    if (arg === '--git-common-dir') {
      const relative = context.cwd === repository.commonDirPath
        ? '.'
        : repository.commonDirPath === `${repository.worktreePath}/.git` && context.cwd === repository.worktreePath
          ? '.git'
          : repository.commonDirPath;
      await context.text().print({ text: `${relative}\n` });
      printedSpecial = true;
      continue;
    }
    if (arg === '--short') {
      short = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    expressions.push(arg);
  }
  if (!printedSpecial && expressions.length === 0) throw new Error('no revision specified');
  if (verify && expressions.length !== 1) throw new Error('--verify requires a single revision');
  for (const expression of expressions) {
    const objectId = expression.includes(':')
      ? (await resolveRevisionPath({ files: context.files, repository, expression })).objectId
      : await resolveRevision({ files: context.files, repository, expression });
    await context.text().print({ text: `${short ? objectId.slice(0, 7) : objectId}\n` });
  }
  return { exitCode: 0 };
}



export async function runReflog({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  let maxCount = Number.POSITIVE_INFINITY;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-n' || arg === '--max-count') {
      const value = args[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) throw new Error(`option '${arg}' requires a numeric value`);
      maxCount = Number.parseInt(value, 10);
      index += 1;
    } else if (/^-[0-9]+$/u.test(arg)) {
      maxCount = Number.parseInt(arg.slice(1), 10);
    } else if (arg.startsWith('-')) {
      throw new Error(`unsupported reflog argument: ${arg}`);
    } else {
      operands.push(arg);
    }
  }
  if (operands[0] === 'show') operands.shift();
  if (operands.length > 1) throw new Error('too many reflog arguments');
  const name = operands[0] ?? 'HEAD';
  const logPath = name === 'HEAD'
    ? joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' })
    : joinPath({
      base: repository.commonDirPath,
      child: name.startsWith('refs/') ? `logs/${name}` : `logs/refs/heads/${name}`,
    });
  const entries = await readReflog({ files: context.files, path: logPath });
  const displayName = name;
  let outputIndex = 0;
  for (let index = entries.length - 1; index >= 0 && outputIndex < maxCount; index -= 1) {
    const entry = entries[index]!;
    await context.text().print({
      text: `${entry.newObjectId.slice(0, 7)} ${displayName}@{${outputIndex}}: ${entry.message}\n`,
    });
    outputIndex += 1;
  }
  return { exitCode: 0 };
}


export async function runStash({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const subcommand = args[0] === undefined || args[0].startsWith('-') ? 'push' : args[0];
  const rest = subcommand === 'push' && (args[0] === undefined || args[0].startsWith('-')) ? args : args.slice(1);
  const repository = await discoverRepositoryFromContext({ context });

  switch (subcommand) {
  case 'push': {
    let includeUntracked = false;
    let message: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === '-u' || arg === '--include-untracked') {
        includeUntracked = true;
      } else if (arg === '-m' || arg === '--message') {
        const value = rest[index + 1];
        if (value === undefined) throw new Error(`option '${arg}' requires a value`);
        message = value;
        index += 1;
      } else if (arg.startsWith('--message=')) {
        message = arg.slice('--message='.length);
      } else {
        throw new Error(`unknown option: ${arg}`);
      }
    }
    const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
    const created = await createStash({
      files: context.files,
      repository,
      config,
      env: context.env,
      message,
      includeUntracked,
    });
    if (created === undefined) {
      await context.text().print({ text: 'No local changes to save\n' });
      return { exitCode: 0 };
    }
    await context.text().print({ text: `Saved working directory and index state ${created.subject}\n` });
    return { exitCode: 0 };
  }
  case 'list': {
    if (rest.length !== 0) throw new Error('stash list arguments are not supported yet');
    for (const entry of await listStashes({ files: context.files, repository })) {
      await context.text().print({ text: `stash@{${entry.index}}: ${entry.message}\n` });
    }
    return { exitCode: 0 };
  }
  case 'drop': {
    if (rest.length > 1) throw new Error('Too many revisions specified');
    const index = parseStashIndex({ expression: rest[0] });
    const dropped = await dropStash({ files: context.files, repository, index });
    await context.text().print({ text: `Dropped stash@{${index}} (${dropped.objectId})\n` });
    return { exitCode: 0 };
  }
  case 'clear':
    if (rest.length !== 0) throw new Error('stash clear does not take arguments');
    await clearStashes({ files: context.files, repository });
    return { exitCode: 0 };
  case 'apply':
  case 'pop': {
    let restoreIndex = false;
    const operands: string[] = [];
    for (const arg of rest) {
      if (arg === '--index') restoreIndex = true;
      else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
      else operands.push(arg);
    }
    if (operands.length > 1) throw new Error('Too many revisions specified');
    const stashIndex = parseStashIndex({ expression: operands[0] });
    const applied = await applyStash({
      files: context.files,
      repository,
      expression: operands[0],
      restoreIndex,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    await printLongStatus({ context, status: await collectStatus({ context }) });
    switch (subcommand) {
    case 'apply':
      break;
    case 'pop':
      await dropStash({ files: context.files, repository, index: stashIndex });
      await context.text().print({ text: `Dropped refs/stash@{${stashIndex}} (${applied.objectId})\n` });
      break;
    default: {
      const _ex: never = subcommand;
      throw new Error(`Unhandled stash apply command: ${_ex}`);
    }
    }
    return { exitCode: 0 };
  }
  case 'show': {
    let expression: string | undefined;
    let stat = false;
    for (const arg of rest) {
      if (arg === '-p' || arg === '--patch' || arg === '--no-color') continue;
      if (arg === '--stat') {
        stat = true;
        continue;
      }
      if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
      if (expression !== undefined) throw new Error('Too many revisions specified');
      expression = arg;
    }
    const stash = await resolveStash({ files: context.files, repository, expression });
    const commit = await readCommit({ files: context.files, repository, objectId: stash.objectId });
    const baseObjectId = commit.parentObjectIds[0];
    if (baseObjectId === undefined) throw new Error('stash commit has invalid parents');
    const stashShowConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
    const stashShowQuoteNonAscii = quoteNonAsciiFromConfig({ config: stashShowConfig });
    if (stat) {
      await writeRevisionStat({ context, repository, leftRevision: baseObjectId, rightRevision: stash.objectId, pathOperands: [], quoteNonAscii: stashShowQuoteNonAscii });
    } else {
      await writeRevisionPatch({ context, repository, leftRevision: baseObjectId, rightRevision: stash.objectId, pathOperands: [], quoteNonAscii: stashShowQuoteNonAscii });
    }
    return { exitCode: 0 };
  }
  default:
    throw new Error(`unknown subcommand: ${subcommand}`);
  }
}

export async function runShow({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const showConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const showQuoteNonAscii = quoteNonAsciiFromConfig({ config: showConfig });
  let noPatch = false;
  let stat = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === '--no-patch' || arg === '-s') noPatch = true;
    else if (arg === '--stat') {
      stat = true;
      noPatch = true;
    } else if (arg === '--no-color') {
      // Output is uncolored by Wesh Git.
    } else if (arg.startsWith('-')) throw new Error(`unsupported show argument: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length > 1) throw new Error('too many revisions specified');
  const expression = operands[0] ?? 'HEAD';

  if (expression.includes(':')) {
    const resolved = await resolveRevisionPath({ files: context.files, repository, expression });
    const object = await readObject({ files: context.files, repository, objectId: resolved.objectId });
    switch (object.type) {
    case 'blob':
      await writeHandleBytes({ handle: context.stdout, bytes: object.body });
      return { exitCode: 0 };
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`object ${resolved.objectId} is not a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled show object type: ${_ex}`);
    }
    }
  }

  let objectId = await resolveRevision({ files: context.files, repository, expression });
  let object = await readObject({ files: context.files, repository, objectId });
  while (object.type === 'tag') {
    const tag = parseAnnotatedTagObject({ body: object.body });
    const tagger = parseAuthorForLog({ author: tag.tagger });
    await context.text().print({
      text: `tag ${tag.name}\nTagger: ${tagger.identity}\nDate:   ${formatLogDate({ timestamp: tagger.timestamp, timezone: tagger.timezone })}\n\n${tag.message.trimEnd()}\n\n`,
    });
    objectId = tag.targetObjectId;
    object = await readObject({ files: context.files, repository, objectId });
  }
  switch (object.type) {
  case 'commit':
    break;
  case 'blob':
  case 'tree':
    throw new Error(`object ${objectId} is not a commit`);
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled show object type: ${_ex}`);
  }
  }
  const commit = await readCommit({ files: context.files, repository, objectId });
  const author = parseAuthorForLog({ author: commit.author });
  const message = commit.message.trimEnd().split('\n').map(line => `    ${line}\n`).join('');
  await context.text().print({
    text: `commit ${objectId}\nAuthor: ${author.identity}\nDate:   ${formatLogDate({ timestamp: author.timestamp, timezone: author.timezone })}\n\n${message}\n`,
  });
  if (stat) {
    await writeRevisionStat({
      context,
      repository,
      leftRevision: commit.parentObjectIds[0],
      rightRevision: objectId,
      pathOperands: [],
      quoteNonAscii: showQuoteNonAscii,
    });
  }
  if (!noPatch) {
    await writeRevisionPatch({
      context,
      repository,
      leftRevision: commit.parentObjectIds[0],
      rightRevision: objectId,
      pathOperands: [],
      quoteNonAscii: showQuoteNonAscii,
    });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
  formatLogDate,
};
