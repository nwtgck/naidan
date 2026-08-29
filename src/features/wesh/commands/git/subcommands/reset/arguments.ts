import { GitUsageError } from '@/features/wesh/commands/git/errors';

type ResetMode = 'soft' | 'mixed' | 'hard';
export function parseResetArguments({ args }: {
    args: readonly string[];
}): {
    mode: ResetMode;
    revisionExpression: string;
    pathOperands: readonly string[] | undefined;
} {
  let mode: ResetMode = 'mixed';
  let revisionExpression = 'HEAD';
  let hasRevision = false;
  let pathOperands: readonly string[] | undefined;
  const separatorIndex = args.indexOf('--');
  const optionAndRevisionArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  if (separatorIndex >= 0) {
    const operands = args.slice(separatorIndex + 1);
    if (operands.length > 0)
      pathOperands = operands;
  }
  for (const arg of optionAndRevisionArgs) {
    if (arg === '--soft')
      mode = 'soft';
    else if (arg === '--mixed')
      mode = 'mixed';
    else if (arg === '--hard')
      mode = 'hard';
    else if (arg.startsWith('-'))
      throw new GitUsageError({ message: `unknown option: ${arg}` });
    else if (!hasRevision) {
      revisionExpression = arg;
      hasRevision = true;
    } else {
      throw new Error('too many revisions');
    }
  }
  if (pathOperands !== undefined && mode !== 'mixed')
    throw new Error(`Cannot do ${mode} reset with paths.`);
  return { mode, revisionExpression, pathOperands };
}

export const TEST_ONLY = {
};
