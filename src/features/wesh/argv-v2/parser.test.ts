import { describe, expect, it } from 'vitest';
import {
  analyzeArgvLongForm,
  analyzeArgvShortForm,
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  parseStandardArgv,
  type ArgvOptionDefinition,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from './index';

const policy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function createFlagCatalog() {
  return defineArgvCatalog<StandardArgvAction<never>>({
    nonExecutableLongOptions: [],
    definitions: [
      {
        semantic: { kind: 'effects', effects: [{ key: 'x', value: true }] },
        forms: [{ kind: 'short', name: 'x', value: { kind: 'none' } }],
      },
      {
        semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
        forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
      },
    ],
  });
}

describe('catalog standard argv parser', () => {
  it('preserves prototype-like semantic keys as ordinary option values', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [{ key: '__proto__', value: true }] },
          forms: [{ kind: 'long', name: 'proto', value: { kind: 'none' } }],
        },
        {
          semantic: { kind: 'required-value', key: '__proto__', parse: undefined },
          forms: [{ kind: 'long', name: 'proto-value', value: { kind: 'required', missingValueName: 'value' } }],
        },
        {
          semantic: { kind: 'required-value', key: 'constructor', parse: undefined },
          forms: [{ kind: 'long', name: 'constructor', value: { kind: 'required', missingValueName: 'value' } }],
        },
      ],
    });

    const empty = parseStandardArgv({ args: [], catalog, policy });
    expect(empty.optionValues.__proto__).toBeUndefined();
    expect(empty.optionValues.constructor).toBeUndefined();
    expect(empty.optionValues.toString).toBeUndefined();

    const parsed = parseStandardArgv({
      args: ['--proto', '--proto-value=stored', '--constructor=value'],
      catalog,
      policy,
    });

    expect(Object.hasOwn(parsed.optionValues, '__proto__')).toBe(true);
    expect(parsed.optionValues.__proto__).toBe('stored');
    expect(Object.hasOwn(parsed.optionValues, 'constructor')).toBe(true);
    expect(parsed.optionValues.constructor).toBe('value');
  });

  it('parses exact flags and short bundles without materializing occurrences', () => {
    const parsed = parseStandardArgv({
      args: ['-xx', '--help', 'operand'],
      catalog: createFlagCatalog(),
      policy,
    });

    expect(parsed.optionValues).toEqual({ x: true, help: true });
    expect(parsed.positionals).toEqual(['operand']);
    expect(parsed.occurrences).toBeUndefined();
    expect(parsed.diagnostics).toEqual([]);
  });

  it('treats single dash and single plus as positionals and stops at double dash', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [{ key: 'x', value: true }] },
          forms: [
            { kind: 'short', name: 'x', value: { kind: 'none' } },
            { kind: 'plus-short', name: 'x', value: { kind: 'none' } },
          ],
        },
      ],
    });
    const parsed = parseStandardArgv({
      args: ['-x', '-', '+', '--', '+x', '-x'],
      catalog,
      policy,
    });

    expect(parsed.optionValues).toEqual({ x: true });
    expect(parsed.positionals).toEqual(['-', '+', '+x', '-x']);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('reports missing required following values using catalog diagnostic metadata', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'required-value', key: 'directory', parse: undefined },
        forms: [
          { kind: 'short', name: 'C', value: { kind: 'required-attached-or-following', missingValueName: 'directory' } },
          { kind: 'long', name: 'directory', value: { kind: 'required', missingValueName: 'directory' } },
        ],
      }],
    });

    expect(parseStandardArgv({ args: ['-C'], catalog, policy }).diagnostics).toMatchObject([{
      kind: 'missing_option_value',
      option: '-C',
      message: '-C requires a value for directory',
    }]);
    expect(parseStandardArgv({ args: ['--directory'], catalog, policy }).diagnostics).toMatchObject([{
      kind: 'missing_option_value',
      option: '--directory',
      message: '--directory requires a value for directory',
    }]);
  });

  it('rejects an inline value for a no-value long flag', () => {
    const parsed = parseStandardArgv({
      args: ['--help=bogus'],
      catalog: createFlagCatalog(),
      policy,
    });

    expect(parsed.optionValues).toEqual({});
    expect(parsed.diagnostics).toMatchObject([
      { kind: 'unexpected_option_value', argvIndex: 0, option: '--help' },
    ]);
  });

  it('keeps compiled catalog data runtime-opaque to callers', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'alpha', value: true }] },
        forms: [{ kind: 'long', name: 'alpha', value: { kind: 'none' } }],
      }],
    });

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.keys(catalog)).toEqual([]);
    expect(parseStandardArgv({ args: ['--alpha'], catalog, policy }).optionValues.alpha).toBe(true);
  });

  it('snapshots catalog syntax and help presentation metadata at definition time', () => {
    const mutableForm = { kind: 'long' as const, name: 'help', value: { kind: 'none' as const } };
    const definitions = [{
      semantic: { kind: 'effects' as const, effects: [{ key: 'help', value: true }] },
      forms: [mutableForm],
    }];
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions,
    });
    const helpRow = { forms: [mutableForm], summary: 'display help' };
    const presentation = defineArgvHelpPresentation({ catalog, rows: [helpRow] });

    mutableForm.name = 'mutated';
    mutableForm.value = { kind: 'none' };
    definitions.push({
      semantic: { kind: 'effects', effects: [{ key: 'later', value: true }] },
      forms: [{ kind: 'long', name: 'later', value: { kind: 'none' } }],
    });
    helpRow.summary = 'mutated summary';

    expect(parseStandardArgv({ args: ['--help'], catalog, policy }).optionValues).toEqual({ help: true });
    expect(parseStandardArgv({ args: ['--mutated', '--later'], catalog, policy }).diagnostics).toHaveLength(2);
    expect(formatArgvOptionHelp({ presentation })).toEqual(['  --help                       display help']);
    expect(formatArgvUsageSummary({ presentation })).toBe('try: --help');
  });

  it('snapshots non-executable resolver metadata at definition time', () => {
    const equivalentNames = ['fixed-regexp', 'fixed-strings'];
    const nonExecutableLongOptions = [{ equivalentNames }];
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions,
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'file', value: true }] },
        forms: [{ kind: 'long', name: 'file', value: { kind: 'none' } }],
      }],
    });

    equivalentNames.splice(0, equivalentNames.length, 'future-option');
    nonExecutableLongOptions.splice(0, nonExecutableLongOptions.length);

    const uniquePrefixPolicy: StandardArgvPolicy = { ...policy, longNameMatch: 'unique-prefix' };
    const ambiguous = parseStandardArgv({ args: ['--fi'], catalog, policy: uniquePrefixPolicy });
    expect(ambiguous.diagnostics).toEqual([{
      kind: 'ambiguous_long_option',
      argvIndex: 0,
      tokenOffset: 0,
      option: '--fi',
      candidateOptions: ['--file', '--fixed-regexp', '--fixed-strings'],
      message: "option '--fi' is ambiguous; possibilities: '--file' '--fixed-regexp' '--fixed-strings'",
    }]);
    expect(parseStandardArgv({ args: ['--future-option'], catalog, policy: uniquePrefixPolicy }).diagnostics)
      .toEqual([{
        kind: 'unknown_long_option',
        argvIndex: 0,
        tokenOffset: 0,
        option: '--future-option',
        message: "unrecognized option '--future-option'",
      }]);
  });

  it('keeps the usage help hint unique and restores it only when truncation hides the help row', () => {
    const definitions = Array.from({ length: 13 }, (_, index) => ({
      semantic: { kind: 'effects' as const, effects: [{ key: `option${index}`, value: true }] },
      forms: [{ kind: 'long' as const, name: index === 12 ? 'help' : `option-${index}`, value: { kind: 'none' as const } }],
    }));
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions,
    });
    const presentation = defineArgvHelpPresentation({
      catalog,
      rows: definitions.map((definition) => ({ forms: definition.forms, summary: 'summary' })),
    });

    const truncated = formatArgvUsageSummary({ presentation });
    expect(truncated.endsWith(', --help')).toBe(true);
    expect(truncated.match(/--help/g)).toHaveLength(1);

    const helpFirstPresentation = defineArgvHelpPresentation({
      catalog,
      rows: [
        { forms: definitions[12]!.forms, summary: 'help' },
        ...definitions.slice(0, 12).map((definition) => ({ forms: definition.forms, summary: 'summary' })),
      ],
    });
    const helpVisible = formatArgvUsageSummary({ presentation: helpFirstPresentation });
    expect(helpVisible.match(/--help/g)).toHaveLength(1);

    const noHelpPresentation = defineArgvHelpPresentation({
      catalog,
      rows: definitions.slice(0, 12).map((definition) => ({ forms: definition.forms, summary: 'summary' })),
    });
    expect(formatArgvUsageSummary({ presentation: noHelpPresentation })).not.toContain('--help');
  });

  it('formats every frozen syntax form without requiring a production consumer', () => {
    const definitions = [
      {
        semantic: { kind: 'effects' as const, effects: [] },
        forms: [{ kind: 'short' as const, name: 'a', value: { kind: 'none' as const } }],
      },
      {
        semantic: { kind: 'effects' as const, effects: [] },
        forms: [{ kind: 'plus-short' as const, name: 'e', value: { kind: 'none' as const } }],
      },
      {
        semantic: { kind: 'required-value' as const, key: 'b', parse: undefined },
        forms: [{ kind: 'short' as const, name: 'b', value: { kind: 'required-attached-or-following' as const, missingValueName: 'ARG' } }],
      },
      {
        semantic: { kind: 'deferred' as const, tag: 'optional-following' as const },
        forms: [{ kind: 'short' as const, name: 'O', value: { kind: 'optional-following' as const } }],
      },
      {
        semantic: { kind: 'deferred' as const, tag: 'optional-attached' as const },
        forms: [{ kind: 'short' as const, name: 'i', value: { kind: 'optional-attached' as const } }],
      },
      {
        semantic: { kind: 'effects' as const, effects: [] },
        forms: [{ kind: 'long' as const, name: 'alpha', value: { kind: 'none' as const } }],
      },
      {
        semantic: { kind: 'required-value' as const, key: 'beta', parse: undefined },
        forms: [{ kind: 'long' as const, name: 'beta', value: { kind: 'required' as const, missingValueName: 'ARG' } }],
      },
      {
        semantic: { kind: 'deferred' as const, tag: 'optional-inline' as const },
        forms: [{ kind: 'long' as const, name: 'color', value: { kind: 'optional-inline' as const } }],
      },
    ] as const;
    const catalog = defineArgvCatalog<StandardArgvAction<string>>({ nonExecutableLongOptions: [], definitions });
    const presentation = defineArgvHelpPresentation({
      catalog,
      rows: [
        { forms: definitions[7].forms, valueName: 'WHEN', summary: 'color', category: 'advanced' },
        { forms: definitions[0].forms, summary: 'alpha short', category: 'common' },
        { forms: definitions[1].forms, summary: 'plus short' },
        { forms: definitions[2].forms, summary: 'required short' },
        { forms: definitions[3].forms, valueName: 'SHOPT', summary: 'optional following' },
        { forms: definitions[4].forms, valueName: 'SUFFIX', summary: 'optional attached' },
        { forms: definitions[5].forms, summary: 'alpha long' },
        { forms: definitions[6].forms, summary: 'required long' },
      ],
    });

    expect(formatArgvOptionHelp({ presentation })).toEqual([
      '  -a                           alpha short',
      '  --color[=WHEN]               color',
      '  +e                           plus short',
      '  -b ARG                       required short',
      '  -O [SHOPT]                   optional following',
      '  -i[SUFFIX]                   optional attached',
      '  --alpha                      alpha long',
      '  --beta=ARG                   required long',
    ]);
  });

  it('rejects empty option definitions and empty help rows', () => {
    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{ semantic: { kind: 'effects', effects: [] }, forms: [] }],
    })).toThrow('Argv option definition must have at least one syntax form');

    const option = {
      semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
      forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    } as const;
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({ nonExecutableLongOptions: [], definitions: [option] });
    expect(() => defineArgvHelpPresentation({
      catalog,
      rows: [{ forms: [], summary: 'invalid empty row' }],
    })).toThrow('Argv help row must have at least one syntax form');
  });

  it('rejects sparse catalog and help-presentation authoring arrays', () => {
    const option = {
      semantic: { kind: 'effects', effects: [] },
      forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    } as const;

    const sparseDefinitions = new Array(1) as unknown as readonly ArgvOptionDefinition<StandardArgvAction<never>>[];
    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: sparseDefinitions,
    })).toThrow('Argv catalog definitions must not contain sparse entries');

    const sparseForms = new Array(1) as unknown as typeof option.forms;
    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{ semantic: option.semantic, forms: sparseForms }],
    })).toThrow('Argv option definition forms must not contain sparse entries');

    const catalog = defineArgvCatalog<StandardArgvAction<never>>({ nonExecutableLongOptions: [], definitions: [option] });
    const sparseRows = new Array(1) as unknown as Parameters<typeof defineArgvHelpPresentation>[0]['rows'];
    expect(() => defineArgvHelpPresentation({ catalog, rows: sparseRows }))
      .toThrow('Argv help rows must not contain sparse entries');

    const sparseHelpForms = new Array(1) as unknown as typeof option.forms;
    expect(() => defineArgvHelpPresentation({
      catalog,
      rows: [{ forms: sparseHelpForms, summary: 'sparse forms' }],
    })).toThrow('Argv help row forms must not contain sparse entries');
  });

  it('requires help rows to reference exact syntax forms from their catalog', () => {
    const option = {
      semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
      forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    } as const;
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({ nonExecutableLongOptions: [], definitions: [option] });

    expect(defineArgvHelpPresentation({
      catalog,
      rows: [{ forms: option.forms, summary: 'display help' }],
    }).rows).toHaveLength(1);

    expect(() => defineArgvHelpPresentation({
      catalog,
      rows: [{
        forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        summary: 'equal spelling but not the catalog form',
      }],
    })).toThrow('Argv help row must reference a syntax form from its catalog');
  });

  it('validates non-executable long-name metadata at catalog definition time', () => {
    const definition = {
      semantic: { kind: 'effects', effects: [] },
      forms: [{ kind: 'long', name: 'recursive', value: { kind: 'none' } }],
    } as const;

    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['reverse', 'reverse'],
      definitions: [definition],
    })).toThrow('Duplicate non-executable long option name: --reverse');

    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['recursive'],
      definitions: [definition],
    })).toThrow('Non-executable long option name duplicates executable option: --recursive');

    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['bad=name'],
      definitions: [definition],
    })).toThrow('Invalid argv long option name');

    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: new Array<string>(1),
      definitions: [definition],
    })).toThrow('Non-executable long options must not contain sparse entries');

    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [{ equivalentNames: ['only-one'] }],
      definitions: [definition],
    })).toThrow('Equivalent non-executable long option group must contain at least two names');

    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [{ equivalentNames: new Array<string>(2) }],
      definitions: [definition],
    })).toThrow('Equivalent non-executable long option names must not contain sparse entries');
  });

  it('accepts a leading hyphen in a real long-name resolver entry', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      // GNU rm exposes the hidden option `---presume-input-tty`.
      nonExecutableLongOptions: ['-presume-input-tty'],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
        forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
      }],
    });

    expect(parseStandardArgv({
      args: ['--=x'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    }).diagnostics).toMatchObject([{
      kind: 'ambiguous_long_option',
      candidateOptions: ['---presume-input-tty', '--help'],
    }]);
  });

  it('fails fast on duplicate spellings in a catalog', () => {
    expect(() => defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [] },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
        {
          semantic: { kind: 'effects', effects: [] },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
      ],
    })).toThrow("Duplicate argv long option: --help");
  });

  it('stops option recognition at the first positional when requested', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'all', value: true }] },
        forms: [{ kind: 'short', name: 'a', value: { kind: 'none' } }],
      }],
    });
    const parsed = parseStandardArgv({
      args: ['-a', 'file', '-a'],
      catalog,
      policy: {
        longNameMatch: 'exact',
        optionBoundary: 'first-positional',
        occurrenceRetention: 'none',
      },
    });

    expect(parsed.optionValues).toEqual({ all: true });
    expect(parsed.positionals).toEqual(['file', '-a']);
  });

  it('retains resolved form identity and raw inline value provenance on demand', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'required-value', key: 'wrap', parse: undefined },
        forms: [
          { kind: 'short', name: 'w', value: { kind: 'required-attached-or-following', missingValueName: 'N' } },
          { kind: 'long', name: 'wrap', value: { kind: 'required', missingValueName: 'N' } },
        ],
      }],
    });
    const parsed = parseStandardArgv({
      args: ['-w12', '--wrap=34'],
      catalog,
      policy: {
        longNameMatch: 'exact',
        optionBoundary: 'continue',
        occurrenceRetention: 'all',
      },
    });

    expect(parsed.optionValues).toEqual({ wrap: '34' });
    expect(parsed.occurrences).toMatchObject([
      {
        resolved: { definitionIndex: 0, formIndex: 0 },
        argvIndex: 0,
        tokenStart: 1,
        tokenEnd: 2,
        value: { kind: 'inline', rawValue: '12', argvIndex: 0, tokenStart: 2, tokenEnd: 4 },
      },
      {
        resolved: { definitionIndex: 0, formIndex: 1 },
        argvIndex: 1,
        tokenStart: 0,
        tokenEnd: 6,
        value: { kind: 'inline', rawValue: '34', argvIndex: 1, tokenStart: 7, tokenEnd: 9 },
      },
    ]);
  });

  it('keeps optional-attached values deferred without inventing command semantics', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<'in-place'>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'deferred', tag: 'in-place' },
        forms: [{ kind: 'short', name: 'i', value: { kind: 'optional-attached' } }],
      }],
    });
    const parsed = parseStandardArgv({
      args: ['-i.bak', '-i'],
      catalog,
      policy,
    });

    expect(parsed.deferred).toMatchObject([
      {
        semantic: { kind: 'deferred', tag: 'in-place' },
        argvIndex: 0,
        value: { kind: 'inline', rawValue: '.bak', argvIndex: 0, tokenStart: 2, tokenEnd: 6 },
      },
      {
        semantic: { kind: 'deferred', tag: 'in-place' },
        argvIndex: 1,
        value: { kind: 'none' },
      },
    ]);
  });

  it('can claim a following argv value and continue the same short token', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<'shell-option'>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: { kind: 'deferred', tag: 'shell-option' },
          forms: [{
            kind: 'short',
            name: 'O',
            value: { kind: 'optional-following' },
          }],
        },
        {
          semantic: { kind: 'effects', effects: [{ key: 'errexit', value: true }] },
          forms: [
            { kind: 'short', name: 'e', value: { kind: 'none' } },
            { kind: 'plus-short', name: 'e', value: { kind: 'none' } },
          ],
        },
      ],
    });
    const parsed = parseStandardArgv({
      args: ['-Oe', 'extglob', 'operand'],
      catalog,
      policy,
    });

    expect(parsed.optionValues).toEqual({ errexit: true });
    expect(parsed.deferred).toMatchObject([{
      semantic: { kind: 'deferred', tag: 'shell-option' },
      argvIndex: 0,
      value: { kind: 'next-argv', rawValue: 'extglob', argvIndex: 1 },
    }]);
    expect(parsed.positionals).toEqual(['operand']);
  });


  it('supports unique-prefix long names and collapses equivalent aliases by definition', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: { kind: 'required-value', key: 'color', parse: undefined },
          forms: [
            { kind: 'long', name: 'color', value: { kind: 'required', missingValueName: 'WHEN' } },
            { kind: 'long', name: 'colour', value: { kind: 'required', missingValueName: 'WHEN' } },
          ],
        },
        {
          semantic: { kind: 'effects', effects: [{ key: 'version', value: true }] },
          forms: [{ kind: 'long', name: 'version', value: { kind: 'none' } }],
        },
        {
          semantic: { kind: 'effects', effects: [{ key: 'versionSort', value: true }] },
          forms: [{ kind: 'long', name: 'version-sort', value: { kind: 'none' } }],
        },
      ],
    });

    const alias = parseStandardArgv({
      args: ['--colo=never'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    });
    expect(alias.optionValues).toEqual({ color: 'never' });
    expect(alias.diagnostics).toEqual([]);

    const exactWins = parseStandardArgv({
      args: ['--version'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    });
    expect(exactWins.optionValues).toEqual({ version: true });
    expect(exactWins.diagnostics).toEqual([]);

    const ambiguous = parseStandardArgv({
      args: ['--ver'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    });
    expect(ambiguous.optionValues).toEqual({});
    expect(ambiguous.diagnostics).toMatchObject([{
      kind: 'ambiguous_long_option',
      option: '--ver',
    }]);

    const exactOnly = parseStandardArgv({
      args: ['--colo=never'],
      catalog,
      policy,
    });
    expect(exactOnly.diagnostics).toMatchObject([{ kind: 'unknown_long_option', option: '--colo=never' }]);
  });

  it('collapses required-value aliases independently of diagnostic labels', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'required-value', key: 'value', parse: undefined },
        forms: [
          { kind: 'long', name: 'alpha-one', value: { kind: 'required', missingValueName: 'FIRST' } },
          { kind: 'long', name: 'alpha-two', value: { kind: 'required', missingValueName: 'SECOND' } },
        ],
      }],
    });
    const uniquePrefixPolicy = { ...policy, longNameMatch: 'unique-prefix' } as const;

    const withValue = parseStandardArgv({
      args: ['--alpha=value'],
      catalog,
      policy: uniquePrefixPolicy,
    });
    expect(withValue.optionValues).toEqual({ value: 'value' });
    expect(withValue.diagnostics).toEqual([]);

    // GNU getopt_long treats aliases with the same required-argument arity and
    // semantic return as equivalent. Wesh-only diagnostic labels do not make the
    // real resolver namespace ambiguous; the first form supplies the diagnostic.
    expect(parseStandardArgv({
      args: ['--alpha'],
      catalog,
      policy: uniquePrefixPolicy,
    }).diagnostics).toMatchObject([{
      kind: 'missing_option_value',
      option: '--alpha-one',
      message: '--alpha-one requires a value for FIRST',
    }]);
  });

  it('resolves an empty GNU long-option prefix when exactly one real name matches', () => {
    const flagCatalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'alpha', value: true }] },
        forms: [{ kind: 'long', name: 'alpha', value: { kind: 'none' } }],
      }],
    });
    const uniquePrefixPolicy = { ...policy, longNameMatch: 'unique-prefix' } as const;

    expect(parseStandardArgv({
      args: ['--=x'],
      catalog: flagCatalog,
      policy: uniquePrefixPolicy,
    }).diagnostics).toMatchObject([{
      kind: 'unexpected_option_value',
      option: '--alpha',
      message: "option '--alpha' doesn't allow an argument",
    }]);

    const valueCatalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'required-value', key: 'alpha', parse: undefined },
        forms: [{ kind: 'long', name: 'alpha', value: { kind: 'required', missingValueName: 'VALUE' } }],
      }],
    });
    expect(parseStandardArgv({
      args: ['--=x'],
      catalog: valueCatalog,
      policy: uniquePrefixPolicy,
    })).toMatchObject({ optionValues: { alpha: 'x' }, diagnostics: [] });
  });

  it('uses the complete long-name namespace for empty unique-prefix diagnostics', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['reverse', 'version'],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
          forms: [{ kind: 'long', name: 'recursive', value: { kind: 'none' } }],
        },
      ],
    });

    expect(parseStandardArgv({
      args: ['--=x'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    }).diagnostics).toMatchObject([{
      kind: 'ambiguous_long_option',
      option: '--=x',
      candidateOptions: ['--recursive', '--reverse', '--version'],
    }]);
  });

  it('keeps unsupported real GNU long names in the abbreviation ambiguity namespace', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['reverse'],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
          forms: [{ kind: 'long', name: 'recursive', value: { kind: 'none' } }],
        },
      ],
    });
    const gnuPolicy: StandardArgvPolicy = {
      ...policy,
      longNameMatch: 'unique-prefix',
    };

    expect(parseStandardArgv({ args: ['--rec'], catalog, policy: gnuPolicy }).optionValues).toEqual({ recursive: true });
    expect(parseStandardArgv({ args: ['--r'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'ambiguous_long_option',
      option: '--r',
      candidateOptions: ['--recursive', '--reverse'],
      message: "option '--r' is ambiguous; possibilities: '--recursive' '--reverse'",
    }]);
    expect(parseStandardArgv({ args: ['--rev'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'unknown_long_option',
      option: '--rev',
    }]);
    expect(parseStandardArgv({ args: ['--reverse'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'unknown_long_option',
      option: '--reverse',
    }]);
  });

  it('preserves ambiguity when only non-executable real long names match a prefix', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['quote-name', 'quoting-style'],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
        forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
      }],
    });

    expect(parseStandardArgv({
      args: ['--q'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    }).diagnostics).toMatchObject([{
      kind: 'ambiguous_long_option',
      option: '--q',
      candidateOptions: ['--quote-name', '--quoting-style'],
    }]);

    expect(parseStandardArgv({
      args: ['--quote-n'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    }).diagnostics).toMatchObject([{
      kind: 'unknown_long_option',
      option: '--quote-n',
    }]);
  });

  it('collapses equivalent non-executable real aliases without hiding distinct ambiguity candidates', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [
        { equivalentNames: ['fixed-regexp', 'fixed-strings'] },
        'file',
      ],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
        forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
      }],
    });
    const gnuPolicy: StandardArgvPolicy = {
      ...policy,
      longNameMatch: 'unique-prefix',
    };

    // GNU grep accepts `--fixed-` because --fixed-regexp and --fixed-strings are
    // resolver-equivalent aliases. Wesh does not implement this semantic in this
    // synthetic catalog, so the resolved unsupported option remains an unknown rather
    // than becoming a false ambiguity.
    expect(parseStandardArgv({ args: ['--fixed-'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'unknown_long_option',
      option: '--fixed-',
    }]);
    expect(parseStandardArgv({ args: ['--fixed-r'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'unknown_long_option',
      option: '--fixed-r',
    }]);
    expect(parseStandardArgv({ args: ['--fixed-regexp'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'unknown_long_option',
      option: '--fixed-regexp',
    }]);

    // A distinct unsupported option matching the same prefix must still preserve the
    // real resolver ambiguity even when two of the spellings collapse together.
    expect(parseStandardArgv({ args: ['--fi'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'ambiguous_long_option',
      option: '--fi',
      candidateOptions: ['--file', '--fixed-regexp', '--fixed-strings'],
    }]);
  });

  it('preserves raw failed long tokens but canonicalizes resolved value diagnostics', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['hello'],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
        forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
      }],
    });
    const gnuPolicy: StandardArgvPolicy = {
      ...policy,
      longNameMatch: 'unique-prefix',
    };

    expect(parseStandardArgv({ args: ['--bogus=x'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'unknown_long_option',
      option: '--bogus=x',
      message: "unrecognized option '--bogus=x'",
    }]);
    expect(parseStandardArgv({ args: ['--he=x'], catalog, policy: gnuPolicy }).diagnostics).toMatchObject([{
      kind: 'ambiguous_long_option',
      option: '--he=x',
    }]);

    const canonical = parseStandardArgv({
      args: ['--help=x'],
      catalog,
      policy: { ...policy, longNameMatch: 'unique-prefix' },
    });
    expect(canonical.diagnostics).toMatchObject([{
      kind: 'unexpected_option_value',
      option: '--help',
      message: "option '--help' doesn't allow an argument",
    }]);
  });

  it('preserves the plus prefix in unknown plus-short diagnostics', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'effects', effects: [] },
        forms: [{ kind: 'plus-short', name: 'O', value: { kind: 'none' } }],
      }],
    });

    expect(parseStandardArgv({ args: ['+Q'], catalog, policy }).diagnostics).toMatchObject([{
      kind: 'unknown_short_option',
      option: '+Q',
    }]);
  });

  it('supports real Bash-style optional following values, plus-prefixed short forms, and cluster continuation', () => {
    type ShellOptionTag = { readonly kind: 'shell-option', readonly enabled: boolean };
    const minusOptions = {
      semantic: { kind: 'deferred', tag: { kind: 'shell-option', enabled: true } },
      forms: [{ kind: 'short', name: 'O', value: { kind: 'optional-following' } }],
    } as const;
    const plusOptions = {
      semantic: { kind: 'deferred', tag: { kind: 'shell-option', enabled: false } },
      forms: [{ kind: 'plus-short', name: 'O', value: { kind: 'optional-following' } }],
    } as const;
    const minusErrexit = {
      semantic: { kind: 'effects', effects: [{ key: 'errexit', value: true }] },
      forms: [{ kind: 'short', name: 'e', value: { kind: 'none' } }],
    } as const;
    const plusErrexit = {
      semantic: { kind: 'effects', effects: [{ key: 'errexit', value: false }] },
      forms: [{ kind: 'plus-short', name: 'e', value: { kind: 'none' } }],
    } as const;
    const catalog = defineArgvCatalog<StandardArgvAction<ShellOptionTag>>({
      nonExecutableLongOptions: [],
      definitions: [minusOptions, plusOptions, minusErrexit, plusErrexit],
    });

    const presentation = defineArgvHelpPresentation({
      catalog,
      rows: [{ forms: [...minusOptions.forms, ...plusOptions.forms], summary: 'set/unset a shell option', valueName: 'SHELLOPT' }],
    });
    expect(formatArgvOptionHelp({ presentation })).toEqual([
      '  -O [SHELLOPT], +O [SHELLOPT] set/unset a shell option',
    ]);

    const minus = parseStandardArgv({ args: ['-Oe', 'extglob'], catalog, policy });
    expect(minus.optionValues).toEqual({ errexit: true });
    expect(minus.deferred).toMatchObject([{
      semantic: { tag: { kind: 'shell-option', enabled: true } },
      argvIndex: 0,
      value: { kind: 'next-argv', rawValue: 'extglob', argvIndex: 1 },
    }]);

    const plus = parseStandardArgv({ args: ['+O', 'extglob'], catalog, policy });
    expect(plus.positionals).toEqual([]);
    expect(plus.deferred).toMatchObject([{
      semantic: { tag: { kind: 'shell-option', enabled: false } },
      argvIndex: 0,
      value: { kind: 'next-argv', rawValue: 'extglob', argvIndex: 1 },
    }]);

    const plusCluster = parseStandardArgv({ args: ['+Oe', 'extglob'], catalog, policy });
    expect(plusCluster.optionValues).toEqual({ errexit: false });
    expect(plusCluster.deferred).toMatchObject([{
      semantic: { tag: { kind: 'shell-option', enabled: false } },
      argvIndex: 0,
      value: { kind: 'next-argv', rawValue: 'extglob', argvIndex: 1 },
    }]);

    const repeated = parseStandardArgv({ args: ['-OO', 'extglob', 'nullglob', 'operand'], catalog, policy });
    expect(repeated.deferred).toMatchObject([
      { argvIndex: 0, value: { kind: 'next-argv', rawValue: 'extglob', argvIndex: 1 } },
      { argvIndex: 0, value: { kind: 'next-argv', rawValue: 'nullglob', argvIndex: 2 } },
    ]);
    expect(repeated.positionals).toEqual(['operand']);

    const bare = parseStandardArgv({ args: ['-O'], catalog, policy });
    expect(bare.deferred).toMatchObject([{
      semantic: { tag: { kind: 'shell-option', enabled: true } },
      value: { kind: 'none' },
    }]);
  });

  it('sources invalid-value diagnostics from the value token', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: {
          kind: 'required-value',
          key: 'count',
          parse: ({ rawValue }) => /^\d+$/.test(rawValue)
            ? { kind: 'parsed', value: Number(rawValue) }
            : { kind: 'invalid', message: 'invalid count' },
        },
        forms: [{ kind: 'short', name: 'n', value: { kind: 'required-attached-or-following', missingValueName: 'COUNT' } }],
      }],
    });
    const parsed = parseStandardArgv({
      args: ['-n', 'bad'],
      catalog,
      policy,
    });

    expect(parsed.optionValues).toEqual({});
    expect(parsed.diagnostics).toEqual([{
      kind: 'invalid_option_value',
      argvIndex: 1,
      tokenOffset: 0,
      option: '-n',
      message: 'invalid count',
    }]);
  });


  it('supports token-local short analysis without owning the caller argv cursor', () => {
    type Semantic =
      | { readonly kind: 'shell-option' }
      | { readonly kind: 'errexit' }
      | { readonly kind: 'lazy-flag' };
    const catalog = defineArgvCatalog<Semantic>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: { kind: 'shell-option' },
          forms: [
            { kind: 'short', name: 'O', value: { kind: 'optional-following' } },
            { kind: 'plus-short', name: 'O', value: { kind: 'optional-following' } },
          ],
        },
        {
          semantic: { kind: 'errexit' },
          forms: [
            { kind: 'short', name: 'e', value: { kind: 'none' } },
            { kind: 'plus-short', name: 'e', value: { kind: 'none' } },
          ],
        },
        {
          semantic: { kind: 'lazy-flag' },
          forms: [{ kind: 'short', name: 'a', value: { kind: 'none' } }],
        },
      ],
    });

    const bashFirst = analyzeArgvShortForm({ token: '-Oe', bodyOffset: 1, prefix: '-', catalog });
    expect(bashFirst).toMatchObject({
      kind: 'matched',
      semantic: { kind: 'shell-option' },
      option: '-O',
      tokenStart: 1,
      tokenEnd: 2,
      nextBodyOffset: 2,
      value: { kind: 'following-optional' },
    });
    const bashSecond = analyzeArgvShortForm({ token: '-Oe', bodyOffset: 2, prefix: '-', catalog });
    expect(bashSecond).toMatchObject({
      kind: 'matched',
      semantic: { kind: 'errexit' },
      option: '-e',
      tokenStart: 2,
      tokenEnd: 3,
      nextBodyOffset: 3,
      value: { kind: 'none' },
    });
    expect(analyzeArgvShortForm({ token: '+Oe', bodyOffset: 1, prefix: '+', catalog })).toMatchObject({
      kind: 'matched',
      semantic: { kind: 'shell-option' },
      option: '+O',
      value: { kind: 'following-optional' },
    });

    expect(analyzeArgvShortForm({ token: '+Q', bodyOffset: 1, prefix: '+', catalog })).toEqual({
      kind: 'unknown',
      option: '+Q',
      tokenOffset: 1,
    });

    // Keep string-based argv diagnostics structurally valid for unknown non-BMP options
    // instead of exposing either UTF-16 surrogate code unit on its own.
    expect(analyzeArgvShortForm({ token: '-😀e', bodyOffset: 1, prefix: '-', catalog })).toEqual({
      kind: 'unknown',
      option: '-😀',
      tokenOffset: 1,
    });
    expect(analyzeArgvShortForm({ token: '+𝒜e', bodyOffset: 1, prefix: '+', catalog })).toEqual({
      kind: 'unknown',
      option: '+𝒜',
      tokenOffset: 1,
    });

    const standardCatalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [{
        semantic: { kind: 'effects', effects: [{ key: 'e', value: true }] },
        forms: [{ kind: 'short', name: 'e', value: { kind: 'none' } }],
      }],
    });
    expect(parseStandardArgv({ args: ['-😀'], catalog: standardCatalog, policy }).diagnostics).toEqual([{
      kind: 'unknown_short_option',
      argvIndex: 0,
      tokenOffset: 1,
      option: '-😀',
      message: "invalid option -- '😀'",
    }]);
    expect(parseStandardArgv({ args: ['-e😀'], catalog: standardCatalog, policy }).diagnostics).toEqual([{
      kind: 'unknown_short_option',
      argvIndex: 0,
      tokenOffset: 2,
      option: '-😀',
      message: "invalid option -- '😀'",
    }]);

    const bashArgs = ['-OO', 'extglob', 'nullglob'] as const;
    const claimedFollowingValues: string[] = [];
    let followingArgvIndex = 1;
    for (let bodyOffset = 1; bodyOffset < bashArgs[0].length;) {
      const analysis = analyzeArgvShortForm({ token: bashArgs[0], bodyOffset, prefix: '-', catalog });
      expect(analysis.kind).toBe('matched');
      if (analysis.kind !== 'matched') throw new Error(`unexpected analysis: ${JSON.stringify(analysis)}`);
      switch (analysis.value.kind) {
      case 'following-optional': {
        const following = bashArgs[followingArgvIndex];
        if (following !== undefined) {
          claimedFollowingValues.push(following);
          followingArgvIndex += 1;
        }
        break;
      }
      case 'none':
      case 'inline':
      case 'following-required':
        throw new Error(`unexpected Bash value claim: ${analysis.value.kind}`);
      default: {
        const _ex: never = analysis.value;
        throw new Error(`Unhandled Bash value claim: ${JSON.stringify(_ex)}`);
      }
      }
      bodyOffset = analysis.nextBodyOffset;
    }
    expect(claimedFollowingValues).toEqual(['extglob', 'nullglob']);
    expect(followingArgvIndex).toBe(3);

    // A command-local lazy grammar can deliberately stop after this one resolved form.
    // The shared analyzer does not force the caller to interpret the `utoskip` suffix.
    expect(analyzeArgvShortForm({ token: '-autoskip', bodyOffset: 1, prefix: '-', catalog })).toMatchObject({
      kind: 'matched',
      semantic: { kind: 'lazy-flag' },
      option: '-a',
      nextBodyOffset: 2,
      value: { kind: 'none' },
    });
  });

  it('keeps required-value diagnostic metadata in token-local claims', () => {
    const catalog = defineArgvCatalog<string>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: 'short-count',
          forms: [{ kind: 'short', name: 'n', value: { kind: 'required-attached-or-following', missingValueName: 'count' } }],
        },
        {
          semantic: 'long-path',
          forms: [{ kind: 'long', name: 'directory', value: { kind: 'required', missingValueName: 'directory' } }],
        },
      ],
    });

    expect(analyzeArgvShortForm({ token: '-n', bodyOffset: 1, prefix: '-', catalog })).toMatchObject({
      kind: 'matched',
      semantic: 'short-count',
      value: { kind: 'following-required', valueName: 'count' },
    });
    expect(analyzeArgvLongForm({ token: '--directory', catalog, longNameMatch: 'exact' })).toMatchObject({
      kind: 'matched',
      semantic: 'long-path',
      value: { kind: 'following-required', valueName: 'directory' },
    });
    expect(() => analyzeArgvShortForm({ token: '-n', bodyOffset: 2, prefix: '-', catalog })).toThrow(
      'Invalid argv short-form analysis coordinates',
    );
  });

  it('supports token-local long analysis with the same real resolver namespace', () => {
    type Semantic = { readonly kind: 'recursive' } | { readonly kind: 'help' };
    const catalog = defineArgvCatalog<Semantic>({
      nonExecutableLongOptions: ['quote-name', 'quoting-style', 'reverse'],
      definitions: [
        {
          semantic: { kind: 'recursive' },
          forms: [{ kind: 'long', name: 'recursive', value: { kind: 'none' } }],
        },
        {
          semantic: { kind: 'help' },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
      ],
    });

    expect(analyzeArgvLongForm({ token: '--rec', catalog, longNameMatch: 'unique-prefix' })).toMatchObject({
      kind: 'matched',
      semantic: { kind: 'recursive' },
      option: '--recursive',
      value: { kind: 'none' },
    });
    expect(analyzeArgvLongForm({ token: '--r', catalog, longNameMatch: 'unique-prefix' })).toEqual({
      kind: 'ambiguous',
      option: '--r',
      candidateOptions: ['--recursive', '--reverse'],
    });
    expect(analyzeArgvLongForm({ token: '--r=x', catalog, longNameMatch: 'unique-prefix' })).toEqual({
      kind: 'ambiguous',
      option: '--r=x',
      candidateOptions: ['--recursive', '--reverse'],
    });
    expect(analyzeArgvLongForm({ token: '--reverse', catalog, longNameMatch: 'unique-prefix' })).toEqual({
      kind: 'unknown',
      option: '--reverse',
    });
    expect(analyzeArgvLongForm({ token: '--q', catalog, longNameMatch: 'unique-prefix' })).toEqual({
      kind: 'ambiguous',
      option: '--q',
      candidateOptions: ['--quote-name', '--quoting-style'],
    });
    expect(analyzeArgvLongForm({ token: '--help=value', catalog, longNameMatch: 'exact' })).toMatchObject({
      kind: 'matched',
      semantic: { kind: 'help' },
      option: '--help',
      value: { kind: 'unexpected-inline', rawValue: 'value' },
    });
  });

});
