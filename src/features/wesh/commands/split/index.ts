import { parseStandardArgv } from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { buildSplitOptions, parseSplitOperands, splitArgvSpec, type SplitMode } from './parse';
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

function createInputOverwriteGuard({
  context,
  input,
}: {
  context: WeshCommandContext,
  input: string | undefined,
}): (({ path }: { path: string }) => string | undefined) | undefined {
  if (input === undefined || input === '-') {
    return undefined;
  }

  const resolvedInputPath = resolvePath({ cwd: context.cwd, path: input });
  return ({ path }: { path: string }): string | undefined => {
    const resolvedOutputPath = resolvePath({ cwd: context.cwd, path });
    return resolvedInputPath === resolvedOutputPath
      ? `'${path}' would overwrite input; aborting`
      : undefined;
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
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled split mode: ${JSON.stringify(_ex)}`);
  }
  }
}

export const splitCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'split',
    description: 'Split a file into pieces',
    usage: 'split [OPTION]... [FILE [PREFIX]]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: splitArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'split',
        message: `split: ${diagnostic.message}`,
        argvSpec: splitArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'split',
        argvSpec: splitArgvSpec,
      });
      return { exitCode: 0 };
    }

    const optionsResult = buildSplitOptions({ optionValues: parsed.optionValues });
    if (!optionsResult.ok) {
      await writeCommandUsageError({
        context,
        command: 'split',
        message: `split: ${optionsResult.message}`,
        argvSpec: splitArgvSpec,
      });
      return { exitCode: 1 };
    }

    const operandsResult = parseSplitOperands({ positionals: parsed.positionals });
    if (!operandsResult.ok) {
      await writeCommandUsageError({
        context,
        command: 'split',
        message: `split: ${operandsResult.message}`,
        argvSpec: splitArgvSpec,
      });
      return { exitCode: 1 };
    }

    const { options } = optionsResult;
    const { input, prefix } = operandsResult.operands;
    const suffixGenerator = createSplitSuffixGenerator({
      prefix,
      suffixLength: options.suffixLength,
      suffixMode: options.suffixMode,
      additionalSuffix: options.additionalSuffix,
    });

    try {
      const rejectPath = createInputOverwriteGuard({ context, input });
      const firstOutputRejection = rejectPath?.({ path: suffixGenerator.peekName() });
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
