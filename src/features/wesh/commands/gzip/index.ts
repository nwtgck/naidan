import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { basenamePath } from '@/features/wesh/commands/_shared/path';
import { getGzipSuffixDiagnostic } from '@/features/wesh/commands/_shared/gzip-suffix';
import { executeGzipDecompressionCommand } from './decompression';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import { writeAllStreamToFile, writeAllStreamToHandle } from '@/features/wesh/utils/fs';
import { pipeThroughBufferSourceTransform } from '@/features/wesh/utils/stream';
import { addNamedGzipHeader } from './header';
import { pathExists as pathEntryExists, unlinkForcedOutputSymlink } from './filesystem';

const gzipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'c', long: 'stdout', effects: [{ key: 'stdout', value: true }], help: { summary: 'write on standard output, keep original files unchanged', category: 'common' } },
    { kind: 'flag', short: 'd', long: 'decompress', effects: [{ key: 'decompress', value: true }], help: { summary: 'decompress', category: 'common' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }], help: { summary: 'force overwrite of output files', category: 'common' } },
    { kind: 'flag', short: 'k', long: 'keep', effects: [{ key: 'keep', value: true }], help: { summary: 'keep input files unchanged', category: 'common' } },
    { kind: 'flag', short: 'n', long: 'no-name', effects: [{ key: 'noName', value: true }], help: { summary: 'do not save the original name and timestamp', category: 'common' } },
    { kind: 'flag', short: 'q', long: 'quiet', effects: [{ key: 'quiet', value: true }], help: { summary: 'suppress warning messages', category: 'common' } },
    { kind: 'value', short: 'S', long: 'suffix', key: 'suffix', valueName: 'SUF', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use suffix SUF on compressed files', valueName: 'SUF' } },
    { kind: 'flag', short: 't', long: 'test', effects: [{ key: 'test', value: true }], help: { summary: 'test compressed file integrity', category: 'common' } },
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
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: gzipArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
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
    const force = parsed.optionValues.force === true;
    const noName = parsed.optionValues.noName === true;
    const keepInput = parsed.optionValues.keep === true || writeToStdout;
    const quiet = parsed.optionValues.quiet === true;
    const suffix = (parsed.optionValues.suffix as string | undefined) ?? '.gz';
    const suffixDiagnostic = getGzipSuffixDiagnostic({ suffix });
    if (suffixDiagnostic !== undefined) {
      await text.error({ text: suffixDiagnostic });
      return { exitCode: 1 };
    }
    const testOnly = parsed.optionValues.test === true;
    if (parsed.optionValues.decompress === true || testOnly) {
      const delegatedArgs: string[] = [];
      if (writeToStdout) {
        delegatedArgs.push('-c');
      }
      if (force) {
        delegatedArgs.push('-f');
      }
      if (parsed.optionValues.keep === true) {
        delegatedArgs.push('-k');
      }
      if (quiet) {
        delegatedArgs.push('-q');
      }
      if (parsed.optionValues.suffix !== undefined) {
        delegatedArgs.push('-S', suffix);
      }
      if (testOnly) {
        delegatedArgs.push('-t');
      }
      for (const positional of parsed.positionals) delegatedArgs.push(positional);
      return executeGzipDecompressionCommand({
        context: {
          ...context,
          args: delegatedArgs,
        },
      });
    }

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
        const outputPath = fullPath === undefined ? undefined : `${fullPath}${suffix}`;
        if (fullPath !== undefined) {
          const inputStat = await context.files.lstat({ path: fullPath });
          const effectiveInputType = await (async () => {
            switch (inputStat.type) {
            case 'symlink': {
              if (!writeToStdout && !force) {
                throw new Error('Too many levels of symbolic links');
              }
              return (await context.files.stat({ path: fullPath })).type;
            }
            case 'directory':
            case 'file':
            case 'fifo':
            case 'chardev':
              return inputStat.type;
            default: {
              const _exhaustiveCheck: never = inputStat.type;
              throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
            }
            }
          })();
          switch (effectiveInputType) {
          case 'directory':
            await text.error({ text: `gzip: ${input} is a directory -- ignored\n` });
            exitCode = Math.max(exitCode, 2);
            continue;
          case 'file':
          case 'fifo':
          case 'chardev':
            break;
          case 'symlink':
            throw new Error('Unexpected unresolved symbolic link');
          default: {
            const _exhaustiveCheck: never = effectiveInputType;
            throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
          }
          }
        }

        if (
          !writeToStdout
          && outputPath !== undefined
          && await pathEntryExists({ context, path: outputPath })
          && !force
        ) {
          await text.error({ text: `gzip: ${input}${suffix} already exists; not overwritten
` });
          exitCode = Math.max(exitCode, 2);
          continue;
        }

        let compressedStream = pipeThroughBufferSourceTransform({
          source: await openCommandInputStream({
            context,
            input,
          }),
          transform: new CompressionStream('gzip'),
        });
        if (fullPath !== undefined && !noName) {
          const stat = await context.files.stat({ path: fullPath });
          compressedStream = addNamedGzipHeader({
            stream: compressedStream,
            fileName: basenamePath({ path: input, suffix: undefined }),
            mtime: stat.mtime,
          });
        }

        if (writeToStdout || input === '-') {
          await writeAllStreamToHandle({
            stream: compressedStream,
            handle: context.stdout,
            closeHandle: false,
          });
          continue;
        }

        if (fullPath === undefined || outputPath === undefined) {
          throw new Error('named gzip input unexpectedly lacked an output path');
        }
        if (force) {
          await unlinkForcedOutputSymlink({ context, path: outputPath });
        }
        await writeAllStreamToFile({
          files: context.files,
          path: outputPath,
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
export const TEST_ONLY = {
};
