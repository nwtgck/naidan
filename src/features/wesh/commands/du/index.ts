import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import {
  writeCommandHelp,
  writeCommandUsageError,
} from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
} from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { iterateUtf8Lines } from '@/features/wesh/utils/text-records';
import {
  duThresholdAllows,
  formatDuValue,
} from './format';
import {
  duArgvSpec,
  parseDuOptions,
  type DuOptions,
} from './options';
import {
  compileDuPattern,
  type CompiledDuPattern,
} from './pattern';
import {
  shouldTrackDuIdentities,
  traverseDuOperand,
} from './traversal';

interface DuOperandRecord {
  value: string,
  sourceRecordNumber: number | undefined,
}

function combineByteFragments({
  fragments,
  finalFragment,
}: {
  fragments: Uint8Array[],
  finalFragment: Uint8Array,
}): Uint8Array {
  if (fragments.length === 0) {
    return finalFragment;
  }

  const totalLength = fragments.reduce(
    (sum, fragment) => sum + fragment.byteLength,
    finalFragment.byteLength,
  );
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const fragment of fragments) {
    combined.set(fragment, offset);
    offset += fragment.byteLength;
  }
  combined.set(finalFragment, offset);
  return combined;
}

function decodePathname({
  decoder,
  bytes,
  source,
}: {
  decoder: TextDecoder,
  bytes: Uint8Array,
  source: string,
}): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`invalid UTF-8 pathname in '${source}'`);
  }
}

async function* iterateNullTerminatedPathnames({
  context,
  source,
}: {
  context: WeshCommandContext,
  source: string,
}): AsyncIterable<DuOperandRecord> {
  const stream = await openCommandInputStream({
    context,
    input: source,
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let fragments: Uint8Array[] = [];
  let sourceRecordNumber = 1;

  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    let recordStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0) {
        continue;
      }

      const bytes = combineByteFragments({
        fragments,
        finalFragment: chunk.subarray(recordStart, index),
      });
      yield {
        value: decodePathname({ decoder, bytes, source }),
        sourceRecordNumber,
      };
      sourceRecordNumber += 1;
      fragments = [];
      recordStart = index + 1;
    }

    if (recordStart < chunk.byteLength) {
      fragments.push(chunk.subarray(recordStart));
    }
  }

  if (fragments.length > 0) {
    yield {
      value: decodePathname({
        decoder,
        bytes: combineByteFragments({
          fragments,
          finalFragment: new Uint8Array(0),
        }),
        source,
      }),
      sourceRecordNumber,
    };
  }
}

async function loadExcludePatterns({
  context,
  directPatterns,
  sources,
}: {
  context: WeshCommandContext,
  directPatterns: string[],
  sources: string[],
}): Promise<CompiledDuPattern[]> {
  const patterns = directPatterns.map((pattern) => compileDuPattern({ pattern }));
  for (const source of sources) {
    const stream = await openCommandInputStream({
      context,
      input: source,
    });
    for await (const line of iterateUtf8Lines({
      chunks: iterateReadableStreamChunks({ stream }),
    })) {
      if (line.length > 0) {
        patterns.push(compileDuPattern({ pattern: line }));
      }
    }
  }
  return patterns;
}

function createOperandSource({
  context,
  options,
  operands,
}: {
  context: WeshCommandContext,
  options: DuOptions,
  operands: string[],
}): AsyncIterable<DuOperandRecord> {
  if (options.files0From !== undefined) {
    return iterateNullTerminatedPathnames({
      context,
      source: options.files0From,
    });
  }

  const values = operands.length > 0 ? operands : ['.'];
  return (async function* (): AsyncIterable<DuOperandRecord> {
    for (const value of values) {
      yield { value, sourceRecordNumber: undefined };
    }
  })();
}

function normalizeDuOperandForDisplay({ operand }: { operand: string }): string {
  if (!operand.endsWith('/')) {
    return operand;
  }
  return operand.replace(/\/+$/u, '/');
}

function duOperandRequiresDirectory({ operand }: { operand: string }): boolean {
  return operand.endsWith('/');
}

export const duCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'du',
    description: 'Estimate logical file size usage',
    usage: 'du [OPTION]... [FILE]... | du [OPTION]... --files0-from=FILE',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseDuOptions({
      args: context.args,
      env: context.env,
    });
    if (!parsed.ok) {
      await writeCommandUsageError({
        context,
        command: 'du',
        message: parsed.message,
        argvSpec: duArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.helpRequested) {
      await writeCommandHelp({
        context,
        command: 'du',
        argvSpec: duArgvSpec,
      });
      return { exitCode: 0 };
    }

    const { options } = parsed;
    if (options.summarize && options.maxDepth === 0) {
      await context.text().error({
        text: 'du: warning: summarizing is the same as using --max-depth=0\n',
      });
    }
    if (options.metric === 'inodes' && options.logicalSizeOptionRequested) {
      await context.text().error({
        text: 'du: warning: options --apparent-size and -b are ineffective with --inodes\n',
      });
    }

    let patterns: CompiledDuPattern[];
    try {
      patterns = await loadExcludePatterns({
        context,
        directPatterns: options.excludePatterns,
        sources: options.excludeFromFiles,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `du: ${message}\n` });
      return { exitCode: 1 };
    }
    const writer = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    let exitCode = 0;
    let grandTotal = 0n;
    const normalOperandCount = parsed.operands.length > 0 ? parsed.operands.length : 1;
    const operandSourceKind = options.files0From !== undefined || normalOperandCount > 1
      ? 'multiple-or-streaming' as const
      : 'single' as const;
    const seenIdentities = shouldTrackDuIdentities({
      options,
      operandSource: operandSourceKind,
    }) ? new Set<string>() : undefined;

    const emit = async ({
      value,
      displayPath,
    }: {
      value: bigint,
      displayPath: string,
    }): Promise<void> => {
      if (!duThresholdAllows({ value, threshold: options.threshold })) {
        return;
      }
      await writer.write({
        text: `${formatDuValue({
          value,
          outputFormat: options.outputFormat,
          metric: options.metric,
        })}\t${displayPath}${options.recordTerminator}`,
      });
    };

    try {
      const operandSource = createOperandSource({
        context,
        options,
        operands: parsed.operands,
      });
      for await (const operandRecord of operandSource) {
        const rawOperand = operandRecord.value;
        if (rawOperand.length === 0) {
          const source = options.files0From ?? '-';
          const recordNumber = operandRecord.sourceRecordNumber ?? 0;
          await context.text().error({
            text: `du: ${source}:${recordNumber}: invalid zero-length file name\n`,
          });
          exitCode = 1;
          continue;
        }

        if (options.files0From === '-' && rawOperand === '-') {
          await context.text().error({
            text: "du: when reading file names from stdin, no file name of '-' allowed\n",
          });
          exitCode = 1;
          continue;
        }

        const operand = normalizeDuOperandForDisplay({ operand: rawOperand });
        const result = await traverseDuOperand({
          context,
          operand,
          operationPath: resolvePath({
            cwd: context.cwd,
            path: rawOperand,
          }),
          providedEntry: undefined,
          operandRequiresDirectory: duOperandRequiresDirectory({ operand: rawOperand }),
          options,
          patterns,
          seenIdentities,
          emit,
          reportError: async ({ displayPath, message }) => {
            await context.text().error({
              text: `du: cannot access '${displayPath}': ${message}\n`,
            });
          },
        });
        grandTotal += result.value;
        if (result.exitCode !== 0) {
          exitCode = 1;
        }
      }

      if (options.showTotal) {
        await writer.write({
          text: `${formatDuValue({
            value: grandTotal,
            outputFormat: options.outputFormat,
            metric: options.metric,
          })}\ttotal${options.recordTerminator}`,
        });
      }
      await writer.flush();
      return { exitCode };
    } catch (error: unknown) {
      try {
        await writer.flush();
      } catch {
        // Preserve the original command failure.
      }
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `du: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
