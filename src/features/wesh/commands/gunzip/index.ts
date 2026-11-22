import type {
  WeshCommandImplementation,
  WeshCommandResult,
  WeshCommandContext,
  WeshFileHandle,
  WeshOpenFlags,
} from '@/features/wesh/types';
import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { getGzipSuffixDiagnostic } from '@/features/wesh/commands/_shared/gzip-suffix';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import {
  consumeGzipInput,
  peekGzipInput,
} from '@/features/wesh/commands/_shared/gzip-decompression';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
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

const gunzipOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'stdout', value: true }] },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'long', name: 'stdout', value: { kind: 'none' } },
    ],
    help: { summary: 'write on standard output, keep original files unchanged', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'force', value: true }] },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'none' } },
      { kind: 'long', name: 'force', value: { kind: 'none' } },
    ],
    help: { summary: 'force overwrite of output files', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'keep', value: true }] },
    forms: [
      { kind: 'short', name: 'k', value: { kind: 'none' } },
      { kind: 'long', name: 'keep', value: { kind: 'none' } },
    ],
    help: { summary: 'keep input files unchanged', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
    forms: [
      { kind: 'short', name: 'q', value: { kind: 'none' } },
      { kind: 'long', name: 'quiet', value: { kind: 'none' } },
    ],
    help: { summary: 'suppress warning messages', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'suffix', parse: undefined },
    forms: [
      { kind: 'short', name: 'S', value: { kind: 'required-attached-or-following', missingValueName: 'SUF' } },
      { kind: 'long', name: 'suffix', value: { kind: 'required', missingValueName: 'SUF' } },
    ],
    help: { summary: 'use suffix SUF on compressed files', valueName: 'SUF' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'test', value: true }] },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'none' } },
      { kind: 'long', name: 'test', value: { kind: 'none' } },
    ],
    help: { summary: 'test compressed file integrity', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    help: { summary: 'display this help and exit', category: 'common' },
  },
] as const;
const gunzipArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: gunzipOptions.map(({ semantic, forms }) => ({ semantic, forms })),
  nonExecutableLongOptions: [],
});
const gunzipArgvHelp = defineArgvHelpPresentation({
  catalog: gunzipArgvCatalog,
  rows: gunzipOptions.map(({ forms, help }) => ({ forms, ...help })),
});
const gunzipArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const gunzipCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: gunzipArgvCatalog,
        policy: gunzipArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: gunzipArgvCatalog,
      policy: gunzipArgvPolicy,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'gunzip',
        message: `gunzip: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: gunzipArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'gunzip',
        optionLines: formatArgvOptionHelp({ presentation: gunzipArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const writeToStdout = parsed.optionValues.stdout === true;
    const force = parsed.optionValues.force === true;
    const quiet = parsed.optionValues.quiet === true;
    const testOnly = parsed.optionValues.test === true;
    const keepInput = parsed.optionValues.keep === true || writeToStdout || testOnly;
    const suffix = typeof parsed.optionValues.suffix === 'string' ? parsed.optionValues.suffix : '.gz';
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
