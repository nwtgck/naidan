import {
  parseStandardArgv,
  type ParsedStandardArgv,
  type StandardArgvParserSpec,
} from '@/features/wesh/argv';

export type JqInjectedArgumentKind = 'string' | 'json' | 'rawfile' | 'slurpfile';

export interface JqInjectedArgument {
  kind: JqInjectedArgumentKind,
  name: string,
  value: string,
}

export type JqEarlyExit = 'help' | 'version';

interface JqEarlyExitMatch {
  kind: JqEarlyExit,
  stopIndex: number,
}

type ParsedJqIndentation =
  | { ok: true, value: number }
  | { ok: false, message: string };

function parseJqIndentationValue({
  value,
}: {
  value: string,
}): ParsedJqIndentation {
  // jq 1.7 feeds this argument through C atoi(): a non-numeric prefix
  // becomes 0, numeric prefixes are accepted, and -1 selects tabs.
  // Values outside -1..7 are rejected after that conversion.
  const match = /^\s*([+-]?\d+)/u.exec(value);
  const indentation = match === null ? 0 : Number.parseInt(match[1]!, 10);
  return indentation >= -1 && indentation <= 7
    ? { ok: true, value: indentation }
    : { ok: false, message: '--indent takes a number between -1 and 7' };
}

export interface ParsedJqArgv {
  standard: ParsedStandardArgv,
  injectedArguments: JqInjectedArgument[],
  filterFromFile: boolean,
  earlyExit: JqEarlyExit | undefined,
  grammarDiagnostic: string | undefined,
}

function flag({
  short,
  long,
  key,
  summary,
}: {
  short: string | undefined,
  long: string | undefined,
  key: string,
  summary: string,
}) {
  return {
    kind: 'flag' as const,
    short,
    long,
    effects: [{ key, value: true }],
    help: { summary, category: 'common' as const },
  };
}

export const jqArgvSpec: StandardArgvParserSpec = {
  options: [
    flag({ short: 'n', long: 'null-input', key: 'nullInput', summary: 'use null as the single input value' }),
    flag({ short: 'R', long: 'raw-input', key: 'rawInput', summary: 'read each input line as a string' }),
    flag({ short: 's', long: 'slurp', key: 'slurp', summary: 'read all inputs into an array' }),
    flag({ short: 'c', long: 'compact-output', key: 'compactOutput', summary: 'emit compact JSON' }),
    flag({ short: 'r', long: 'raw-output', key: 'rawOutput', summary: 'emit strings without JSON quoting' }),
    flag({ short: 'j', long: 'join-output', key: 'joinOutput', summary: 'do not print a newline after each output' }),
    flag({ short: 'a', long: 'ascii-output', key: 'asciiOutput', summary: 'escape non-ASCII code points' }),
    flag({ short: 'S', long: 'sort-keys', key: 'sortKeys', summary: 'sort object keys in output' }),
    flag({ short: 'e', long: 'exit-status', key: 'exitStatus', summary: 'set the exit status from the last output value' }),
    flag({ short: undefined, long: 'raw-output0', key: 'rawOutput0', summary: 'emit raw strings followed by NUL' }),
    flag({ short: undefined, long: 'tab', key: 'tabOutput', summary: 'use tabs for indentation' }),
    flag({ short: undefined, long: 'unbuffered', key: 'unbuffered', summary: 'flush after each output value' }),
    flag({ short: undefined, long: 'args', key: 'argsMode', summary: 'place remaining arguments in $ARGS.positional as strings' }),
    flag({ short: undefined, long: 'jsonargs', key: 'jsonArgsMode', summary: 'place remaining arguments in $ARGS.positional as JSON values' }),
    flag({ short: 'V', long: 'version', key: 'version', summary: 'display version information and exit' }),
    flag({ short: 'h', long: 'help', key: 'help', summary: 'display this help and exit' }),
    {
      kind: 'value',
      short: undefined,
      long: 'indent',
      key: 'indent',
      valueName: 'N',
      allowAttachedValue: false,
      parseValue: parseJqIndentationValue,
      help: { summary: 'indent output with N spaces (0 through 7)', valueName: 'N', category: 'common' },
    },
    {
      kind: 'value',
      short: 'f',
      long: 'from-file',
      key: 'filterFile',
      valueName: 'FILE',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'read the jq filter from FILE', valueName: 'FILE', category: 'common' },
    },
    // These entries are used for generated help. The command-specific grammar
    // pass removes valid NAME/VALUE triples before parseStandardArgv runs.
    {
      kind: 'value',
      short: undefined,
      long: 'arg',
      key: 'unusedArgHelp',
      valueName: 'NAME VALUE',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'set $NAME to the string VALUE', valueName: 'NAME VALUE', category: 'common' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'argjson',
      key: 'unusedArgJsonHelp',
      valueName: 'NAME JSON',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'set $NAME to the parsed JSON value', valueName: 'NAME JSON', category: 'common' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'rawfile',
      key: 'unusedRawFileHelp',
      valueName: 'NAME FILE',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'set $NAME to the contents of FILE', valueName: 'NAME FILE', category: 'advanced' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'slurpfile',
      key: 'unusedSlurpFileHelp',
      valueName: 'NAME FILE',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'set $NAME to the JSON values read from FILE', valueName: 'NAME FILE', category: 'advanced' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

const JQ_BUNDLED_SHORT_FLAG_NAMES = new Set([
  'n',
  'R',
  's',
  'c',
  'r',
  'j',
  'a',
  'S',
  'e',
  'V',
  'h',
]);

const JQ_STANDARD_LONG_FLAG_NAMES = new Set(
  jqArgvSpec.options.flatMap((option) => option.kind === 'flag' && option.long !== undefined
    ? [option.long]
    : []),
);

/**
 * jq does not use ordinary getopt value consumption for every option. Help and
 * version terminate while scanning argv, even after `-f`, while `--arg` and
 * `--indent` deliberately consume option-looking values. Keep that grammar
 * command-local instead of weakening the shared standard argv parser.
 */
function findJqEarlyExit({
  args,
}: {
  args: readonly string[],
}): JqEarlyExitMatch | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') return undefined;

    const injectedKind = injectedArgumentKind({ token });
    if (injectedKind !== undefined) {
      if (args[index + 1] === undefined || args[index + 2] === undefined) return undefined;
      index += 2;
      continue;
    }

    if (token === '--indent') {
      const value = args[index + 1];
      if (value === undefined || !parseJqIndentationValue({ value }).ok) {
        return undefined;
      }
      index += 1;
      continue;
    }

    if (token === '-f' || token === '--from-file') {
      // jq treats -f as a mode switch. Its filter file is the first ordinary
      // operand, so later options (including help/version) remain options.
      continue;
    }

    if (token === '--help') return { kind: 'help', stopIndex: index };
    if (token === '--version') return { kind: 'version', stopIndex: index };

    if (token.startsWith('--') && token.length > 2) {
      if (token.includes('=')) return undefined;
      const name = token.slice(2);
      if (!JQ_STANDARD_LONG_FLAG_NAMES.has(name)) return undefined;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      if (/^-(?:\d|\.)/u.test(token)) continue;
      const body = token.slice(1);

      // jq scans a whole short-option token before acting. `-Vh` and `-hV`
      // both select help, and h/V also win over an unknown sibling character
      // inside that same token. A bad earlier argv token still blocks them.
      if (body.includes('h')) return { kind: 'help', stopIndex: index };
      if (body.includes('V')) return { kind: 'version', stopIndex: index };

      if (body.includes('f')) {
        const normalized = normalizeBundledFilterFileOption({ token });
        if (normalized === undefined || !normalized.ok) return undefined;
        continue;
      }

      if ([...body].some((character) => !JQ_BUNDLED_SHORT_FLAG_NAMES.has(character))) {
        return undefined;
      }
    }
  }

  return undefined;
}


const JQ_NEGATIVE_FILTER_SENTINEL_PREFIX = '\u0000jq-negative-filter:';

function protectLeadingNegativeFilter({
  args,
}: {
  args: readonly string[],
}): { args: string[], protectedFilter: string | undefined } {
  const normalized = [...args];
  let expectingValue = false;
  let parsingOptions = true;
  let foundFilter = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const token = normalized[index]!;
    if (expectingValue) {
      expectingValue = false;
      continue;
    }
    if (parsingOptions && token === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (token === '--indent')) {
      expectingValue = true;
      continue;
    }
    if (parsingOptions && token.startsWith('-') && token.length > 1) {
      if (!foundFilter && /^-(?:\d|\.)/u.test(token)) {
        const sentinel = `${JQ_NEGATIVE_FILTER_SENTINEL_PREFIX}${index}`;
        normalized[index] = sentinel;
        return { args: normalized, protectedFilter: token };
      }
      continue;
    }
    if (!foundFilter) foundFilter = true;
  }

  return { args: normalized, protectedFilter: undefined };
}

function restoreLeadingNegativeFilter({
  parsed,
  protectedFilter,
}: {
  parsed: ParsedStandardArgv,
  protectedFilter: string | undefined,
}): ParsedStandardArgv {
  if (protectedFilter === undefined) return parsed;
  return {
    ...parsed,
    positionals: parsed.positionals.map((value) => value.startsWith(JQ_NEGATIVE_FILTER_SENTINEL_PREFIX)
      ? protectedFilter
      : value),
  };
}

function normalizeBundledFilterFileOption({
  token,
}: {
  token: string,
}): { ok: true, args: string[] } | { ok: false } | undefined {
  if (/^-(?:\d|\.)/u.test(token)) return undefined;
  if (!token.startsWith('-') || token.startsWith('--') || token.length <= 2) return undefined;

  const body = token.slice(1);
  if (!body.includes('f')) return undefined;

  const filterOptionCount = [...body].filter((character) => character === 'f').length;
  if (filterOptionCount !== 1) return { ok: false };

  const flagCharacters = [...body].filter((character) => character !== 'f');
  if (flagCharacters.some((character) => !JQ_BUNDLED_SHORT_FLAG_NAMES.has(character))) {
    return { ok: false };
  }

  return {
    ok: true,
    args: [
      ...(flagCharacters.length > 0 ? [`-${flagCharacters.join('')}`] : []),
      '-f',
    ],
  };
}

function injectedArgumentKind({
  token,
}: {
  token: string,
}): JqInjectedArgumentKind | undefined {
  switch (token) {
  case '--arg':
    return 'string';
  case '--argjson':
    return 'json';
  case '--rawfile':
    return 'rawfile';
  case '--slurpfile':
    return 'slurpfile';
  default:
    return undefined;
  }
}

export function parseJqArgv({
  args,
}: {
  args: string[],
}): ParsedJqArgv {
  const earlyExitMatch = findJqEarlyExit({ args });
  const effectiveArgs = earlyExitMatch === undefined
    ? args
    : args.slice(0, earlyExitMatch.stopIndex);

  const standardArgs: string[] = [];
  const injectedArguments: JqInjectedArgument[] = [];
  let filterFromFile = false;
  let parsingOptions = true;

  for (let index = 0; index < effectiveArgs.length; index += 1) {
    const token = effectiveArgs[index]!;
    if (parsingOptions && token === '--') {
      parsingOptions = false;
      standardArgs.push(token);
      continue;
    }

    if (parsingOptions && token.startsWith('--') && token.includes('=')) {
      return {
        standard: parseStandardArgv({ args: standardArgs, spec: jqArgvSpec }),
        injectedArguments,
        filterFromFile,
        earlyExit: undefined,
        grammarDiagnostic: `Unknown option ${token}`,
      };
    }

    if (parsingOptions && (token === '-f' || token === '--from-file')) {
      filterFromFile = true;
      continue;
    }

    if (parsingOptions) {
      const normalizedBundle = normalizeBundledFilterFileOption({ token });
      if (normalizedBundle !== undefined) {
        if (!normalizedBundle.ok) {
          return {
            standard: parseStandardArgv({ args: standardArgs, spec: jqArgvSpec }),
            injectedArguments,
            filterFromFile,
            earlyExit: undefined,
            grammarDiagnostic: `Unknown option ${token}`,
          };
        }
        for (const normalizedToken of normalizedBundle.args) {
          if (normalizedToken === '-f') {
            filterFromFile = true;
          } else {
            standardArgs.push(normalizedToken);
          }
        }
        continue;
      }
    }

    const kind = parsingOptions ? injectedArgumentKind({ token }) : undefined;
    if (kind === undefined) {
      standardArgs.push(token);
      continue;
    }

    const name = effectiveArgs[index + 1];
    const value = effectiveArgs[index + 2];
    if (name === undefined || value === undefined) {
      return {
        standard: parseStandardArgv({ args: standardArgs, spec: jqArgvSpec }),
        injectedArguments,
        filterFromFile,
        earlyExit: undefined,
        grammarDiagnostic: `${token} requires NAME and VALUE arguments`,
      };
    }

    injectedArguments.push({ kind, name, value });
    index += 2;
  }

  const protectedStandardArgs = protectLeadingNegativeFilter({ args: standardArgs });
  return {
    standard: restoreLeadingNegativeFilter({
      parsed: parseStandardArgv({ args: protectedStandardArgs.args, spec: jqArgvSpec }),
      protectedFilter: protectedStandardArgs.protectedFilter,
    }),
    injectedArguments,
    filterFromFile,
    earlyExit: earlyExitMatch?.kind,
    grammarDiagnostic: undefined,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
