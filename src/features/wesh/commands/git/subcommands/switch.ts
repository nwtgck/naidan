import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import type { CheckoutLikeArguments } from "@/features/wesh/commands/git/checkout-like";
import { executeCheckoutLike } from "@/features/wesh/commands/git/checkout-like";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

function parseSwitchArguments({ args }: { args: readonly string[] }): CheckoutLikeArguments {
  let createBranchName: string | undefined;
  let detach = false;
  let parsingOptions = true;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: [], valueOptions: ['c'] });
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg === '-c') {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      createBranchName = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg === '--detach') {
      detach = true;
      continue;
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new Error(`unknown option: ${arg}`);
    operands.push(arg);
  }
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
