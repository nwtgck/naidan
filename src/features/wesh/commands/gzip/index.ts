import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import { writeAllStreamToFile, writeAllStreamToHandle } from '@/features/wesh/utils/fs';
import { pipeThroughBufferSourceTransform } from '@/features/wesh/utils/stream';

const gzipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'c', long: 'stdout', effects: [{ key: 'stdout', value: true }], help: { summary: 'write on standard output, keep original files unchanged', category: 'common' } },
    { kind: 'flag', short: 'k', long: 'keep', effects: [{ key: 'keep', value: true }], help: { summary: 'keep input files unchanged', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const gzipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'gzip',
    description: 'Compress files',
    usage: 'gzip [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: gzipArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'gzip',
        message: `gzip: ${diagnostic.message}`,
        argvSpec: gzipArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'gzip',
        argvSpec: gzipArgvSpec,
      });
      return { exitCode: 0 };
    }

    const writeToStdout = parsed.optionValues.stdout === true;
    const keepInput = parsed.optionValues.keep === true || writeToStdout;
    const inputs = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    let exitCode = 0;

    for (const input of inputs) {
      try {
        const compressedStream = pipeThroughBufferSourceTransform({
          source: await openCommandInputStream({
            context,
            input,
          }),
          transform: new CompressionStream('gzip'),
        });

        if (writeToStdout || input === '-') {
          await writeAllStreamToHandle({
            stream: compressedStream,
            handle: context.stdout,
            closeHandle: false,
          });
          continue;
        }

        const fullPath = resolvePath({
          cwd: context.cwd,
          path: input,
        });
        await writeAllStreamToFile({
          files: context.files,
          path: `${fullPath}.gz`,
          stream: compressedStream,
          mode: 'truncate',
        });
        if (!keepInput) {
          await context.files.unlink({ path: fullPath });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `gzip: ${input}: ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
