export interface DiffLineTable {
  readonly bytes: Uint8Array,
  readonly starts: Uint32Array,
  readonly ends: Uint32Array,
  readonly hasLineFeed: Uint8Array,
}

export interface DiffInput {
  readonly displayName: string,
  readonly resolvedPath: string | undefined,
  readonly mtime: number | undefined,
  readonly lines: DiffLineTable,
}

export interface DiffComparisonOptions {
  readonly stripTrailingCarriageReturn: boolean,
  readonly ignoreCase: boolean,
  readonly ignoreTabExpansion: boolean,
  readonly ignoreTrailingSpace: boolean,
  readonly ignoreSpaceChange: boolean,
  readonly ignoreAllSpace: boolean,
  readonly tabSize: number,
}

export type DiffOperation =
  | {
      readonly kind: 'equal',
      readonly leftStart: number,
      readonly rightStart: number,
      readonly length: number,
    }
  | {
      readonly kind: 'delete',
      readonly leftStart: number,
      readonly rightStart: number,
      readonly length: number,
    }
  | {
      readonly kind: 'insert',
      readonly leftStart: number,
      readonly rightStart: number,
      readonly length: number,
    };

export interface DiffChangeGroup {
  readonly operationStart: number,
  readonly operationEnd: number,
  readonly leftStart: number,
  readonly leftCount: number,
  readonly rightStart: number,
  readonly rightCount: number,
}

export interface DiffHunk {
  readonly operationStart: number,
  readonly operationEnd: number,
  readonly leftStart: number,
  readonly leftCount: number,
  readonly rightStart: number,
  readonly rightCount: number,
}

export type DiffOutputMode =
  | { readonly kind: 'normal' }
  | { readonly kind: 'unified', readonly contextLines: number }
  | { readonly kind: 'context', readonly contextLines: number }
  | { readonly kind: 'brief' }
  | { readonly kind: 'side-by-side', readonly width: number, readonly commonLineMode: 'both' | 'left-only' | 'suppress' }
  | { readonly kind: 'ed' }
  | { readonly kind: 'rcs' }
  | { readonly kind: 'ifdef', readonly name: string };

export interface DiffOutputOptions {
  readonly mode: DiffOutputMode,
  readonly functionLinePattern: RegExp | undefined,
  readonly expandTabs: boolean,
  readonly initialTab: boolean,
  readonly tabSize: number,
  readonly suppressBlankEmpty: boolean,
  readonly labels: readonly string[],
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
