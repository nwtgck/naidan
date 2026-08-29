import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { matchRepositoryPaths, selectedDirectoryPathForPathspec } from "@/features/wesh/commands/git/pathspec";
import { sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { readIndex } from "@/features/wesh/commands/git/index-file";
import { joinPath, relativeToWorktree, repositoryCwdIsInsideWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { removeWorktreePaths } from "@/features/wesh/commands/git/worktree";
import { statusPathFromCwd } from "@/features/wesh/commands/git/status-output";
import { getBooleanConfigValue, readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { loadIgnoreMatcher } from "@/features/wesh/commands/git/ignore";
import { pathExists, readFileText } from "@/features/wesh/commands/git/files";
import { normalizePath } from "@/features/wesh/path";

async function isNestedGitWorktree({ context, absolutePath }: {
  context: WeshCommandContext;
  absolutePath: string;
}): Promise<boolean> {
  const markerPath = joinPath({ base: absolutePath, child: '.git' });
  if (!await pathExists({ files: context.files, path: markerPath })) return false;
  const markerStat = await context.files.lstat({ path: markerPath });
  switch (markerStat.type) {
  case 'directory':
    return await pathExists({ files: context.files, path: joinPath({ base: markerPath, child: 'HEAD' }) })
      && await pathExists({ files: context.files, path: joinPath({ base: markerPath, child: 'objects' }) });
  case 'file': {
    const match = /^gitdir:\s*(.+?)\s*$/u.exec(await readFileText({ files: context.files, path: markerPath }));
    if (match === null) return false;
    const gitDirPath = normalizePath({ cwd: absolutePath, path: match[1]! });
    if (!await pathExists({ files: context.files, path: gitDirPath })) return false;
    const stat = await context.files.lstat({ path: gitDirPath });
    return stat.type === 'directory';
  }
  case 'fifo':
  case 'chardev':
  case 'symlink':
    return false;
  default: {
    const _ex: never = markerStat.type;
    throw new Error(`Unhandled nested Git marker type: ${_ex}`);
  }
  }
}

interface CleanInventory {
  leafPaths: string[];
  untrackedDirectoryPaths: Set<string>;
  fullyRemovableDirectoryPaths: Set<string>;
}

function isDescendantOf({ path, directory }: { path: string, directory: string }): boolean {
  return path.startsWith(`${directory}/`);
}

function isWithinCwdScope({ path, cwdRelative }: { path: string, cwdRelative: string }): boolean {
  return cwdRelative.length === 0 || isDescendantOf({ path, directory: cwdRelative });
}

function hasAncestorInSet({ path, directories }: {
  path: string;
  directories: ReadonlySet<string>;
}): boolean {
  const segments = path.split('/');
  for (let count = 1; count < segments.length; count += 1) {
    if (directories.has(segments.slice(0, count).join('/'))) return true;
  }
  return false;
}

async function collectCleanInventory({ context, repository, trackedPaths, nestedRepositoryForce }: {
  context: WeshCommandContext;
  repository: Awaited<ReturnType<typeof discoverRepositoryFromContext>>;
  trackedPaths: ReadonlySet<string>;
  nestedRepositoryForce: boolean;
}): Promise<CleanInventory> {
  const ignoreMatcher = await loadIgnoreMatcher({ files: context.files, repository });
  const leafPaths: string[] = [];
  const untrackedDirectoryPaths = new Set<string>();
  const fullyRemovableDirectoryPaths = new Set<string>();

  const visitDirectory = async ({ absolutePath, relativePath }: {
    absolutePath: string;
    relativePath: string;
  }): Promise<{ hasTrackedDescendant: boolean, hasProtectedDescendant: boolean }> => {
    if (relativePath.length > 0 && ignoreMatcher.isIgnored({ path: relativePath, isDirectory: true })) {
      return { hasTrackedDescendant: false, hasProtectedDescendant: true };
    }
    if (relativePath.length > 0 && trackedPaths.has(relativePath)) {
      return { hasTrackedDescendant: true, hasProtectedDescendant: true };
    }
    if (relativePath.length > 0 && await isNestedGitWorktree({ context, absolutePath })) {
      untrackedDirectoryPaths.add(relativePath);
      if (!nestedRepositoryForce) {
        return { hasTrackedDescendant: false, hasProtectedDescendant: true };
      }
      fullyRemovableDirectoryPaths.add(relativePath);
      return { hasTrackedDescendant: false, hasProtectedDescendant: false };
    }

    let hasTrackedDescendant = false;
    let hasProtectedDescendant = false;
    for await (const entry of context.files.readDir({ path: absolutePath })) {
      if (relativePath.length === 0 && entry.name === '.git') continue;
      const childRelativePath = relativeToWorktree({ repository, absolutePath: entry.fullPath });
      switch (entry.type) {
      case 'directory': {
        const child = await visitDirectory({ absolutePath: entry.fullPath, relativePath: childRelativePath });
        hasTrackedDescendant ||= child.hasTrackedDescendant;
        hasProtectedDescendant ||= child.hasProtectedDescendant;
        break;
      }
      case 'file':
      case 'symlink':
      case 'fifo':
      case 'chardev':
        if (trackedPaths.has(childRelativePath)) {
          hasTrackedDescendant = true;
          hasProtectedDescendant = true;
        } else if (ignoreMatcher.isIgnored({ path: childRelativePath, isDirectory: false })) {
          hasProtectedDescendant = true;
        } else {
          leafPaths.push(childRelativePath);
        }
        break;
      default: {
        const _ex: never = entry.type;
        throw new Error(`Unhandled git clean path type: ${_ex}`);
      }
      }
    }

    if (relativePath.length > 0 && !hasTrackedDescendant) {
      untrackedDirectoryPaths.add(relativePath);
      if (!hasProtectedDescendant) fullyRemovableDirectoryPaths.add(relativePath);
    }
    return { hasTrackedDescendant, hasProtectedDescendant };
  };

  await visitDirectory({ absolutePath: repository.worktreePath, relativePath: '' });
  return {
    leafPaths: sortGitPaths({ paths: leafPaths }),
    untrackedDirectoryPaths,
    fullyRemovableDirectoryPaths,
  };
}

function chooseTopmostDirectories({ directories }: { directories: Iterable<string> }): string[] {
  const sorted = [...directories].sort((left, right) => {
    const depthDifference = left.split('/').length - right.split('/').length;
    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });
  const selected: string[] = [];
  for (const path of sorted) {
    if (!selected.some(directory => isDescendantOf({ path, directory }))) selected.push(path);
  }
  return sortGitPaths({ paths: selected });
}

function selectExplicitCleanPaths({ repository, cwd, operands, inventory }: {
  repository: Awaited<ReturnType<typeof discoverRepositoryFromContext>>;
  cwd: string;
  operands: readonly string[];
  inventory: CleanInventory;
}): { directories: string[], leaves: string[] } {
  const matches = matchRepositoryPaths({
    repository,
    cwd,
    operands,
    availablePaths: inventory.leafPaths,
  });
  const selected = new Set([...matches.values()].flat());
  const exactDirectories = new Set<string>();
  for (const [operand, operandMatches] of matches) {
    const directory = selectedDirectoryPathForPathspec({ repository, cwd, operand, matchedPaths: operandMatches });
    if (directory === undefined || !inventory.fullyRemovableDirectoryPaths.has(directory)) continue;
    const descendantLeaves = inventory.leafPaths.filter(path => isDescendantOf({ path, directory }));
    if (descendantLeaves.length > 0 && descendantLeaves.every(path => selected.has(path))) exactDirectories.add(directory);
  }
  const directories = chooseTopmostDirectories({ directories: exactDirectories });
  return {
    directories,
    leaves: inventory.leafPaths.filter(path =>
      selected.has(path)
      && !directories.some(directory => isDescendantOf({ path, directory })),
    ),
  };
}

export async function runClean({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  let dryRun = false;
  let forceCount = 0;
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
      forceCount += 1;
    else if (parsingOptions && /^-[nfd]+$/u.test(arg)) {
      for (const option of arg.slice(1)) {
        if (option === 'n')
          dryRun = true;
        else if (option === 'f')
          forceCount += 1;
        else if (option === 'd')
          directories = true;
      }
    } else if (parsingOptions && arg.startsWith('-'))
      throw new GitUsageError({ message: `unknown option: ${arg}` });
    else
      operands.push(arg);
  }
  if (!dryRun && forceCount === 0) {
    if (getBooleanConfigValue({ config, key: 'clean.requireforce' }) !== false) {
      await context.text().error({
        text: 'fatal: clean.requireForce is true and -f not given: refusing to clean\n',
      });
      return { exitCode: 128 };
    }
  }
  const indexEntries = await readIndex({ files: context.files, repository });
  const trackedPaths = new Set(indexEntries.filter(entry => entry.stage === 0).map(entry => entry.path));
  const inventory = await collectCleanInventory({
    context,
    repository,
    trackedPaths,
    nestedRepositoryForce: forceCount >= 2,
  });
  const selection = (() => {
    if (operands.length > 0) {
      return selectExplicitCleanPaths({ repository, cwd: context.cwd, operands, inventory });
    }
    const cwdRelative = repositoryCwdIsInsideWorktree({ context, repository })
      ? relativeToWorktree({ repository, absolutePath: context.cwd })
      : '';
    if (!directories) {
      return {
        directories: [] as string[],
        leaves: inventory.leafPaths.filter(path =>
          isWithinCwdScope({ path, cwdRelative })
          && !hasAncestorInSet({ path, directories: inventory.untrackedDirectoryPaths }),
        ),
      };
    }
    const removableDirectories = [...inventory.fullyRemovableDirectoryPaths]
      .filter(path => isWithinCwdScope({ path, cwdRelative }));
    const selectedDirectories = chooseTopmostDirectories({ directories: removableDirectories });
    return {
      directories: selectedDirectories,
      leaves: inventory.leafPaths.filter(path =>
        isWithinCwdScope({ path, cwdRelative })
        && !selectedDirectories.some(directory => isDescendantOf({ path, directory })),
      ),
    };
  })();
  const candidatePaths = sortGitPaths({ paths: [...selection.directories, ...selection.leaves] });
  const directorySet = new Set(selection.directories);
  for (const path of candidatePaths) {
    const displayPath = statusPathFromCwd({ context, repository, path });
    await context.text().print({
      text: `${dryRun ? 'Would remove' : 'Removing'} ${displayPath}${directorySet.has(path) ? '/' : ''}\n`,
    });
  }
  if (!dryRun)
    await removeWorktreePaths({ files: context.files, repository, paths: candidatePaths });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
  chooseTopmostDirectories,
};
