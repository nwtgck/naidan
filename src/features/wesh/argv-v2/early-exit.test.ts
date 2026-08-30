import { describe, expect, it } from 'vitest';
import {
  defineArgvCatalog,
  HELP_EARLY_EXIT_OPTIONS,
  HELP_VERSION_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from './index';

const prefixPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

const helpCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: ['version'],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
      forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'required-value', key: 'output', parse: undefined },
      forms: [{ kind: 'long', name: 'output', value: { kind: 'required', missingValueName: 'FILE' } }],
    },
  ],
});

describe('shared early-exit option constants', () => {
  it('are runtime-immutable because they are reused across commands', () => {
    expect(Object.isFrozen(HELP_EARLY_EXIT_OPTIONS)).toBe(true);
    expect(Object.isFrozen(HELP_VERSION_EARLY_EXIT_OPTIONS)).toBe(true);
    expect(HELP_EARLY_EXIT_OPTIONS.every(option => Object.isFrozen(option))).toBe(true);
    expect(HELP_VERSION_EARLY_EXIT_OPTIONS.every(option => Object.isFrozen(option))).toBe(true);
  });
});

describe('stopArgvAtFirstEarlyExit', () => {
  it('accepts a uniquely resolved abbreviated help and drops later argv', () => {
    expect(stopArgvAtFirstEarlyExit({
      args: ['--he', '--bogus'],
      catalog: helpCatalog,
      policy: prefixPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    })).toEqual(['--he']);
  });

  it('does not treat an ambiguous prefix as help', () => {
    const ambiguousCatalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['hello'],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
      ],
    });
    expect(stopArgvAtFirstEarlyExit({
      args: ['--hel', '--bogus'],
      catalog: ambiguousCatalog,
      policy: prefixPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    })).toEqual(['--hel', '--bogus']);
  });

  it('uses parsed prefix values for exact configured early-exit tokens', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: {
            kind: 'required-value',
            key: 'help',
            parse: ({ rawValue }) => ({ kind: 'parsed', value: rawValue === 'true' }),
          },
          forms: [{ kind: 'long', name: 'mode', value: { kind: 'required', missingValueName: 'VALUE' } }],
        },
      ],
    });

    expect(stopArgvAtFirstEarlyExit({
      args: ['--mode=true', '--bogus'],
      catalog,
      policy: prefixPolicy,
      earlyExitOptions: [{ token: '--mode=true', optionKey: 'help' }],
    })).toEqual(['--mode=true']);
  });

  it('allows a current-candidate missing value to be satisfied before a later terminal option', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: {
            kind: 'required-value',
            key: 'mode',
            parse: ({ rawValue }) => ({ kind: 'parsed', value: rawValue === 'true' }),
          },
          forms: [{ kind: 'long', name: 'mode', value: { kind: 'required', missingValueName: 'BOOL' } }],
        },
        {
          semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
      ],
    });
    const args = ['--mode', 'true', '--help', '--bogus'];
    expect(stopArgvAtFirstEarlyExit({
      args,
      catalog,
      policy: prefixPolicy,
      earlyExitOptions: [
        { token: '--mode', optionKey: 'mode' },
        { token: '--help', optionKey: 'help' },
      ],
    })).toEqual(['--mode', 'true', '--help']);
  });

  it('does not steal a token already claimed as a required value', () => {
    const args = ['--output', '--help', '--help', '--bogus'];
    expect(stopArgvAtFirstEarlyExit({
      args,
      catalog: helpCatalog,
      policy: prefixPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    })).toEqual(['--output', '--help', '--help']);
    expect(parseStandardArgv({ args: ['--output', '--help'], catalog: helpCatalog, policy: prefixPolicy }).diagnostics).toEqual([]);
  });


  it('does not steal a token claimed by optional-following short forms', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<'bash-option'>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
        {
          semantic: { kind: 'deferred', tag: 'bash-option' },
          forms: [
            { kind: 'short', name: 'O', value: { kind: 'optional-following' } },
            { kind: 'plus-short', name: 'O', value: { kind: 'optional-following' } },
          ],
        },
      ],
    });

    for (const token of ['-O', '+O']) {
      const args = [token, '--help', '--help', '--bogus'];
      expect(stopArgvAtFirstEarlyExit({
        args,
        catalog,
        policy: prefixPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      })).toEqual([token, '--help', '--help']);
      expect(parseStandardArgv({ args: [token, '--help'], catalog, policy: prefixPolicy }).diagnostics).toEqual([]);
    }
  });


  it('keeps scanning when a candidate is an option occurrence but does not enable its early-exit key', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: [],
      definitions: [
        {
          semantic: {
            kind: 'required-value',
            key: 'mode',
            parse: ({ rawValue }) => ({ kind: 'parsed', value: rawValue === 'true' }),
          },
          forms: [{ kind: 'long', name: 'mode', value: { kind: 'required', missingValueName: 'BOOL' } }],
        },
        {
          semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
      ],
    });
    const args = ['--mode=false', '--help', '--bogus'];
    expect(stopArgvAtFirstEarlyExit({
      args,
      catalog,
      policy: prefixPolicy,
      earlyExitOptions: [
        { token: '--mode=false', optionKey: 'mode' },
        { token: '--help', optionKey: 'help' },
      ],
    })).toEqual(['--mode=false', '--help']);
  });


  it('does not infer a durable boundary from positional candidates under continue scanning', () => {
    for (const token of ['operand', '+mode', '-']) {
      const args = [token, '--help', '--bogus'];
      expect(stopArgvAtFirstEarlyExit({
        args,
        catalog: helpCatalog,
        policy: prefixPolicy,
        earlyExitOptions: [
          { token, optionKey: 'nonTerminal' },
          { token: '--help', optionKey: 'help' },
        ],
      })).toEqual([token, '--help']);
    }
  });


  it('preserves an earlier diagnostic instead of promoting a later help token', () => {
    const args = ['--bogus', '--he'];
    expect(stopArgvAtFirstEarlyExit({
      args,
      catalog: helpCatalog,
      policy: prefixPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    })).toEqual(args);
  });

  it('preserves earlier ambiguity and invalid-value diagnostics before later help', () => {
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      nonExecutableLongOptions: ['quote-name', 'quoting-style'],
      definitions: [
        {
          semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
          forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
        },
        {
          semantic: {
            kind: 'required-value',
            key: 'lines',
            parse: ({ rawValue }) => rawValue === 'bad'
              ? { kind: 'invalid', message: `invalid line count: ${rawValue}` }
              : { kind: 'parsed', value: rawValue },
          },
          forms: [{ kind: 'long', name: 'lines', value: { kind: 'required', missingValueName: 'COUNT' } }],
        },
      ],
    });

    for (const args of [
      ['--q', '--help'],
      ['--lines=bad', '--help'],
    ]) {
      expect(stopArgvAtFirstEarlyExit({
        args,
        catalog,
        policy: prefixPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      })).toEqual(args);
      expect(parseStandardArgv({ args, catalog, policy: prefixPolicy }).diagnostics).toHaveLength(1);
    }
  });

  it('does not promote a help-looking token after the explicit option terminator', () => {
    const args = ['--', '--he', '--bogus'];
    expect(stopArgvAtFirstEarlyExit({
      args,
      catalog: helpCatalog,
      policy: prefixPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    })).toEqual(args);
  });

  it('does not promote a help-looking token after a first-positional boundary', () => {
    const args = ['operand', '--he', '--bogus'];
    expect(stopArgvAtFirstEarlyExit({
      args,
      catalog: helpCatalog,
      policy: { ...prefixPolicy, optionBoundary: 'first-positional' },
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    })).toEqual(args);
  });
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
