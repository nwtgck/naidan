import type { WeshCommandContext } from "@/features/wesh/types";
import { readMergeState } from "./merge-state";
import { quoteGitPath } from "./path-output";
import { sortGitPaths } from "./path-order";
import { discoverRepositoryFromContext, relativeToWorktree, repositoryCwdIsInsideWorktree } from "./repository";
import type { GitRepository } from "./repository";
import type { GitStatus, GitStatusEntry } from "./status";

function visibleStatusEntries({ entries }: {
    entries: readonly GitStatusEntry[];
}): readonly GitStatusEntry[] {
  const renameSources = new Map<string, {
        objectId: string | undefined;
        mode: number | undefined;
    }>();
  for (const entry of entries) {
    if (entry.renameSourcePath === undefined)
      continue;
    renameSources.set(entry.renameSourcePath, { objectId: entry.indexObjectId, mode: entry.indexMode });
  }
  const visible = entries.filter(entry => {
    const source = renameSources.get(entry.path);
    if (source === undefined)
      return true;
    return !(entry.indexStatus === 'D'
            && entry.headObjectId === source.objectId
            && entry.headMode === source.mode);
  });
  const sortPath = ({ entry }: {
        entry: GitStatusEntry;
    }): string => entry.renameSourcePath ?? entry.path;
  const pathOrder = new Map(sortGitPaths({ paths: new Set(visible.map(entry => sortPath({ entry }))) })
    .map((path, index) => [path, index]));
  return visible.map((entry, index) => ({ entry, index }))
    .sort((left, right) => (pathOrder.get(sortPath({ entry: left.entry }))! - pathOrder.get(sortPath({ entry: right.entry }))!)
        || (left.entry.renameSourcePath === undefined ? 1 : 0) - (right.entry.renameSourcePath === undefined ? 1 : 0)
        || left.index - right.index)
    .map(({ entry }) => entry);
}
export function statusPathFromCwd({ context, repository, path }: {
    context: WeshCommandContext;
    repository: GitRepository;
    path: string;
}): string {
  if (!repositoryCwdIsInsideWorktree({ context, repository }))
    return path;
  const cwdRelative = relativeToWorktree({ repository, absolutePath: context.cwd });
  if (cwdRelative.length === 0)
    return path;
  const from = cwdRelative.split('/');
  const to = path.split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common])
    common += 1;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}
export function renderShortStatus({ context, repository, entries, quoteNonAscii }: {
    context: WeshCommandContext;
    repository: GitRepository;
    entries: readonly GitStatusEntry[];
    quoteNonAscii: boolean;
}): string {
  return visibleStatusEntries({ entries }).map(entry => {
    const path = quoteGitPath({ path: statusPathFromCwd({ context, repository, path: entry.path }), quoteNonAscii, quoteSpaces: true });
    if (entry.worktreeStatus === '?' && entry.indexStatus === ' ')
      return `?? ${path}\n`;
    if (entry.renameSourcePath !== undefined) {
      const source = quoteGitPath({ path: statusPathFromCwd({ context, repository, path: entry.renameSourcePath }), quoteNonAscii, quoteSpaces: true });
      return `R${entry.worktreeStatus} ${source} -> ${path}\n`;
    }
    return `${entry.indexStatus}${entry.worktreeStatus} ${path}\n`;
  }).join('');
}
export function renderPorcelainV1({ entries, nul, quoteNonAscii }: {
    entries: readonly GitStatusEntry[];
    nul: boolean;
    quoteNonAscii: boolean;
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
      if (nul)
        return `${prefix} ${path}\0${entry.renameSourcePath}\0`;
      const source = quoteGitPath({ path: entry.renameSourcePath, quoteNonAscii, quoteSpaces: true });
      return `${prefix} ${source} -> ${path}\n`;
    }
    return `${prefix} ${path}${separator}`;
  }).join('');
}
function porcelainMode({ mode }: {
    mode: number | undefined;
}): string {
  return mode === undefined ? '000000' : mode.toString(8).padStart(6, '0');
}
function porcelainObjectId({ objectId }: {
    objectId: string | undefined;
}): string {
  return objectId ?? '0000000000000000000000000000000000000000';
}
function porcelainIndexStatus({ status }: {
    status: GitStatusEntry['indexStatus'];
}): string {
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
function porcelainWorktreeStatus({ status }: {
    status: GitStatusEntry['worktreeStatus'];
}): string {
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
export function renderPorcelainV2({ context, repository, entries, nul, quoteNonAscii }: {
    context: WeshCommandContext;
    repository: GitRepository;
    entries: readonly GitStatusEntry[];
    nul: boolean;
    quoteNonAscii: boolean;
}): string {
  const separator = nul ? '\0' : '\n';
  return visibleStatusEntries({ entries }).map(entry => {
    const displayPath = nul ? entry.path : statusPathFromCwd({ context, repository, path: entry.path });
    const path = nul ? displayPath : quoteGitPath({ path: displayPath, quoteNonAscii, quoteSpaces: false });
    if (entry.worktreeStatus === '?' && entry.indexStatus === ' ')
      return `? ${path}${separator}`;
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
function longStatusPath({ path, quoteNonAscii }: {
    path: string;
    quoteNonAscii: boolean;
}): string {
  return quoteGitPath({ path, quoteNonAscii, quoteSpaces: false });
}
function stagedLongStatusLabel({ status }: {
    status: GitStatusEntry['indexStatus'];
}): string {
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
function unstagedLongStatusLabel({ status }: {
    status: GitStatusEntry['worktreeStatus'];
}): string {
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
function unmergedLongStatusLabel({ entry }: {
    entry: GitStatusEntry;
}): string {
  const stages = new Set(entry.unmergedEntries?.map(indexEntry => indexEntry.stage) ?? []);
  const has1 = stages.has(1);
  const has2 = stages.has(2);
  const has3 = stages.has(3);
  if (has1 && has2 && has3)
    return 'both modified:   ';
  if (!has1 && has2 && has3)
    return 'both added:      ';
  if (has1 && has2 && !has3)
    return 'deleted by them: ';
  if (has1 && !has2 && has3)
    return 'deleted by us:   ';
  if (has1 && !has2 && !has3)
    return 'both deleted:    ';
  if (!has1 && has2 && !has3)
    return 'added by us:     ';
  if (!has1 && !has2 && has3)
    return 'added by them:   ';
  throw new Error(`invalid unmerged index stages for ${entry.path}`);
}
export async function printLongStatus({ context, status }: {
    context: WeshCommandContext;
    status: GitStatus;
}): Promise<void> {
  const text = context.text();
  if (status.branchName === undefined)
    await text.print({ text: 'HEAD detached\n' });
  else
    await text.print({ text: `On branch ${status.branchName}\n` });
  if (!status.hasCommits)
    await text.print({ text: '\nNo commits yet\n' });
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
  const renderPath = ({ path }: {
        path: string;
    }): string => longStatusPath({
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
    for (const entry of untracked)
      await text.print({ text: `\t${renderPath({ path: entry.path })}\n` });
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
export function formatPorcelainV1Branch({ status }: {
    status: GitStatus;
}): string {
  if (status.branchName === undefined)
    return 'HEAD (no branch)';
  const prefix = status.hasCommits ? status.branchName : `No commits yet on ${status.branchName}`;
  if (status.upstreamName === undefined)
    return prefix;
  let suffix = `${prefix}...${status.upstreamName}`;
  if (status.upstreamObjectId === undefined)
    return `${suffix} [gone]`;
  const divergence: string[] = [];
  if ((status.ahead ?? 0) > 0)
    divergence.push(`ahead ${status.ahead}`);
  if ((status.behind ?? 0) > 0)
    divergence.push(`behind ${status.behind}`);
  if (divergence.length > 0)
    suffix += ` [${divergence.join(', ')}]`;
  return suffix;
}

export const TEST_ONLY = {
};
