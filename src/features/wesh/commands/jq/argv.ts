import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  parseStandardArgv,
  type ArgvOptionDefinition,
  type ParsedStandardArgv,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv-v2';

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
  | { kind: 'parsed', value: number }
  | { kind: 'invalid', message: string };

function parseJqIndentationValue({
  rawValue,
}: {
  rawValue: string,
}): ParsedJqIndentation {
  // jq 1.7 feeds this argument through C atoi(): a non-numeric prefix
  // becomes 0, numeric prefixes are accepted, and -1 selects tabs.
  // Values outside -1..7 are rejected after that conversion.
  const match = /^\s*([+-]?\d+)/u.exec(rawValue);
  const indentation = match === null ? 0 : Number.parseInt(match[1]!, 10);
  return indentation >= -1 && indentation <= 7
    ? { kind: 'parsed', value: indentation }
    : { kind: 'invalid', message: '--indent takes a number between -1 and 7' };
}

export interface ParsedJqArgv {
  standard: ParsedStandardArgv<never>,
  injectedArguments: JqInjectedArgument[],
  filterFromFile: boolean,
  earlyExit: JqEarlyExit | undefined,
  grammarDiagnostic: string | undefined,
}

function flag({
  short,
  long,
  key,
  value,
  summary,
}: {
  short: string | undefined,
  long: string,
  key: string,
  value: boolean | string | number,
  summary: string,
}): ArgvOptionDefinition<StandardArgvAction<never>> & { summary: string } {
  return {
    semantic: { kind: 'effects', effects: [{ key, value }] },
    forms: [
      ...(short === undefined ? [] : [{ kind: 'short', name: short, value: { kind: 'none' } }] as const),
      { kind: 'long', name: long, value: { kind: 'none' } },
    ],
    summary,
  };
}

const jqFlags = [
  flag({ short: 'n', long: 'null-input', key: 'nullInput', value: true, summary: 'use null as the single input value' }),
  flag({ short: 'R', long: 'raw-input', key: 'rawInput', value: true, summary: 'read each input line as a string' }),
  flag({ short: 's', long: 'slurp', key: 'slurp', value: true, summary: 'read all inputs into an array' }),
  flag({ short: 'c', long: 'compact-output', key: 'compactOutput', value: true, summary: 'emit compact JSON' }),
  flag({ short: 'r', long: 'raw-output', key: 'rawOutput', value: true, summary: 'emit strings without JSON quoting' }),
  flag({ short: 'j', long: 'join-output', key: 'joinOutput', value: true, summary: 'emit raw strings and omit output newlines' }),
  flag({ short: 'a', long: 'ascii-output', key: 'asciiOutput', value: true, summary: 'escape non-ASCII code points' }),
  flag({ short: 'S', long: 'sort-keys', key: 'sortKeys', value: true, summary: 'sort object keys in output' }),
  flag({ short: 'e', long: 'exit-status', key: 'exitStatus', value: true, summary: 'set the exit status from the last output value' }),
  flag({ short: undefined, long: 'raw-output0', key: 'rawOutput0', value: true, summary: 'emit raw strings followed by NUL' }),
  flag({ short: undefined, long: 'tab', key: 'indent', value: -1, summary: 'use tabs for indentation' }),
  flag({ short: undefined, long: 'unbuffered', key: 'unbuffered', value: true, summary: 'flush after each output value' }),
  flag({ short: undefined, long: 'args', key: 'argumentMode', value: 'strings', summary: 'place remaining arguments in $ARGS.positional as strings' }),
  flag({ short: undefined, long: 'jsonargs', key: 'argumentMode', value: 'json', summary: 'place remaining arguments in $ARGS.positional as JSON values' }),
  flag({ short: 'V', long: 'version', key: 'version', value: true, summary: 'display version information and exit' }),
  flag({ short: 'h', long: 'help', key: 'help', value: true, summary: 'display this help and exit' }),
] as const;

const jqOptions = [
  ...jqFlags,
  {
    semantic: { kind: 'required-value', key: 'indent', parse: parseJqIndentationValue },
    forms: [{ kind: 'long', name: 'indent', value: { kind: 'required', missingValueName: 'N' } }],
    summary: 'indent output with N spaces (0 through 7)',
  },
] as const;

const jqArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: jqOptions,
  nonExecutableLongOptions: [],
});
export const jqArgvHelp = defineArgvHelpPresentation({ catalog: jqArgvCatalog, rows: jqOptions });

const jqArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

const JQ_BUNDLED_SHORT_FLAG_NAMES = new Set<string>();
const JQ_STANDARD_LONG_FLAG_NAMES = new Set<string>();
for (const { forms } of jqFlags) {
  for (const form of forms) {
    switch (form.kind) {
    case 'short':
      JQ_BUNDLED_SHORT_FLAG_NAMES.add(form.name);
      break;
    case 'long':
      JQ_STANDARD_LONG_FLAG_NAMES.add(form.name);
      break;
    case 'plus-short':
      break;
    default: {
      const _ex: never = form;
      throw new Error(`Unhandled jq option form: ${JSON.stringify(_ex)}`);
    }
    }
  }
}

const JQ_NEGATIVE_OPERAND = /^-(?:\d|\.)/u;
const JQ_POSITIONAL_ESCAPE = '\u0000';

export function getJqOptionHelp(): string[] {
  // jq rejects the equals form for long options. The multi-operand options
  // below belong to jq's grammar rather than the standard option catalog.
  const standard = formatArgvOptionHelp({ presentation: jqArgvHelp })
    .map(line => line.startsWith('  --indent=') ? line.replace('=', ' ') : line);
  const grammar = [
    { label: '-f FILE, --from-file FILE', summary: 'read the jq filter from FILE' },
    { label: '--arg NAME VALUE', summary: 'set $NAME to the string VALUE' },
    { label: '--argjson NAME JSON', summary: 'set $NAME to the parsed JSON value' },
    { label: '--rawfile NAME FILE', summary: 'set $NAME to the contents of FILE' },
    { label: '--slurpfile NAME FILE', summary: 'set $NAME to the JSON values read from FILE' },
  ];
  return [...standard, ...grammar.map(({ label, summary }) => `  ${label.padEnd(28, ' ')} ${summary}`)];
}

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
    if (token === '--') {
      return undefined;
    }

    const injectedKind = injectedArgumentKind({ token });
    if (injectedKind !== undefined) {
      if (args[index + 1] === undefined || args[index + 2] === undefined) {
        return undefined;
      }
      index += 2;
      continue;
    }

    if (token === '--indent') {
      const value = args[index + 1];
      if (value === undefined || parseJqIndentationValue({ rawValue: value }).kind === 'invalid') {
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

    if (token === '--help') {
      return { kind: 'help', stopIndex: index };
    }
    if (token === '--version') {
      return { kind: 'version', stopIndex: index };
    }

    if (token.startsWith('--') && token.length > 2) {
      if (token.includes('=')) {
        return undefined;
      }
      const name = token.slice(2);
      if (!JQ_STANDARD_LONG_FLAG_NAMES.has(name)) {
        return undefined;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      if (JQ_NEGATIVE_OPERAND.test(token)) {
        continue;
      }
      const body = token.slice(1);

      // jq scans a whole short-option token before acting. `-Vh` and `-hV`
      // both select help, and h/V also win over an unknown sibling character
      // inside that same token. A bad earlier argv token still blocks them.
      if (body.includes('h')) {
        return { kind: 'help', stopIndex: index };
      }
      if (body.includes('V')) {
        return { kind: 'version', stopIndex: index };
      }

      if (body.includes('f')) {
        const normalized = normalizeBundledFilterFileOption({ token });
        if (normalized === undefined || !normalized.ok) {
          return undefined;
        }
        continue;
      }

      if ([...body].some((character) => !JQ_BUNDLED_SHORT_FLAG_NAMES.has(character))) {
        return undefined;
      }
    }
  }

  return undefined;
}

function parseJqStandardArgv({
  args,
}: {
  args: readonly string[],
}): ParsedStandardArgv<never> {
  return parseStandardArgv({ args, catalog: jqArgvCatalog, policy: jqArgvPolicy });
}

function normalizeBundledFilterFileOption({
  token,
}: {
  token: string,
}): { ok: true, args: string[] } | { ok: false } | undefined {
  if (!token.startsWith('-') || token.startsWith('--') || token.length <= 2) {
    return undefined;
  }

  const body = token.slice(1);
  if (!body.includes('f')) {
    return undefined;
  }

  const filterOptionCount = [...body].filter((character) => character === 'f').length;
  if (filterOptionCount !== 1) {
    return { ok: false };
  }

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
  let escapedPositionals = false;
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
        standard: parseJqStandardArgv({ args: standardArgs }),
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

    if (parsingOptions && token === '--indent') {
      standardArgs.push(token);
      const value = effectiveArgs[index + 1];
      if (value !== undefined) {
        // jq consumes this value even when it would otherwise start another option.
        standardArgs.push(value);
        index += 1;
      }
      continue;
    }

    if ((parsingOptions && JQ_NEGATIVE_OPERAND.test(token)) || token.startsWith(JQ_POSITIONAL_ESCAPE)) {
      // Escape operands that look like options and any literal escape prefix.
      escapedPositionals = true;
      standardArgs.push(`${JQ_POSITIONAL_ESCAPE}${token}`);
      continue;
    }

    if (parsingOptions) {
      const normalizedBundle = normalizeBundledFilterFileOption({ token });
      if (normalizedBundle !== undefined) {
        if (!normalizedBundle.ok) {
          return {
            standard: parseJqStandardArgv({ args: standardArgs }),
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
        standard: parseJqStandardArgv({ args: standardArgs }),
        injectedArguments,
        filterFromFile,
        earlyExit: undefined,
        grammarDiagnostic: `${token} requires NAME and VALUE arguments`,
      };
    }

    injectedArguments.push({ kind, name, value });
    index += 2;
  }

  const standard = parseJqStandardArgv({ args: standardArgs });
  return {
    standard: escapedPositionals ? {
      ...standard,
      positionals: standard.positionals.map(value => value.startsWith(JQ_POSITIONAL_ESCAPE) ? value.slice(1) : value),
    } : standard,
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
