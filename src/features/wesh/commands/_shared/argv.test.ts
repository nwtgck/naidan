import { describe, expect, it } from 'vitest';
import { parseStandardArgv, type ParsedStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  findFirstStandardSemanticIssue,
  standardSemanticIssuePrecedesDiagnostic,
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  stopStandardArgvAtFirstEarlyExit,
  stopStandardOptionParsingAtFirstPositional,
} from './argv';

const spec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'a',
      long: 'all',
      effects: [{ key: 'all', value: true }],
      help: { summary: 'flag' },
    },
    {
      kind: 'value',
      short: 'v',
      long: 'value',
      key: 'value',
      valueName: 'VALUE',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'value', valueName: 'VALUE' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'help' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'version',
      effects: [{ key: 'version', value: true }],
      help: { summary: 'version' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

describe('stopStandardOptionParsingAtFirstPositional', () => {
  it('inserts an option terminator before the first ordinary operand', () => {
    expect(stopStandardOptionParsingAtFirstPositional({
      args: ['-a', 'name', '--all'],
      spec,
    })).toEqual(['-a', '--', 'name', '--all']);
  });

  it('consumes separated and attached required option values before finding the operand', () => {
    expect(stopStandardOptionParsingAtFirstPositional({
      args: ['-v', '-looks-like-option', 'name', '-a'],
      spec,
    })).toEqual(['-v', '-looks-like-option', '--', 'name', '-a']);
    expect(stopStandardOptionParsingAtFirstPositional({
      args: ['-vattached', 'name', '-a'],
      spec,
    })).toEqual(['-vattached', '--', 'name', '-a']);
  });

  it('keeps short flag bundles before the operand', () => {
    expect(stopStandardOptionParsingAtFirstPositional({
      args: ['-aa', 'name', '-a'],
      spec,
    })).toEqual(['-aa', '--', 'name', '-a']);
  });

  it('does not rewrite an explicit option terminator', () => {
    expect(stopStandardOptionParsingAtFirstPositional({
      args: ['-a', '--', '--all'],
      spec,
    })).toEqual(['-a', '--', '--all']);
  });

  it('treats a single dash as the first positional when requested by the command grammar', () => {
    expect(stopStandardOptionParsingAtFirstPositional({
      args: ['-', '-a'],
      spec,
    })).toEqual(['--', '-', '-a']);
  });
});

describe('stopStandardArgvAtFirstEarlyExit', () => {
  it('drops argv after a valid help option', () => {
    expect(stopStandardArgvAtFirstEarlyExit({
      args: ['operand', '--help', '--unknown'],
      spec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    })).toEqual(['operand', '--help']);
  });

  it('keeps an earlier invalid option so its diagnostic wins', () => {
    const args = ['--unknown', '--help'];
    expect(stopStandardArgvAtFirstEarlyExit({
      args,
      spec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    })).toBe(args);
  });

  it('supports first-wins help and version sentinels', () => {
    expect(stopStandardArgvAtFirstEarlyExit({
      args: ['--version', '--help'],
      spec,
      earlyExitOptions: [
        { token: '--help', optionKey: 'help' },
        { token: '--version', optionKey: 'version' },
      ],
    })).toEqual(['--version']);
  });

  it('does not mistake a required value or post-terminator token for help', () => {
    const requiredValue = ['-v', '--help', 'operand'];
    const afterTerminator = ['--', '--help'];
    expect(stopStandardArgvAtFirstEarlyExit({
      args: requiredValue,
      spec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    })).toBe(requiredValue);
    expect(stopStandardArgvAtFirstEarlyExit({
      args: afterTerminator,
      spec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    })).toBe(afterTerminator);
  });
});



describe('standardSemanticIssuePrecedesDiagnostic', () => {
  const semanticIssue = ({ parsed }: { parsed: ParsedStandardArgv }): string | undefined => {
    const occurrence = parsed.occurrences.find(value => value.kind === 'value' && value.key === 'value');
    if (occurrence?.kind !== 'value' || occurrence.value !== 'bad') return undefined;
    return 'bad value';
  };

  it('detects an earlier command semantic issue before a later parser diagnostic', () => {
    const args = ['-v', 'bad', '--unknown'];
    const parsed = parseStandardArgv({ args, spec });
    expect(standardSemanticIssuePrecedesDiagnostic({ args, spec, parsed, findSemanticIssue: semanticIssue }))
      .toBe(true);
  });

  it('keeps an earlier parser diagnostic before a later command semantic issue', () => {
    const args = ['--unknown', '-v', 'bad'];
    const parsed = parseStandardArgv({ args, spec });
    expect(standardSemanticIssuePrecedesDiagnostic({ args, spec, parsed, findSemanticIssue: semanticIssue }))
      .toBe(false);
  });

  it('does not treat an incomplete prefix as a missing-value error', () => {
    const args = ['-v', 'bad', '--unknown'];
    const parsed = parseStandardArgv({ args, spec });
    expect(standardSemanticIssuePrecedesDiagnostic({ args, spec, parsed, findSemanticIssue: semanticIssue }))
      .toBe(true);
  });

  it('does no semantic ordering work without a parser diagnostic', () => {
    const args = ['-v', 'bad'];
    const parsed = parseStandardArgv({ args, spec });
    expect(standardSemanticIssuePrecedesDiagnostic({ args, spec, parsed, findSemanticIssue: semanticIssue }))
      .toBe(false);
  });

  it('preserves an overwritten semantic issue before a later parser diagnostic', () => {
    const finalValueSemanticIssue = ({ parsed: candidate }: { parsed: ParsedStandardArgv }): string | undefined => (
      candidate.optionValues.value === 'bad' ? 'bad value' : undefined
    );
    const args = ['-v', 'bad', '-v', 'good', '--unknown'];
    const parsed = parseStandardArgv({ args, spec });
    expect(standardSemanticIssuePrecedesDiagnostic({
      args,
      spec,
      parsed,
      findSemanticIssue: finalValueSemanticIssue,
    })).toBe(true);
  });

  it('keeps option-looking required values and explicit terminators out of parser diagnostics', () => {
    const valueArgs = ['-v', '--unknown'];
    const valueParsed = parseStandardArgv({ args: valueArgs, spec });
    expect(standardSemanticIssuePrecedesDiagnostic({ args: valueArgs, spec, parsed: valueParsed, findSemanticIssue: semanticIssue }))
      .toBe(false);

    const terminatedArgs = ['--', '-v', 'bad', '--unknown'];
    const terminatedParsed = parseStandardArgv({ args: terminatedArgs, spec });
    expect(standardSemanticIssuePrecedesDiagnostic({ args: terminatedArgs, spec, parsed: terminatedParsed, findSemanticIssue: semanticIssue }))
      .toBe(false);
  });
});



describe('findFirstStandardSemanticIssue', () => {
  const twoValueSpec: StandardArgvParserSpec = {
    options: [
      {
        kind: 'value',
        short: 'a',
        long: 'alpha',
        key: 'alpha',
        valueName: 'VALUE',
        allowAttachedValue: true,
        parseValue: undefined,
        help: { summary: 'alpha', valueName: 'VALUE' },
      },
      {
        kind: 'value',
        short: 'b',
        long: 'beta',
        key: 'beta',
        valueName: 'VALUE',
        allowAttachedValue: true,
        parseValue: undefined,
        help: { summary: 'beta', valueName: 'VALUE' },
      },
    ],
    allowShortFlagBundles: true,
    stopAtDoubleDash: true,
    treatSingleDashAsPositional: true,
    specialTokenParsers: [],
  };

  const semanticIssue = ({ parsed }: { parsed: ParsedStandardArgv }): 'alpha' | 'beta' | undefined => {
    if (parsed.optionValues.alpha === 'bad') return 'alpha';
    if (parsed.optionValues.beta === 'bad') return 'beta';
    return undefined;
  };

  it('returns the issue that first becomes observable in argv order rather than finder priority', () => {
    const args = ['--beta', 'bad', '--alpha', 'bad'];
    const parsed = parseStandardArgv({ args, spec: twoValueSpec });
    expect(findFirstStandardSemanticIssue({
      args,
      spec: twoValueSpec,
      parsed,
      findSemanticIssue: semanticIssue,
    })).toBe('beta');
  });

  it('returns undefined without prefix reparsing when the complete argv has no semantic issue', () => {
    const args = ['--beta', 'good', '--alpha', 'good'];
    const parsed = parseStandardArgv({ args, spec: twoValueSpec });
    expect(findFirstStandardSemanticIssue({
      args,
      spec: twoValueSpec,
      parsed,
      findSemanticIssue: semanticIssue,
    })).toBeUndefined();
  });

  it('preserves an earlier semantic issue hidden by a later value occurrence', () => {
    const args = ['--alpha', 'bad', '--alpha', 'good'];
    const parsed = parseStandardArgv({ args, spec: twoValueSpec });
    expect(parsed.optionValues.alpha).toBe('good');
    expect(findFirstStandardSemanticIssue({
      args,
      spec: twoValueSpec,
      parsed,
      findSemanticIssue: semanticIssue,
    })).toBe('alpha');
  });
});
