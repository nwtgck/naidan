import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const APPLY_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'exclude', 'include', 'no-add', 'add', 'stat', 'no-stat', 'numstat', 'no-numstat',
    'summary', 'no-summary', 'no-check', 'no-index', 'intent-to-add', 'no-intent-to-add',
    'no-cached', 'unsafe-paths', 'no-unsafe-paths', 'apply', 'no-apply', '3way', 'no-3way',
    'ours', 'theirs', 'union', 'build-fake-ancestor', 'no-build-fake-ancestor',
    'whitespace', 'no-whitespace', 'ignore-space-change', 'no-ignore-space-change',
    'ignore-whitespace', 'no-ignore-whitespace', 'no-reverse', 'unidiff-zero', 'no-unidiff-zero',
    'reject', 'no-reject', 'allow-overlap', 'no-allow-overlap', 'verbose', 'no-verbose',
    'quiet', 'no-quiet', 'inaccurate-eof', 'no-inaccurate-eof', 'recount', 'no-recount',
    'directory', 'no-directory', 'allow-empty', 'no-allow-empty',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'reverse', value: true }] },
      forms: [
        { kind: 'short', name: 'R', value: { kind: 'none' } },
        { kind: 'long', name: 'reverse', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'cached', value: true }] },
      forms: [{ kind: 'long', name: 'cached', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'check', value: true }] },
      forms: [{ kind: 'long', name: 'check', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'index', value: true }] },
      forms: [{ kind: 'long', name: 'index', value: { kind: 'none' } }],
    },
  ],
});

const APPLY_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

interface ApplyArguments {
  cached: boolean,
  check: boolean,
  index: boolean,
  reverse: boolean,
  inputPath: string | undefined,
}

export function parseApplyArguments({ args }: { args: readonly string[] }): ApplyArguments {
  const parsed = parseStandardArgv({ args, catalog: APPLY_ARGV_CATALOG, policy: APPLY_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
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
      throw new GitUsageError({ message: `unknown option for git apply: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  if (parsed.positionals.length > 1)
    throw new Error('git apply accepts at most one patch input');
  return {
    cached: parsed.optionValues.cached === true,
    check: parsed.optionValues.check === true,
    index: parsed.optionValues.index === true,
    reverse: parsed.optionValues.reverse === true,
    inputPath: parsed.positionals[0],
  };
}

export const TEST_ONLY = {
};
