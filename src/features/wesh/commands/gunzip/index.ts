import type {
  WeshCommandImplementation,
  WeshCommandResult,
  WeshCommandContext,
  WeshFileHandle,
  WeshOpenFlags,
} from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { getGzipSuffixDiagnostic } from '@/features/wesh/commands/_shared/gzip-suffix';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import {
  consumeGzipInput,
  peekGzipInput,
} from '@/features/wesh/commands/_shared/gzip-decompression';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import { writeAllStreamToHandle } from '@/features/wesh/utils/fs';

async function unlinkForcedOutputSymlink({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<void> {
  try {
    const stat = await context.files.lstat({ path });
    switch (stat.type) {
    case 'symlink':
      await context.files.unlink({ path });
      break;
    case 'directory':
    case 'file':
    case 'fifo':
    case 'chardev':
      break;
    default: {
      const _exhaustiveCheck: never = stat.type;
      throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
    }
    }
  } catch (error: unknown) {
    if (!isPathNotFoundError({ error })) {
      throw error;
    }
  }
}

async function pathExists({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<boolean> {
  try {
    await context.files.lstat({ path });
    return true;
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) {
      return false;
    }
    throw error;
  }
}

function mergeGunzipExitCode({
  current,
  next,
}: {
  current: number,
  next: 1 | 2,
}): number {
  return Math.max(current, next);
}

async function openOutputFile({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<WeshFileHandle> {
  const flags: WeshOpenFlags = {
    access: 'write',
    creation: 'if-needed',
    truncate: 'truncate',
    append: 'preserve',
  };
  return context.files.open({ path, flags });
}

const gunzipArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'c',
      long: 'stdout',
      effects: [{ key: 'stdout', value: true }],
      help: { summary: 'write on standard output, keep original files unchanged', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'f',
      long: 'force',
      effects: [{ key: 'force', value: true }],
      help: { summary: 'force overwrite of output files', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'k',
      long: 'keep',
      effects: [{ key: 'keep', value: true }],
      help: { summary: 'keep input files unchanged', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'q',
      long: 'quiet',
      effects: [{ key: 'quiet', value: true }],
      help: { summary: 'suppress warning messages', category: 'common' },
    },
    {
      kind: 'value',
      short: 'S',
      long: 'suffix',
      key: 'suffix',
      valueName: 'SUF',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'use suffix SUF on compressed files', valueName: 'SUF' },
    },
    {
      kind: 'flag',
      short: 't',
      long: 'test',
      effects: [{ key: 'test', value: true }],
      help: { summary: 'test compressed file integrity', category: 'common' },
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

export const gunzipCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: gunzipArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
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
    const force = parsed.optionValues.force === true;
    const quiet = parsed.optionValues.quiet === true;
    const testOnly = parsed.optionValues.test === true;
    const keepInput = parsed.optionValues.keep === true || writeToStdout || testOnly;
    const suffix = (parsed.optionValues.suffix as string | undefined) ?? '.gz';
    const suffixDiagnostic = getGzipSuffixDiagnostic({ suffix });
    if (suffixDiagnostic !== undefined) {
      await text.error({ text: suffixDiagnostic });
      return { exitCode: 1 };
    }
    const inputs = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    let exitCode = 0;

    for (const input of inputs) {
      let outputPath: string | undefined;
      let outputHandle: WeshFileHandle | undefined;
      let outputCreated = false;
      try {
        const fullPath = input === '-'
          ? undefined
          : resolvePath({
            cwd: context.cwd,
            path: input,
          });

        if (
          fullPath !== undefined
          && !writeToStdout
          && !testOnly
          && !fullPath.endsWith(suffix)
        ) {
          await text.error({ text: `gzip: ${input}: unknown suffix -- ignored\n` });
          exitCode = mergeGunzipExitCode({ current: exitCode, next: 2 });
          continue;
        }
        if (fullPath !== undefined) {
          const inputStat = await context.files.lstat({ path: fullPath });
          const effectiveInputType = await (async () => {
            switch (inputStat.type) {
            case 'symlink': {
              if (!writeToStdout && !testOnly && !force) {
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
            exitCode = mergeGunzipExitCode({ current: exitCode, next: 2 });
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

        outputPath = fullPath === undefined || writeToStdout || testOnly
          ? undefined
          : fullPath.slice(0, -suffix.length);
        if (
          outputPath !== undefined
          && await pathExists({ context, path: outputPath })
          && !force
        ) {
          await text.error({
            text: `gzip: ${input.slice(0, -suffix.length)} already exists; not overwritten\n`,
          });
          exitCode = mergeGunzipExitCode({ current: exitCode, next: 2 });
          continue;
        }

        const peeked = await peekGzipInput({
          source: await openCommandInputStream({ context, input }),
        });
        if (!peeked.isGzip) {
          if (force && writeToStdout && !testOnly) {
            await writeAllStreamToHandle({
              stream: peeked.stream,
              handle: context.stdout,
              closeHandle: false,
            });
            continue;
          }
          const displayInput = input === '-' ? 'stdin' : input;
          await text.error({ text: `\ngzip: ${displayInput}: not in gzip format\n` });
          exitCode = mergeGunzipExitCode({ current: exitCode, next: 1 });
          continue;
        }

        if (outputPath !== undefined) {
          if (force) {
            await unlinkForcedOutputSymlink({ context, path: outputPath });
          }
          outputHandle = await openOutputFile({ context, path: outputPath });
          outputCreated = true;
        }
        const result = await consumeGzipInput({
          source: peeked.stream,
          output: testOnly ? undefined : outputHandle ?? context.stdout,
        });
        if (outputHandle !== undefined) {
          await outputHandle.close();
          outputHandle = undefined;
        }

        switch (result) {
        case 'success':
          if (fullPath !== undefined && !keepInput) {
            await context.files.unlink({ path: fullPath });
          }
          break;
        case 'trailing_garbage':
          if (!quiet) {
            await text.error({
              text: `gzip: ${input}: decompression OK, trailing garbage ignored\n`,
            });
          }
          if (fullPath !== undefined && !keepInput) {
            await context.files.unlink({ path: fullPath });
          }
          exitCode = mergeGunzipExitCode({ current: exitCode, next: 2 });
          break;
        case 'invalid':
          if (outputCreated && outputPath !== undefined) {
            await context.files.unlink({ path: outputPath });
            outputCreated = false;
          }
          await text.error({ text: `gzip: ${input}: invalid compressed data\n` });
          exitCode = mergeGunzipExitCode({ current: exitCode, next: 1 });
          break;
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled gunzip decompression result: ${_ex}`);
        }
        }
      } catch (error: unknown) {
        if (outputHandle !== undefined) {
          try {
            await outputHandle.close();
          } catch {
            // Preserve the primary error.
          }
        }
        if (outputCreated && outputPath !== undefined) {
          try {
            await context.files.unlink({ path: outputPath });
          } catch {
            // Preserve the primary error rather than cleanup details.
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `gzip: ${input}: ${message}\n` });
        exitCode = mergeGunzipExitCode({ current: exitCode, next: 1 });
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
