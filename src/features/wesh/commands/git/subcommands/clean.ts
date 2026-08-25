import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { matchRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import { sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { readIndex } from "@/features/wesh/commands/git/index-file";
import { relativeToWorktree, repositoryCwdIsInsideWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { removeWorktreePaths } from "@/features/wesh/commands/git/worktree";
import { collectStatus } from "@/features/wesh/commands/git/status";
import { statusPathFromCwd } from "@/features/wesh/commands/git/status-output";

export async function runClean({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
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
    if (parsingOptions && arg === '--dry-run')
      dryRun = true;
    else if (parsingOptions && arg === '--force')
      force = true;
    else if (parsingOptions && /^-[nfd]+$/u.test(arg)) {
      for (const option of arg.slice(1)) {
        if (option === 'n')
          dryRun = true;
        else if (option === 'f')
          force = true;
        else if (option === 'd')
          directories = true;
      }
    } else if (parsingOptions && arg.startsWith('-'))
      throw new Error(`unknown option: ${arg}`);
    else
      operands.push(arg);
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
  const hasUntrackedDirectoryAncestor = ({ path }: {
        path: string;
    }): boolean => {
    const segments = path.split('/');
    for (let count = 1; count < segments.length; count += 1) {
      const ancestor = segments.slice(0, count).join('/');
      if (!trackedPaths.some(tracked => tracked.startsWith(`${ancestor}/`)))
        return true;
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
    for (const paths of matches.values())
      for (const path of paths)
        selected.add(path);
    candidates = [...selected];
  }
  candidates = sortGitPaths({ paths: candidates });
  for (const path of candidates) {
    await context.text().print({
      text: `${dryRun ? 'Would remove' : 'Removing'} ${statusPathFromCwd({ context, repository, path })}\n`,
    });
  }
  if (!dryRun)
    await removeWorktreePaths({ files: context.files, repository, paths: candidates });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
