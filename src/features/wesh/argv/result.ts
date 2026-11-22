import type { ArgvOptionEffect, ArgvValue } from './types';
import type { ArgvResolvedForm, StandardArgvAction } from './model';

export type StandardArgvRawValue =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'inline',
      readonly rawValue: string,
      readonly argvIndex: number,
      readonly tokenStart: number,
      readonly tokenEnd: number,
    }
  | {
      readonly kind: 'next-argv',
      readonly rawValue: string,
      readonly argvIndex: number,
    };

export interface StandardArgvOccurrence<TSemantic> {
  readonly semantic: TSemantic,
  readonly resolved: ArgvResolvedForm,
  readonly argvIndex: number,
  readonly tokenStart: number,
  readonly tokenEnd: number,
  readonly value: StandardArgvRawValue,
}

export type StandardArgvDiagnostic =
  | {
      readonly kind: 'unknown_short_option',
      readonly argvIndex: number,
      readonly tokenOffset: number,
      readonly option: string,
      readonly message: string,
    }
  | {
      readonly kind: 'unknown_long_option',
      readonly argvIndex: number,
      readonly tokenOffset: number,
      readonly option: string,
      readonly message: string,
    }
  | {
      readonly kind: 'ambiguous_long_option',
      readonly argvIndex: number,
      readonly tokenOffset: number,
      readonly option: string,
      readonly candidateOptions: readonly string[],
      readonly message: string,
    }
  | {
      readonly kind: 'missing_option_value',
      readonly argvIndex: number,
      readonly tokenOffset: number,
      readonly option: string,
      readonly message: string,
    }
  | {
      readonly kind: 'unexpected_option_value',
      readonly argvIndex: number,
      readonly tokenOffset: number,
      readonly option: string,
      readonly message: string,
    }
  | {
      readonly kind: 'invalid_option_value',
      readonly argvIndex: number,
      readonly tokenOffset: number,
      readonly option: string,
      readonly message: string,
    };

export function createMissingOptionValueDiagnostic({
  argvIndex,
  tokenOffset,
  option,
  valueName,
}: {
  argvIndex: number,
  tokenOffset: number,
  option: string,
  valueName: string,
}): Extract<StandardArgvDiagnostic, { kind: 'missing_option_value' }> {
  return {
    kind: 'missing_option_value',
    argvIndex,
    tokenOffset,
    option,
    message: `${option} requires a value for ${valueName}`,
  };
}

export interface ParsedStandardArgv<TDeferred> {
  readonly optionValues: Readonly<Record<string, ArgvValue>>,
  readonly positionals: readonly string[],
  readonly diagnostics: readonly StandardArgvDiagnostic[],
  readonly deferred: readonly StandardArgvOccurrence<Extract<StandardArgvAction<TDeferred>, { kind: 'deferred' }>>[],
  readonly occurrences: readonly StandardArgvOccurrence<StandardArgvAction<TDeferred>>[] | undefined,
}

function applyEffects({
  optionValues,
  effects,
}: {
  optionValues: Record<string, ArgvValue>,
  effects: readonly ArgvOptionEffect[],
}): void {
  for (const effect of effects) {
    optionValues[effect.key] = effect.value;
  }
}

function createOccurrence<TSemantic>({
  semantic,
  resolved,
  argvIndex,
  tokenStart,
  tokenEnd,
  value,
}: {
  semantic: TSemantic,
  resolved: ArgvResolvedForm,
  argvIndex: number,
  tokenStart: number,
  tokenEnd: number,
  value: StandardArgvRawValue,
}): StandardArgvOccurrence<TSemantic> {
  return {
    semantic,
    resolved,
    argvIndex,
    tokenStart,
    tokenEnd,
    value,
  };
}

export function commitStandardArgvAction<TDeferred>({
  action,
  resolved,
  argvIndex,
  tokenStart,
  tokenEnd,
  value,
  option,
  optionValues,
  diagnostics,
  deferred,
  occurrences,
}: {
  action: StandardArgvAction<TDeferred>,
  resolved: ArgvResolvedForm,
  argvIndex: number,
  tokenStart: number,
  tokenEnd: number,
  value: StandardArgvRawValue,
  option: string,
  optionValues: Record<string, ArgvValue>,
  diagnostics: StandardArgvDiagnostic[],
  deferred: StandardArgvOccurrence<Extract<StandardArgvAction<TDeferred>, { kind: 'deferred' }>>[],
  occurrences: StandardArgvOccurrence<StandardArgvAction<TDeferred>>[] | undefined,
}): void {
  switch (action.kind) {
  case 'effects':
    applyEffects({ optionValues, effects: action.effects });
    if (occurrences !== undefined) {
      occurrences.push(createOccurrence({ semantic: action, resolved, argvIndex, tokenStart, tokenEnd, value }));
    }
    return;
  case 'required-value': {
    const rawValue = (() => {
      switch (value.kind) {
      case 'none':
        throw new Error(`argv structural contract violated for ${option}`);
      case 'inline':
      case 'next-argv':
        return value.rawValue;
      default: {
        const _ex: never = value;
        throw new Error(`Unhandled argv raw value kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    if (occurrences !== undefined) {
      occurrences.push(createOccurrence({ semantic: action, resolved, argvIndex, tokenStart, tokenEnd, value }));
    }
    const parsed = action.parse === undefined
      ? { kind: 'parsed' as const, value: rawValue }
      : action.parse({ rawValue });
    switch (parsed.kind) {
    case 'parsed':
      optionValues[action.key] = parsed.value;
      return;
    case 'invalid':
      diagnostics.push({
        kind: 'invalid_option_value',
        argvIndex: value.argvIndex,
        tokenOffset: (() => {
          switch (value.kind) {
          case 'inline':
            return value.tokenStart;
          case 'next-argv':
            return 0;
          default: {
            const _ex: never = value;
            throw new Error(`Unhandled argv raw value kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
          }
          }
        })(),
        option,
        message: parsed.message,
      });
      return;
    default: {
      const _ex: never = parsed;
      throw new Error(`Unhandled argv value parse result: ${JSON.stringify(_ex)}`);
    }
    }
  }
  case 'deferred': {
    const occurrence = createOccurrence({ semantic: action, resolved, argvIndex, tokenStart, tokenEnd, value });
    deferred.push(occurrence);
    occurrences?.push(occurrence);
    return;
  }
  default: {
    const _ex: never = action;
    throw new Error(`Unhandled standard argv action: ${JSON.stringify(_ex)}`);
  }
  }
}


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
