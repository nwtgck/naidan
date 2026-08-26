import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { openHandleReadStream, openFileReadStream, writeAllBytesToHandle, writeAllStreamToHandle } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';

const CAT_OUTPUT_BUFFER_LENGTH = 64 * 1024;
const NEWLINE_BYTE = 0x0a;
const TAB_BYTE = 0x09;
const DELETE_BYTE = 0x7f;
const HIGH_BIT = 0x80;
const textEncoder = new TextEncoder();

function appendAsciiText({
  output,
  text,
}: {
  output: number[],
  text: string,
}): void {
  output.push(...textEncoder.encode(text));
}

function appendCaretNotation({
  output,
  byte,
}: {
  output: number[],
  byte: number,
}): void {
  output.push(0x5e);
  output.push(byte === DELETE_BYTE ? 0x3f : byte + 0x40);
}

function appendVisibleByte({
  output,
  byte,
  showTabs,
  showNonPrinting,
}: {
  output: number[],
  byte: number,
  showTabs: boolean,
  showNonPrinting: boolean,
}): void {
  if (byte === TAB_BYTE) {
    if (showTabs) {
      appendCaretNotation({ output, byte });
    } else {
      output.push(byte);
    }
    return;
  }

  if (!showNonPrinting) {
    output.push(byte);
    return;
  }

  let visibleByte = byte;
  if (byte >= HIGH_BIT) {
    output.push(0x4d, 0x2d);
    visibleByte = byte & 0x7f;
  }

  if (visibleByte < 0x20 || visibleByte === DELETE_BYTE) {
    appendCaretNotation({ output, byte: visibleByte });
    return;
  }
  output.push(visibleByte);
}

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  return path.startsWith('/') ? path : cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

const catArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'n', long: 'number', effects: [{ key: 'numberAllLines', value: true }], help: { summary: 'number all output lines', category: 'common' } },
    { kind: 'flag', short: 'b', long: 'number-nonblank', effects: [{ key: 'numberNonBlankLines', value: true }], help: { summary: 'number nonempty output lines', category: 'common' } },
    { kind: 'flag', short: 'E', long: 'show-ends', effects: [{ key: 'showEnds', value: true }], help: { summary: 'display $ at end of each line', category: 'common' } },
    { kind: 'flag', short: 'T', long: 'show-tabs', effects: [{ key: 'showTabs', value: true }], help: { summary: 'display TAB characters as ^I', category: 'common' } },
    { kind: 'flag', short: 'v', long: 'show-nonprinting', effects: [{ key: 'showNonPrinting', value: true }], help: { summary: 'show non-printing characters except TAB and LF', category: 'common' } },
    {
      kind: 'flag',
      short: 'A',
      long: 'show-all',
      effects: [
        { key: 'showEnds', value: true },
        { key: 'showTabs', value: true },
        { key: 'showNonPrinting', value: true },
      ],
      help: { summary: 'equivalent to -vET', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'e',
      long: undefined,
      effects: [
        { key: 'showEnds', value: true },
        { key: 'showNonPrinting', value: true },
      ],
      help: { summary: 'equivalent to -vE', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 't',
      long: undefined,
      effects: [
        { key: 'showTabs', value: true },
        { key: 'showNonPrinting', value: true },
      ],
      help: { summary: 'equivalent to -vT', category: 'advanced' },
    },
    { kind: 'flag', short: 's', long: 'squeeze-blank', effects: [{ key: 'squeezeBlank', value: true }], help: { summary: 'suppress repeated empty output lines', category: 'common' } },
    { kind: 'flag', short: 'u', long: 'u', effects: [], help: { summary: 'accepted for compatibility', category: 'advanced' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const catCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: catArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: catArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cat',
        message: `cat: ${diagnostic.message}`,
        argvSpec: catArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cat',
        argvSpec: catArgvSpec,
      });
      return { exitCode: 0 };
    }

    const files = parsed.positionals;
    const numberAllLines = parsed.optionValues.numberAllLines === true;
    const numberNonBlankLines = parsed.optionValues.numberNonBlankLines === true;
    const showEnds = parsed.optionValues.showEnds === true;
    const showTabs = parsed.optionValues.showTabs === true;
    const showNonPrinting = parsed.optionValues.showNonPrinting === true;
    const squeezeBlank = parsed.optionValues.squeezeBlank === true;
    const text = context.text();
    const numberBlankLines = numberAllLines && !numberNonBlankLines;
    let lineNumber = 1;
    let atLineStart = true;
    let previousLineWasBlank = false;
    let pendingCarriageReturn = false;
    let hadError = false;
    const applyNumbering = numberAllLines || numberNonBlankLines;
    const hasTransform = applyNumbering || showEnds || showTabs || showNonPrinting || squeezeBlank;

    const appendLineNumber = ({
      output,
    }: {
      output: number[],
    }): void => {
      appendAsciiText({
        output,
        text: `${String(lineNumber).padStart(6, ' ')}\t`,
      });
      lineNumber += 1;
    };

    const processRawStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      await writeAllStreamToHandle({
        stream,
        handle: context.stdout,
        closeHandle: false,
      });
    };

    const processTransformedStream = async ({
      stream,
    }: {
      stream: ReadableStream<Uint8Array>,
    }): Promise<void> => {
      let output: number[] = [];
      const flushOutput = async (): Promise<void> => {
        if (output.length === 0) {
          return;
        }
        await writeAllBytesToHandle({
          handle: context.stdout,
          data: Uint8Array.from(output),
        });
        output = [];
      };

      for await (const chunk of iterateReadableStreamChunks({ stream })) {
        for (const byte of chunk) {
          if (pendingCarriageReturn) {
            if (byte === NEWLINE_BYTE) {
              appendCaretNotation({ output, byte: 0x0d });
            } else {
              output.push(0x0d);
            }
            pendingCarriageReturn = false;
          }

          if (byte === NEWLINE_BYTE) {
            const currentLineIsBlank = atLineStart;
            if (squeezeBlank && currentLineIsBlank && previousLineWasBlank) {
              continue;
            }
            if (atLineStart && numberBlankLines) {
              appendLineNumber({ output });
            }
            if (showEnds) {
              output.push(0x24);
            }
            output.push(NEWLINE_BYTE);
            atLineStart = true;
            previousLineWasBlank = currentLineIsBlank;
          } else {
            if (atLineStart) {
              if (numberAllLines || numberNonBlankLines) {
                appendLineNumber({ output });
              }
              atLineStart = false;
            }
            if (byte === 0x0d && showEnds && !showNonPrinting) {
              pendingCarriageReturn = true;
            } else {
              appendVisibleByte({
                output,
                byte,
                showTabs,
                showNonPrinting,
              });
            }
          }

          if (output.length >= CAT_OUTPUT_BUFFER_LENGTH) {
            await flushOutput();
          }
        }
      }
      await flushOutput();
    };

    const flushPendingCarriageReturn = async (): Promise<void> => {
      if (!pendingCarriageReturn) {
        return;
      }
      pendingCarriageReturn = false;
      await writeAllBytesToHandle({
        handle: context.stdout,
        data: Uint8Array.of(0x0d),
      });
    };

    const processInputStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      if (hasTransform) {
        await processTransformedStream({ stream });
        return;
      }
      await processRawStream({ stream });
    };

    if (files.length === 0) {
      await processInputStream({ stream: openHandleReadStream({ handle: context.stdin }) });
    } else {
      for (const f of files) {
        if (f === '-') {
          await processInputStream({ stream: openHandleReadStream({ handle: context.stdin }) });
          continue;
        }

        try {
          await processInputStream({
            stream: await openFileReadStream({
              files: context.files,
              path: resolvePath({ cwd: context.cwd, path: f }),
            }),
          });
        } catch (e: unknown) {
          const shouldForwardSignal = (() => {
            const waitStatus = context.process.getWaitStatus();
            if (waitStatus === undefined) return false;

            switch (waitStatus.kind) {
            case 'signaled':
              return true;
            case 'exited':
            case 'stopped':
              return false;
            default: {
              const _ex: never = waitStatus;
              throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
            }
            }
          })();

          if (shouldForwardSignal) {
            throw e;
          }
          const rawMessage = e instanceof Error ? e.message : String(e);
          const message = rawMessage.includes('NotFoundError')
            ? 'No such file or directory'
            : rawMessage;
          await text.error({ text: `cat: ${f}: ${message}\n` });
          hadError = true;
        }
      }
    }
    await flushPendingCarriageReturn();

    return { exitCode: hadError ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
