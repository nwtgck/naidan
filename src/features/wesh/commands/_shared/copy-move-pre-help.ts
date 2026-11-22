import type { ParsedStandardArgv } from '@/features/wesh/argv-v2';
import { parseUpdateMode, type UpdateMode } from './update';

export type CopyMoveOption = 'backup' | 'update';

type CopyMoveOptions =
  | {
      readonly kind: 'options',
      readonly updateMode: UpdateMode,
      readonly backupRequested: boolean,
      readonly backupControl: string | undefined,
    }
  | { readonly kind: 'invalid-option', readonly message: string }
  | { readonly kind: 'multiple-target-directories' };

export function parseCopyMoveOptions({ parsed }: {
  parsed: ParsedStandardArgv<CopyMoveOption>,
}): CopyMoveOptions {
  let targetDirectorySeen = false;
  let updateMode: UpdateMode = 'all';
  let backupRequested = false;
  let backupControl: string | undefined;
  const diagnostic = parsed.diagnostics[0];

  for (const { semantic, value, argvIndex, tokenStart } of parsed.occurrences ?? []) {
    if (diagnostic !== undefined && (argvIndex > diagnostic.argvIndex
      || (argvIndex === diagnostic.argvIndex && tokenStart >= diagnostic.tokenOffset))) {
      break;
    }
    switch (semantic.kind) {
    case 'required-value':
      if (semantic.key !== 'targetDirectory') {
        break;
      }
      if (targetDirectorySeen) {
        return { kind: 'multiple-target-directories' };
      }
      targetDirectorySeen = true;
      break;
    case 'deferred': {
      let rawValue: string | undefined;
      switch (value.kind) {
      case 'none':
        break;
      case 'inline':
      case 'next-argv':
        rawValue = value.rawValue;
        break;
      default: {
        const _ex: never = value;
        throw new Error(`Unhandled copy/move argument: ${JSON.stringify(_ex)}`);
      }
      }
      switch (semantic.tag) {
      case 'backup':
        backupRequested = true;
        if (rawValue !== undefined) {
          backupControl = rawValue;
        }
        break;
      case 'update': {
        const requested = rawValue ?? 'older';
        const mode = parseUpdateMode({ value: requested });
        if (mode === undefined) {
          return { kind: 'invalid-option', message: `invalid argument '${requested}' for '--update'` };
        }
        updateMode = mode;
        break;
      }
      default: {
        const _ex: never = semantic.tag;
        throw new Error(`Unhandled copy/move option: ${_ex}`);
      }
      }
      break;
    }
    case 'effects':
      break;
    default: {
      const _ex: never = semantic;
      throw new Error(`Unhandled copy/move argv occurrence: ${String(_ex)}`);
    }
    }
  }

  return diagnostic === undefined
    ? {
      kind: 'options',
      updateMode,
      backupRequested,
      backupControl,
    }
    : { kind: 'invalid-option', message: diagnostic.message };
}

// ESLint-required test-only export for TypeScript modules.
export const TEST_ONLY = {
};
