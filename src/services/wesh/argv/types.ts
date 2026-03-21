export type ArgvValue = boolean | string | number;

export interface ArgvOptionEffect {
  key: string;
  value: ArgvValue;
}

export interface ArgvOptionHelp {
  summary: string;
  valueName?: string;
  category?: 'common' | 'advanced';
}

export interface ArgvFlagOptionSpec {
  kind: 'flag';
  short: string | undefined;
  long: string | undefined;
  effects: ArgvOptionEffect[];
  help: ArgvOptionHelp;
}

export interface ArgvValueOptionSpec {
  kind: 'value';
  short: string | undefined;
  long: string | undefined;
  key: string;
  valueName: string;
  allowAttachedValue: boolean;
  parseValue: ((options: { value: string }) => { ok: true; value: ArgvValue } | { ok: false; message: string }) | undefined;
  help: ArgvOptionHelp;
}

export type ArgvOptionSpec = ArgvFlagOptionSpec | ArgvValueOptionSpec;

export interface ArgvDiagnostic {
  kind: 'unknown-short-option' | 'unknown-long-option' | 'missing-option-value' | 'invalid-option-value';
  option: string;
  message: string;
}

export interface ArgvSpecialParseResult {
  kind: 'matched';
  consumeCount: number;
  effects: ArgvOptionEffect[];
  occurrences?: ArgvOptionOccurrence[];
}

export type ArgvSpecialTokenParser = (options: {
  token: string;
  nextToken: string | undefined;
}) => ArgvSpecialParseResult | undefined;

export interface StandardArgvParserSpec {
  options: ArgvOptionSpec[];
  allowShortFlagBundles: boolean;
  stopAtDoubleDash: boolean;
  treatSingleDashAsPositional: boolean;
  specialTokenParsers: ArgvSpecialTokenParser[];
}

export interface ParsedStandardArgv {
  optionValues: Record<string, ArgvValue>;
  positionals: string[];
  diagnostics: ArgvDiagnostic[];
  occurrences: ArgvOptionOccurrence[];
}

export interface ArgvFlagOptionOccurrence {
  kind: 'flag';
  option: string;
  effects: ArgvOptionEffect[];
}

export interface ArgvValueOptionOccurrence {
  kind: 'value';
  option: string;
  key: string;
  value: ArgvValue;
}

export interface ArgvSpecialOptionOccurrence {
  kind: 'special';
  option: string;
  effects: ArgvOptionEffect[];
}

export type ArgvOptionOccurrence =
  | ArgvFlagOptionOccurrence
  | ArgvValueOptionOccurrence
  | ArgvSpecialOptionOccurrence;

export interface SubcommandArgvParserSpec {
  name: string;
  parser:
    | { kind: 'standard'; spec: StandardArgvParserSpec }
    | { kind: 'subcommand'; spec: SubcommandArgvParserSpec };
  subcommands: Record<string, SubcommandArgvParserSpec>;
}

export interface ParsedSubcommandArgv {
  matchedSubcommands: string[];
  activeCommand: string;
  parsed: ParsedStandardArgv | undefined;
}

export interface ParsedFindLikeArgv {
  paths: string[];
  expressionTokens: string[];
}
