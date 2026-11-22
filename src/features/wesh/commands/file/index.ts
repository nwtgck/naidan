import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  parseStandardArgv,
  type ParsedStandardArgv,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import {
  detectFileClassification,
  detectStdinClassification,
  statFileTarget,
} from './detect';
import {
  formatFileClassification,
  formatFileMime,
  formatFileMimeEncoding,
  formatFileMimeType,
} from './format';
import type { FileCommandClassification } from './types';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { getWeshCodePointDisplayWidth } from '@/features/wesh/utils/display-width';
import { isPathTypeMismatchError } from '@/features/wesh/commands/_shared/path-errors';

const fileOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'brief', value: true }] },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'none' } },
      { kind: 'long', name: 'brief', value: { kind: 'none' } },
    ],
    summary: 'do not prepend filenames to output lines',
  },
  {
    semantic: { kind: 'required-value', key: 'separator', parse: undefined },
    forms: [
      { kind: 'short', name: 'F', value: { kind: 'required-attached-or-following', missingValueName: 'SEPARATOR' } },
      { kind: 'long', name: 'separator', value: { kind: 'required', missingValueName: 'SEPARATOR' } },
    ],
    summary: 'use SEPARATOR instead of colon after filenames',
    valueName: 'SEPARATOR',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'followSymlinks', value: true }] },
    forms: [
      { kind: 'short', name: 'L', value: { kind: 'none' } },
      { kind: 'long', name: 'dereference', value: { kind: 'none' } },
    ],
    summary: 'follow symbolic links',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'followSymlinks', value: false }] },
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'no-dereference', value: { kind: 'none' } },
    ],
    summary: 'do not follow symbolic links',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'errorStatus', value: true }] },
    forms: [{ kind: 'short', name: 'E', value: { kind: 'none' } }],
    summary: 'on filesystem errors, print ERROR and return failure',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'mimeType', value: true }, { key: 'mimeEncoding', value: true },] },
    forms: [
      { kind: 'short', name: 'i', value: { kind: 'none' } },
      { kind: 'long', name: 'mime', value: { kind: 'none' } },
    ],
    summary: 'output MIME type and encoding strings',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'mimeType', value: true }] },
    forms: [{ kind: 'long', name: 'mime-type', value: { kind: 'none' } }],
    summary: 'output only the MIME type string',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'mimeEncoding', value: true }] },
    forms: [{ kind: 'long', name: 'mime-encoding', value: { kind: 'none' } }],
    summary: 'output only the MIME encoding string',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const fileArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: fileOptions,
  nonExecutableLongOptions: [],
});
const fileArgvHelp = defineArgvHelpPresentation({ catalog: fileArgvCatalog, rows: fileOptions });
const fileArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};



type FileArgvDiagnostic = ParsedStandardArgv<never>['diagnostics'][number];

function parseFileArgv({ args }: { args: readonly string[] }): {
  parsed: ParsedStandardArgv<never>,
  precedingUnknownOptions: readonly FileArgvDiagnostic[],
} {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--help') {
      continue;
    }

    const prefix = args.slice(0, index + 1);
    const result = parseStandardArgv({ args: prefix, catalog: fileArgvCatalog, policy: fileArgvPolicy });
    if (result.diagnostics.some(diagnostic => diagnostic.kind !== 'unknown_short_option' && diagnostic.kind !== 'unknown_long_option')) {
      continue;
    }

    // Unknown options preceding --help still produce diagnostics. Parse the remaining
    // tokens again so help handling never depends on the values of a failed parse.
    const unknownIndices = new Set(result.diagnostics.map(diagnostic => diagnostic.argvIndex));
    const parsed = unknownIndices.size === 0
      ? result
      : parseStandardArgv({
        args: prefix.map((token, argvIndex) => unknownIndices.has(argvIndex) ? '' : token),
        catalog: fileArgvCatalog,
        policy: fileArgvPolicy,
      });
    if (parsed.diagnostics.length === 0 && parsed.optionValues.help === true) {
      return { parsed, precedingUnknownOptions: result.diagnostics };
    }
  }

  return {
    parsed: parseStandardArgv({ args, catalog: fileArgvCatalog, policy: fileArgvPolicy }),
    precedingUnknownOptions: [],
  };
}

type FileOutputMode = 'description' | 'mime' | 'mime_type' | 'mime_encoding';

function formatClassification({
  classification,
  outputMode,
}: {
  classification: FileCommandClassification,
  outputMode: FileOutputMode,
}): string {
  switch (outputMode) {
  case 'description':
    return formatFileClassification({ classification });
  case 'mime':
    return formatFileMime({ classification });
  case 'mime_type':
    return formatFileMimeType({ classification });
  case 'mime_encoding':
    return formatFileMimeEncoding({ classification });
  default: {
    const _ex: never = outputMode;
    throw new Error(`Unhandled file output mode: ${_ex}`);
  }
  }
}

function getDisplayPath({
  path,
}: {
  path: string,
}): string {
  return path === '-' ? '/dev/stdin' : path;
}

function getFileOperandDisplayWidth({
  path,
}: {
  path: string,
}): number {
  let width = 0;
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const displayWidth = getWeshCodePointDisplayWidth({ codePoint });
    // libmagic counts printable combining and default-ignorable code points as
    // one filename column even though terminal text rendering gives them zero.
    width += displayWidth === 0 && codePoint >= 0x20 ? 1 : displayWidth;
  }
  return width;
}

function fileSystemErrorReason({
  error,
}: {
  error: unknown,
}): string {
  if (isPathTypeMismatchError({ error })) {
    return 'Not a directory';
  }
  if (error instanceof Error && /too many levels of symbolic links/iu.test(error.message)) {
    return 'Too many levels of symbolic links';
  }
  return 'No such file or directory';
}

async function describePath({
  context,
  path,
  brief,
  outputMode,
  followSymlinks,
  operandDisplayWidth,
  alignmentWidth,
  outputSeparator,
  errorStatus,
}: {
  context: WeshCommandContext,
  path: string,
  brief: boolean,
  outputMode: FileOutputMode,
  followSymlinks: boolean,
  operandDisplayWidth: number,
  alignmentWidth: number,
  outputSeparator: string,
  errorStatus: boolean,
}): Promise<{ ok: true } | { ok: false }> {
  const displayPath = getDisplayPath({ path });
  try {
    const classification = path === '-'
      ? await detectStdinClassification({ context })
      : await (async () => {
        const target = await statFileTarget({
          context,
          path,
          followSymlinks,
        });
        return detectFileClassification({ context, target });
      })();
    const brokenSymlinkEncoding = outputMode === 'mime_encoding'
      && classification.kind === 'symlink'
      && classification.broken;
    const description = brokenSymlinkEncoding
      ? 'ERROR: (null)'
      : formatClassification({ classification, outputMode });
    const padding = ' '.repeat(Math.max(1, alignmentWidth - operandDisplayWidth + 1));
    const text = brief ? `${description}\n` : `${displayPath}${outputSeparator}${padding}${description}\n`;
    await context.text().print({ text });
    return brokenSymlinkEncoding ? { ok: false } : { ok: true };
  } catch (error: unknown) {
    const reason = fileSystemErrorReason({ error });
    const padding = ' '.repeat(Math.max(1, alignmentWidth - operandDisplayWidth + 1));
    const description = errorStatus
      ? `ERROR: cannot stat \`${displayPath}' (${reason})`
      : `cannot open \`${displayPath}' (${reason})`;
    const text = brief
      ? `${description}\n`
      : `${displayPath}${outputSeparator}${padding}${description}\n`;
    await context.text().print({ text });
    return errorStatus ? { ok: false } : { ok: true };
  }
}

export const fileCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { parsed, precedingUnknownOptions } = parseFileArgv({ args: context.args });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'file',
        message: `file: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: fileArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      for (const diagnostic of precedingUnknownOptions) {
        await context.text().error({ text: `file: ${diagnostic.message}\n` });
      }
      await writeCommandHelp({
        context,
        command: 'file',
        optionLines: formatArgvOptionHelp({ presentation: fileArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'file',
        message: 'file: missing file operand',
        usageSummary: formatArgvUsageSummary({ presentation: fileArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const mimeType = parsed.optionValues.mimeType === true;
    const mimeEncoding = parsed.optionValues.mimeEncoding === true;
    const outputMode: FileOutputMode = mimeType && mimeEncoding
      ? 'mime'
      : mimeType
        ? 'mime_type'
        : mimeEncoding
          ? 'mime_encoding'
          : 'description';
    const brief = parsed.optionValues.brief === true;
    const outputSeparator = typeof parsed.optionValues.separator === 'string'
      ? parsed.optionValues.separator
      : ':';
    const operands = parsed.positionals.map((path) => ({
      path,
      displayWidth: getFileOperandDisplayWidth({ path }),
    }));
    const alignmentWidth = brief
      ? 0
      : operands.reduce((maximum, operand) => Math.max(maximum, operand.displayWidth), 0);
    let hadFailure = false;
    for (const operand of operands) {
      const result = await describePath({
        context,
        path: operand.path,
        brief,
        outputMode,
        followSymlinks: parsed.optionValues.followSymlinks === true,
        operandDisplayWidth: operand.displayWidth,
        alignmentWidth,
        outputSeparator,
        errorStatus: parsed.optionValues.errorStatus === true,
      });
      if (!result.ok) {
        hadFailure = true;
      }
    }

    return { exitCode: hadFailure ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
