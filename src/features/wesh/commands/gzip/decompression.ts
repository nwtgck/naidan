// This execution flow is owned by the gzip command to avoid a sibling-command
// dependency. GNU gunzip delegates normal decompression to gzip -d, so shared
// decompression behavior is kept in parity tests while command-specific surfaces
// remain independently owned.

import type {
  WeshCommandResult,
  WeshCommandContext,
  WeshFileHandle,
  WeshOpenFlags,
} from '@/features/wesh/types';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import {
  consumeGzipInput,
  peekGzipInput,
} from '@/features/wesh/commands/_shared/gzip-decompression';
import { resolvePath } from '@/features/wesh/path';
import { writeAllStreamToHandle } from '@/features/wesh/utils/fs';
import { pathExists, unlinkForcedOutputSymlink } from './filesystem';

function mergeDecompressionExitCode({
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

export async function decompressGzipInputs({
  context,
  inputs,
  writeToStdout,
  force,
  quiet,
  testOnly,
  keepInput,
  suffix,
}: {
  context: WeshCommandContext,
  inputs: readonly string[],
  writeToStdout: boolean,
  force: boolean,
  quiet: boolean,
  testOnly: boolean,
  keepInput: boolean,
  suffix: string,
}): Promise<WeshCommandResult> {
  const text = context.text();
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
        exitCode = mergeDecompressionExitCode({ current: exitCode, next: 2 });
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
          exitCode = mergeDecompressionExitCode({ current: exitCode, next: 2 });
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
        exitCode = mergeDecompressionExitCode({ current: exitCode, next: 2 });
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
        exitCode = mergeDecompressionExitCode({ current: exitCode, next: 1 });
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
        exitCode = mergeDecompressionExitCode({ current: exitCode, next: 2 });
        break;
      case 'invalid':
        if (outputCreated && outputPath !== undefined) {
          await context.files.unlink({ path: outputPath });
          outputCreated = false;
        }
        await text.error({ text: `gzip: ${input}: invalid compressed data\n` });
        exitCode = mergeDecompressionExitCode({ current: exitCode, next: 1 });
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
      exitCode = mergeDecompressionExitCode({ current: exitCode, next: 1 });
    }
  }

  return { exitCode };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
