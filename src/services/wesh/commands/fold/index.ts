import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { openFileReadStream, openHandleReadStream } from '@/services/wesh/utils/fs';

function parseWidth({
  value,
}: {
  value: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^[1-9]\d*$/.test(value)) {
    return { ok: false, message: `invalid width: '${value}'` };
  }

  return { ok: true, value: Number.parseInt(value, 10) };
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function findFoldBreakIndex({
  characters,
  width,
  breakAtSpaces,
}: {
  characters: string[];
  width: number;
  breakAtSpaces: boolean;
}): number {
  if (characters.length <= width) {
    return characters.length;
  }

  if (!breakAtSpaces) {
    return width;
  }

  for (let index = width - 1; index >= 0; index--) {
    const character = characters[index];
    if (character === ' ' || character === '\t') {
      return index + 1;
    }
  }

  return width;
}

function foldLine({
  line,
  width,
  breakAtSpaces,
}: {
  line: string;
  width: number;
  breakAtSpaces: boolean;
}): string[] {
  const characters = Array.from(line);
  if (characters.length === 0) {
    return [''];
  }

  const foldedLines: string[] = [];
  let remaining = characters;
  while (remaining.length > width) {
    const breakIndex = findFoldBreakIndex({
      characters: remaining,
      width,
      breakAtSpaces,
    });
    foldedLines.push(remaining.slice(0, breakIndex).join(''));
    remaining = remaining.slice(breakIndex);
  }

  foldedLines.push(remaining.join(''));
  return foldedLines;
}

async function writeFoldedLine({
  context,
  line,
  width,
  breakAtSpaces,
  hadNewline,
}: {
  context: WeshCommandContext;
  line: string;
  width: number;
  breakAtSpaces: boolean;
  hadNewline: boolean;
}): Promise<void> {
  const foldedLines = foldLine({
    line,
    width,
    breakAtSpaces,
  });

  for (let index = 0; index < foldedLines.length; index++) {
    const foldedLine = foldedLines[index]!;
    const shouldTerminateWithNewline = hadNewline || index < foldedLines.length - 1;
    await context.text().print({
      text: shouldTerminateWithNewline ? `${foldedLine}\n` : foldedLine,
    });
  }
}

async function processFoldStream({
  context,
  stream,
  width,
  breakAtSpaces,
}: {
  context: WeshCommandContext;
  stream: ReadableStream<Uint8Array>;
  width: number;
  breakAtSpaces: boolean;
}): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        await writeFoldedLine({
          context,
          line,
          width,
          breakAtSpaces,
          hadNewline: true,
        });
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      await writeFoldedLine({
        context,
        line: buffer,
        width,
        breakAtSpaces,
        hadNewline: false,
      });
    }
  } finally {
    reader.releaseLock();
  }
}

const foldArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'w',
      long: 'width',
      key: 'width',
      valueName: 'width',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseWidth({ value }),
      help: { summary: 'use WIDTH columns instead of 80', valueName: 'WIDTH', category: 'common' },
    },
    {
      kind: 'flag',
      short: 's',
      long: 'spaces',
      effects: [{ key: 'spaces', value: true }],
      help: { summary: 'break at spaces if possible', category: 'common' },
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

export const foldCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'fold',
    description: 'Wrap input lines to fit in specified width',
    usage: 'fold [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: foldArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'fold',
        message: `fold: ${diagnostic.message}`,
        argvSpec: foldArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'fold',
        argvSpec: foldArgvSpec,
      });
      return { exitCode: 0 };
    }

    const width = typeof parsed.optionValues.width === 'number' ? parsed.optionValues.width : 80;
    const inputs = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
    let exitCode = 0;

    for (const input of inputs) {
      try {
        const stream = input === '-'
          ? openHandleReadStream({ handle: context.stdin })
          : await openFileReadStream({
            files: context.files,
            path: resolvePath({
              cwd: context.cwd,
              path: input,
            }),
          });

        await processFoldStream({
          context,
          stream,
          width,
          breakAtSpaces: parsed.optionValues.spaces === true,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({
          text: `fold: ${input}: ${message}\n`,
        });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
