import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';

type ResetMode = 'soft' | 'mixed' | 'hard';

const RESET_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  // Linux Git 2.47.3 treats --patch/--no-patch as exact-only spellings: they do not
  // participate in long-option prefix resolution. Wesh does not implement patch reset,
  // so leave those exact-only options outside this prefix-resolver catalog.
  nonExecutableLongOptions: [
    'quiet', 'no-quiet', 'no-refresh', 'refresh', 'merge', 'keep',
    'recurse-submodules', 'no-recurse-submodules',
    'intent-to-add', 'no-intent-to-add', 'pathspec-from-file', 'no-pathspec-from-file',
    'pathspec-file-nul', 'no-pathspec-file-nul',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'soft' }] },
      forms: [{ kind: 'long', name: 'soft', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'mixed' }] },
      forms: [{ kind: 'long', name: 'mixed', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'hard' }] },
      forms: [{ kind: 'long', name: 'hard', value: { kind: 'none' } }],
    },
  ],
});

const RESET_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function throwResetDiagnostic({ args, diagnostic }: {
  args: readonly string[],
  diagnostic: ReturnType<typeof parseStandardArgv>['diagnostics'][number],
}): never {
  switch (diagnostic.kind) {
  case 'ambiguous_long_option':
    throw new GitUsageError({
      message: formatGitAmbiguousLongOption({
        option: diagnostic.option,
        candidateOptions: diagnostic.candidateOptions,
      }),
    });
  case 'unknown_short_option':
  case 'unknown_long_option':
  case 'missing_option_value':
  case 'unexpected_option_value':
  case 'invalid_option_value':
    throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
  default: {
    const _ex: never = diagnostic;
    throw new Error(`Unhandled reset argv diagnostic: ${JSON.stringify(_ex)}`);
  }
  }
}

export function parseResetArguments({ args }: {
  args: readonly string[];
}): {
  mode: ResetMode;
  revisionExpression: string;
  pathOperands: readonly string[] | undefined;
} {
  const separatorIndex = args.indexOf('--');
  const optionAndRevisionArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  const operandsAfterSeparator = separatorIndex < 0 ? [] : args.slice(separatorIndex + 1);
  const parsed = parseStandardArgv({
    args: optionAndRevisionArgs,
    catalog: RESET_ARGV_CATALOG,
    policy: RESET_ARGV_POLICY,
  });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined)
    throwResetDiagnostic({ args: optionAndRevisionArgs, diagnostic });

  const modeValue = parsed.optionValues.mode;
  const mode: ResetMode = modeValue === 'soft' || modeValue === 'hard' ? modeValue : 'mixed';
  if (parsed.positionals.length > 1)
    throw new Error('too many revisions');
  const revisionExpression = parsed.positionals[0] ?? 'HEAD';
  const pathOperands = operandsAfterSeparator.length > 0 ? operandsAfterSeparator : undefined;
  if (pathOperands !== undefined && mode !== 'mixed')
    throw new Error(`Cannot do ${mode} reset with paths.`);
  return { mode, revisionExpression, pathOperands };
}

export const TEST_ONLY = {
};
