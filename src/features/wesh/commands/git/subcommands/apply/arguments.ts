import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const APPLY_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
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
  longNameMatch: 'exact',
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
    throw new GitUsageError({ message: `unknown option for git apply: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
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
