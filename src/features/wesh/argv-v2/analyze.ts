import {
  getCatalogData,
  type ArgvCatalog,
  type ArgvCatalogData,
  type ArgvLongValueSyntax,
  type FlatLongArgvForm,
} from './catalog';
import type { ArgvResolvedForm, StandardArgvPolicy } from './model';

interface CatalogArgvInlineValueClaim {
  readonly kind: 'inline',
  readonly rawValue: string,
  readonly tokenStart: number,
  readonly tokenEnd: number,
}

export type CatalogArgvShortValueClaim =
  | { readonly kind: 'none' }
  | CatalogArgvInlineValueClaim
  | { readonly kind: 'following-required', readonly valueName: string }
  | { readonly kind: 'following-optional' };

export type CatalogArgvLongValueClaim =
  | { readonly kind: 'none' }
  | CatalogArgvInlineValueClaim
  | { readonly kind: 'following-required', readonly valueName: string }
  | {
      readonly kind: 'unexpected-inline',
      readonly rawValue: string,
      readonly tokenStart: number,
      readonly tokenEnd: number,
    };

export type CatalogArgvShortFormAnalysis<TSemantic> =
  | {
      readonly kind: 'unknown',
      readonly option: string,
      readonly tokenOffset: number,
    }
  | {
      readonly kind: 'matched',
      readonly semantic: TSemantic,
      readonly resolved: ArgvResolvedForm,
      readonly option: string,
      readonly tokenStart: number,
      readonly tokenEnd: number,
      readonly nextBodyOffset: number,
      readonly value: CatalogArgvShortValueClaim,
    };

export type CatalogArgvLongFormAnalysis<TSemantic> =
  | {
      readonly kind: 'unknown',
      readonly option: string,
    }
  | {
      readonly kind: 'ambiguous',
      readonly option: string,
      readonly candidateOptions: readonly string[],
    }
  | {
      readonly kind: 'matched',
      readonly semantic: TSemantic,
      readonly resolved: ArgvResolvedForm,
      readonly option: string,
      readonly value: CatalogArgvLongValueClaim,
    };

function readUnknownShortOptionName({
  token,
  bodyOffset,
}: {
  token: string,
  bodyOffset: number,
}): string {
  const codePoint = token.codePointAt(bodyOffset);
  if (codePoint === undefined) {
    throw new Error(`Invalid argv short-form analysis offset for ${JSON.stringify(token)}`);
  }
  return String.fromCodePoint(codePoint);
}

// Token-local partial-use primitive for command-owned argv state machines. Real examples include
// Bash `-OO extglob nullglob` (caller-owned following-value cursor) and xxd `-autoskip`
// (caller may intentionally stop after resolving `-a`). Call sites remain mechanically grep-able.
// Precondition: token starts with the supplied prefix and bodyOffset points at an option
// character inside that token body. Invalid coordinates are caller programming errors.
export function analyzeArgvShortForm<TSemantic>({
  token,
  bodyOffset,
  prefix,
  catalog,
}: {
  token: string,
  bodyOffset: number,
  prefix: '-' | '+',
  catalog: ArgvCatalog<TSemantic>,
}): CatalogArgvShortFormAnalysis<TSemantic> {
  return analyzeArgvShortFormWithData({
    token,
    bodyOffset,
    prefix,
    data: getCatalogData({ catalog }),
  });
}

// Internal compiled-catalog entry point shared by the standard scanner and the public
// token-local analyzer. It keeps lexical/value-claim semantics single-sourced without
// making callers outside argv-v2 depend on the compiled catalog representation.
export function analyzeArgvShortFormWithData<TSemantic>({
  token,
  bodyOffset,
  prefix,
  data,
}: {
  token: string,
  bodyOffset: number,
  prefix: '-' | '+',
  data: ArgvCatalogData<TSemantic>,
}): CatalogArgvShortFormAnalysis<TSemantic> {
  if (token[0] !== prefix || bodyOffset < 1 || bodyOffset >= token.length) {
    throw new Error(`Invalid argv short-form analysis coordinates for ${JSON.stringify(token)}`);
  }
  const name = token[bodyOffset]!;
  const flat = (() => {
    switch (prefix) {
    case '-':
      return data.short.get(name);
    case '+':
      return data.plusShort.get(name);
    default: {
      const _ex: never = prefix;
      throw new Error(`Unhandled argv short prefix: ${_ex}`);
    }
    }
  })();
  if (flat === undefined) {
    // Catalog short spellings are one UTF-16 code unit, so keep the hot matched path
    // unchanged. Unknown argv tokens are JavaScript strings, so only the cold miss path
    // reconstructs a complete code point instead of exposing a lone surrogate.
    const unknownName = readUnknownShortOptionName({ token, bodyOffset });
    return { kind: 'unknown', option: `${prefix}${unknownName}`, tokenOffset: bodyOffset };
  }

  const optionStart = bodyOffset;
  const optionEnd = bodyOffset + 1;
  const suffix = token.slice(optionEnd);
  const value = (() => {
    switch (flat.form.value.kind) {
    case 'none':
      return { kind: 'none' as const };
    case 'required-attached-or-following':
      return suffix.length === 0
        ? { kind: 'following-required' as const, valueName: flat.form.value.missingValueName }
        : { kind: 'inline' as const, rawValue: suffix, tokenStart: optionEnd, tokenEnd: token.length };
    case 'optional-following':
      return { kind: 'following-optional' as const };
    case 'optional-attached':
      return suffix.length === 0
        ? { kind: 'none' as const }
        : { kind: 'inline' as const, rawValue: suffix, tokenStart: optionEnd, tokenEnd: token.length };
    default: {
      const _ex: never = flat.form.value;
      throw new Error(`Unhandled argv short value syntax: ${JSON.stringify(_ex)}`);
    }
    }
  })();

  const nextBodyOffset = (() => {
    switch (value.kind) {
    case 'inline':
      return token.length;
    case 'none':
    case 'following-required':
    case 'following-optional':
      return optionEnd;
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled short-form lexical claim: ${JSON.stringify(_ex)}`);
    }
    }
  })();

  return {
    kind: 'matched',
    semantic: flat.semantic,
    resolved: { definitionIndex: flat.definitionIndex, formIndex: flat.formIndex },
    option: `${prefix}${name}`,
    tokenStart: optionStart,
    tokenEnd: optionEnd,
    nextBodyOffset,
    value,
  };
}

type LongFormResolution<TSemantic> =
  | { readonly kind: 'matched', readonly flat: FlatLongArgvForm<TSemantic> }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous', readonly names: readonly string[] };

function haveEquivalentLongValueSyntax({
  left,
  right,
}: {
  left: ArgvLongValueSyntax,
  right: ArgvLongValueSyntax,
}): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
  case 'none':
  case 'optional-inline':
    return true;
  case 'required':
    // GNU getopt_long equivalent-alias resolution is based on the parser contract
    // (required argument + same semantic return), not on a Wesh diagnostic label.
    // If aliases differ only in missingValueName, the first catalog form remains the
    // representative spelling/diagnostic source after the aliases collapse.
    return right.kind === 'required';
  default: {
    const _ex: never = left;
    throw new Error(`Unhandled long argv value syntax: ${JSON.stringify(_ex)}`);
  }
  }
}

export function resolveUniqueLongPrefix<TSemantic>({
  data,
  name,
}: {
  data: ArgvCatalogData<TSemantic>,
  name: string,
}): LongFormResolution<TSemantic> {
  const matches: FlatLongArgvForm<TSemantic>[] = [];
  for (const flat of data.long.values()) {
    if (flat.form.name.startsWith(name)) matches.push(flat);
  }

  // An exact real-but-unimplemented name still wins over longer prefixes, just as an
  // exact executable name does. Wesh cannot execute it, so leave it unresolved here.
  if (data.nonExecutableLongGroupByName.has(name)) return { kind: 'none' };

  const nonExecutableMatches: string[] = [];
  let nonExecutableGroup: number | undefined;
  let multipleNonExecutableGroups = false;
  for (const [nonExecutableName, group] of data.nonExecutableLongGroupByName) {
    if (!nonExecutableName.startsWith(name)) continue;
    nonExecutableMatches.push(nonExecutableName);
    if (nonExecutableGroup === undefined) nonExecutableGroup = group;
    else if (nonExecutableGroup !== group) multipleNonExecutableGroups = true;
  }
  if (nonExecutableMatches.length > 0) {
    if (matches.length > 0 || multipleNonExecutableGroups) {
      return {
        kind: 'ambiguous',
        names: [
          ...matches.map(candidate => candidate.form.name),
          ...nonExecutableMatches,
        ].sort(),
      };
    }
    // Multiple unsupported spellings in one real equivalence group are one resolver
    // candidate. Wesh still cannot execute that semantic, so report the token as unknown
    // rather than a false ambiguity.
    return { kind: 'none' };
  }
  if (matches.length === 0) return { kind: 'none' };

  const first = matches[0];
  if (first === undefined) return { kind: 'none' };
  const firstValue = first.form.value;
  const equivalent = matches.every(candidate => candidate.definitionIndex === first.definitionIndex
    && haveEquivalentLongValueSyntax({ left: candidate.form.value, right: firstValue }));
  if (equivalent) return { kind: 'matched', flat: first };
  return {
    kind: 'ambiguous',
    names: matches.map(candidate => candidate.form.name).sort(),
  };
}

// Token-local long-name resolver for command-owned argv phases. Git subcommand parse-options
// (`git status --porc`) is a real unique-prefix example; the caller owns phase/cursor semantics.
// Precondition: token is a long-option token beginning with `--`, excluding the bare `--`
// terminator. Invalid tokens are caller programming errors. Keep partial-use call sites direct
// so this function name remains a useful architecture-review grep point.
export function analyzeArgvLongForm<TSemantic>({
  token,
  catalog,
  longNameMatch,
}: {
  token: string,
  catalog: ArgvCatalog<TSemantic>,
  longNameMatch: StandardArgvPolicy['longNameMatch'],
}): CatalogArgvLongFormAnalysis<TSemantic> {
  return analyzeArgvLongFormWithData({
    token,
    data: getCatalogData({ catalog }),
    longNameMatch,
  });
}

// Internal compiled-catalog entry point; see analyzeArgvShortFormWithData.
export function analyzeArgvLongFormWithData<TSemantic>({
  token,
  data,
  longNameMatch,
}: {
  token: string,
  data: ArgvCatalogData<TSemantic>,
  longNameMatch: StandardArgvPolicy['longNameMatch'],
}): CatalogArgvLongFormAnalysis<TSemantic> {
  if (!token.startsWith('--') || token === '--') {
    throw new Error(`Invalid argv long-form analysis token: ${JSON.stringify(token)}`);
  }
  const body = token.slice(2);
  const equalsIndex = body.indexOf('=');
  const name = equalsIndex < 0 ? body : body.slice(0, equalsIndex);
  const inlineValue = equalsIndex < 0 ? undefined : body.slice(equalsIndex + 1);
  let flat = data.long.get(name);
  if (flat === undefined) {
    const resolution = (() => {
      switch (longNameMatch) {
      case 'exact':
        return { kind: 'none' as const };
      case 'unique-prefix':
        return resolveUniqueLongPrefix({ data, name });
      default: {
        const _ex: never = longNameMatch;
        throw new Error(`Unhandled long-name match policy: ${_ex}`);
      }
      }
    })();
    switch (resolution.kind) {
    case 'none':
      return { kind: 'unknown', option: token };
    case 'ambiguous':
      return {
        kind: 'ambiguous',
        option: token,
        candidateOptions: resolution.names.map(candidate => `--${candidate}`),
      };
    case 'matched':
      flat = resolution.flat;
      break;
    default: {
      const _ex: never = resolution;
      throw new Error(`Unhandled long-form resolution: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const value = (() => {
    switch (flat.form.value.kind) {
    case 'none':
      return inlineValue === undefined
        ? { kind: 'none' as const }
        : {
          kind: 'unexpected-inline' as const,
          rawValue: inlineValue,
          tokenStart: equalsIndex + 3,
          tokenEnd: token.length,
        };
    case 'required':
      return inlineValue === undefined
        ? { kind: 'following-required' as const, valueName: flat.form.value.missingValueName }
        : {
          kind: 'inline' as const,
          rawValue: inlineValue,
          tokenStart: equalsIndex + 3,
          tokenEnd: token.length,
        };
    case 'optional-inline':
      return inlineValue === undefined
        ? { kind: 'none' as const }
        : {
          kind: 'inline' as const,
          rawValue: inlineValue,
          tokenStart: equalsIndex + 3,
          tokenEnd: token.length,
        };
    default: {
      const _ex: never = flat.form.value;
      throw new Error(`Unhandled argv long value syntax: ${JSON.stringify(_ex)}`);
    }
    }
  })();

  return {
    kind: 'matched',
    semantic: flat.semantic,
    resolved: { definitionIndex: flat.definitionIndex, formIndex: flat.formIndex },
    option: `--${flat.form.name}`,
    value,
  };
}


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
