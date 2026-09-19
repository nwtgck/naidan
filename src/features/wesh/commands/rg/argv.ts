import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  parseStandardArgv,
  type ArgvOptionDefinition,
  type StandardArgvAction,
  type StandardArgvPolicy,
  type StandardArgvRawValue,
} from '@/features/wesh/argv-v2';

export type RgCaseMode = 'sensitive' | 'insensitive' | 'smart';
export type RgOutputMode = 'normal' | 'files-with-matches' | 'files-without-match' | 'count-lines' | 'count-matches';
export type RgSortMode = 'default' | 'path' | 'path-reverse';

export interface RgParsedArgv {
  readonly pattern: string | undefined,
  readonly paths: readonly string[],
  readonly fixedStrings: boolean,
  readonly caseMode: RgCaseMode,
  readonly wordRegexp: boolean,
  readonly lineNumber: boolean | undefined,
  readonly column: boolean,
  readonly byteOffset: boolean,
  readonly withFilename: boolean | undefined,
  readonly outputMode: RgOutputMode,
  readonly onlyMatching: boolean,
  readonly invertMatch: boolean,
  readonly lineRegexp: boolean,
  readonly quiet: boolean,
  readonly follow: boolean,
  readonly text: boolean,
  readonly hidden: boolean,
  readonly files: boolean,
  readonly noIgnore: boolean,
  readonly noIgnoreVcs: boolean,
  readonly noMessages: boolean,
  readonly nullOutput: boolean,
  readonly colorMode: 'never' | undefined,
  readonly noHeading: boolean,
  readonly sortMode: RgSortMode,
  readonly beforeContext: number,
  readonly afterContext: number,
  readonly maxCount: number | undefined,
  readonly maxDepth: number | undefined,
  readonly globs: readonly { readonly pattern: string, readonly caseInsensitive: boolean }[],
  readonly typeFilters: readonly { readonly name: string, readonly exclude: boolean }[],
  readonly ignoreFiles: readonly string[],
  readonly typeList: boolean,
  readonly help: boolean,
  readonly version: boolean,
  readonly diagnostic: string | undefined,
}

type RgDeferred = 'glob' | 'iglob' | 'type' | 'type-not' | 'ignore-file';

function defineFlagOption({
  short,
  long,
  key,
  value,
}: {
  short: string | undefined,
  long: string | undefined,
  key: string,
  value: boolean | string | number,
}): ArgvOptionDefinition<StandardArgvAction<RgDeferred>> {
  return {
    semantic: { kind: 'effects', effects: [{ key, value }] },
    forms: [
      ...(short === undefined ? [] : [{ kind: 'short' as const, name: short, value: { kind: 'none' as const } }]),
      ...(long === undefined ? [] : [{ kind: 'long' as const, name: long, value: { kind: 'none' as const } }]),
    ],
  };
}

function defineChoiceOption({
  long,
  key,
  choices,
}: {
  long: string,
  key: string,
  choices: Readonly<Record<string, string>>,
}): ArgvOptionDefinition<StandardArgvAction<RgDeferred>> {
  return {
    semantic: {
      kind: 'required-value',
      key,
      parse: ({ rawValue }: { rawValue: string }) => {
        const value = choices[rawValue];
        if (value === undefined) {
          return { kind: 'invalid', message: `unsupported value '${rawValue}' for --${long}` };
        }
        return { kind: 'parsed', value };
      },
    },
    forms: [{ kind: 'long', name: long, value: { kind: 'required', missingValueName: 'VALUE' } }],
  };
}

function defineNumberOption({
  short,
  long,
  key,
}: {
  short: string | undefined,
  long: string,
  key: string,
}): ArgvOptionDefinition<StandardArgvAction<RgDeferred>> {
  return {
    semantic: {
      kind: 'required-value',
      key,
      parse: ({ rawValue }: { rawValue: string }) => {
        if (!/^\d+$/.test(rawValue)) {
          return { kind: 'invalid', message: `invalid value '${rawValue}': expected a non-negative integer` };
        }
        return { kind: 'parsed', value: Number(rawValue) };
      },
    },
    forms: [
      ...(short === undefined ? [] : [{
        kind: 'short' as const,
        name: short,
        value: { kind: 'required-attached-or-following' as const, missingValueName: 'NUM' },
      }]),
      { kind: 'long', name: long, value: { kind: 'required', missingValueName: 'NUM' } },
    ],
  };
}

const rgIgnoreCaseOption = defineFlagOption({ short: 'i', long: 'ignore-case', key: 'caseMode', value: 'insensitive' });
const rgCaseSensitiveOption = defineFlagOption({ short: 's', long: 'case-sensitive', key: 'caseMode', value: 'sensitive' });
const rgSmartCaseOption = defineFlagOption({ short: 'S', long: 'smart-case', key: 'caseMode', value: 'smart' });
const rgWordRegexpOption = defineFlagOption({ short: 'w', long: 'word-regexp', key: 'wordRegexp', value: true });
const rgFixedStringsOption = defineFlagOption({ short: 'F', long: 'fixed-strings', key: 'fixedStrings', value: true });
const rgLineNumberOption = defineFlagOption({ short: 'n', long: 'line-number', key: 'lineNumber', value: true });
const rgNoLineNumberOption = defineFlagOption({ short: 'N', long: 'no-line-number', key: 'lineNumber', value: false });
const rgColumnOption = defineFlagOption({ short: undefined, long: 'column', key: 'column', value: true });
const rgNoColumnOption = defineFlagOption({ short: undefined, long: 'no-column', key: 'column', value: false });
const rgByteOffsetOption = defineFlagOption({ short: 'b', long: 'byte-offset', key: 'byteOffset', value: true });
const rgNoByteOffsetOption = defineFlagOption({ short: undefined, long: 'no-byte-offset', key: 'byteOffset', value: false });
const rgWithFilenameOption = defineFlagOption({ short: 'H', long: 'with-filename', key: 'withFilename', value: true });
const rgNoFilenameOption = defineFlagOption({ short: 'I', long: 'no-filename', key: 'withFilename', value: false });
const rgFilesWithMatchesOption = defineFlagOption({ short: 'l', long: 'files-with-matches', key: 'outputMode', value: 'files-with-matches' });
const rgFilesWithoutMatchOption = defineFlagOption({ short: undefined, long: 'files-without-match', key: 'outputMode', value: 'files-without-match' });
const rgCountOption = defineFlagOption({ short: 'c', long: 'count', key: 'outputMode', value: 'count-lines' });
const rgCountMatchesOption = defineFlagOption({ short: undefined, long: 'count-matches', key: 'outputMode', value: 'count-matches' });
const rgOnlyMatchingOption = defineFlagOption({ short: 'o', long: 'only-matching', key: 'onlyMatching', value: true });
const rgInvertMatchOption = defineFlagOption({ short: 'v', long: 'invert-match', key: 'invertMatch', value: true });
const rgLineRegexpOption = defineFlagOption({ short: 'x', long: 'line-regexp', key: 'lineRegexp', value: true });
const rgQuietOption = defineFlagOption({ short: 'q', long: 'quiet', key: 'quiet', value: true });
const rgFollowOption = defineFlagOption({ short: 'L', long: 'follow', key: 'follow', value: true });
const rgTextOption = defineFlagOption({ short: 'a', long: 'text', key: 'text', value: true });
const rgHiddenOption = defineFlagOption({ short: undefined, long: 'hidden', key: 'hidden', value: true });
const rgFilesOption = defineFlagOption({ short: undefined, long: 'files', key: 'files', value: true });
const rgNoIgnoreOption = defineFlagOption({ short: undefined, long: 'no-ignore', key: 'noIgnore', value: true });
const rgNoIgnoreVcsOption = defineFlagOption({ short: undefined, long: 'no-ignore-vcs', key: 'noIgnoreVcs', value: true });
const rgNoMessagesOption = defineFlagOption({ short: undefined, long: 'no-messages', key: 'noMessages', value: true });
const rgNullOption = defineFlagOption({ short: '0', long: 'null', key: 'nullOutput', value: true });
const rgColorOption = defineChoiceOption({ long: 'color', key: 'colorMode', choices: { never: 'never' } });
const rgNoHeadingOption = defineFlagOption({ short: undefined, long: 'no-heading', key: 'noHeading', value: true });
const rgSortOption = defineChoiceOption({ long: 'sort', key: 'sortMode', choices: { path: 'path' } });
const rgSortReverseOption = defineChoiceOption({ long: 'sortr', key: 'sortMode', choices: { path: 'path-reverse' } });
const rgHelpOption = defineFlagOption({ short: 'h', long: 'help', key: 'help', value: true });
const rgVersionOption = defineFlagOption({ short: 'V', long: 'version', key: 'version', value: true });
const rgBeforeContextOption = defineNumberOption({ short: 'B', long: 'before-context', key: 'beforeContext' });
const rgAfterContextOption = defineNumberOption({ short: 'A', long: 'after-context', key: 'afterContext' });
const rgContextOption = defineNumberOption({ short: 'C', long: 'context', key: 'context' });
const rgMaxCountOption = defineNumberOption({ short: 'm', long: 'max-count', key: 'maxCount' });
const rgMaxDepthOption = defineNumberOption({ short: undefined, long: 'max-depth', key: 'maxDepth' });

const rgGlobOption = {
  semantic: { kind: 'deferred', tag: 'glob' },
  forms: [
    { kind: 'short', name: 'g', value: { kind: 'required-attached-or-following', missingValueName: 'GLOB' } },
    { kind: 'long', name: 'glob', value: { kind: 'required', missingValueName: 'GLOB' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RgDeferred>>;

const rgTypeOption = {
  semantic: { kind: 'deferred', tag: 'type' },
  forms: [
    { kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'TYPE' } },
    { kind: 'long', name: 'type', value: { kind: 'required', missingValueName: 'TYPE' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RgDeferred>>;

const rgTypeNotOption = {
  semantic: { kind: 'deferred', tag: 'type-not' },
  forms: [
    { kind: 'short', name: 'T', value: { kind: 'required-attached-or-following', missingValueName: 'TYPE' } },
    { kind: 'long', name: 'type-not', value: { kind: 'required', missingValueName: 'TYPE' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RgDeferred>>;

const rgTypeListOption = defineFlagOption({ short: undefined, long: 'type-list', key: 'typeList', value: true });

const rgIgnoreFileOption = {
  semantic: { kind: 'deferred', tag: 'ignore-file' },
  forms: [{ kind: 'long', name: 'ignore-file', value: { kind: 'required', missingValueName: 'PATH' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RgDeferred>>;

const rgIGlobOption = {
  semantic: { kind: 'deferred', tag: 'iglob' },
  forms: [{ kind: 'long', name: 'iglob', value: { kind: 'required', missingValueName: 'GLOB' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RgDeferred>>;

const rgArgvCatalog = defineArgvCatalog<StandardArgvAction<RgDeferred>>({
  nonExecutableLongOptions: [
    'colors', 'crlf', 'debug', 'encoding', 'engine',
    'generate', 'glob-case-insensitive', 'heading', 'json',
    'max-columns', 'max-columns-preview', 'max-filesize', 'mmap',
    'multiline', 'multiline-dotall', 'no-config',
    'null-data', 'one-file-system', 'passthru', 'path-separator', 'pcre2',
    'pre', 'pre-glob', 'replace', 'stats',
    'stop-on-nonmatch', 'trim', 'type-add', 'type-clear',
    'unrestricted',
  ],
  definitions: [
    rgIgnoreCaseOption, rgCaseSensitiveOption, rgSmartCaseOption, rgWordRegexpOption,
    rgFixedStringsOption, rgLineNumberOption, rgNoLineNumberOption, rgColumnOption, rgNoColumnOption,
    rgByteOffsetOption, rgNoByteOffsetOption,
    rgWithFilenameOption, rgNoFilenameOption, rgFilesWithMatchesOption, rgFilesWithoutMatchOption, rgCountOption,
    rgCountMatchesOption, rgOnlyMatchingOption, rgInvertMatchOption, rgLineRegexpOption,
    rgQuietOption, rgFollowOption, rgTextOption, rgHiddenOption, rgFilesOption,
    rgNoIgnoreOption, rgNoIgnoreVcsOption, rgNoMessagesOption, rgNullOption, rgColorOption, rgNoHeadingOption, rgSortOption,
    rgSortReverseOption, rgBeforeContextOption, rgAfterContextOption,
    rgContextOption, rgMaxCountOption, rgMaxDepthOption, rgGlobOption, rgIGlobOption,
    rgTypeOption, rgTypeNotOption, rgTypeListOption, rgIgnoreFileOption, rgHelpOption,
    rgVersionOption,
  ],
});

const rgArgvHelp = defineArgvHelpPresentation({
  catalog: rgArgvCatalog,
  rows: [
    { forms: rgIgnoreCaseOption.forms, summary: 'search case insensitively', category: 'common' },
    { forms: rgSmartCaseOption.forms, summary: 'search case insensitively unless the pattern contains uppercase', category: 'common' },
    { forms: rgWordRegexpOption.forms, summary: 'only show matches surrounded by word boundaries', category: 'common' },
    { forms: rgFixedStringsOption.forms, summary: 'treat the pattern as a literal string', category: 'common' },
    { forms: rgLineNumberOption.forms, summary: 'show line numbers', category: 'common' },
    { forms: rgColumnOption.forms, summary: 'show 1-based byte columns of matches', category: 'common' },
    { forms: rgByteOffsetOption.forms, summary: 'show 0-based byte offsets', category: 'advanced' },
    { forms: rgFilesWithMatchesOption.forms, summary: 'print only paths with matches', category: 'common' },
    { forms: rgFilesWithoutMatchOption.forms, summary: 'print only paths without matches', category: 'advanced' },
    { forms: rgGlobOption.forms, summary: 'include or exclude files matching GLOB', valueName: 'GLOB', category: 'common' },
    { forms: rgTypeOption.forms, summary: 'only search files matching TYPE', valueName: 'TYPE', category: 'common' },
    { forms: rgTypeNotOption.forms, summary: 'do not search files matching TYPE', valueName: 'TYPE', category: 'advanced' },
    { forms: rgTypeListOption.forms, summary: 'show supported file types', category: 'advanced' },
    { forms: rgIgnoreFileOption.forms, summary: 'add ignore rules from PATH', valueName: 'PATH', category: 'advanced' },
    { forms: rgHiddenOption.forms, summary: 'search hidden files and directories', category: 'common' },
    { forms: rgNoMessagesOption.forms, summary: 'suppress runtime file-system messages', category: 'advanced' },
    { forms: rgNullOption.forms, summary: 'use NUL after file paths in output', category: 'advanced' },
    { forms: rgColorOption.forms, summary: 'disable colored output with VALUE=never', valueName: 'VALUE', category: 'advanced' },
    { forms: rgNoHeadingOption.forms, summary: 'do not group matches by file', category: 'advanced' },
    { forms: rgSortOption.forms, summary: 'sort directory results by path with VALUE=path', valueName: 'VALUE', category: 'advanced' },
    { forms: rgSortReverseOption.forms, summary: 'reverse-sort directory results by path with VALUE=path', valueName: 'VALUE', category: 'advanced' },
    { forms: rgFilesOption.forms, summary: 'print files that would be searched', category: 'common' },
    { forms: rgContextOption.forms, summary: 'show NUM lines before and after each match', valueName: 'NUM', category: 'common' },
    { forms: rgBeforeContextOption.forms, summary: 'show NUM lines before each match', valueName: 'NUM', category: 'advanced' },
    { forms: rgAfterContextOption.forms, summary: 'show NUM lines after each match', valueName: 'NUM', category: 'advanced' },
    { forms: rgFollowOption.forms, summary: 'follow symbolic links', category: 'advanced' },
    { forms: rgMaxDepthOption.forms, summary: 'descend at most NUM directories', valueName: 'NUM', category: 'advanced' },
    { forms: rgHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});

const rgArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

function rawValueText({ value }: { value: StandardArgvRawValue }): string {
  switch (value.kind) {
  case 'inline':
  case 'next-argv':
    return value.rawValue;
  case 'none':
    throw new Error('rg deferred glob option requires a value');
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled rg raw value: ${JSON.stringify(_ex)}`);
  }
  }
}

export function parseRgArgv({ args }: { args: readonly string[] }): RgParsedArgv {
  const parsed = parseStandardArgv({ args, catalog: rgArgvCatalog, policy: rgArgvPolicy });
  const diagnostic = parsed.diagnostics[0]?.message;
  const context = typeof parsed.optionValues.context === 'number' ? parsed.optionValues.context : undefined;
  const globs = parsed.deferred.flatMap((occurrence) => {
    switch (occurrence.semantic.tag) {
    case 'glob':
      return [{ pattern: rawValueText({ value: occurrence.value }), caseInsensitive: false }];
    case 'iglob':
      return [{ pattern: rawValueText({ value: occurrence.value }), caseInsensitive: true }];
    case 'type':
    case 'type-not':
    case 'ignore-file':
      return [];
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled rg deferred option: ${JSON.stringify(_ex)}`);
    }
    }
  });
  const typeFilters = parsed.deferred.flatMap((occurrence) => {
    switch (occurrence.semantic.tag) {
    case 'type':
      return [{ name: rawValueText({ value: occurrence.value }), exclude: false }];
    case 'type-not':
      return [{ name: rawValueText({ value: occurrence.value }), exclude: true }];
    case 'glob':
    case 'iglob':
    case 'ignore-file':
      return [];
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled rg deferred option: ${JSON.stringify(_ex)}`);
    }
    }
  });
  const ignoreFiles = parsed.deferred.flatMap((occurrence) => {
    switch (occurrence.semantic.tag) {
    case 'ignore-file':
      return [rawValueText({ value: occurrence.value })];
    case 'glob':
    case 'iglob':
    case 'type':
    case 'type-not':
      return [];
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled rg deferred option: ${JSON.stringify(_ex)}`);
    }
    }
  });
  const files = parsed.optionValues.files === true;
  const [firstPositional, ...remainingPositionals] = parsed.positionals;
  const pattern = files ? undefined : firstPositional;
  const paths = files ? parsed.positionals : remainingPositionals;

  return {
    pattern,
    paths,
    fixedStrings: parsed.optionValues.fixedStrings === true,
    caseMode: parsed.optionValues.caseMode === 'insensitive' || parsed.optionValues.caseMode === 'smart'
      ? parsed.optionValues.caseMode
      : 'sensitive',
    wordRegexp: parsed.optionValues.wordRegexp === true,
    lineNumber: typeof parsed.optionValues.lineNumber === 'boolean' ? parsed.optionValues.lineNumber : undefined,
    column: parsed.optionValues.column === true,
    byteOffset: parsed.optionValues.byteOffset === true,
    withFilename: typeof parsed.optionValues.withFilename === 'boolean' ? parsed.optionValues.withFilename : undefined,
    outputMode: (() => {
      const value = parsed.optionValues.outputMode;
      if (value === 'files-with-matches' || value === 'files-without-match' || value === 'count-lines' || value === 'count-matches') return value;
      return 'normal';
    })(),
    onlyMatching: parsed.optionValues.onlyMatching === true,
    invertMatch: parsed.optionValues.invertMatch === true,
    lineRegexp: parsed.optionValues.lineRegexp === true,
    quiet: parsed.optionValues.quiet === true,
    follow: parsed.optionValues.follow === true,
    text: parsed.optionValues.text === true,
    hidden: parsed.optionValues.hidden === true,
    files,
    noIgnore: parsed.optionValues.noIgnore === true,
    noIgnoreVcs: parsed.optionValues.noIgnoreVcs === true,
    noMessages: parsed.optionValues.noMessages === true,
    nullOutput: parsed.optionValues.nullOutput === true,
    colorMode: parsed.optionValues.colorMode === 'never' ? 'never' : undefined,
    noHeading: parsed.optionValues.noHeading === true,
    sortMode: parsed.optionValues.sortMode === 'path' || parsed.optionValues.sortMode === 'path-reverse'
      ? parsed.optionValues.sortMode
      : 'default',
    beforeContext: typeof parsed.optionValues.beforeContext === 'number' ? parsed.optionValues.beforeContext : (context ?? 0),
    afterContext: typeof parsed.optionValues.afterContext === 'number' ? parsed.optionValues.afterContext : (context ?? 0),
    maxCount: typeof parsed.optionValues.maxCount === 'number' ? parsed.optionValues.maxCount : undefined,
    maxDepth: typeof parsed.optionValues.maxDepth === 'number' ? parsed.optionValues.maxDepth : undefined,
    globs,
    typeFilters,
    ignoreFiles,
    typeList: parsed.optionValues.typeList === true,
    help: parsed.optionValues.help === true,
    version: parsed.optionValues.version === true,
    diagnostic,
  };
}

export function getRgOptionHelp(): readonly string[] {
  return formatArgvOptionHelp({ presentation: rgArgvHelp });
}

export function getRgUsageSummary(): string {
  return formatArgvUsageSummary({ presentation: rgArgvHelp });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
