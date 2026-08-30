import { getOptionalCoreMethod } from '@/features/wesh/commands/_shared/core-capability';
import { isPathNotFoundError, isPathTypeMismatchError } from '@/features/wesh/commands/_shared/path-errors';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext, WeshStat } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  findFirstStandardSemanticIssue,
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';
import { containsNonAsciiDateWhitespace, trimAsciiDateWhitespace } from '@/features/wesh/commands/_shared/date-whitespace';
import { foldAsciiCase } from '@/features/wesh/commands/_shared/locale';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { writeAllFileBytes } from '@/features/wesh/utils/fs';
import { canonicalizePathAllowingMissingLeaf, resolvePath } from '@/features/wesh/path';


type TouchTimeSelection =
  | { readonly kind: 'current' }
  | { readonly kind: 'reference', readonly path: string }
  | { readonly kind: 'date', readonly value: string, readonly referencePath: string | undefined }
  | { readonly kind: 'timestamp', readonly value: string };

const relativeDateUnitsMilliseconds = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

type RelativeDateUnit = keyof typeof relativeDateUnitsMilliseconds;

function parseRelativeDateValue({
  value,
  baseTime,
}: {
  value: string,
  baseTime: number,
}): number | undefined {
  const normalized = foldAsciiCase({ value: trimAsciiDateWhitespace({ value }) });
  switch (normalized) {
  case 'now':
  case 'today':
    return baseTime;
  case 'yesterday':
    return baseTime - relativeDateUnitsMilliseconds.day;
  case 'tomorrow':
    return baseTime + relativeDateUnitsMilliseconds.day;
  default:
    break;
  }

  const match = /^(?:(next|last)[\t\n\v\f\r ]+)?([+-]?\d+)?[\t\n\v\f\r ]*(seconds?|minutes?|hours?|days?|weeks?)(?:[\t\n\v\f\r ]+(ago))?$/.exec(normalized);
  if (match === null) return undefined;

  const directionWord = match[1];
  const rawAmount = match[2];
  const ago = match[4] !== undefined;
  if (directionWord !== undefined && rawAmount !== undefined) return undefined;

  const singularUnit = match[3]?.replace(/s$/, '') as RelativeDateUnit | undefined;
  if (singularUnit === undefined || !(singularUnit in relativeDateUnitsMilliseconds)) {
    return undefined;
  }

  const amount = rawAmount === undefined ? 1 : Number(rawAmount);
  if (!Number.isFinite(amount)) return undefined;

  let direction = 1;
  if (directionWord === 'last' || ago) direction = -1;
  const delta = amount * relativeDateUnitsMilliseconds[singularUnit] * direction;
  const result = baseTime + delta;
  if (!Number.isSafeInteger(result)) return undefined;
  return result;
}

function parseDateValue({ value, baseTime }: { value: string, baseTime: number }): number {
  if (containsNonAsciiDateWhitespace({ value })) {
    throw new Error(`invalid date format '${value}'`);
  }

  const epochMatch = /^@([+-]?\d+)(?:\.(\d+))?$/.exec(value);
  if (epochMatch !== null) {
    const wholeSeconds = Number(epochMatch[1]);
    const fractionalDigits = epochMatch[2] ?? '';
    const milliseconds = Number((fractionalDigits + '000').slice(0, 3));
    const sign = wholeSeconds < 0 || epochMatch[1]?.startsWith('-') === true ? -1 : 1;
    const result = wholeSeconds * 1000 + sign * milliseconds;
    if (!Number.isSafeInteger(result)) {
      throw new Error(`invalid date format '${value}'`);
    }
    return result;
  }

  const relative = parseRelativeDateValue({ value, baseTime });
  if (relative !== undefined) return relative;

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
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
  parsed: ReturnType<typeof parseStandardArgv>,
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

const touchArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'm', long: undefined, effects: [{ key: 'modifyOnly', value: true }], help: { summary: 'change only the modification time', category: 'common' } },
    { kind: 'flag', short: 'h', long: 'no-dereference', effects: [{ key: 'noDereference', value: true }], help: { summary: 'affect symbolic links instead of referenced files', category: 'common' } },
    {
      kind: 'value',
      short: 'd',
      long: 'date',
      key: 'date',
      valueName: 'STRING',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { valueName: 'STRING', summary: 'parse STRING and use it instead of current time', category: 'common' },
    },
    {
      kind: 'value',
      short: 't',
      long: undefined,
      key: 'timestamp',
      valueName: 'STAMP',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { valueName: 'STAMP', summary: 'use [[CC]YY]MMDDhhmm[.ss] instead of current time', category: 'common' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'time',
      key: 'timeKind',
      valueName: 'WORD',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { valueName: 'WORD', summary: 'change the specified time; supports modify or mtime', category: 'advanced' },
    },
    {
      kind: 'value',
      short: 'r',
      long: 'reference',
      key: 'reference',
      valueName: 'FILE',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { valueName: 'FILE', summary: 'use this file timestamps instead of current time', category: 'common' },
    },
    { kind: 'flag', short: 'c', long: 'no-create', effects: [{ key: 'noCreate', value: true }], help: { summary: 'do not create any files', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

type TouchPreHelpSemanticIssue =
  | { readonly kind: 'time-kind', readonly value: string }
  | { readonly kind: 'timestamp', readonly message: string };

function findTouchPreHelpSemanticIssue({
  parsed,
  now,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
  now: number,
}): TouchPreHelpSemanticIssue | undefined {
  const timeKind = parsed.optionValues.timeKind;
  if (timeKind !== undefined && timeKind !== 'modify' && timeKind !== 'mtime') {
    return { kind: 'time-kind', value: String(timeKind) };
  }

  const timestamp = parsed.optionValues.timestamp;
  if (typeof timestamp !== 'string') return undefined;
  try {
    parseTimestampValue({ value: timestamp, now });
    return undefined;
  } catch (error: unknown) {
    return {
      kind: 'timestamp',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export const touchCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: touchArgvSpec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: touchArgvSpec });

    const now = Date.now();
    const diagnostic = parsed.diagnostics[0];
    const findSemanticIssue = ({ parsed: candidate }: { parsed: ReturnType<typeof parseStandardArgv> }) => (
      findTouchPreHelpSemanticIssue({ parsed: candidate, now })
    );
    const firstPreHelpSemanticIssue = findFirstStandardSemanticIssue({
      args: parsedArgs,
      spec: touchArgvSpec,
      parsed,
      findSemanticIssue,
    });
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: touchArgvSpec,
      parsed,
      findSemanticIssue,
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'touch',
        message: `touch: ${diagnostic.message}`,
        argvSpec: touchArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (firstPreHelpSemanticIssue !== undefined) {
      switch (firstPreHelpSemanticIssue.kind) {
      case 'time-kind':
        await context.text().error({
          text: `touch: invalid argument '${firstPreHelpSemanticIssue.value}' for '--time'\n`,
        });
        return { exitCode: 1 };
      case 'timestamp':
        await context.text().error({ text: `touch: ${firstPreHelpSemanticIssue.message}\n` });
        return { exitCode: 1 };
      default: {
        const _ex: never = firstPreHelpSemanticIssue;
        throw new Error(`Unhandled touch pre-help semantic issue: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const text = context.text();

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'touch',
        argvSpec: touchArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'touch',
        message: 'touch: missing file operand',
        argvSpec: touchArgvSpec,
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
      if (p === undefined || p === '-' || (noCreate && p.length === 0)) continue;
      try {
        const affectSymbolicLink = noDereference && !p.endsWith('/');
        let fullPath: string;
        try {
          fullPath = affectSymbolicLink
            ? resolvePath({ cwd: context.cwd, path: p })
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
          await writeAllFileBytes({ files: context.files, path: fullPath, data: new Uint8Array(0) });
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
