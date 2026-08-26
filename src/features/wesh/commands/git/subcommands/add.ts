import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { pathExists } from "@/features/wesh/commands/git/files";
import { loadIgnoreMatcher } from "@/features/wesh/commands/git/ignore";
import { readIndex, writeIndex } from "@/features/wesh/commands/git/index-file";
import { joinPath, relativeToWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { stageWorktreePaths } from "@/features/wesh/commands/git/stage";
import { collectPathsForAdd, listWorktreeEntries, worktreeAbsolutePath } from "@/features/wesh/commands/git/worktree";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runAdd({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context, cleanMutation: true });
  const repository = await discoverRepositoryFromContext({ context });
  let mode: 'paths' | 'all' | 'update' = 'paths';
  let allModeSeen = false;
  let updateModeSeen = false;
  let force = false;
  let parsingOptions = true;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['A', 'u', 'f'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-A' || arg === '--all')) {
      if (updateModeSeen)
        throw new Error("options '-A' and '-u' cannot be used together");
      allModeSeen = true;
      mode = 'all';
      continue;
    }
    if (parsingOptions && (arg === '-u' || arg === '--update')) {
      if (allModeSeen)
        throw new Error("options '-A' and '-u' cannot be used together");
      updateModeSeen = true;
      mode = 'update';
      continue;
    }
    if (parsingOptions && (arg === '-f' || arg === '--force')) {
      force = true;
      continue;
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new Error(`unknown option ${arg}`);
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
      if (path.startsWith(prefix))
        selected.delete(path);
    }
    if (!selected.has(gitlink.path))
      continue;
    const absolutePath = worktreeAbsolutePath({ repository, path: gitlink.path });
    if (!await pathExists({ files: context.files, path: absolutePath }))
      continue;
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
        if (relativePath.length === 0)
          continue;
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
        for (const path of explicitIgnored)
          await context.text().error({ text: `${path}\n` });
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

export const TEST_ONLY = {
};
