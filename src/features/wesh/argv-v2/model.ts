import type { ArgvOptionEffect, ArgvValue } from './types';

export type StandardArgvValueParseResult =
  | { readonly kind: 'parsed', readonly value: ArgvValue }
  | { readonly kind: 'invalid', readonly message: string };

// `ArgvCatalog<TSemantic>` deliberately stores generic semantic payloads by reference so
// token-local analyzers can preserve caller-owned identity. Treat StandardArgvAction objects,
// nested effects arrays, and deferred tags as immutable declarations after catalog definition.
export type StandardArgvAction<TDeferred> =
  | {
      readonly kind: 'effects',
      readonly effects: readonly ArgvOptionEffect[],
    }
  | {
      readonly kind: 'required-value',
      readonly key: string,
      // Pair this action only with syntax forms that structurally require a value. Optional
      // value syntax can produce a value-less occurrence; use `deferred` when the command
      // must distinguish option presence from an absent/empty optional value.
      // This callback is a pure value transformation. Early-exit source-order checks may
      // parse argv prefixes, so callers must not rely on exactly-once invocation or perform
      // side effects here. Command state changes belong in the command-owned semantic layer.
      readonly parse: (({ rawValue }: { rawValue: string }) => StandardArgvValueParseResult) | undefined,
    }
  // Searchable semantic-delegation boundary: the standard scanner owns syntax/value
  // claims, while the command owns this bounded semantic family. Future argv architecture
  // reviews can grep command catalogs for `kind: 'deferred'`.
  | {
      readonly kind: 'deferred',
      readonly tag: TDeferred,
    };

export interface StandardArgvPolicy {
  // Real-command examples include GNU Coreutils (`rmdir --ignore-fail`) and Git
  // subcommand parse-options (`git status --porc`). Commands that require exact long
  // spellings keep `exact`; prefix-resolution diagnostics remain command-consumable data.
  readonly longNameMatch: 'exact' | 'unique-prefix',
  readonly optionBoundary: 'continue' | 'first-positional',
  // Keep `all` even while the migrated v2 cohort does not consume it yet: existing
  // Wesh commands such as date, sort, cp, and grep use ordered option occurrences for
  // real source-order semantics. Re-adding this only after migration would reopen the
  // frozen result contract, so retain the verified shared mechanic here.
  readonly occurrenceRetention: 'none' | 'all',
}

export interface ArgvResolvedForm {
  readonly definitionIndex: number,
  readonly formIndex: number,
}


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
