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
  if (!operand.startsWith(':(')) throw new Error(`pathspec magic is not supported yet: ${operand}`);
  const close = operand.indexOf(')');
  if (close < 0) throw new Error(`invalid pathspec magic: ${operand}`);
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

function matchOnePathspec({ repository, cwd, pathspec, paths }: {
  repository: GitRepository,
  cwd: string,
  pathspec: ParsedGitPathspec,
  paths: readonly string[],
}): string[] {
  const baseCwd = pathspec.top ? repository.worktreePath : cwd;
  const absolutePath = normalizePath({ cwd: baseCwd, path: pathspec.pattern });
  const relativePath = relativeToWorktree({ repository, absolutePath });
  const hasWildcards = /[*?[]/u.test(relativePath);
  switch (pathspec.mode) {
  case 'literal':
    return relativePath.length === 0
      ? [...paths]
      : paths.filter(path => path === relativePath || path.startsWith(`${relativePath}/`));
  case 'glob': {
    if (!hasWildcards) {
      return relativePath.length === 0
        ? [...paths]
        : paths.filter(path => path === relativePath || path.startsWith(`${relativePath}/`));
    }
    const matcher = compileGitWildmatch({
      pattern: relativePath,
      slashMode: 'wildcards-exclude-slash',
      anchorMode: 'full',
    });
    return paths.filter(path => matcher.matches({ value: path }));
  }
  case 'default': {
    if (hasWildcards) {
      const matcher = compileGitWildmatch({
        pattern: relativePath,
        slashMode: 'wildcards-include-slash',
        anchorMode: 'full',
      });
      return paths.filter(path => matcher.matches({ value: path }));
    }
    return relativePath.length === 0
      ? [...paths]
      : paths.filter(path => path === relativePath || path.startsWith(`${relativePath}/`));
  }
  default: {
    const _ex: never = pathspec.mode;
    throw new Error(`Unhandled pathspec match mode: ${_ex}`);
  }
  }
}

interface GitPathspecSelection {
  byOperand: Map<string, readonly string[]>,
  selected: Set<string>,
  unmatchedPositiveOperands: string[],
}

function calculatePathspecSelection({ repository, cwd, operands, availablePaths }: {
  repository: GitRepository,
  cwd: string,
  operands: readonly string[],
  availablePaths: Iterable<string>,
}): GitPathspecSelection {
  const paths = sortGitPaths({ paths: new Set(availablePaths) });
  const specs = operands.map(operand => parseGitPathspec({ operand }));
  const positives = specs.filter(spec => !spec.exclude);
  const excludes = specs.filter(spec => spec.exclude);
  const rawMatches = new Map<ParsedGitPathspec, string[]>();
  for (const spec of specs) rawMatches.set(spec, matchOnePathspec({ repository, cwd, pathspec: spec, paths }));
  const excluded = new Set(excludes.flatMap(spec => rawMatches.get(spec)!));
  const selected = new Set<string>();
  if (positives.length === 0) {
    for (const path of paths) if (!excluded.has(path)) selected.add(path);
  } else {
    for (const spec of positives) {
      for (const path of rawMatches.get(spec)!) if (!excluded.has(path)) selected.add(path);
    }
  }

  const byOperand = new Map<string, readonly string[]>();
  if (positives.length === 0 && specs.length > 0) {
    byOperand.set(specs[0]!.operand, [...selected]);
  } else {
    for (const spec of positives) {
      byOperand.set(spec.operand, rawMatches.get(spec)!.filter(path => selected.has(path)));
    }
  }
  return {
    byOperand,
    selected,
    unmatchedPositiveOperands: positives.filter(spec => rawMatches.get(spec)!.length === 0).map(spec => spec.operand),
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
  if (pathspec.exclude) return undefined;
  const baseCwd = pathspec.top ? repository.worktreePath : cwd;
  const absolutePath = normalizePath({ cwd: baseCwd, path: pathspec.pattern });
  const relativePath = relativeToWorktree({ repository, absolutePath });
  if (relativePath.length === 0) return undefined;
  const hasWildcards = pathspec.mode !== 'literal' && /[*?[]/u.test(relativePath);
  if (hasWildcards || matchedPaths.length === 0 || matchedPaths.includes(relativePath)) return undefined;
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
  return calculatePathspecSelection({ repository, cwd, operands, availablePaths }).byOperand;
}

export function selectRepositoryPaths({ repository, cwd, operands, availablePaths }: {
  repository: GitRepository,
  cwd: string,
  operands: readonly string[],
  availablePaths: Iterable<string>,
}): Set<string> {
  const selection = calculatePathspecSelection({ repository, cwd, operands, availablePaths });
  const unmatched = selection.unmatchedPositiveOperands[0];
  if (unmatched !== undefined) {
    throw new Error(`pathspec '${unmatched}' did not match any file(s) known to git`);
  }
  return selection.selected;
}

export const TEST_ONLY = {
  parseGitPathspec,
};
