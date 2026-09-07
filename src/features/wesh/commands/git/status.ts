import type { WeshCommandContext } from "@/features/wesh/types";
import { loadWorktreeAttributes } from "./attributes";
import { readCommit } from "./commits";
import { getConfigValue, readEffectiveConfig, resolveWorktreeContentConfig } from "./config";
import { pathExists } from "./files";
import { quoteNonAsciiFromConfig } from "./path-output";
import { sortGitPaths } from "./path-order";
import { findExactRenames } from "./renames";
import { countCommitDivergence } from "./history";
import { loadIgnoreMatcher } from "./ignore";
import type { GitIndexEntry } from "./index-file";
import { readIndex } from "./index-file";
import { branchNameFromHead, readHead, readRef } from "./refs";
import { assertRepositoryHasUsableWorktree, discoverRepository, joinPath, discoverRepositoryFromContext } from "./repository";
import type { GitRepository } from "./repository";
import { readTreeRecursively } from "./tree";
import { hashWorktreeEntry, listWorktreeEntries, worktreeAbsolutePath } from "./worktree";

export interface GitStatusEntry {
    path: string;
    indexStatus: ' ' | 'A' | 'M' | 'D' | 'U';
    worktreeStatus: ' ' | 'M' | 'D' | '?' | 'U';
    headObjectId: string | undefined;
    headMode: number | undefined;
    indexObjectId: string | undefined;
    indexMode: number | undefined;
    worktreeMode: number | undefined;
    unmergedEntries: readonly GitIndexEntry[] | undefined;
    renameSourcePath: string | undefined;
}
function regularFileModeFromIndex({ entry }: {
    entry: GitIndexEntry | undefined;
}): 0o100644 | 0o100755 | undefined {
  if (entry === undefined)
    return undefined;
  switch (entry.mode) {
  case 0o100644:
  case 0o100755:
    return entry.mode;
  default:
    return undefined;
  }
}
async function readHeadTreeMap({ context, repository, headObjectId }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    headObjectId: string | undefined;
}): Promise<Map<string, {
    objectId: string;
    mode: number;
}>> {
  if (headObjectId === undefined)
    return new Map();
  const commit = await readCommit({ files: context.files, repository, objectId: headObjectId });
  const entries = await readTreeRecursively({
    files: context.files,
    repository,
    treeObjectId: commit.treeObjectId,
  });
  const byPath = new Map<string, { objectId: string, mode: number }>();
  for (const entry of entries) byPath.set(entry.path, { objectId: entry.objectId, mode: entry.mode });
  return byPath;
}
export async function collectStatus({ context }: {
    context: WeshCommandContext;
}): Promise<{
    repository: GitRepository;
    branchName: string | undefined;
    headObjectId: string | undefined;
    hasCommits: boolean;
    upstreamName: string | undefined;
    upstreamObjectId: string | undefined;
    ahead: number | undefined;
    behind: number | undefined;
    quoteNonAscii: boolean;
    entries: GitStatusEntry[];
}> {
  const repository = await discoverRepositoryFromContext({ context });
  assertRepositoryHasUsableWorktree({ context, repository });
  const head = await readHead({ files: context.files, repository });
  const headTree = await readHeadTreeMap({ context, repository, headObjectId: head.objectId });
  const indexEntries = await readIndex({ files: context.files, repository });
  const index = new Map<string, GitIndexEntry>();
  const unmergedByPath = new Map<string, GitIndexEntry[]>();
  for (const entry of indexEntries) {
    if (entry.stage === 0) {
      index.set(entry.path, entry);
      continue;
    }
    const entries = unmergedByPath.get(entry.path) ?? [];
    entries.push(entry);
    unmergedByPath.set(entry.path, entries);
  }
  const ignoreMatcher = await loadIgnoreMatcher({ files: context.files, repository });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  const attributes = await loadWorktreeAttributes({
    files: context.files,
    repository,
    contentConfig: resolveWorktreeContentConfig({ config }),
  });
  const gitlinkPaths = new Set<string>();
  for (const entry of index.values()) {
    if (entry.mode === 0o160000) gitlinkPaths.add(entry.path);
  }
  const isInsideGitlink = ({ path }: { path: string }): boolean => {
    let separator = path.indexOf('/');
    while (separator >= 0) {
      if (gitlinkPaths.has(path.slice(0, separator))) return true;
      separator = path.indexOf('/', separator + 1);
    }
    return false;
  };
  const worktreePaths = new Set<string>();
  for (const path of await listWorktreeEntries({ files: context.files, repository })) {
    if (!isInsideGitlink({ path })) worktreePaths.add(path);
  }
  for (const gitlinkPath of gitlinkPaths) {
    const absolutePath = worktreeAbsolutePath({ repository, path: gitlinkPath });
    if (!await pathExists({ files: context.files, path: absolutePath }))
      continue;
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
  const paths = new Set<string>();
  for (const collection of [headTree, index, unmergedByPath]) {
    for (const path of collection.keys()) paths.add(path);
  }
  for (const path of worktreePaths) paths.add(path);
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
            && ignoreMatcher.isIgnored({ path, isDirectory: false }))
      continue;
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
    if (headEntry === undefined && indexEntry !== undefined)
      indexStatus = 'A';
    else if (headEntry !== undefined && indexEntry === undefined)
      indexStatus = 'D';
    else if (headEntry !== undefined && indexEntry !== undefined
            && (headEntry.objectId !== indexEntry.objectId || headEntry.mode !== indexEntry.mode))
      indexStatus = 'M';
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
  const statusEntriesByPath = new Map<string, GitStatusEntry>();
  const deletedRenameCandidates: Array<{ path: string, objectId: string, mode: number }> = [];
  const addedRenameCandidates: Array<{ path: string, objectId: string, mode: number }> = [];
  for (const entry of statusEntries) {
    statusEntriesByPath.set(entry.path, entry);
    if (entry.indexStatus === 'D' && entry.headObjectId !== undefined && entry.headMode !== undefined) {
      deletedRenameCandidates.push({ path: entry.path, objectId: entry.headObjectId, mode: entry.headMode });
    }
    if (entry.indexStatus === 'A' && entry.indexObjectId !== undefined && entry.indexMode !== undefined) {
      addedRenameCandidates.push({ path: entry.path, objectId: entry.indexObjectId, mode: entry.indexMode });
    }
  }
  const exactRenames = findExactRenames({ deleted: deletedRenameCandidates, added: addedRenameCandidates });
  for (const rename of exactRenames) {
    const source = statusEntriesByPath.get(rename.sourcePath)!;
    const destination = statusEntriesByPath.get(rename.destinationPath)!;
    destination.headObjectId = source.headObjectId;
    destination.headMode = source.headMode;
    destination.renameSourcePath = source.path;
  }
  const branchName = branchNameFromHead({ head });
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
        const divergence = await countCommitDivergence({
          files: context.files,
          repository,
          leftObjectId: head.objectId,
          rightObjectId: upstreamObjectId,
        });
        ahead = divergence.leftOnly;
        behind = divergence.rightOnly;
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

export type GitStatus = Awaited<ReturnType<typeof collectStatus>>;

export const TEST_ONLY = {
};
