import { analyzeArgvLongForm } from './analyze';
import { parseStandardArgv } from './parser';
import type { StandardArgvAction, StandardArgvPolicy } from './model';
import type { ArgvCatalog } from './catalog';

export interface ArgvEarlyExitOption {
  readonly token: string,
  readonly optionKey: string,
}

const HELP_EARLY_EXIT_OPTION: ArgvEarlyExitOption = Object.freeze({ token: '--help', optionKey: 'help' });
const VERSION_EARLY_EXIT_OPTION: ArgvEarlyExitOption = Object.freeze({ token: '--version', optionKey: 'version' });

export const HELP_EARLY_EXIT_OPTIONS: readonly ArgvEarlyExitOption[] = Object.freeze([
  HELP_EARLY_EXIT_OPTION,
]);

export const HELP_VERSION_EARLY_EXIT_OPTIONS: readonly ArgvEarlyExitOption[] = Object.freeze([
  HELP_EARLY_EXIT_OPTION,
  VERSION_EARLY_EXIT_OPTION,
]);

function couldResolveToEarlyExit({
  token,
  canonicalToken,
}: {
  token: string,
  canonicalToken: string,
}): boolean {
  if (token === canonicalToken) return true;
  if (!canonicalToken.startsWith('--') || !token.startsWith('--')) return false;
  if (token.length <= 2 || token.includes('=')) return false;
  return canonicalToken.startsWith(token);
}

export function stopArgvAtFirstEarlyExit<TDeferred>({
  args,
  catalog,
  policy,
  earlyExitOptions,
}: {
  args: readonly string[],
  catalog: ArgvCatalog<StandardArgvAction<TDeferred>>,
  policy: StandardArgvPolicy,
  earlyExitOptions: readonly ArgvEarlyExitOption[],
}): readonly string[] {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) break;

    for (const earlyExitOption of earlyExitOptions) {
      if (!couldResolveToEarlyExit({ token, canonicalToken: earlyExitOption.token })) continue;

      // A raw abbreviation is only a cheap candidate test. Exact configured tokens go
      // straight to the established prefix parse; there is nothing for the resolver to prove
      // first. For abbreviated long candidates, reject only outcomes that the shared resolver
      // proves cannot be a successful option occurrence. Do not infer the final early-exit key
      // from the matched semantic: the contract is the result of parsing the whole prefix,
      // including earlier option effects and value parsing. This conservative prefilter still
      // removes the adversarial O(n²) path for repeated unknown/ambiguous abbreviations.
      if (token !== earlyExitOption.token && token.startsWith('--') && token !== '--') {
        const analysis = analyzeArgvLongForm({
          token,
          catalog,
          longNameMatch: policy.longNameMatch,
        });
        switch (analysis.kind) {
        case 'unknown':
        case 'ambiguous':
          continue;
        case 'matched':
          break;
        default: {
          const _ex: never = analysis;
          throw new Error(`Unhandled long-form analysis: ${JSON.stringify(_ex)}`);
        }
        }
      }

      const prefix = args.slice(0, index + 1);
      const parsedPrefix = parseStandardArgv({ args: prefix, catalog, policy });
      // Most diagnostics are sticky across a longer parse of the same argv prefix. The one
      // exception relevant here is a missing following value on the current candidate token:
      // a later argv can satisfy it. Once any other diagnostic exists, no later candidate can
      // become a successful terminal option, so stop reparsing ever-growing doomed prefixes.
      const hasPersistentDiagnostic = parsedPrefix.diagnostics.some(diagnostic =>
        diagnostic.kind !== 'missing_option_value' || diagnostic.argvIndex !== index);
      if (hasPersistentDiagnostic) return args;
      if (parsedPrefix.optionValues[earlyExitOption.optionKey] === true) {
        return prefix;
      }

      const hasRepairableCandidateMissingValue = parsedPrefix.diagnostics.some(diagnostic =>
        diagnostic.kind === 'missing_option_value' && diagnostic.argvIndex === index);
      if (hasRepairableCandidateMissingValue) continue;

      // On this rare non-terminal/no-diagnostic path, ask the same parser whether adding the
      // candidate increased positional output. This distinguishes an actual positional from an
      // option occurrence or a token claimed as a previous option's following value without
      // introducing a second ownership model. Value parsers are required to be pure because
      // early-exit prefix checks may invoke them more than once.
      const parsedBeforeCandidate = parseStandardArgv({
        args: args.slice(0, index),
        catalog,
        policy,
      });
      const candidateIsPositional = parsedPrefix.positionals.length > parsedBeforeCandidate.positionals.length;
      const positionalCandidateEndsOptionScanning = (() => {
        switch (policy.optionBoundary) {
        case 'first-positional':
          return true;
        case 'continue':
          // Under the continue policy, ordinary operands, singleton `-`, and unrecognized
          // plus-prefixed tokens do not stop later option scanning. A dash-prefixed token
          // other than singleton `-` reaches the positional result only after explicit `--`.
          return token !== '-' && token.startsWith('-');
        default: {
          const _ex: never = policy.optionBoundary;
          throw new Error(`Unhandled option boundary policy: ${_ex}`);
        }
        }
      })();
      if (candidateIsPositional && positionalCandidateEndsOptionScanning) {
        // The parser has proved that this candidate is positional after a durable boundary.
        // Later candidates cannot become terminal options, so no further prefix reparse is useful.
        return args;
      }
    }
  }
  return args;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
