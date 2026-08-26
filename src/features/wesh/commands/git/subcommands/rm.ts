import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { isExclusionPathspec, matchRepositoryPaths, pathspecSelectsDirectory, selectRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import { sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { readIndex, writeIndex } from "@/features/wesh/commands/git/index-file";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { removeWorktreePaths } from "@/features/wesh/commands/git/worktree";
import { collectStatus } from "@/features/wesh/commands/git/status";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runRm({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  let force = false;
  let cached = false;
  let recursive = false;
  let parsingOptions = true;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['f', 'r'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-f' || arg === '--force'))
      force = true;
    else if (parsingOptions && arg === '--cached')
      cached = true;
    else if (parsingOptions && arg === '-r')
      recursive = true;
    else if (parsingOptions && arg.startsWith('-'))
      throw new Error(`unknown option: ${arg}`);
    else
      operands.push(arg);
  }
  if (operands.length === 0)
    throw new Error('No pathspec was given. Which files should I remove?');
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
      if (unmergedPaths.has(path))
        return false;
      const entry = statusByPath.get(path);
      if (entry === undefined)
        return false;
      if (cached)
        return entry.indexStatus !== ' ' && entry.worktreeStatus !== ' ';
      return entry.indexStatus !== ' ' || entry.worktreeStatus !== ' ';
    });
    if (changed.length > 0) {
      if (cached) {
        await context.text().error({ text: 'error: the following files have staged content different from both the file and the HEAD:\n' });
        for (const path of sortGitPaths({ paths: changed }))
          await context.text().error({ text: `    ${path}\n` });
        await context.text().error({ text: '(use -f to force removal)\n' });
      } else {
        await context.text().error({ text: 'error: the following files have local modifications:\n' });
        for (const path of sortGitPaths({ paths: changed }))
          await context.text().error({ text: `    ${path}\n` });
        await context.text().error({ text: '(use --cached to keep the file, or -f to force removal)\n' });
      }
      return { exitCode: 1 };
    }
  }
  await writeIndex({
    files: context.files,
    repository,
    entries: currentEntries.filter(entry => !selected.has(entry.path)),
  });
  if (!cached)
    await removeWorktreePaths({ files: context.files, repository, paths: selected });
  for (const path of sortGitPaths({ paths: selected }))
    await context.text().print({ text: `rm '${path}'\n` });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
