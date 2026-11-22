import { formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { canonicalizeExistingPath, toAbsolutePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { parseSplitArgv, splitArgvHelp, type SplitMode } from './parse';
import { createSplitSuffixGenerator, isSuffixExhaustedError } from './suffix';
import { createSplitOutputController, type SplitOutputController } from './writer';

function formatError({
  error,
}: {
  error: unknown,
}): string {
  return error instanceof Error ? error.message : String(error);
}

async function splitByLines({
  stream,
  output,
  lineCountLimit,
}: {
  stream: ReadableStream<Uint8Array>,
  output: SplitOutputController,
  lineCountLimit: number,
}): Promise<void> {
  let currentLineCount = 0;

  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }

      currentLineCount += 1;
      if (currentLineCount !== lineCountLimit) {
        continue;
      }

      await output.write({ chunk: chunk.subarray(start, index + 1) });
      await output.closeCurrent();
      currentLineCount = 0;
      start = index + 1;
    }

    if (start < chunk.byteLength) {
      await output.write({ chunk: chunk.subarray(start) });
    }
  }
}

async function splitByBytes({
  stream,
  output,
  byteLimit,
}: {
  stream: ReadableStream<Uint8Array>,
  output: SplitOutputController,
  byteLimit: number,
}): Promise<void> {
  let remainingInCurrentFile = byteLimit;

  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const length = Math.min(remainingInCurrentFile, chunk.byteLength - offset);
      await output.write({ chunk: chunk.subarray(offset, offset + length) });
      offset += length;
      remainingInCurrentFile -= length;

      if (remainingInCurrentFile === 0) {
        await output.closeCurrent();
        remainingInCurrentFile = byteLimit;
      }
    }
  }
}

interface PendingSplitRecord {
  fragments: Uint8Array[],
  firstFragmentIndex: number,
  byteLength: number,
}

function appendPendingRecord({
  pending,
  fragment,
}: {
  pending: PendingSplitRecord,
  fragment: Uint8Array,
}): void {
  if (fragment.byteLength === 0) {
    return;
  }
  pending.fragments.push(fragment);
  pending.byteLength += fragment.byteLength;
}

function takePendingRecordBytes({
  pending,
  byteLength,
}: {
  pending: PendingSplitRecord,
  byteLength: number,
}): Uint8Array {
  if (byteLength < 0 || byteLength > pending.byteLength) {
    throw new Error(`Invalid pending split record byte length: ${byteLength}`);
  }

  const result = new Uint8Array(byteLength);
  let written = 0;
  while (written < byteLength) {
    const fragment = pending.fragments[pending.firstFragmentIndex];
    if (fragment === undefined) {
      throw new Error('Pending split record fragments ended unexpectedly');
    }
    const remaining = byteLength - written;
    const consumed = Math.min(remaining, fragment.byteLength);
    result.set(fragment.subarray(0, consumed), written);
    written += consumed;
    if (consumed === fragment.byteLength) {
      pending.firstFragmentIndex += 1;
    } else {
      pending.fragments[pending.firstFragmentIndex] = fragment.subarray(consumed);
    }
  }
  pending.byteLength -= byteLength;

  if (pending.firstFragmentIndex === pending.fragments.length) {
    pending.fragments.length = 0;
    pending.firstFragmentIndex = 0;
  } else if (
    pending.firstFragmentIndex >= 1024
    && pending.firstFragmentIndex * 2 >= pending.fragments.length
  ) {
    pending.fragments = pending.fragments.slice(pending.firstFragmentIndex);
    pending.firstFragmentIndex = 0;
  }

  return result;
}

async function splitByLineBytes({
  stream,
  output,
  byteLimit,
}: {
  stream: ReadableStream<Uint8Array>,
  output: SplitOutputController,
  byteLimit: number,
}): Promise<void> {
  const pending: PendingSplitRecord = {
    fragments: [],
    firstFragmentIndex: 0,
    byteLength: 0,
  };
  let currentOutputByteLength = 0;

  const closeCurrent = async (): Promise<void> => {
    await output.closeCurrent();
    currentOutputByteLength = 0;
  };

  const writePending = async ({ byteLength }: { byteLength: number }): Promise<void> => {
    if (byteLength === 0) {
      return;
    }
    await output.write({
      chunk: takePendingRecordBytes({ pending, byteLength }),
    });
    currentOutputByteLength += byteLength;
    if (currentOutputByteLength === byteLimit) {
      await closeCurrent();
    }
  };

  const drainRecord = async ({ complete }: { complete: boolean }): Promise<void> => {
    const combinedByteLength = currentOutputByteLength + pending.byteLength;
    if (
      currentOutputByteLength > 0
      && (
        combinedByteLength > byteLimit
        || (!complete && combinedByteLength === byteLimit)
      )
    ) {
      await closeCurrent();
    }

    while (pending.byteLength > byteLimit) {
      await writePending({ byteLength: byteLimit });
    }

    if (complete && pending.byteLength > 0) {
      await writePending({ byteLength: pending.byteLength });
    }
  };

  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    let recordStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }
      appendPendingRecord({
        pending,
        fragment: chunk.subarray(recordStart, index + 1),
      });
      await drainRecord({ complete: true });
      recordStart = index + 1;
    }
    if (recordStart < chunk.byteLength) {
      appendPendingRecord({
        pending,
        fragment: chunk.subarray(recordStart),
      });
      await drainRecord({ complete: false });
    }
  }

  await drainRecord({ complete: true });
}

type SplitOutputPathGuard = ({ path }: { path: string }) => Promise<string | undefined>;

async function createInputOverwriteGuard({
  context,
  input,
}: {
  context: WeshCommandContext,
  input: string | undefined,
}): Promise<SplitOutputPathGuard | undefined> {
  if (input === undefined || input === '-') {
    return undefined;
  }

  const resolvedInputPath = toAbsolutePath({ cwd: context.cwd, path: input });
  const canonicalInputPath = await canonicalizeExistingPath({
    context,
    path: resolvedInputPath,
  });

  return async ({ path }: { path: string }): Promise<string | undefined> => {
    const resolvedOutputPath = toAbsolutePath({ cwd: context.cwd, path });
    if (resolvedInputPath === resolvedOutputPath) {
      return `'${path}' would overwrite input; aborting`;
    }

    try {
      const canonicalOutputPath = await canonicalizeExistingPath({
        context,
        path: resolvedOutputPath,
      });
      return canonicalInputPath === canonicalOutputPath
        ? `'${path}' would overwrite input; aborting`
        : undefined;
    } catch {
      // Missing and dangling output paths retain their normal open diagnostics.
      return undefined;
    }
  };
}

async function executeSplit({
  context,
  input,
  mode,
  output,
}: {
  context: WeshCommandContext,
  input: string | undefined,
  mode: SplitMode,
  output: SplitOutputController,
}): Promise<void> {
  const stream = await openCommandInputStream({ context, input });

  switch (mode.kind) {
  case 'lines':
    await splitByLines({
      stream,
      output,
      lineCountLimit: mode.count,
    });
    return;
  case 'bytes':
    await splitByBytes({
      stream,
      output,
      byteLimit: mode.size,
    });
    return;
  case 'lineBytes':
    await splitByLineBytes({
      stream,
      output,
      byteLimit: mode.size,
    });
    return;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled split mode: ${JSON.stringify(_ex)}`);
  }
  }
}

export const splitCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseSplitArgv({ args: context.args });
    switch (parsed.kind) {
    case 'error':
      await writeCommandUsageError({
        context,
        command: 'split',
        message: `split: ${parsed.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: splitArgvHelp }),
      });
      return { exitCode: 1 };
    case 'help':
      await writeCommandHelp({
        context,
        command: 'split',
        optionLines: formatArgvOptionHelp({ presentation: splitArgvHelp }),
      });
      return { exitCode: 0 };
    case 'ok':
      break;
    default: {
      const _ex: never = parsed;
      throw new Error(`Unhandled split arguments: ${JSON.stringify(_ex)}`);
    }
    }

    const { options, operands: { input, prefix } } = parsed;
    const suffixGenerator = createSplitSuffixGenerator({
      prefix,
      suffixLength: options.suffixLength,
      suffixMode: options.suffixMode,
      additionalSuffix: options.additionalSuffix,
    });

    try {
      const rejectPath = await createInputOverwriteGuard({ context, input });
      const firstOutputRejection = await rejectPath?.({ path: suffixGenerator.peekName() });
      if (firstOutputRejection !== undefined) {
        await context.text().error({ text: `split: ${firstOutputRejection}\n` });
        return { exitCode: 1 };
      }

      const output = createSplitOutputController({
        context,
        suffixGenerator,
        verbose: options.verbose,
        rejectPath,
      });
      try {
        await executeSplit({
          context,
          input,
          mode: options.mode,
          output,
        });
      } finally {
        await output.closeAll();
      }
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = isSuffixExhaustedError({ error })
        ? 'output file suffixes exhausted'
        : formatError({ error });
      await context.text().error({ text: `split: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createInputOverwriteGuard,
  executeSplit,
};
