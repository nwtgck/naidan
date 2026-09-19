import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import type { CheckoutLikeArguments } from "@/features/wesh/commands/git/checkout-like";
import { executeCheckoutLike } from "@/features/wesh/commands/git/checkout-like";
import { executeRestore } from "@/features/wesh/commands/git/restore-operation";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const CHECKOUT_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'guess', 'no-guess', 'overlay', 'no-overlay', 'quiet', 'no-quiet',
    'recurse-submodules', 'no-recurse-submodules', 'progress', 'no-progress',
    'merge', 'no-merge', 'conflict', 'no-conflict', 'no-detach', 'track', 'no-track',
    'force', 'no-force', 'orphan', 'no-orphan', 'overwrite-ignore', 'no-overwrite-ignore',
    'ignore-other-worktrees', 'no-ignore-other-worktrees', 'ours', 'theirs', 'patch', 'no-patch',
    'ignore-skip-worktree-bits', 'no-ignore-skip-worktree-bits',
    'pathspec-from-file', 'no-pathspec-from-file', 'pathspec-file-nul', 'no-pathspec-file-nul',
  ],
  definitions: [
    {
      semantic: { kind: 'required-value', key: 'createBranchName', parse: undefined },
      forms: [{ kind: 'short', name: 'b', value: { kind: 'required-attached-or-following', missingValueName: 'branch' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'detach', value: true }] },
      forms: [{ kind: 'long', name: 'detach', value: { kind: 'none' } }],
    },
  ],
});

const CHECKOUT_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function parseCheckoutBranchArguments({ args }: { args: readonly string[] }): CheckoutLikeArguments {
  const parsed = parseStandardArgv({ args, catalog: CHECKOUT_ARGV_CATALOG, policy: CHECKOUT_ARGV_POLICY });
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
      throw new Error(`Unhandled checkout argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  const createBranchValue = parsed.optionValues.createBranchName;
  const createBranchName = typeof createBranchValue === 'string' ? createBranchValue : undefined;
  const detach = parsed.optionValues.detach === true;
  const operands = parsed.positionals;
  if (createBranchName !== undefined) {
    if (detach)
      throw new Error('options are incompatible');
    if (operands.length > 1)
      throw new Error('too many arguments');
    return { createBranchName, detach: false, targetExpression: operands[0] ?? 'HEAD', missingBranchBehavior: 'resolve-revision' };
  }
  if (detach && operands.length === 0)
    return { createBranchName: undefined, detach: true, targetExpression: 'HEAD', missingBranchBehavior: 'resolve-revision' };
  if (operands.length !== 1)
    throw new Error('git checkout requires exactly one branch or revision');
  return { createBranchName: undefined, detach, targetExpression: operands[0]!, missingBranchBehavior: 'resolve-revision' };
}


export async function runCheckout({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  if (args.length === 0) return { exitCode: 0 };
  const separatorIndex = args.indexOf('--');
  if (separatorIndex < 0)
    return executeCheckoutLike({ context, parsed: parseCheckoutBranchArguments({ args }) });
  const before = args.slice(0, separatorIndex);
  const paths = args.slice(separatorIndex + 1);
  if (paths.length === 0) {
    if (before.length === 0)
      return { exitCode: 0 };
    return executeCheckoutLike({ context, parsed: parseCheckoutBranchArguments({ args: before }) });
  }
  if (before.length === 0) {
    return executeRestore({
      context,
      request: { staged: false, worktree: true, sourceExpression: undefined, operands: [...paths] },
    });
  }
  if (before.length === 1 && !before[0]!.startsWith('-')) {
    return executeRestore({
      context,
      request: { staged: true, worktree: true, sourceExpression: before[0]!, operands: [...paths] },
    });
  }
  throw new Error('unsupported checkout path arguments');
}

export const TEST_ONLY = {
};
