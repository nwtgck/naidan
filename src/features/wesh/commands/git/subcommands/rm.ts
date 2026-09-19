import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { isExclusionPathspec, matchRepositoryPaths, pathspecSelectsDirectory, selectRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import { sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { collectUnmergedPaths, readIndex, writeIndex } from "@/features/wesh/commands/git/index-file";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { removeWorktreePaths } from "@/features/wesh/commands/git/worktree";
import { collectStatus } from "@/features/wesh/commands/git/status";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const RM_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'dry-run', 'no-dry-run', 'quiet', 'no-quiet', 'no-cached', 'no-force',
    'ignore-unmatch', 'no-ignore-unmatch', 'sparse', 'no-sparse',
    'pathspec-from-file', 'no-pathspec-from-file', 'pathspec-file-nul', 'no-pathspec-file-nul',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'force', value: true }] },
      forms: [
        { kind: 'short', name: 'f', value: { kind: 'none' } },
        { kind: 'long', name: 'force', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
      forms: [{ kind: 'short', name: 'r', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'cached', value: true }] },
      forms: [{ kind: 'long', name: 'cached', value: { kind: 'none' } }],
    },
  ],
});

const RM_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export async function runRm({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const parsed = parseStandardArgv({ args, catalog: RM_ARGV_CATALOG, policy: RM_ARGV_POLICY });
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
      throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  const force = parsed.optionValues.force === true;
  const cached = parsed.optionValues.cached === true;
  const recursive = parsed.optionValues.recursive === true;
  const operands = parsed.positionals;
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
  const unmergedPaths = collectUnmergedPaths({ entries: currentEntries });
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
