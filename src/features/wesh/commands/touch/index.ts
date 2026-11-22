import { getOptionalCoreMethod } from '@/features/wesh/commands/_shared/core-capability';
import { isPathNotFoundError, isPathTypeMismatchError } from '@/features/wesh/commands/_shared/path-errors';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext, WeshStat } from '@/features/wesh/types';
import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type ParsedStandardArgv,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
import { parseDateExpressionMilliseconds } from '@/features/wesh/commands/_shared/date-expression';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { writeAllFileBytes } from '@/features/wesh/utils/fs';
import { canonicalizePathAllowingMissingLeaf, toAbsolutePath } from '@/features/wesh/path';


type TouchTimeSelection =
  | { readonly kind: 'current' }
  | { readonly kind: 'reference', readonly path: string }
  | { readonly kind: 'date', readonly value: string, readonly referencePath: string | undefined }
  | { readonly kind: 'timestamp', readonly value: string };

function parseDateValue({ value, baseTime }: { value: string, baseTime: number }): number {
  const parsed = parseDateExpressionMilliseconds({ value, baseTime });
  if (parsed === undefined) {
    throw new Error(`invalid date format '${value}'`);
  }
  return parsed;
}

function parseTimestampValue({ value, now }: { value: string, now: number }): number {
  const match = /^(\d{8}|\d{10}|\d{12})(?:\.(\d{2}))?$/.exec(value);
  if (match === null) {
    throw new Error(`invalid date format '${value}'`);
  }

  const digits = match[1] ?? '';
  const seconds = Number(match[2] ?? '00');
  const currentYear = new Date(now).getUTCFullYear();
  let year: number;
  let offset: number;
  switch (digits.length) {
  case 8:
    year = currentYear;
    offset = 0;
    break;
  case 10: {
    const shortYear = Number(digits.slice(0, 2));
    year = shortYear >= 69 ? 1900 + shortYear : 2000 + shortYear;
    offset = 2;
    break;
  }
  case 12:
    year = Number(digits.slice(0, 4));
    offset = 4;
    break;
  default: {
    const _ex: never = digits.length as never;
    throw new Error(`Unhandled timestamp length: ${_ex}`);
  }
  }

  const month = Number(digits.slice(offset, offset + 2));
  const day = Number(digits.slice(offset + 2, offset + 4));
  const hour = Number(digits.slice(offset + 4, offset + 6));
  const minute = Number(digits.slice(offset + 6, offset + 8));
  if (seconds > 60) {
    throw new Error(`invalid date format '${value}'`);
  }
  const minuteStart = Date.UTC(year, month - 1, day, hour, minute, 0);
  const normalized = new Date(minuteStart);
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
    || normalized.getUTCHours() !== hour
    || normalized.getUTCMinutes() !== minute
  ) {
    throw new Error(`invalid date format '${value}'`);
  }
  return minuteStart + seconds * 1_000;
}

function selectTouchTime({
  parsed,
}: {
  parsed: ParsedStandardArgv<never>,
}): TouchTimeSelection {
  const dateValue = parsed.optionValues.date;
  const timestampValue = parsed.optionValues.timestamp;
  const referencePath = parsed.optionValues.reference;

  if (
    typeof timestampValue === 'string'
    && (typeof dateValue === 'string' || typeof referencePath === 'string')
  ) {
    throw new Error('cannot specify times from more than one source');
  }

  if (typeof dateValue === 'string') {
    return {
      kind: 'date',
      value: dateValue,
      referencePath: typeof referencePath === 'string' ? referencePath : undefined,
    };
  }
  if (typeof timestampValue === 'string') {
    return { kind: 'timestamp', value: timestampValue };
  }
  if (typeof referencePath === 'string') {
    return { kind: 'reference', path: referencePath };
  }
  return { kind: 'current' };
}

function requiresExplicitMtimeMutation({
  selection,
}: {
  selection: TouchTimeSelection,
}): boolean {
  switch (selection.kind) {
  case 'current':
    return false;
  case 'reference':
  case 'date':
  case 'timestamp':
    return true;
  default: {
    const _ex: never = selection;
    throw new Error(`Unhandled time selection: ${String(_ex)}`);
  }
  }
}

function getReferencePath({
  selection,
}: {
  selection: TouchTimeSelection,
}): string | undefined {
  switch (selection.kind) {
  case 'current':
  case 'timestamp':
    return undefined;
  case 'date':
    return selection.referencePath;
  case 'reference':
    return selection.path;
  default: {
    const _ex: never = selection;
    throw new Error(`Unhandled time selection: ${String(_ex)}`);
  }
  }
}

const touchOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'modifyOnly', value: true }] },
    forms: [{ kind: 'short', name: 'm', value: { kind: 'none' } }],
    summary: 'change only the modification time',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'noDereference', value: true }] },
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'no-dereference', value: { kind: 'none' } },
    ],
    summary: 'affect symbolic links instead of referenced files',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'date', parse: undefined },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'required-attached-or-following', missingValueName: 'STRING' } },
      { kind: 'long', name: 'date', value: { kind: 'required', missingValueName: 'STRING' } },
    ],
    summary: 'parse STRING and use it instead of current time',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'timestamp', parse: undefined },
    forms: [{ kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'STAMP' } }],
    summary: 'use [[CC]YY]MMDDhhmm[.ss] instead of current time',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'timeKind', parse: undefined },
    forms: [{ kind: 'long', name: 'time', value: { kind: 'required', missingValueName: 'WORD' } }],
    summary: 'change the specified time; supports modify or mtime',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'reference', parse: undefined },
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'reference', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'use this file timestamps instead of current time',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'noCreate', value: true }] },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'long', name: 'no-create', value: { kind: 'none' } },
    ],
    summary: 'do not create any files',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const touchArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: touchOptions,
  nonExecutableLongOptions: [],
});
const touchArgvHelp = defineArgvHelpPresentation({ catalog: touchArgvCatalog, rows: touchOptions });
const touchArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

function findTouchOptionError({
  parsed,
  now,
}: {
  parsed: ParsedStandardArgv<never>,
  now: number,
}): string | undefined {
  for (const { semantic, value } of parsed.occurrences ?? []) {
    if (semantic.kind !== 'required-value' || value.kind === 'none') {
      continue;
    }
    const raw = value.rawValue;
    switch (semantic.key) {
    case 'timeKind':
      if (raw !== 'modify' && raw !== 'mtime') {
        return `invalid argument '${raw}' for '--time'`;
      }
      break;
    case 'timestamp':
      try {
        parseTimestampValue({ value: raw, now });
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
      break;
    default:
      break;
    }
  }
  return undefined;
}

export const touchCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopArgvAtFirstEarlyExit({
      args: context.args,
      catalog: touchArgvCatalog,
      policy: touchArgvPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, catalog: touchArgvCatalog, policy: touchArgvPolicy });

    const now = Date.now();
    const diagnostic = parsed.diagnostics[0];
    // A value-bearing option consumes the rest of its short token, so a
    // timestamp or time-kind error before a syntax error is in an earlier token.
    const parsedPrefix = diagnostic === undefined
      ? parsed
      : parseStandardArgv({ args: parsedArgs.slice(0, diagnostic.argvIndex), catalog: touchArgvCatalog, policy: touchArgvPolicy });
    const optionError = findTouchOptionError({ parsed: parsedPrefix, now });
    if (optionError !== undefined) {
      await context.text().error({ text: `touch: ${optionError}\n` });
      return { exitCode: 1 };
    }
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'touch',
        message: `touch: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: touchArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const text = context.text();

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'touch',
        optionLines: formatArgvOptionHelp({ presentation: touchArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'touch',
        message: 'touch: missing file operand',
        usageSummary: formatArgvUsageSummary({ presentation: touchArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const noCreate = parsed.optionValues.noCreate === true;
    const noDereference = parsed.optionValues.noDereference === true;
    let timeSelection: TouchTimeSelection;
    try {
      timeSelection = selectTouchTime({ parsed });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `touch: ${message}\n` });
      return { exitCode: 1 };
    }

    const requiresExplicitMtime = requiresExplicitMtimeMutation({ selection: timeSelection });

    let requestedMtime: number;
    try {
      switch (timeSelection.kind) {
      case 'current':
        requestedMtime = now;
        break;
      case 'date': {
        const baseTime = timeSelection.referencePath === undefined
          ? now
          : (await context.files.stat({
            path: await canonicalizePathAllowingMissingLeaf({
              context,
              path: timeSelection.referencePath,
            }),
          })).mtime;
        requestedMtime = parseDateValue({ value: timeSelection.value, baseTime });
        break;
      }
      case 'timestamp':
        requestedMtime = parseTimestampValue({ value: timeSelection.value, now });
        break;
      case 'reference': {
        const referenceFullPath = await canonicalizePathAllowingMissingLeaf({
          context,
          path: timeSelection.path,
        });
        requestedMtime = (await context.files.stat({ path: referenceFullPath })).mtime;
        break;
      }
      default: {
        const _ex: never = timeSelection;
        throw new Error(`Unhandled time selection: ${String(_ex)}`);
      }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const referencePath = getReferencePath({ selection: timeSelection });
      const subject = referencePath === undefined
        ? message
        : `failed to get attributes of '${referencePath}': ${message}`;
      await text.error({ text: `touch: ${subject}\n` });
      return { exitCode: 1 };
    }

    const setMtime = getOptionalCoreMethod<({
      path,
      mtime,
      finalSymlinkTreatment,
    }: {
      path: string;
      mtime: number;
      finalSymlinkTreatment: 'follow' | 'no-follow';
    }) => Promise<void>>({ object: context.files, name: 'setMtime' });
    let exitCode = 0;

    for (const p of parsed.positionals) {
      if (p === undefined || p === '-' || (noCreate && p.length === 0)) {
        continue;
      }
      try {
        const operandPath = toAbsolutePath({ cwd: context.cwd, path: p });
        const affectSymbolicLink = noDereference && !p.endsWith('/');
        let fullPath: string;
        try {
          fullPath = affectSymbolicLink
            ? operandPath
            : await canonicalizePathAllowingMissingLeaf({ context, path: p });
        } catch (error: unknown) {
          if (noCreate && isPathNotFoundError({ error })) {
            continue;
          }
          throw error;
        }
        let existingStat: WeshStat | undefined;
        try {
          existingStat = affectSymbolicLink
            ? await context.files.lstat({ path: fullPath })
            : await context.files.stat({ path: fullPath });
        } catch (error: unknown) {
          if (!isPathNotFoundError({ error })) {
            throw error;
          }
          if (noCreate) {
            continue;
          }
          if (affectSymbolicLink) {
            throw error;
          }
        }

        if (existingStat === undefined) {
          if (noCreate) {
            continue;
          }
          if (setMtime === undefined && requiresExplicitMtime) {
            throw new Error('operation requires Wesh core mtime mutation support');
          }
          await writeAllFileBytes({ files: context.files, path: operandPath, data: new Uint8Array(0) });
          if (setMtime !== undefined) {
            await setMtime({
              path: fullPath,
              mtime: requestedMtime,
              finalSymlinkTreatment: affectSymbolicLink ? 'no-follow' : 'follow',
            });
          }
          continue;
        }

        const stat = existingStat;
        if (affectSymbolicLink && stat.type === 'symlink') {
          if (setMtime === undefined) {
            throw new Error('operation requires Wesh core mtime mutation support');
          }
          await setMtime({
            path: fullPath,
            mtime: requestedMtime,
            finalSymlinkTreatment: 'no-follow',
          });
          continue;
        }
        switch (stat.type) {
        case 'directory':
        case 'fifo':
        case 'chardev':
          if (setMtime === undefined) {
            throw new Error('operation requires Wesh core mtime mutation support');
          }
          await setMtime({
            path: fullPath,
            mtime: requestedMtime,
            finalSymlinkTreatment: affectSymbolicLink ? 'no-follow' : 'follow',
          });
          continue;
        case 'file':
          break;
        case 'symlink':
          throw new Error(`Unable to resolve symbolic link: ${fullPath}`);
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled file type: ${_ex}`);
        }
        }

        if (setMtime !== undefined) {
          await setMtime({
            path: fullPath,
            mtime: requestedMtime,
            finalSymlinkTreatment: affectSymbolicLink ? 'no-follow' : 'follow',
          });
          continue;
        }
        if (requiresExplicitMtime) {
          throw new Error('operation requires Wesh core mtime mutation support');
        }

        const handle = await context.files.open({
          path: fullPath,
          flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' },
        });
        try {
          await handle.write({
            buffer: new Uint8Array(0),
            position: stat.size,
          });
        } finally {
          await handle.close();
        }
      } catch (e: unknown) {
        const message = isPathTypeMismatchError({ error: e })
          ? 'Not a directory'
          : e instanceof Error
            ? e.message
            : String(e);
        await text.error({ text: `touch: cannot touch '${p}': ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
