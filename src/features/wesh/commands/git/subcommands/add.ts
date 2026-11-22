import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext, WeshCommandResult, WeshFileType, WeshStat } from "@/features/wesh/types";
import { pathExists } from "@/features/wesh/commands/git/files";
import { loadIgnoreMatcher } from "@/features/wesh/commands/git/ignore";
import { readIndex, writeIndex } from "@/features/wesh/commands/git/index-file";
import { matchRepositoryPathSelection } from "@/features/wesh/commands/git/pathspec";
import { joinPath, relativeToWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { stageWorktreePaths } from "@/features/wesh/commands/git/stage";
import { collectPathsForAdd, listWorktreeEntries, lstatWorktreePath, worktreeAbsolutePath } from "@/features/wesh/commands/git/worktree";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const ADD_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'dry-run', 'no-dry-run', 'verbose', 'no-verbose', 'interactive', 'no-interactive',
    'patch', 'no-patch', 'edit', 'no-edit', 'no-force', 'no-update', 'renormalize',
    'no-renormalize', 'intent-to-add', 'no-intent-to-add', 'no-all', 'ignore-removal',
    'no-ignore-removal', 'refresh', 'no-refresh', 'ignore-errors', 'no-ignore-errors',
    'ignore-missing', 'no-ignore-missing', 'sparse', 'no-sparse', 'chmod', 'no-chmod',
    'pathspec-from-file', 'no-pathspec-from-file', 'pathspec-file-nul', 'no-pathspec-file-nul',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'all', value: true }] },
      forms: [
        { kind: 'short', name: 'A', value: { kind: 'none' } },
        { kind: 'long', name: 'all', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'update', value: true }] },
      forms: [
        { kind: 'short', name: 'u', value: { kind: 'none' } },
        { kind: 'long', name: 'update', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'force', value: true }] },
      forms: [
        { kind: 'short', name: 'f', value: { kind: 'none' } },
        { kind: 'long', name: 'force', value: { kind: 'none' } },
      ],
    },
  ],
});

const ADD_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

async function reportIgnoredPaths({ context, paths }: {
  context: WeshCommandContext,
  paths: Iterable<string>,
}): Promise<WeshCommandResult> {
  await context.text().error({ text: 'The following paths are ignored by one of your .gitignore files:\n' });
  for (const path of paths) {
    await context.text().error({ text: `${path}\n` });
  }
  await context.text().error({ text: 'hint: Use -f if you really want to add them.\n' });
  await context.text().error({ text: 'hint: Disable this message with "git config advice.addIgnoredFile false"\n' });
  return { exitCode: 1 };
}

export async function runAdd({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context, cleanMutation: true });
  const repository = await discoverRepositoryFromContext({ context });
  const parsed = parseStandardArgv({ args, catalog: ADD_ARGV_CATALOG, policy: ADD_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    switch (diagnostic.kind) {
    case 'ambiguous_long_option':
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: diagnostic.option,
          candidateOptions: diagnostic.candidateOptions,
        }),
      });
    case 'unknown_short_option':
    case 'unknown_long_option':
    case 'missing_option_value':
    case 'unexpected_option_value':
    case 'invalid_option_value':
      throw new GitUsageError({ message: `unknown option ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  const allModeSeen = parsed.optionValues.all === true;
  const updateModeSeen = parsed.optionValues.update === true;
  if (allModeSeen && updateModeSeen) {
    throw new Error("options '-A' and '-u' cannot be used together");
  }
  const mode: 'paths' | 'all' | 'update' = allModeSeen ? 'all' : updateModeSeen ? 'update' : 'paths';
  const force = parsed.optionValues.force === true;
  const operands = parsed.positionals;
  if (operands.includes('')) {
    throw new Error('empty string is not a valid pathspec. please use . instead if you meant to match all paths');
  }
  const currentEntries = await readIndex({ files: context.files, repository });
  const trackedPaths = new Set(currentEntries.map(entry => entry.path));
  if (mode === 'paths' && operands.length === 0) {
    await context.text().error({ text: 'Nothing specified, nothing added.\n' });
    return { exitCode: 128 };
  }
  const ignoreMatcher = force || mode === 'update'
    ? undefined
    : await loadIgnoreMatcher({ files: context.files, repository });
  let selected: Set<string>;
  switch (mode) {
  case 'all':
    selected = new Set(trackedPaths);
    for (const path of await listWorktreeEntries({ files: context.files, repository })) {
      if (!ignoreMatcher?.isIgnored({ path, isDirectory: false })) {
        selected.add(path);
      }
    }
    break;
  case 'update':
    selected = new Set(trackedPaths);
    break;
  case 'paths':
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
  const explicitIgnored = new Set<string>();
  const hasModePathspecs = mode !== 'paths' && operands.length > 0;
  if (hasModePathspecs) {
    const selection = matchRepositoryPathSelection({
      repository,
      cwd: context.cwd,
      operands,
      availablePaths: selected,
      trailingSlash: 'require-directory',
    });
    const ancestorTypes = new Map<string, WeshFileType | undefined>();
    for (const { operand, path, mode: pathspecMode, exclude, requiresDirectory, matched } of selection.operands) {
      const lookup = await lstatWorktreePath({ files: context.files, repository, path, ancestorTypes });
      let stat: WeshStat | undefined;
      switch (lookup.kind) {
      case 'entry':
        stat = lookup.stat;
        if (requiresDirectory && stat.type === 'symlink') {
          throw new Error(`pathspec '${operand}' is beyond a symbolic link`);
        }
        break;
      case 'missing':
        stat = undefined;
        break;
      case 'leading-symlink':
        throw new Error(`pathspec '${operand}' is beyond a symbolic link`);
      default: {
        const _ex: never = lookup;
        throw new Error(`Unhandled worktree path: ${JSON.stringify(_ex)}`);
      }
      }
      if (exclude) {
        continue;
      }
      let allowsLiteralMatch: boolean;
      switch (pathspecMode) {
      case 'literal':
      case 'default':
        allowsLiteralMatch = true;
        break;
      case 'glob':
        allowsLiteralMatch = false;
        break;
      default: {
        const _ex: never = pathspecMode;
        throw new Error(`Unhandled pathspec mode: ${_ex}`);
      }
      }
      // A literal may name a real path with no eligible entries, such as an untracked file under -u.
      const isDirectory = stat?.type === 'directory';
      if (!matched && (!allowsLiteralMatch || stat === undefined || (requiresDirectory && !isDirectory))) {
        throw new Error(`pathspec '${operand}' did not match any files`);
      }
      if (path.length > 0) {
        const ignoredPath = ignoreMatcher?.firstIgnoredPath({ path, isDirectory });
        if (ignoredPath !== undefined && (ignoredPath !== path || (stat !== undefined && !trackedPaths.has(path)))) {
          explicitIgnored.add(ignoredPath);
        }
      }
    }
    selected = selection.selected;
  }
  const trackedGitlinks = currentEntries.filter(entry => entry.stage === 0 && entry.mode === 0o160000);
  for (const gitlink of trackedGitlinks) {
    const prefix = `${gitlink.path}/`;
    for (const path of [...selected]) {
      if (path.startsWith(prefix)) {
        selected.delete(path);
      }
    }
    if (!selected.has(gitlink.path)) {
      continue;
    }
    const absolutePath = worktreeAbsolutePath({ repository, path: gitlink.path });
    if (!await pathExists({ files: context.files, path: absolutePath })) {
      continue;
    }
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
  if (mode === 'paths' && ignoreMatcher !== undefined) {
    for (const operand of operands) {
      const absolutePath = normalizePath({ cwd: context.cwd, path: operand });
      const stat = await context.files.lstat({ path: absolutePath }).catch(() => undefined);
      if (stat === undefined) {
        continue;
      }
      const relativePath = relativeToWorktree({ repository, absolutePath });
      if (relativePath.length > 0 && !trackedPaths.has(relativePath)
        && ignoreMatcher.isIgnored({ path: relativePath, isDirectory: stat.type === 'directory' })) {
        explicitIgnored.add(relativePath);
      }
    }
    if (explicitIgnored.size > 0) {
      return reportIgnoredPaths({ context, paths: explicitIgnored });
    }
    for (const path of selected) {
      if (!trackedPaths.has(path) && ignoreMatcher.isIgnored({ path, isDirectory: false })) {
        selected.delete(path);
      }
    }
  }
  if (!hasModePathspecs || selected.size > 0) {
    const stagedEntries = await stageWorktreePaths({
      files: context.files,
      repository,
      currentEntries,
      paths: selected,
      trackedOnly: mode === 'update',
      contentConfig: await resolveContentConfigForContext({ context, repository }),
      fileDirectoryChanges: allModeSeen || updateModeSeen ? 'stage' : undefined,
    });
    await writeIndex({ files: context.files, repository, entries: stagedEntries });
  }
  return explicitIgnored.size > 0
    ? reportIgnoredPaths({ context, paths: explicitIgnored })
    : { exitCode: 0 };
}

export const TEST_ONLY = {
};
