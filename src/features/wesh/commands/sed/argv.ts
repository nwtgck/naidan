import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  type ArgvOptionDefinition,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv-v2';

type SedDeferredOption = 'in-place';
type SedArgvAction = StandardArgvAction<SedDeferredOption>;

const quietOption = {
  semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
  forms: [
    { kind: 'short', name: 'n', value: { kind: 'none' } },
    { kind: 'long', name: 'quiet', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const silentOption = {
  semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
  forms: [{ kind: 'long', name: 'silent', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const expressionOption = {
  semantic: { kind: 'required-value', key: 'expression', parse: undefined },
  forms: [
    {
      kind: 'short',
      name: 'e',
      value: { kind: 'required-attached-or-following', missingValueName: 'script' },
    },
    { kind: 'long', name: 'expression', value: { kind: 'required', missingValueName: 'script' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const scriptFileOption = {
  semantic: { kind: 'required-value', key: 'scriptFile', parse: undefined },
  forms: [
    {
      kind: 'short',
      name: 'f',
      value: { kind: 'required-attached-or-following', missingValueName: 'script-file' },
    },
    { kind: 'long', name: 'file', value: { kind: 'required', missingValueName: 'script-file' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const extendedRegexpShortOption = {
  semantic: { kind: 'effects', effects: [{ key: 'extendedRegexp', value: true }] },
  forms: [{ kind: 'short', name: 'r', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const extendedRegexpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'extendedRegexp', value: true }] },
  forms: [
    { kind: 'short', name: 'E', value: { kind: 'none' } },
    { kind: 'long', name: 'regexp-extended', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const nullDataOption = {
  semantic: { kind: 'effects', effects: [{ key: 'nullData', value: true }] },
  forms: [
    { kind: 'short', name: 'z', value: { kind: 'none' } },
    { kind: 'long', name: 'null-data', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const unbufferedOption = {
  semantic: { kind: 'effects', effects: [{ key: 'unbuffered', value: true }] },
  forms: [
    { kind: 'short', name: 'u', value: { kind: 'none' } },
    { kind: 'long', name: 'unbuffered', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const separateOption = {
  semantic: { kind: 'effects', effects: [{ key: 'separate', value: true }] },
  forms: [
    { kind: 'short', name: 's', value: { kind: 'none' } },
    { kind: 'long', name: 'separate', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const lineLengthOption = {
  semantic: { kind: 'required-value', key: 'lineLength', parse: undefined },
  forms: [
    {
      kind: 'short',
      name: 'l',
      value: { kind: 'required-attached-or-following', missingValueName: 'N' },
    },
    { kind: 'long', name: 'line-length', value: { kind: 'required', missingValueName: 'N' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const inPlaceOption = {
  semantic: { kind: 'deferred', tag: 'in-place' },
  forms: [
    { kind: 'short', name: 'i', value: { kind: 'optional-attached' } },
    { kind: 'long', name: 'in-place', value: { kind: 'optional-inline' } },
  ],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const followSymlinksOption = {
  semantic: { kind: 'effects', effects: [{ key: 'followSymlinks', value: true }] },
  forms: [{ kind: 'long', name: 'follow-symlinks', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const binaryOption = {
  semantic: { kind: 'effects', effects: [] },
  forms: [{ kind: 'long', name: 'binary', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

const helpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<SedArgvAction>;

export const sedArgvCatalog = defineArgvCatalog<SedArgvAction>({
  definitions: [
    quietOption,
    silentOption,
    expressionOption,
    scriptFileOption,
    extendedRegexpShortOption,
    extendedRegexpOption,
    nullDataOption,
    unbufferedOption,
    separateOption,
    lineLengthOption,
    inPlaceOption,
    followSymlinksOption,
    binaryOption,
    helpOption,
  ],
  nonExecutableLongOptions: ['debug', 'posix', 'sandbox', 'version'],
});

export const sedArgvHelp = defineArgvHelpPresentation({
  catalog: sedArgvCatalog,
  rows: [
    {
      forms: [...quietOption.forms, ...silentOption.forms],
      summary: 'suppress automatic printing of pattern space',
      category: 'common',
    },
    {
      forms: expressionOption.forms,
      summary: 'add a script to the commands to be executed',
      valueName: 'script',
      category: 'common',
    },
    {
      forms: scriptFileOption.forms,
      summary: 'add a script file to the commands to be executed',
      valueName: 'script-file',
      category: 'common',
    },
    {
      forms: [...extendedRegexpShortOption.forms, ...extendedRegexpOption.forms],
      summary: 'use extended regular expressions',
      category: 'common',
    },
    {
      forms: nullDataOption.forms,
      summary: 'separate records by NUL characters',
      category: 'advanced',
    },
    {
      forms: unbufferedOption.forms,
      summary: 'flush output more frequently',
      category: 'advanced',
    },
    {
      forms: separateOption.forms,
      summary: 'treat input files as separate streams',
      category: 'advanced',
    },
    {
      forms: lineLengthOption.forms,
      summary: 'specify the desired line-wrap length for the l command',
      valueName: 'N',
      category: 'advanced',
    },
    {
      forms: inPlaceOption.forms,
      summary: 'edit files in place, optionally keeping a backup suffix',
      valueName: 'suffix',
      category: 'advanced',
    },
    {
      forms: followSymlinksOption.forms,
      summary: 'follow symbolic links when processing in place',
      category: 'advanced',
    },
    {
      forms: helpOption.forms,
      summary: 'display this help and exit',
      category: 'common',
    },
  ],
});

export const sedArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
