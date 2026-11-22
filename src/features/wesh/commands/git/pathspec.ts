import { normalizePath } from '@/features/wesh/path';
import type { GitRepository } from './repository';
import { relativeToWorktree } from './repository';
import { compileGitWildmatch } from './wildmatch';
import { sortGitPaths } from './path-order';

type GitPathspecMatchMode = 'default' | 'literal' | 'glob';

interface ParsedGitPathspec {
  operand: string,
  pattern: string,
  mode: GitPathspecMatchMode,
  exclude: boolean,
  top: boolean,
}

function parseGitPathspec({ operand }: { operand: string }): ParsedGitPathspec {
  if (operand.startsWith(':!') || operand.startsWith(':^')) {
    return { operand, pattern: operand.slice(2), mode: 'default', exclude: true, top: false };
  }
  if (!operand.startsWith(':')) {
    return { operand, pattern: operand, mode: 'default', exclude: false, top: false };
  }
  if (!operand.startsWith(':(')) {
    throw new Error(`pathspec magic is not supported yet: ${operand}`);
  }
  const close = operand.indexOf(')');
  if (close < 0) {
    throw new Error(`invalid pathspec magic: ${operand}`);
  }
  const magic = operand.slice(2, close).split(',').filter(value => value.length > 0);
  let mode: GitPathspecMatchMode = 'default';
  let exclude = false;
  let top = false;
  for (const word of magic) {
    switch (word) {
    case 'literal':
      switch (mode) {
      case 'glob':
        throw new Error(`incompatible pathspec magic in '${operand}'`);
      case 'default':
      case 'literal':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled pathspec mode: ${_ex}`);
      }
      }
      mode = 'literal';
      break;
    case 'glob':
      switch (mode) {
      case 'literal':
        throw new Error(`incompatible pathspec magic in '${operand}'`);
      case 'default':
      case 'glob':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled pathspec mode: ${_ex}`);
      }
      }
      mode = 'glob';
      break;
    case 'exclude':
    case '!':
      exclude = true;
      break;
    case 'top':
      top = true;
      break;
    default:
      throw new Error(`pathspec magic '${word}' is not supported yet: ${operand}`);
    }
  }
  return { operand, pattern: operand.slice(close + 1), mode, exclude, top };
}

function pathspecAbsolutePath({ repository, cwd, pathspec }: {
  repository: GitRepository,
  cwd: string,
  pathspec: ParsedGitPathspec,
}): string {
  const baseCwd = pathspec.top ? repository.worktreePath : cwd;
  return normalizePath({ cwd: baseCwd, path: pathspec.pattern });
}

function matchOnePathspec({ relativePath, pathspec, paths, requiresDirectory }: {
  relativePath: string,
  pathspec: ParsedGitPathspec,
  paths: readonly string[],
  requiresDirectory: boolean,
}): string[] {
  const hasWildcards = /[*?[]/u.test(relativePath);
  const pattern = requiresDirectory ? `${relativePath}/` : relativePath;
  switch (pathspec.mode) {
  case 'literal':
    return relativePath.length === 0
      ? [...paths]
      : paths.filter(path => (!requiresDirectory && path === relativePath) || path.startsWith(`${relativePath}/`));
  case 'glob': {
    if (!hasWildcards) {
      return relativePath.length === 0
        ? [...paths]
        : paths.filter(path => (!requiresDirectory && path === relativePath) || path.startsWith(`${relativePath}/`));
    }
    const matcher = compileGitWildmatch({
      pattern,
      slashMode: 'wildcards-exclude-slash',
      anchorMode: 'full',
    });
    return paths.filter(path => matcher.matches({ value: path }));
  }
  case 'default': {
    if (hasWildcards) {
      const matcher = compileGitWildmatch({
        pattern,
        slashMode: 'wildcards-include-slash',
        anchorMode: 'full',
      });
      return paths.filter(path => matcher.matches({ value: path }));
    }
    return relativePath.length === 0
      ? [...paths]
      : paths.filter(path => (!requiresDirectory && path === relativePath) || path.startsWith(`${relativePath}/`));
  }
  default: {
    const _ex: never = pathspec.mode;
    throw new Error(`Unhandled pathspec match mode: ${_ex}`);
  }
  }
}

export interface GitRepositoryPathSelection {
  readonly byOperand: Map<string, readonly string[]>,
  readonly selected: Set<string>,
  readonly operands: readonly {
    operand: string,
    path: string,
    mode: GitPathspecMatchMode,
    exclude: boolean,
    requiresDirectory: boolean,
    matched: boolean,
  }[],
}

export function matchRepositoryPathSelection({ repository, cwd, operands, availablePaths, trailingSlash }: {
  repository: GitRepository,
  cwd: string,
  operands: readonly string[],
  availablePaths: Iterable<string>,
  trailingSlash?: 'require-directory',
}): GitRepositoryPathSelection {
  const paths = sortGitPaths({ paths: new Set(availablePaths) });
  const specs = operands.map(operand => {
    const pathspec = parseGitPathspec({ operand });
    const absolutePath = pathspecAbsolutePath({ repository, cwd, pathspec });
    const path = relativeToWorktree({ repository, absolutePath });
    const requiresDirectory = trailingSlash === 'require-directory'
      && (pathspec.pattern.endsWith('/') || pathspec.pattern.endsWith('/.'));
    const matches = matchOnePathspec({ relativePath: path, pathspec, paths, requiresDirectory });
    return { pathspec, path, requiresDirectory, matches };
  });
  const positives = specs.filter(({ pathspec }) => !pathspec.exclude);
  const excludes = specs.filter(({ pathspec }) => pathspec.exclude);
  const excluded = new Set<string>();
  for (const { matches } of excludes) {
    for (const path of matches) {
      excluded.add(path);
    }
  }
  const selected = new Set<string>();
  if (positives.length === 0) {
    for (const path of paths) {
      if (!excluded.has(path)) {
        selected.add(path);
      }
    }
  } else {
    for (const { matches } of positives) {
      for (const path of matches) {
        if (!excluded.has(path)) {
          selected.add(path);
        }
      }
    }
  }

  const byOperand = new Map<string, readonly string[]>();
  if (positives.length === 0 && specs.length > 0) {
    byOperand.set(specs[0]!.pathspec.operand, [...selected]);
  } else {
    for (const { pathspec, matches } of positives) {
      byOperand.set(pathspec.operand, matches.filter(path => selected.has(path)));
    }
  }
  return {
    byOperand,
    selected,
    operands: specs.map(({ pathspec, path, requiresDirectory, matches }) => ({
      operand: pathspec.operand,
      path,
      mode: pathspec.mode,
      exclude: pathspec.exclude,
      requiresDirectory,
      matched: matches.length > 0,
    })),
  };
}

export function isExclusionPathspec({ operand }: { operand: string }): boolean {
  return parseGitPathspec({ operand }).exclude;
}

export function selectedDirectoryPathForPathspec({ repository, cwd, operand, matchedPaths }: {
  repository: GitRepository,
  cwd: string,
  operand: string,
  matchedPaths: readonly string[],
}): string | undefined {
  const pathspec = parseGitPathspec({ operand });
  if (pathspec.exclude) {
    return undefined;
  }
  const absolutePath = pathspecAbsolutePath({ repository, cwd, pathspec });
  const relativePath = relativeToWorktree({ repository, absolutePath });
  if (relativePath.length === 0) {
    return undefined;
  }
  const hasWildcards = pathspec.mode !== 'literal' && /[*?[]/u.test(relativePath);
  if (hasWildcards || matchedPaths.length === 0 || matchedPaths.includes(relativePath)) {
    return undefined;
  }
  return relativePath;
}

export function pathspecSelectsDirectory({ repository, cwd, operand, matchedPaths }: {
  repository: GitRepository,
  cwd: string,
  operand: string,
  matchedPaths: readonly string[],
}): boolean {
  return selectedDirectoryPathForPathspec({ repository, cwd, operand, matchedPaths }) !== undefined;
}

export function matchRepositoryPaths({ repository, cwd, operands, availablePaths }: {
  repository: GitRepository,
  cwd: string,
  operands: readonly string[],
  availablePaths: Iterable<string>,
}): Map<string, readonly string[]> {
  return matchRepositoryPathSelection({ repository, cwd, operands, availablePaths }).byOperand;
}

export function selectRepositoryPaths({ repository, cwd, operands, availablePaths }: {
  repository: GitRepository,
  cwd: string,
  operands: readonly string[],
  availablePaths: Iterable<string>,
}): Set<string> {
  const selection = matchRepositoryPathSelection({ repository, cwd, operands, availablePaths });
  const unmatched = selection.operands.find(({ exclude, matched }) => !exclude && !matched);
  if (unmatched !== undefined) {
    throw new Error(`pathspec '${unmatched.operand}' did not match any file(s) known to git`);
  }
  return selection.selected;
}

export const TEST_ONLY = {
  parseGitPathspec,
};
