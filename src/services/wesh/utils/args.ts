import { parseStandardArgv } from '@/services/wesh/argv';

export function parseFlags({
  args,
  booleanFlags,
  stringFlags,
}: {
  args: string[];
  booleanFlags: string[];
  stringFlags: string[];
}): {
  flags: Record<string, string | boolean>;
  positional: string[];
  unknown: string[];
} {
  const parsed = parseStandardArgv({
    args,
    spec: {
      options: [
        ...booleanFlags.map((flag) => ({
          kind: 'flag' as const,
          short: flag,
          long: flag,
          effects: [{ key: flag, value: true }],
        })),
        ...stringFlags.map((flag) => ({
          kind: 'value' as const,
          short: flag,
          long: flag,
          key: flag,
          valueName: flag,
          allowAttachedValue: true,
          parseValue: undefined,
        })),
      ],
      allowShortFlagBundles: true,
      stopAtDoubleDash: true,
      treatSingleDashAsPositional: false,
      specialTokenParsers: [],
    },
  });

  return {
    flags: parsed.optionValues as Record<string, string | boolean>,
    positional: parsed.positionals,
    unknown: parsed.diagnostics
      .filter((diagnostic) => diagnostic.kind === 'unknown-short-option' || diagnostic.kind === 'unknown-long-option')
      .map((diagnostic) => diagnostic.option.replace(/^-+/, '')),
  };
}
