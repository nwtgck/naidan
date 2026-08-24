import {
  parseStandardArgv,
  type ArgvOptionSpec,
  type ParsedStandardArgv,
  type StandardArgvParserSpec,
} from '@/features/wesh/argv';

interface StandardOptionLookup {
  readonly shortOptions: ReadonlyMap<string, ArgvOptionSpec>,
  readonly longOptions: ReadonlyMap<string, ArgvOptionSpec>,
}

const optionLookupCache = new WeakMap<StandardArgvParserSpec, StandardOptionLookup>();

function getStandardOptionLookup({
  spec,
}: {
  spec: StandardArgvParserSpec,
}): StandardOptionLookup {
  const cached = optionLookupCache.get(spec);
  if (cached !== undefined) return cached;

  const shortOptions = new Map<string, ArgvOptionSpec>();
  const longOptions = new Map<string, ArgvOptionSpec>();
  for (const option of spec.options) {
    if (option.short !== undefined) shortOptions.set(option.short, option);
    if (option.long !== undefined) longOptions.set(option.long, option);
  }

  const lookup = { shortOptions, longOptions };
  optionLookupCache.set(spec, lookup);
  return lookup;
}


export interface StandardEarlyExitOption {
  readonly token: string,
  readonly optionKey: string,
}

export const STANDARD_HELP_EARLY_EXIT_OPTIONS: readonly StandardEarlyExitOption[] = [
  { token: '--help', optionKey: 'help' },
];

export const STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS: readonly StandardEarlyExitOption[] = [
  { token: '--help', optionKey: 'help' },
  { token: '--version', optionKey: 'version' },
];

/**
 * Preserve GNU-style first-occurrence early exits without changing the shared
 * argv parser. Normal invocations only scan for exact early-exit tokens. When
 * one is present, parse only the prefix ending at that token so required option
 * values, an earlier invalid option, and an explicit `--` keep their normal
 * meaning. A valid early exit discards all later argv, matching utilities that
 * terminate as soon as getopt returns their help/version sentinel.
 */
export function stopStandardArgvAtFirstEarlyExit({
  args,
  spec,
  earlyExitOptions,
}: {
  args: string[],
  spec: StandardArgvParserSpec,
  earlyExitOptions: readonly StandardEarlyExitOption[],
}): string[] {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) break;

    for (const earlyExitOption of earlyExitOptions) {
      if (token !== earlyExitOption.token) continue;

      const prefix = args.slice(0, index + 1);
      const parsedPrefix = parseStandardArgv({ args: prefix, spec });
      if (
        parsedPrefix.diagnostics.length === 0
        && parsedPrefix.optionValues[earlyExitOption.optionKey] === true
      ) {
        return prefix;
      }
    }
  }

  return args;
}


function hasRepeatedValueOccurrenceKey({
  parsed,
}: {
  parsed: ParsedStandardArgv,
}): boolean {
  const seenValueKeys = new Set<string>();
  for (const occurrence of parsed.occurrences) {
    switch (occurrence.kind) {
    case 'value':
      if (seenValueKeys.has(occurrence.key)) return true;
      seenValueKeys.add(occurrence.key);
      break;
    case 'flag':
    case 'special':
      break;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled argv occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return false;
}

export function findFirstStandardSemanticIssue<T>({
  args,
  spec,
  parsed,
  findSemanticIssue,
}: {
  args: string[],
  spec: StandardArgvParserSpec,
  parsed: ParsedStandardArgv,
  findSemanticIssue: ({ parsed }: { parsed: ParsedStandardArgv }) => T | undefined,
}): T | undefined {
  const fullIssue = findSemanticIssue({ parsed });
  if (fullIssue === undefined && !hasRepeatedValueOccurrenceKey({ parsed })) return undefined;

  for (let end = 1; end <= args.length; end += 1) {
    const parsedPrefix = parseStandardArgv({ args: args.slice(0, end), spec });
    const prefixIssue = findSemanticIssue({ parsed: parsedPrefix });
    if (prefixIssue !== undefined) return prefixIssue;
  }

  return fullIssue;
}


export function standardSemanticIssuePrecedesDiagnostic<T>({
  args,
  spec,
  parsed,
  findSemanticIssue,
}: {
  args: string[],
  spec: StandardArgvParserSpec,
  parsed: ParsedStandardArgv,
  findSemanticIssue: ({ parsed }: { parsed: ParsedStandardArgv }) => T | undefined,
}): boolean {
  if (parsed.diagnostics[0] === undefined) return false;
  if (
    findSemanticIssue({ parsed }) === undefined
    && !hasRepeatedValueOccurrenceKey({ parsed })
  ) return false;

  for (let end = 1; end <= args.length; end += 1) {
    const parsedPrefix = parseStandardArgv({ args: args.slice(0, end), spec });
    const prefixSemanticIssue = findSemanticIssue({ parsed: parsedPrefix });
    const prefixDiagnostic = parsedPrefix.diagnostics.find(value => (
      value.kind !== 'missing_option_value' || end === args.length
    ));

    // When both first become observable in the same token, the semantic issue
    // came from an occurrence parsed before the parser reached its diagnostic.
    if (prefixSemanticIssue !== undefined) return true;
    if (prefixDiagnostic !== undefined) return false;
  }

  return false;
}

/**
 * Adapt commands whose grammar recognizes options only before the first ordinary
 * operand. Later option-looking tokens belong to the operand list. This applies
 * to the supported Bash builtins that use this helper and to command grammars
 * such as `awk` and `which`; it is not a generic GNU rule. The shared parser keeps
 * scanning for options because that is correct for many other utilities, so this
 * boundary stays command-layer behavior rather than changing Wesh argv core.
 */
export function stopStandardOptionParsingAtFirstPositional({
  args,
  spec,
}: {
  args: string[],
  spec: StandardArgvParserSpec,
}): string[] {
  const { shortOptions, longOptions } = getStandardOptionLookup({ spec });

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) break;

    if (spec.stopAtDoubleDash && token === '--') {
      return args;
    }

    let handledSpecial = false;
    for (const specialParser of spec.specialTokenParsers) {
      const result = specialParser({ token, nextToken: args[index + 1] });
      if (result === undefined) continue;
      index += Math.max(result.consumeCount - 1, 0);
      handledSpecial = true;
      break;
    }
    if (handledSpecial) continue;

    if (token.startsWith('--') && token.length > 2) {
      const optionBody = token.slice(2);
      const equalsIndex = optionBody.indexOf('=');
      const key = equalsIndex >= 0 ? optionBody.slice(0, equalsIndex) : optionBody;
      const inlineValue = equalsIndex >= 0 ? optionBody.slice(equalsIndex + 1) : undefined;
      const option = longOptions.get(key);
      if (option?.kind === 'value' && inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (
      token.startsWith('-')
      && token.length > 1
      && !(spec.treatSingleDashAsPositional && token === '-')
    ) {
      const body = token.slice(1);
      for (let bodyIndex = 0; bodyIndex < body.length; bodyIndex += 1) {
        const short = body[bodyIndex];
        if (short === undefined) continue;
        const option = shortOptions.get(short);
        if (option === undefined) break;

        switch (option.kind) {
        case 'flag':
          if (!spec.allowShortFlagBundles && bodyIndex < body.length - 1) {
            return [
              ...args.slice(0, index),
              `-${short}`,
              '--',
              `-${body.slice(bodyIndex + 1)}`,
              ...args.slice(index + 1),
            ];
          }
          continue;
        case 'value': {
          const attachedValue = body.slice(bodyIndex + 1);
          if (!(option.allowAttachedValue && attachedValue.length > 0)) {
            index += 1;
          }
          break;
        }
        default: {
          const _ex: never = option;
          throw new Error(`Unhandled option kind: ${_ex}`);
        }
        }
        break;
      }
      continue;
    }

    return [...args.slice(0, index), '--', ...args.slice(index)];
  }

  return args;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
