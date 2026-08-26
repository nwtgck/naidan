import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import type { GitReplayRequest } from "@/features/wesh/commands/git/replay-operation";
import { executeReplay } from "@/features/wesh/commands/git/replay-operation";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";

function parseCherryPickArguments({ args }: { args: readonly string[] }): GitReplayRequest {
  if (args.length === 1 && args[0] === '--continue')
    return { action: 'continue', operands: [], mainlineParentNumber: undefined };
  if (args.length === 1 && args[0] === '--abort')
    return { action: 'abort', operands: [], mainlineParentNumber: undefined };
  if (args.length === 1 && args[0] === '--skip')
    return { action: 'skip', operands: [], mainlineParentNumber: undefined };
  const operands: string[] = [];
  let mainlineParentNumber: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--no-edit')
      continue;
    if (arg === '-m' || arg === '--mainline') {
      const value = args[index + 1];
      if (value === undefined || !/^[1-9][0-9]*$/u.test(value))
        throw new Error(`option '${arg}' requires a positive parent number`);
      mainlineParentNumber = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (/^-m[1-9][0-9]*$/u.test(arg)) {
      mainlineParentNumber = Number.parseInt(arg.slice(2), 10);
      continue;
    }
    if (arg.startsWith('--mainline=')) {
      const value = arg.slice('--mainline='.length);
      if (!/^[1-9][0-9]*$/u.test(value))
        throw new Error("option '--mainline' requires a positive parent number");
      mainlineParentNumber = Number.parseInt(value, 10);
      continue;
    }
    if (arg.startsWith('-'))
      throw new Error(`unsupported cherry-pick option: ${arg}`);
    operands.push(arg);
  }
  if (operands.length === 0)
    throw new Error('cherry-pick requires at least one commit');
  return { action: 'start', operands, mainlineParentNumber };
}

export async function runCherryPick({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  return executeReplay({ context, request: parseCherryPickArguments({ args }), kind: 'cherry-pick' });
}

export const TEST_ONLY = {
};
