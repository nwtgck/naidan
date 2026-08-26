import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { iterateNullTerminatedPathnames } from '@/features/wesh/commands/_shared/files0-from';
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
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await openCommandInputStream({
        context,
        input: source,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read exclude file '${source}': ${message}`);
    }
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

    for (const diagnostic of parsed.preHelpDiagnostics) {
      await context.text().error({ text: `${diagnostic}\n` });
    }

    const { options } = parsed;

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
      if (!parsed.helpRequested) return { exitCode: 1 };
      patterns = [];
    }

    if (parsed.helpRequested) {
      await writeCommandHelp({
        context,
        command: 'du',
        argvSpec: duArgvSpec,
      });
      return { exitCode: 0 };
    }

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
