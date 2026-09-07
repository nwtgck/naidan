import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';

import type { RestoreRequest } from "@/features/wesh/commands/git/restore-operation";

type RestoreDeferredSemantic = 'source';

const RESTORE_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<RestoreDeferredSemantic>>({
  nonExecutableLongOptions: [
    'no-source', 'no-staged', 'no-worktree', 'ignore-unmerged', 'no-ignore-unmerged',
    'overlay', 'no-overlay', 'quiet', 'no-quiet', 'recurse-submodules', 'no-recurse-submodules',
    'progress', 'no-progress', 'merge', 'no-merge', 'conflict', 'no-conflict',
    'ours', 'theirs', 'patch', 'no-patch', 'ignore-skip-worktree-bits',
    'no-ignore-skip-worktree-bits', 'pathspec-from-file', 'no-pathspec-from-file',
    'pathspec-file-nul', 'no-pathspec-file-nul',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'staged', value: true }] },
      forms: [
        { kind: 'short', name: 'S', value: { kind: 'none' } },
        { kind: 'long', name: 'staged', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'worktree', value: true }] },
      forms: [
        { kind: 'short', name: 'W', value: { kind: 'none' } },
        { kind: 'long', name: 'worktree', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'source' },
      forms: [
        { kind: 'short', name: 's', value: { kind: 'required-attached-or-following', missingValueName: 'source' } },
        { kind: 'long', name: 'source', value: { kind: 'required', missingValueName: 'source' } },
      ],
    },
  ],
});

const RESTORE_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export function parseRestoreArguments({ args }: {
    args: readonly string[];
}): RestoreRequest {
  const parsed = parseStandardArgv({ args, catalog: RESTORE_ARGV_CATALOG, policy: RESTORE_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    switch (diagnostic.kind) {
    case 'missing_option_value':
      throw new GitUsageError({ message: `option '${diagnostic.option}' requires a value` });
    case 'ambiguous_long_option':
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: diagnostic.option,
          candidateOptions: diagnostic.candidateOptions,
        }),
      });
    case 'unknown_short_option':
    case 'unknown_long_option':
    case 'unexpected_option_value':
    case 'invalid_option_value':
      throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled restore argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }

  let sourceExpression: string | undefined;
  for (const occurrence of parsed.deferred) {
    switch (occurrence.semantic.tag) {
    case 'source':
      switch (occurrence.value.kind) {
      case 'inline':
        if (occurrence.value.rawValue.length === 0)
          throw new GitUsageError({ message: "option '--source' requires a value" });
        sourceExpression = occurrence.value.rawValue;
        break;
      case 'next-argv':
        sourceExpression = occurrence.value.rawValue;
        break;
      case 'none':
        throw new Error('Restore source option did not claim a value');
      default: {
        const _ex: never = occurrence.value;
        throw new Error(`Unhandled restore source value: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled restore deferred semantic: ${_ex}`);
    }
    }
  }

  const staged = parsed.optionValues.staged === true;
  const worktree = parsed.optionValues.worktree === true || !staged;
  const operands = [...parsed.positionals];
  if (operands.length === 0)
    throw new Error('you must specify path(s) to restore');
  return { staged, worktree, sourceExpression, operands };
}


export const TEST_ONLY = {
};
