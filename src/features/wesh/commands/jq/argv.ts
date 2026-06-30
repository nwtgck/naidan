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

export interface ParsedJqArgv {
  standard: ParsedStandardArgv,
  injectedArguments: JqInjectedArgument[],
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
      allowAttachedValue: true,
      parseValue: ({ value }) => /^[0-7]$/.test(value)
        ? { ok: true, value: Number(value) }
        : { ok: false, message: `invalid indentation count '${value}'` },
      help: { summary: 'indent output with N spaces (0 through 7)', valueName: 'N', category: 'common' },
    },
    {
      kind: 'value',
      short: 'f',
      long: 'from-file',
      key: 'filterFile',
      valueName: 'FILE',
      allowAttachedValue: true,
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
  const standardArgs: string[] = [];
  const injectedArguments: JqInjectedArgument[] = [];
  let parsingOptions = true;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (parsingOptions && token === '--') {
      parsingOptions = false;
      standardArgs.push(token);
      continue;
    }

    const kind = parsingOptions ? injectedArgumentKind({ token }) : undefined;
    if (kind === undefined) {
      standardArgs.push(token);
      continue;
    }

    const name = args[index + 1];
    const value = args[index + 2];
    if (name === undefined || value === undefined) {
      return {
        standard: parseStandardArgv({ args: standardArgs, spec: jqArgvSpec }),
        injectedArguments,
        grammarDiagnostic: `${token} requires NAME and VALUE arguments`,
      };
    }

    injectedArguments.push({ kind, name, value });
    index += 2;
  }

  return {
    standard: parseStandardArgv({ args: standardArgs, spec: jqArgvSpec }),
    injectedArguments,
    grammarDiagnostic: undefined,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
