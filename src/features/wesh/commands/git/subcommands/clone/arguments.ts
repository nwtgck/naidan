import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { GitUsageError } from '@/features/wesh/commands/git/errors';

export interface CloneArguments {
  quiet: boolean;
  branchOption: string | undefined;
  depthOption: number | undefined;
  operands: string[];
}

const CLONE_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
      forms: [
        { kind: 'short', name: 'q', value: { kind: 'none' } },
        { kind: 'long', name: 'quiet', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'required-value', key: 'branchOption', parse: undefined },
      forms: [
        { kind: 'short', name: 'b', value: { kind: 'required-attached-or-following', missingValueName: 'branch' } },
        { kind: 'long', name: 'branch', value: { kind: 'required', missingValueName: 'branch' } },
      ],
    },
    {
      semantic: {
        kind: 'required-value',
        key: 'depthOption',
        parse: ({ rawValue }) => {
          if (!/^[0-9]+$/u.test(rawValue) || Number.parseInt(rawValue, 10) <= 0) {
            return { kind: 'invalid', message: `depth ${rawValue} is not a positive number` };
          }
          return { kind: 'parsed', value: Number.parseInt(rawValue, 10) };
        },
      },
      forms: [{ kind: 'long', name: 'depth', value: { kind: 'required', missingValueName: 'depth' } }],
    },
  ],
});

const CLONE_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export function parseCloneArguments({ args }: { args: readonly string[] }): CloneArguments {
  const parsed = parseStandardArgv({ args, catalog: CLONE_ARGV_CATALOG, policy: CLONE_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    switch (diagnostic.kind) {
    case 'missing_option_value':
      throw new GitUsageError({ message: `option '${diagnostic.option}' requires a value` });
    case 'invalid_option_value':
      throw new Error(diagnostic.message);
    case 'unknown_short_option':
    case 'unknown_long_option':
    case 'ambiguous_long_option':
    case 'unexpected_option_value':
      throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled clone argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const branchValue = parsed.optionValues.branchOption;
  const branchOption = typeof branchValue === 'string' ? branchValue : undefined;
  const depthValue = parsed.optionValues.depthOption;
  const depthOption = typeof depthValue === 'number' ? depthValue : undefined;
  const operands = [...parsed.positionals];
  if (operands.length < 1)
    throw new GitUsageError({ message: 'You must specify a repository to clone.', prefix: 'fatal' });
  if (operands.length > 2)
    throw new GitUsageError({ message: 'Too many arguments.', prefix: 'fatal' });
  return { quiet: parsed.optionValues.quiet === true, branchOption, depthOption, operands };
}

export const TEST_ONLY = {
};
