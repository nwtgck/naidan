import { parseStandardArgv, type ArgvDiagnostic, type ParsedStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
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

const fileArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'b',
      long: 'brief',
      effects: [{ key: 'brief', value: true }],
      help: { summary: 'do not prepend filenames to output lines' },
    },
    {
      kind: 'value',
      short: 'F',
      long: 'separator',
      key: 'separator',
      valueName: 'SEPARATOR',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'use SEPARATOR instead of colon after filenames', valueName: 'SEPARATOR' },
    },
    {
      kind: 'flag',
      short: 'L',
      long: 'dereference',
      effects: [{ key: 'followSymlinks', value: true }],
      help: { summary: 'follow symbolic links' },
    },
    {
      kind: 'flag',
      short: 'i',
      long: 'mime',
      effects: [
        { key: 'mimeType', value: true },
        { key: 'mimeEncoding', value: true },
      ],
      help: { summary: 'output MIME type and encoding strings' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'mime-type',
      effects: [{ key: 'mimeType', value: true }],
      help: { summary: 'output only the MIME type string' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'mime-encoding',
      effects: [{ key: 'mimeEncoding', value: true }],
      help: { summary: 'output only the MIME encoding string' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};


interface ParsedFileArgv {
  readonly parsed: ParsedStandardArgv,
  readonly helpMode: 'normal' | 'after-unknown-options',
}

function isFileUnknownOptionDiagnostic({
  diagnostic,
}: {
  diagnostic: ArgvDiagnostic,
}): boolean {
  switch (diagnostic.kind) {
  case 'unknown_short_option':
  case 'unknown_long_option':
    return true;
  case 'missing_option_value':
  case 'invalid_option_value':
    return false;
  default: {
    const _ex: never = diagnostic.kind;
    throw new Error(`Unhandled file argv diagnostic kind: ${_ex}`);
  }
  }
}

function parseFileArgv({
  args,
}: {
  args: string[],
}): ParsedFileArgv {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--help') continue;

    const parsedPrefix = parseStandardArgv({
      args: args.slice(0, index + 1),
      spec: fileArgvSpec,
    });
    if (
      parsedPrefix.optionValues.help === true
      && parsedPrefix.diagnostics.every((diagnostic) => isFileUnknownOptionDiagnostic({ diagnostic }))
    ) {
      return {
        parsed: parsedPrefix,
        helpMode: parsedPrefix.diagnostics.length === 0 ? 'normal' : 'after-unknown-options',
      };
    }
  }

  return {
    parsed: parseStandardArgv({ args, spec: fileArgvSpec }),
    helpMode: 'normal',
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
    if (codePoint === undefined) continue;
    const displayWidth = getWeshCodePointDisplayWidth({ codePoint });
    // libmagic counts printable combining and default-ignorable code points as
    // one filename column even though terminal text rendering gives them zero.
    width += displayWidth === 0 && codePoint >= 0x20 ? 1 : displayWidth;
  }
  return width;
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
}: {
  context: WeshCommandContext,
  path: string,
  brief: boolean,
  outputMode: FileOutputMode,
  followSymlinks: boolean,
  operandDisplayWidth: number,
  alignmentWidth: number,
  outputSeparator: string,
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
  } catch {
    const padding = ' '.repeat(Math.max(1, alignmentWidth - operandDisplayWidth + 1));
    const text = brief
      ? `cannot open \`${displayPath}' (No such file or directory)\n`
      : `${displayPath}${outputSeparator}${padding}cannot open \`${displayPath}' (No such file or directory)\n`;
    await context.text().print({ text });
    return { ok: true };
  }
}

export const fileCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgv = parseFileArgv({ args: context.args });
    const { parsed, helpMode } = parsedArgv;

    switch (helpMode) {
    case 'after-unknown-options':
      for (const diagnostic of parsed.diagnostics) {
        await context.text().error({ text: `file: ${diagnostic.message}\n` });
      }
      await writeCommandHelp({
        context,
        command: 'file',
        argvSpec: fileArgvSpec,
      });
      return { exitCode: 0 };
    case 'normal':
      break;
    default: {
      const _ex: never = helpMode;
      throw new Error(`Unhandled file help mode: ${_ex}`);
    }
    }

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'file',
        message: `file: ${diagnostic.message}`,
        argvSpec: fileArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'file',
        argvSpec: fileArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'file',
        message: 'file: missing file operand',
        argvSpec: fileArgvSpec,
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
      });
      if (!result.ok) hadFailure = true;
    }

    return { exitCode: hadFailure ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
