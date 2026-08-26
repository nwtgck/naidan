import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import {
  consumeGzipInput,
  peekGzipInput,
} from '@/features/wesh/commands/_shared/gzip-decompression';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { writeAllStreamToHandle } from '@/features/wesh/utils/fs';

const zcatArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'c',
      long: 'stdout',
      effects: [{ key: 'stdout', value: true }],
      help: { summary: 'write on standard output' },
    },
    {
      kind: 'flag',
      short: 'd',
      long: 'decompress',
      effects: [{ key: 'decompress', value: true }],
      help: { summary: 'decompress input' },
    },
    {
      kind: 'flag',
      short: 'f',
      long: 'force',
      effects: [{ key: 'force', value: true }],
      help: { summary: 'copy input unchanged when it is not gzip data' },
    },
    {
      kind: 'flag',
      short: 'q',
      long: 'quiet',
      effects: [{ key: 'quiet', value: true }],
      help: { summary: 'suppress warning messages' },
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

function mergeExitCode({
  current,
  next,
}: {
  current: number,
  next: 1 | 2,
}): number {
  return Math.max(current, next);
}

export const zcatCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'zcat',
    description: 'Decompress and print files to standard output',
    usage: 'zcat [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: zcatArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: zcatArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'zcat',
        message: `zcat: ${diagnostic.message}`,
        argvSpec: zcatArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'zcat',
        argvSpec: zcatArgvSpec,
      });
      return { exitCode: 0 };
    }

    const force = parsed.optionValues.force === true;
    const quiet = parsed.optionValues.quiet === true;
    const inputs = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    let exitCode = 0;

    for (const input of inputs) {
      try {
        const peeked = await peekGzipInput({
          source: await openCommandInputStream({ context, input }),
        });
        if (!peeked.isGzip) {
          if (force) {
            await writeAllStreamToHandle({
              stream: peeked.stream,
              handle: context.stdout,
              closeHandle: false,
            });
            continue;
          }
          const displayInput = input === '-' ? 'stdin' : input;
          await text.error({ text: `\ngzip: ${displayInput}: not in gzip format\n` });
          exitCode = mergeExitCode({ current: exitCode, next: 1 });
          continue;
        }

        const result = await consumeGzipInput({
          source: peeked.stream,
          output: context.stdout,
        });
        switch (result) {
        case 'success':
          break;
        case 'trailing_garbage':
          if (!quiet) {
            await text.error({
              text: `gzip: ${input}: decompression OK, trailing garbage ignored\n`,
            });
          }
          exitCode = mergeExitCode({ current: exitCode, next: 2 });
          break;
        case 'invalid':
          await text.error({ text: `gzip: ${input}: invalid compressed data\n` });
          exitCode = mergeExitCode({ current: exitCode, next: 1 });
          break;
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled zcat decompression result: ${_ex}`);
        }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `gzip: ${input}: ${message}\n` });
        exitCode = mergeExitCode({ current: exitCode, next: 1 });
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
