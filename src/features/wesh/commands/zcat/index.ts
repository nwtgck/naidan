import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import {
  consumeGzipInput,
  peekGzipInput,
} from '@/features/wesh/commands/_shared/gzip-decompression';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { writeAllStreamToHandle } from '@/features/wesh/utils/fs';

const zcatStdoutOption = {
  semantic: { kind: 'effects', effects: [{ key: 'stdout', value: true }] },
  forms: [
    { kind: 'short', name: 'c', value: { kind: 'none' } },
    { kind: 'long', name: 'stdout', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const zcatDecompressOption = {
  semantic: { kind: 'effects', effects: [{ key: 'decompress', value: true }] },
  forms: [
    { kind: 'short', name: 'd', value: { kind: 'none' } },
    { kind: 'long', name: 'decompress', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const zcatForceOption = {
  semantic: { kind: 'effects', effects: [{ key: 'force', value: true }] },
  forms: [
    { kind: 'short', name: 'f', value: { kind: 'none' } },
    { kind: 'long', name: 'force', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const zcatQuietOption = {
  semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
  forms: [
    { kind: 'short', name: 'q', value: { kind: 'none' } },
    { kind: 'long', name: 'quiet', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const zcatHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const zcatArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [zcatStdoutOption, zcatDecompressOption, zcatForceOption, zcatQuietOption, zcatHelpOption],
});
const zcatArgvHelp = defineArgvHelpPresentation({
  catalog: zcatArgvCatalog,
  rows: [
    { forms: zcatStdoutOption.forms, summary: 'write on standard output' },
    { forms: zcatDecompressOption.forms, summary: 'decompress input' },
    { forms: zcatForceOption.forms, summary: 'copy input unchanged when it is not gzip data' },
    { forms: zcatQuietOption.forms, summary: 'suppress warning messages' },
    { forms: zcatHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const zcatArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
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
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: zcatArgvCatalog,
        policy: zcatArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: zcatArgvCatalog,
      policy: zcatArgvPolicy,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'zcat',
        message: `zcat: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: zcatArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'zcat',
        optionLines: formatArgvOptionHelp({ presentation: zcatArgvHelp }),
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
