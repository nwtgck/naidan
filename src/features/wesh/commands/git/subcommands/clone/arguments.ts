import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';

export interface CloneArguments {
  quiet: boolean;
  branchOption: string | undefined;
  depthOption: number | undefined;
  operands: string[];
}

const CLONE_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'verbose', 'no-verbose', 'no-quiet',
    'progress', 'no-progress', 'reject-shallow', 'no-reject-shallow',
    'no-checkout', 'checkout', 'bare', 'no-bare', 'mirror', 'no-mirror',
    'local', 'no-local', 'no-hardlinks', 'hardlinks', 'shared', 'no-shared',
    'recurse-submodules', 'no-recurse-submodules', 'recursive', 'no-recursive',
    'jobs', 'no-jobs', 'template', 'no-template', 'reference', 'no-reference',
    'reference-if-able', 'no-reference-if-able', 'dissociate', 'no-dissociate',
    'origin', 'no-origin', 'no-branch', 'upload-pack', 'no-upload-pack', 'no-depth',
    'shallow-since', 'no-shallow-since', 'shallow-exclude', 'no-shallow-exclude',
    'single-branch', 'no-single-branch', 'no-tags', 'tags',
    'shallow-submodules', 'no-shallow-submodules', 'separate-git-dir', 'no-separate-git-dir',
    'ref-format', 'no-ref-format', 'config', 'no-config', 'server-option', 'no-server-option',
    'ipv4', 'ipv6', 'filter', 'no-filter', 'also-filter-submodules', 'no-also-filter-submodules',
    'remote-submodules', 'no-remote-submodules', 'sparse', 'no-sparse', 'bundle-uri', 'no-bundle-uri',
  ],
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
  longNameMatch: 'unique-prefix',
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
    case 'ambiguous_long_option':
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: diagnostic.option,
          candidateOptions: diagnostic.candidateOptions,
        }),
      });
    case 'unknown_short_option':
    case 'unknown_long_option':
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
