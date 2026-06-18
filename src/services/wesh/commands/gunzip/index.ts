import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { openCommandInputStream } from '@/services/wesh/commands/_shared/binary-input';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { resolvePath } from '@/services/wesh/path';
import { writeAllStreamToFile, writeAllStreamToHandle } from '@/services/wesh/utils/fs';
import { pipeThroughBufferSourceTransform } from '@/services/wesh/utils/stream';

const gunzipArgvSpec: StandardArgvParserSpec = {
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

export const gunzipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'gunzip',
    description: 'Decompress files',
    usage: 'gunzip [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: gunzipArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'gunzip',
        message: `gunzip: ${diagnostic.message}`,
        argvSpec: gunzipArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'gunzip',
        argvSpec: gunzipArgvSpec,
      });
      return { exitCode: 0 };
    }

    const writeToStdout = parsed.optionValues.stdout === true;
    const keepInput = parsed.optionValues.keep === true || writeToStdout;
    const inputs = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    let exitCode = 0;

    for (const input of inputs) {
      try {
        const fullPath = input === '-'
          ? undefined
          : resolvePath({
            cwd: context.cwd,
            path: input,
          });

        if (fullPath !== undefined && !fullPath.endsWith('.gz')) {
          await text.error({ text: `gunzip: ${input}: unknown suffix -- ignored\n` });
          exitCode = 1;
          continue;
        }

        const decompressedStream = pipeThroughBufferSourceTransform({
          source: await openCommandInputStream({
            context,
            input,
          }),
          transform: new DecompressionStream('gzip'),
        });

        if (writeToStdout || input === '-') {
          await writeAllStreamToHandle({
            stream: decompressedStream,
            handle: context.stdout,
            closeHandle: false,
          });
          continue;
        }

        const outputPath = fullPath?.slice(0, -3);
        if (fullPath === undefined || outputPath === undefined) {
          throw new Error('missing output path');
        }

        await writeAllStreamToFile({
          files: context.files,
          path: outputPath,
          stream: decompressedStream,
          mode: 'truncate',
        });
        if (!keepInput) {
          await context.files.unlink({ path: fullPath });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `gunzip: ${input}: ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
