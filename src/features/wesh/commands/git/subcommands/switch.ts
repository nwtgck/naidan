import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import type { CheckoutLikeArguments } from "@/features/wesh/commands/git/checkout-like";
import { executeCheckoutLike } from "@/features/wesh/commands/git/checkout-like";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const SWITCH_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'create', 'no-create', 'force-create', 'no-force-create', 'guess', 'no-guess',
    'discard-changes', 'no-discard-changes', 'quiet', 'no-quiet',
    'recurse-submodules', 'no-recurse-submodules', 'progress', 'no-progress',
    'merge', 'no-merge', 'conflict', 'no-conflict', 'no-detach', 'track', 'no-track',
    'force', 'no-force', 'orphan', 'no-orphan', 'overwrite-ignore', 'no-overwrite-ignore',
    'ignore-other-worktrees', 'no-ignore-other-worktrees',
  ],
  definitions: [
    {
      semantic: { kind: 'required-value', key: 'createBranchName', parse: undefined },
      forms: [{ kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'branch' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'detach', value: true }] },
      forms: [{ kind: 'long', name: 'detach', value: { kind: 'none' } }],
    },
  ],
});

const SWITCH_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function parseSwitchArguments({ args }: { args: readonly string[] }): CheckoutLikeArguments {
  const parsed = parseStandardArgv({ args, catalog: SWITCH_ARGV_CATALOG, policy: SWITCH_ARGV_POLICY });
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
      throw new Error(`Unhandled switch argv diagnostic: ${JSON.stringify(_ex)}`);
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
    return { createBranchName, detach: false, targetExpression: operands[0] ?? 'HEAD', missingBranchBehavior: 'reject' };
  }
  if (detach && operands.length === 0)
    return { createBranchName: undefined, detach: true, targetExpression: 'HEAD', missingBranchBehavior: 'reject' };
  if (operands.length !== 1)
    throw new Error('git switch requires exactly one branch or revision');
  return { createBranchName: undefined, detach, targetExpression: operands[0]!, missingBranchBehavior: 'reject' };
}


export async function runSwitch({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  return executeCheckoutLike({ context, parsed: parseSwitchArguments({ args }) });
}

export const TEST_ONLY = {
};
