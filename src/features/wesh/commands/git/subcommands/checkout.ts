import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import type { CheckoutLikeArguments } from "@/features/wesh/commands/git/checkout-like";
import { executeCheckoutLike } from "@/features/wesh/commands/git/checkout-like";
import { executeRestore } from "@/features/wesh/commands/git/restore-operation";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

function parseCheckoutBranchArguments({ args }: { args: readonly string[] }): CheckoutLikeArguments {
  let createBranchName: string | undefined;
  let detach = false;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: [], valueOptions: ['b'] });
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    if (arg === '-b') {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new GitUsageError({ message: `option '${arg}' requires a value` });
      createBranchName = value;
      index += 1;
      continue;
    }
    if (arg === '--detach') {
      detach = true;
      continue;
    }
    if (arg === '--')
      throw new Error('path checkout is not supported by git checkout yet');
    if (arg.startsWith('-'))
      throw new GitUsageError({ message: `unknown option: ${arg}` });
    operands.push(arg);
  }
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
