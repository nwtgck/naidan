import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshFileHandle,
} from '@/features/wesh/types';
import { openFileReadStream, openHandleReadStream } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

const BACKSPACE_BYTE = 0x08;
const TAB_BYTE = 0x09;
const NEWLINE_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;
const SPACE_BYTE = 0x20;
const OUTPUT_BUFFER_LENGTH = 16 * 1024;

type FoldWidthMode = 'columns' | 'bytes';

type FoldByteLine = {
  readonly bytes: Uint8Array,
  readonly hadNewline: boolean,
};

function parseWidth({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?[1-9]\d*$/.test(numericText)) {
    return { ok: false, message: `invalid width: '${value}'` };
  }

  const parsed = Number.parseInt(numericText, 10);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `invalid width: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function concatenateChunks({
  chunks,
  totalLength,
}: {
  chunks: readonly Uint8Array[],
  totalLength: number,
}): Uint8Array {
  if (chunks.length === 1) {
    return new Uint8Array(chunks[0]!);
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function* iterateByteLineRecords({
  chunks,
}: {
  chunks: AsyncIterable<Uint8Array>,
}): AsyncIterable<FoldByteLine> {
  let fragments: Uint8Array[] = [];
  let fragmentLength = 0;

  const createRecord = ({
    finalFragment,
    hadNewline,
  }: {
    finalFragment: Uint8Array,
    hadNewline: boolean,
  }): FoldByteLine => {
    const totalLength = fragmentLength + finalFragment.byteLength;
    const bytes = fragments.length === 0
      ? new Uint8Array(finalFragment)
      : concatenateChunks({
        chunks: [...fragments, finalFragment],
        totalLength,
      });
    fragments = [];
    fragmentLength = 0;
    return { bytes, hadNewline };
  };

  for await (const chunk of chunks) {
    let recordStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== NEWLINE_BYTE) {
        continue;
      }

      yield createRecord({
        finalFragment: chunk.subarray(recordStart, index),
        hadNewline: true,
      });
      recordStart = index + 1;
    }

    if (recordStart < chunk.byteLength) {
      const fragment = chunk.subarray(recordStart);
      fragments.push(fragment);
      fragmentLength += fragment.byteLength;
    }
  }

  if (fragments.length > 0) {
    yield createRecord({
      finalFragment: new Uint8Array(0),
      hadNewline: false,
    });
  }
}

async function writeAllBytesToHandle({
  handle,
  bytes,
}: {
  handle: WeshFileHandle,
  bytes: Uint8Array,
}): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write({
      buffer: bytes,
      offset,
      length: bytes.byteLength - offset,
    });
    if (bytesWritten === 0) {
      throw new Error('short write');
    }
    offset += bytesWritten;
  }
}

function createBufferedBinaryWriter({
  handle,
  maxBufferLength,
}: {
  handle: WeshFileHandle,
  maxBufferLength: number,
}) {
  let chunks: Uint8Array[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }

    const bytes = concatenateChunks({
      chunks,
      totalLength: bufferedLength,
    });
    chunks = [];
    bufferedLength = 0;
    await writeAllBytesToHandle({ handle, bytes });
  };

  return {
    async write({
      bytes,
    }: {
      bytes: Uint8Array,
    }): Promise<void> {
      if (bytes.byteLength === 0) {
        return;
      }

      chunks.push(bytes);
      bufferedLength += bytes.byteLength;
      if (bufferedLength >= maxBufferLength) {
        await flush();
      }
    },
    flush,
  };
}

function advanceColumn({
  column,
  byte,
  widthMode,
}: {
  column: number,
  byte: number,
  widthMode: FoldWidthMode,
}): number {
  switch (widthMode) {
  case 'bytes':
    return column + 1;
  case 'columns':
    switch (byte) {
    case BACKSPACE_BYTE:
      return Math.max(0, column - 1);
    case TAB_BYTE:
      return column + (8 - (column % 8));
    case CARRIAGE_RETURN_BYTE:
      return 0;
    default:
      return column + 1;
    }
  default: {
    const _ex: never = widthMode;
    throw new Error(`Unhandled fold width mode: ${_ex}`);
  }
  }
}

function isBlankByte({ byte }: { byte: number }): boolean {
  return byte === SPACE_BYTE || byte === TAB_BYTE;
}

function foldLineBytes({
  bytes,
  width,
  breakAtSpaces,
  widthMode,
}: {
  bytes: Uint8Array,
  width: number,
  breakAtSpaces: boolean,
  widthMode: FoldWidthMode,
}): readonly Uint8Array[] {
  if (bytes.byteLength === 0) {
    return [bytes];
  }

  const folded: Uint8Array[] = [];
  let segmentStart = 0;
  let index = 0;
  let column = 0;
  let lastBlankEnd: number | undefined;

  while (index < bytes.byteLength) {
    const byte = bytes[index]!;
    const nextColumn = advanceColumn({
      column,
      byte,
      widthMode,
    });

    if (nextColumn > width && index > segmentStart) {
      const segmentEnd = breakAtSpaces && lastBlankEnd !== undefined
        ? lastBlankEnd
        : index;
      folded.push(bytes.subarray(segmentStart, segmentEnd));
      segmentStart = segmentEnd;
      index = segmentStart;
      column = 0;
      lastBlankEnd = undefined;
      continue;
    }

    column = nextColumn;
    index += 1;
    if (isBlankByte({ byte })) {
      lastBlankEnd = index;
    }
  }

  folded.push(bytes.subarray(segmentStart));
  return folded;
}

async function writeFoldedLine({
  writer,
  line,
  width,
  breakAtSpaces,
  widthMode,
}: {
  writer: ReturnType<typeof createBufferedBinaryWriter>,
  line: FoldByteLine,
  width: number,
  breakAtSpaces: boolean,
  widthMode: FoldWidthMode,
}): Promise<void> {
  const foldedLines = foldLineBytes({
    bytes: line.bytes,
    width,
    breakAtSpaces,
    widthMode,
  });

  for (let index = 0; index < foldedLines.length; index += 1) {
    await writer.write({ bytes: foldedLines[index]! });
    if (line.hadNewline || index < foldedLines.length - 1) {
      await writer.write({ bytes: Uint8Array.of(NEWLINE_BYTE) });
    }
  }
}

async function processFoldStream({
  context,
  stream,
  width,
  breakAtSpaces,
  widthMode,
}: {
  context: WeshCommandContext,
  stream: ReadableStream<Uint8Array>,
  width: number,
  breakAtSpaces: boolean,
  widthMode: FoldWidthMode,
}): Promise<void> {
  const writer = createBufferedBinaryWriter({
    handle: context.stdout,
    maxBufferLength: OUTPUT_BUFFER_LENGTH,
  });
  for await (const line of iterateByteLineRecords({
    chunks: iterateReadableStreamChunks({ stream }),
  })) {
    await writeFoldedLine({
      writer,
      line,
      width,
      breakAtSpaces,
      widthMode,
    });
  }
  await writer.flush();
}

const foldArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'b',
      long: 'bytes',
      effects: [{ key: 'bytes', value: true }],
      help: { summary: 'count bytes rather than columns', category: 'common' },
    },
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
  specialTokenParsers: [
    ({ token }) => {
      if (!/^-[1-9]\d*$/u.test(token)) {
        return undefined;
      }
      const parsed = parseWidth({ value: token.slice(1) });
      return {
        kind: 'matched',
        consumeCount: 1,
        effects: parsed.ok
          ? [{ key: 'width', value: parsed.value }]
          : [{ key: 'obsoleteWidthError', value: parsed.message }],
      };
    },
  ],
};

export const foldCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: foldArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
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

    const obsoleteWidthError = parsed.optionValues.obsoleteWidthError;
    if (typeof obsoleteWidthError === 'string') {
      await writeCommandUsageError({
        context,
        command: 'fold',
        message: `fold: ${obsoleteWidthError}`,
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
    const widthMode: FoldWidthMode = parsed.optionValues.bytes === true ? 'bytes' : 'columns';
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
          widthMode,
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
