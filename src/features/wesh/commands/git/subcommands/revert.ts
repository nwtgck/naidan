import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import type { GitReplayRequest } from "@/features/wesh/commands/git/replay-operation";
import { executeReplay } from "@/features/wesh/commands/git/replay-operation";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { parseReplayControlAction } from "@/features/wesh/commands/git/replay-arguments";

function parseRevertArguments({ args }: { args: readonly string[] }): GitReplayRequest {
  const controlAction = parseReplayControlAction({ args });
  if (controlAction !== undefined)
    return { action: controlAction, operands: [], mainlineParentNumber: undefined };
  const operands: string[] = [];
  let parsingOptions = true;
  let mainlineParentNumber: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg === '--no-edit')
      continue;
    if (parsingOptions && (arg === '-m' || arg === '--mainline')) {
      const value = args[index + 1];
      if (value === undefined || !/^[1-9][0-9]*$/u.test(value))
        throw new GitUsageError({ message: `option '${arg}' requires a positive parent number` });
      mainlineParentNumber = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (parsingOptions && /^-m[1-9][0-9]*$/u.test(arg)) {
      mainlineParentNumber = Number.parseInt(arg.slice(2), 10);
      continue;
    }
    if (parsingOptions && arg.startsWith('--mainline=')) {
      const value = arg.slice('--mainline='.length);
      if (!/^[1-9][0-9]*$/u.test(value))
        throw new GitUsageError({ message: "option '--mainline' requires a positive parent number" });
      mainlineParentNumber = Number.parseInt(value, 10);
      continue;
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new GitUsageError({ message: `unsupported revert option: ${arg}` });
    operands.push(arg);
  }
  if (operands.length === 0)
    throw new GitUsageError({ message: 'usage: git revert [--no-edit] [-m <parent-number>] <commit>...', prefix: 'none' });
  return { action: 'start', operands, mainlineParentNumber };
}

export async function runRevert({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  return executeReplay({ context, request: parseRevertArguments({ args }), kind: 'revert' });
}

export const TEST_ONLY = {
};
