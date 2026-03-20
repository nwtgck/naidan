import { describe, expect, it } from 'vitest';
import { parseFindLikeArgv, parseStandardArgv, parseSubcommandArgv } from './argv';

describe('wesh argv', () => {
  it('parses bundled short flags and value options', () => {
    const parsed = parseStandardArgv({
      args: ['-abn10', '--label=value', 'file.txt'],
      spec: {
        options: [
          { kind: 'flag', short: 'a', long: 'all', effects: [{ key: 'all', value: true }], help: { summary: 'test all flag' } },
          { kind: 'flag', short: 'b', long: 'binary', effects: [{ key: 'binary', value: true }], help: { summary: 'test binary flag' } },
          {
            kind: 'value',
            short: 'n',
            long: 'number',
            key: 'number',
            valueName: 'number',
            allowAttachedValue: true,
            parseValue: ({ value }) => ({ ok: true, value: parseInt(value, 10) }),
            help: { summary: 'test numeric value', valueName: 'NUMBER' },
          },
          {
            kind: 'value',
            short: undefined,
            long: 'label',
            key: 'label',
            valueName: 'label',
            allowAttachedValue: true,
            parseValue: undefined,
            help: { summary: 'test label value', valueName: 'LABEL' },
          },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: false,
        specialTokenParsers: [],
      },
    });

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.optionValues).toEqual({
      all: true,
      binary: true,
      number: 10,
      label: 'value',
    });
    expect(parsed.positionals).toEqual(['file.txt']);
    expect(parsed.occurrences).toEqual([
      { kind: 'flag', option: '-a', effects: [{ key: 'all', value: true }] },
      { kind: 'flag', option: '-b', effects: [{ key: 'binary', value: true }] },
      { kind: 'value', option: '-n', key: 'number', value: 10 },
      { kind: 'value', option: '--label', key: 'label', value: 'value' },
    ]);
  });

  it('preserves repeated value option occurrences in order', () => {
    const parsed = parseStandardArgv({
      args: ['-e', 'alpha', '--regexp=beta', '-e', 'gamma'],
      spec: {
        options: [
          {
            kind: 'value',
            short: 'e',
            long: 'regexp',
            key: 'regexp',
            valueName: 'pattern',
            allowAttachedValue: true,
            parseValue: undefined,
            help: { summary: 'test repeated value option', valueName: 'PATTERN' },
          },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: false,
        specialTokenParsers: [],
      },
    });

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.optionValues.regexp).toBe('gamma');
    expect(parsed.occurrences).toEqual([
      { kind: 'value', option: '-e', key: 'regexp', value: 'alpha' },
      { kind: 'value', option: '--regexp', key: 'regexp', value: 'beta' },
      { kind: 'value', option: '-e', key: 'regexp', value: 'gamma' },
    ]);
  });

  it('supports nested subcommands with per-command parsing', () => {
    const parsed = parseSubcommandArgv({
      args: ['remote', 'add', '--verbose', 'origin'],
      spec: {
        name: 'git',
        parser: {
          kind: 'standard',
          spec: {
            options: [],
            allowShortFlagBundles: true,
            stopAtDoubleDash: true,
            treatSingleDashAsPositional: false,
            specialTokenParsers: [],
          },
        },
        subcommands: {
          remote: {
            name: 'remote',
            parser: {
              kind: 'standard',
              spec: {
                options: [],
                allowShortFlagBundles: true,
                stopAtDoubleDash: true,
                treatSingleDashAsPositional: false,
                specialTokenParsers: [],
              },
            },
            subcommands: {
              add: {
                name: 'add',
                parser: {
                  kind: 'standard',
                  spec: {
                    options: [
                      {
                        kind: 'flag',
                        short: undefined,
                        long: 'verbose',
                        effects: [{ key: 'verbose', value: true }],
                        help: { summary: 'test verbose flag' },
                      },
                    ],
                    allowShortFlagBundles: true,
                    stopAtDoubleDash: true,
                    treatSingleDashAsPositional: false,
                    specialTokenParsers: [],
                  },
                },
                subcommands: {},
              },
            },
          },
        },
      },
    });

    expect(parsed.matchedSubcommands).toEqual(['remote', 'add']);
    expect(parsed.activeCommand).toBe('add');
    expect(parsed.parsed?.optionValues).toEqual({ verbose: true });
    expect(parsed.parsed?.positionals).toEqual(['origin']);
  });

  it('splits find-style path arguments from expression tokens', () => {
    const parsed = parseFindLikeArgv({
      args: ['src', 'tests', '(', '-name', '*.ts', '-o', '-name', '*.tsx', ')', '-type', 'f'],
    });

    expect(parsed.paths).toEqual(['src', 'tests']);
    expect(parsed.expressionTokens).toEqual(['(', '-name', '*.ts', '-o', '-name', '*.tsx', ')', '-type', 'f']);
  });
});
