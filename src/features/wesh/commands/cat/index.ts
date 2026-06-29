import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { openHandleReadStream, openFileReadStream, writeAllStreamToHandle } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { getWeshTextRecordTerminator, iterateUtf8LineRecords } from '@/features/wesh/utils/text-records';

function renderVisibleAscii({ char }: { char: string }): string {
  if (char === '\t') return char;

  const code = char.charCodeAt(0);
  if ((code >= 0 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) {
    return '^' + String.fromCharCode(code + 64);
  }

  return char;
}

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
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
      args: context.args,
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
    let lineNumber = 1;
    let lastWasEmpty = false;
    let hadError = false;
    const applyNumbering = numberAllLines || numberNonBlankLines;
    const hasTransform = applyNumbering || showEnds || showTabs || showNonPrinting || squeezeBlank;

    const processRawStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      await writeAllStreamToHandle({
        stream,
        handle: context.stdout,
        closeHandle: false,
      });
    };

    const processStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      const writer = createBufferedTextWriter({
        handle: context.stdout,
        maxBufferLength: 16 * 1024,
      });
      for await (const record of iterateUtf8LineRecords({
        chunks: iterateReadableStreamChunks({ stream }),
      })) {
        const isEmpty = record.text.length === 0;
        if (squeezeBlank && isEmpty && lastWasEmpty) {
          continue;
        }

        let output = '';
        const shouldNumberLine = numberNonBlankLines ? !isEmpty : numberAllLines;
        if (shouldNumberLine) {
          output += `${String(lineNumber++).padStart(6, ' ')}  `;
        }

        let processedLine = record.text;
        if (showTabs) {
          processedLine = processedLine.replace(/\t/g, '^I');
        }
        if (showNonPrinting) {
          processedLine = Array.from(processedLine, char => renderVisibleAscii({ char })).join('');
        }
        if (showEnds) {
          processedLine += '$';
        }
        await writer.write({
          text: output + processedLine + getWeshTextRecordTerminator({
            termination: record.termination,
          }),
        });
        lastWasEmpty = isEmpty;
      }
      await writer.flush();
    };

    const processInputStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      if (hasTransform) {
        await processStream({ stream });
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
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `cat: ${f}: ${message}\n` });
          hadError = true;
        }
      }
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};
