
import type { RestoreRequest } from "@/features/wesh/commands/git/restore-operation";

export function parseRestoreArguments({ args }: {
    args: readonly string[];
}): RestoreRequest {
  let staged = false;
  let worktree = false;
  let sourceExpression: string | undefined;
  let parsingOptions = true;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
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
      const value = args[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      sourceExpression = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--source=')) {
      sourceExpression = arg.slice('--source='.length);
      if (sourceExpression.length === 0)
        throw new Error("option '--source' requires a value");
      continue;
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new Error(`unknown option: ${arg}`);
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
