import type { ArgvValue } from './types';
import { getCatalogData, type ArgvCatalog } from './catalog';
import { analyzeArgvLongFormWithData, analyzeArgvShortFormWithData } from './analyze';
import type { StandardArgvAction, StandardArgvPolicy } from './model';
import {
  commitStandardArgvAction,
  createMissingOptionValueDiagnostic,
  type ParsedStandardArgv,
  type StandardArgvDiagnostic,
  type StandardArgvOccurrence,
} from './result';

export function parseStandardArgv<TDeferred>({
  args,
  catalog,
  policy,
}: {
  args: readonly string[],
  catalog: ArgvCatalog<StandardArgvAction<TDeferred>>,
  policy: StandardArgvPolicy,
}): ParsedStandardArgv<TDeferred> {
  const data = getCatalogData({ catalog });
  const optionValues = Object.create(null) as Record<string, ArgvValue>;
  const positionals: string[] = [];
  const diagnostics: StandardArgvDiagnostic[] = [];
  const deferred: StandardArgvOccurrence<Extract<StandardArgvAction<TDeferred>, { kind: 'deferred' }>>[] = [];
  let occurrences: StandardArgvOccurrence<StandardArgvAction<TDeferred>>[] | undefined;
  switch (policy.occurrenceRetention) {
  case 'none':
    occurrences = undefined;
    break;
  case 'all':
    occurrences = [];
    break;
  default: {
    const _ex: never = policy.occurrenceRetention;
    throw new Error(`Unhandled occurrence retention policy: ${_ex}`);
  }
  }

  for (let argvIndex = 0; argvIndex < args.length;) {
    const token = args[argvIndex];
    if (token === undefined) break;

    if (token === '--') {
      for (let restIndex = argvIndex + 1; restIndex < args.length; restIndex += 1) {
        const rest = args[restIndex];
        if (rest !== undefined) {
          positionals.push(rest);
        }
      }
      break;
    }

    const isPlusShortToken = token !== '+' && token.startsWith('+') && data.plusShort.size > 0;
    if (token === '-' || token === '+' || (!token.startsWith('-') && !isPlusShortToken)) {
      positionals.push(token);
      argvIndex += 1;
      switch (policy.optionBoundary) {
      case 'continue':
        continue;
      case 'first-positional':
        for (; argvIndex < args.length; argvIndex += 1) {
          const rest = args[argvIndex];
          if (rest !== undefined) {
            positionals.push(rest);
          }
        }
        break;
      default: {
        const _ex: never = policy.optionBoundary;
        throw new Error(`Unhandled option boundary policy: ${_ex}`);
      }
      }
      break;
    }

    if (token.startsWith('--')) {
      const analysis = analyzeArgvLongFormWithData({
        token,
        data,
        longNameMatch: policy.longNameMatch,
      });
      switch (analysis.kind) {
      case 'unknown':
        diagnostics.push({
          kind: 'unknown_long_option',
          argvIndex,
          tokenOffset: 0,
          option: analysis.option,
          message: `unrecognized option '${analysis.option}'`,
        });
        argvIndex += 1;
        continue;
      case 'ambiguous':
        diagnostics.push({
          kind: 'ambiguous_long_option',
          argvIndex,
          tokenOffset: 0,
          option: analysis.option,
          candidateOptions: analysis.candidateOptions,
          message: `option '${analysis.option}' is ambiguous; possibilities: ${analysis.candidateOptions.map(candidate => `'${candidate}'`).join(' ')}`,
        });
        argvIndex += 1;
        continue;
      case 'matched': {
        const { semantic: action, resolved, option, value } = analysis;
        const optionTokenEnd = (() => {
          switch (value.kind) {
          case 'inline':
          case 'unexpected-inline':
            return value.tokenStart - 1;
          case 'none':
          case 'following-required':
            return token.length;
          default: {
            const _ex: never = value;
            throw new Error(`Unhandled long-form value claim: ${JSON.stringify(_ex)}`);
          }
          }
        })();
        switch (value.kind) {
        case 'none':
          commitStandardArgvAction({
            action,
            resolved,
            argvIndex,
            tokenStart: 0,
            tokenEnd: optionTokenEnd,
            value: { kind: 'none' },
            option,
            optionValues,
            diagnostics,
            deferred,
            occurrences,
          });
          argvIndex += 1;
          continue;
        case 'unexpected-inline':
          diagnostics.push({
            kind: 'unexpected_option_value',
            argvIndex,
            tokenOffset: 0,
            option,
            message: `option '${option}' doesn't allow an argument`,
          });
          argvIndex += 1;
          continue;
        case 'inline':
          commitStandardArgvAction({
            action,
            resolved,
            argvIndex,
            tokenStart: 0,
            tokenEnd: optionTokenEnd,
            value: {
              kind: 'inline',
              rawValue: value.rawValue,
              argvIndex,
              tokenStart: value.tokenStart,
              tokenEnd: value.tokenEnd,
            },
            option,
            optionValues,
            diagnostics,
            deferred,
            occurrences,
          });
          argvIndex += 1;
          continue;
        case 'following-required': {
          const following = args[argvIndex + 1];
          if (following === undefined) {
            diagnostics.push(createMissingOptionValueDiagnostic({
              argvIndex,
              tokenOffset: 0,
              option,
              valueName: value.valueName,
            }));
            argvIndex += 1;
            continue;
          }
          commitStandardArgvAction({
            action,
            resolved,
            argvIndex,
            tokenStart: 0,
            tokenEnd: optionTokenEnd,
            value: { kind: 'next-argv', rawValue: following, argvIndex: argvIndex + 1 },
            option,
            optionValues,
            diagnostics,
            deferred,
            occurrences,
          });
          argvIndex += 2;
          continue;
        }
        default: {
          const _ex: never = value;
          throw new Error(`Unhandled long-form value claim: ${JSON.stringify(_ex)}`);
        }
        }
      }
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled long-form analysis: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const prefix = isPlusShortToken ? '+' : '-';
    let bodyOffset = 1;
    let nextArgvIndex = argvIndex + 1;
    while (bodyOffset < token.length) {
      const analysis = analyzeArgvShortFormWithData({ token, bodyOffset, prefix, data });
      switch (analysis.kind) {
      case 'unknown':
        diagnostics.push({
          kind: 'unknown_short_option',
          argvIndex,
          tokenOffset: analysis.tokenOffset,
          option: analysis.option,
          message: `invalid option -- '${analysis.option.slice(1)}'`,
        });
        bodyOffset = token.length;
        continue;
      case 'matched': {
        const { semantic: action, resolved, option, tokenStart, tokenEnd, value } = analysis;
        switch (value.kind) {
        case 'none':
          commitStandardArgvAction({
            action,
            resolved,
            argvIndex,
            tokenStart,
            tokenEnd,
            value: { kind: 'none' },
            option,
            optionValues,
            diagnostics,
            deferred,
            occurrences,
          });
          bodyOffset = analysis.nextBodyOffset;
          continue;
        case 'inline':
          commitStandardArgvAction({
            action,
            resolved,
            argvIndex,
            tokenStart,
            tokenEnd,
            value: {
              kind: 'inline',
              rawValue: value.rawValue,
              argvIndex,
              tokenStart: value.tokenStart,
              tokenEnd: value.tokenEnd,
            },
            option,
            optionValues,
            diagnostics,
            deferred,
            occurrences,
          });
          bodyOffset = analysis.nextBodyOffset;
          continue;
        case 'following-required': {
          const following = args[nextArgvIndex];
          if (following === undefined) {
            diagnostics.push(createMissingOptionValueDiagnostic({
              argvIndex,
              tokenOffset: tokenStart,
              option,
              valueName: value.valueName,
            }));
            bodyOffset = token.length;
            continue;
          }
          commitStandardArgvAction({
            action,
            resolved,
            argvIndex,
            tokenStart,
            tokenEnd,
            value: { kind: 'next-argv', rawValue: following, argvIndex: nextArgvIndex },
            option,
            optionValues,
            diagnostics,
            deferred,
            occurrences,
          });
          nextArgvIndex += 1;
          bodyOffset = analysis.nextBodyOffset;
          continue;
        }
        case 'following-optional': {
          const following = args[nextArgvIndex];
          commitStandardArgvAction({
            action,
            resolved,
            argvIndex,
            tokenStart,
            tokenEnd,
            value: following === undefined
              ? { kind: 'none' }
              : { kind: 'next-argv', rawValue: following, argvIndex: nextArgvIndex },
            option,
            optionValues,
            diagnostics,
            deferred,
            occurrences,
          });
          if (following !== undefined) nextArgvIndex += 1;
          bodyOffset = analysis.nextBodyOffset;
          continue;
        }
        default: {
          const _ex: never = value;
          throw new Error(`Unhandled short-form value claim: ${JSON.stringify(_ex)}`);
        }
        }
      }
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled short-form analysis: ${JSON.stringify(_ex)}`);
      }
      }
    }
    argvIndex = nextArgvIndex;
  }

  return {
    optionValues,
    positionals,
    diagnostics,
    deferred,
    occurrences,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
