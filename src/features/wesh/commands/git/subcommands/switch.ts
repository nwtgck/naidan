import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import type { CheckoutLikeArguments } from "@/features/wesh/commands/git/checkout-like";
import { executeCheckoutLike } from "@/features/wesh/commands/git/checkout-like";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";

function parseSwitchArguments({ args }: { args: readonly string[] }): CheckoutLikeArguments {
  let createBranchName: string | undefined;
  let detach = false;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-c') {
      const value = args[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      createBranchName = value;
      index += 1;
      continue;
    }
    if (arg === '--detach') {
      detach = true;
      continue;
    }
    if (arg === '--')
      throw new Error('path checkout is not supported by git switch yet');
    if (arg.startsWith('-'))
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
