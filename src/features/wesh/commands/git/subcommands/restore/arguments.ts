import { GitUsageError } from '@/features/wesh/commands/git/errors';

import type { RestoreRequest } from "@/features/wesh/commands/git/restore-operation";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export function parseRestoreArguments({ args }: {
    args: readonly string[];
}): RestoreRequest {
  let staged = false;
  let worktree = false;
  let sourceExpression: string | undefined;
  let parsingOptions = true;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['S', 'W'], valueOptions: ['s'] });
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '--staged' || arg === '-S')) {
      staged = true;
      continue;
    }
    if (parsingOptions && (arg === '--worktree' || arg === '-W')) {
      worktree = true;
      continue;
    }
    if (parsingOptions && (arg === '--source' || arg === '-s')) {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new GitUsageError({ message: `option '${arg}' requires a value` });
      sourceExpression = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--source=')) {
      sourceExpression = arg.slice('--source='.length);
      if (sourceExpression.length === 0)
        throw new GitUsageError({ message: "option '--source' requires a value" });
      continue;
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new GitUsageError({ message: `unknown option: ${arg}` });
    operands.push(arg);
  }
  if (!staged && !worktree)
    worktree = true;
  if (operands.length === 0)
    throw new Error('you must specify path(s) to restore');
  return { staged, worktree, sourceExpression, operands };
}

export const TEST_ONLY = {
};
