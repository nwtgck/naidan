import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshOpenFlags,
} from '@/features/wesh/types';
import { resolvePath } from '@/features/wesh/path';
import { openHandleReadStream } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { parseCmpByteCount, parseCmpIgnoreInitial } from './byte-count';
import { CmpInputError, iterateCmpDifferences } from './compare';
import {
  formatCmpByteDifference,
  formatCmpEofDifference,
  formatCmpVerboseDifference,
} from './format';

const CMP_READ_FLAGS: WeshOpenFlags = {
  access: 'read',
  creation: 'never',
  truncate: 'preserve',
  append: 'preserve',
};

const cmpArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'b', long: 'print-bytes', effects: [{ key: 'printBytes', value: true }], help: { summary: 'print differing bytes', category: 'common' } },
    { kind: 'value', short: 'i', long: 'ignore-initial', key: 'ignoreInitial', valueName: 'SKIP', allowAttachedValue: true, parseValue: undefined, help: { summary: 'skip SKIP bytes of both inputs, or SKIP1:SKIP2 separately', valueName: 'SKIP', category: 'common' } },
    { kind: 'flag', short: 'l', long: 'verbose', effects: [{ key: 'verbose', value: true }], help: { summary: 'output byte numbers and differing byte values', category: 'common' } },
    { kind: 'value', short: 'n', long: 'bytes', key: 'limit', valueName: 'LIMIT', allowAttachedValue: true, parseValue: undefined, help: { summary: 'compare at most LIMIT bytes', valueName: 'LIMIT', category: 'common' } },
    { kind: 'flag', short: 's', long: 'quiet', effects: [{ key: 'quiet', value: true }], help: { summary: 'suppress all normal output', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'silent', effects: [{ key: 'quiet', value: true }], help: { summary: 'same as --quiet', category: 'advanced' } },
    { kind: 'flag', short: 'v', long: 'version', effects: [{ key: 'version', value: true }], help: { summary: 'output version information and exit', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

type CmpInput = {
  stream: ReadableStream<Uint8Array>,
  remainingSkip: bigint,
  knownRemainingBytes: bigint | undefined,
};

async function openCmpInput({
  context,
  operand,
  skip,
}: {
  context: WeshCommandContext,
  operand: string,
  skip: bigint,
}): Promise<CmpInput> {
  if (operand === '-') {
    return {
      stream: openHandleReadStream({ handle: context.stdin }),
      remainingSkip: skip,
      knownRemainingBytes: undefined,
    };
  }

  const path = resolvePath({ cwd: context.cwd, path: operand });
  const efficientResult = await context.files.tryReadBlobEfficiently({ path });
  switch (efficientResult.kind) {
  case 'blob': {
    const start = skip >= BigInt(efficientResult.blob.size)
      ? efficientResult.blob.size
      : Number(skip);
    const blob = efficientResult.blob.slice(start);
    return {
      stream: blob.stream() as ReadableStream<Uint8Array>,
      remainingSkip: 0n,
      knownRemainingBytes: BigInt(blob.size),
    };
  }
  case 'fallback_required': {
    const stat = await context.files.stat({ path });
    const handle = await context.files.open({
      path,
      flags: CMP_READ_FLAGS,
    });
    const knownRemainingBytes = (() => {
      switch (stat.type) {
      case 'file': {
        const size = BigInt(Math.max(0, stat.size));
        return size > skip ? size - skip : 0n;
      }
      case 'directory':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        return undefined;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled stat type: ${_ex}`);
      }
      }
    })();
    return {
      stream: openHandleReadStream({ handle }),
      remainingSkip: skip,
      knownRemainingBytes,
    };
  }
  default: {
    const _ex: never = efficientResult;
    throw new Error(`Unhandled efficient blob result: ${JSON.stringify(_ex)}`);
  }
  }
}

async function cancelCmpInput({
  input,
}: {
  input: CmpInput | undefined,
}): Promise<void> {
  if (input === undefined) {
    return;
  }
  try {
    await input.stream.cancel();
  } catch {
    // Best-effort cleanup after an earlier failure.
  }
}

function effectiveKnownLength({
  length,
  limit,
}: {
  length: bigint,
  limit: bigint | undefined,
}): bigint {
  if (limit === undefined || length < limit) {
    return length;
  }
  return limit;
}


function verbosePositionWidth({
  leftLength,
  rightLength,
  limit,
}: {
  leftLength: bigint | undefined,
  rightLength: bigint | undefined,
  limit: bigint | undefined,
}): number {
  const knownLengths = [leftLength, rightLength]
    .filter((value): value is bigint => value !== undefined)
    .map((value) => effectiveKnownLength({ length: value, limit }));
  if (knownLengths.length === 0) {
    return 1;
  }
  const comparisonSpan = knownLengths.reduce(
    (current, value) => value < current ? value : current,
  );
  return Math.max(1, comparisonSpan.toString().length);
}

function errorMessage({
  error,
}: {
  error: unknown,
}): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeCmpRuntimeError({
  context,
  quiet,
  operand,
  error,
}: {
  context: WeshCommandContext,
  quiet: boolean,
  operand: string | undefined,
  error: unknown,
}): Promise<void> {
  if (quiet) {
    return;
  }

  const subject = operand === undefined ? '' : `${operand}: `;
  await context.text().error({
    text: `cmp: ${subject}${errorMessage({ error })}\n`,
  });
}

async function suppressCmpOpenError({
  context,
  quiet,
  operand,
}: {
  context: WeshCommandContext,
  quiet: boolean,
  operand: string,
}): Promise<boolean> {
  if (!quiet || operand === '-') {
    return false;
  }

  try {
    const stat = await context.files.stat({
      path: resolvePath({ cwd: context.cwd, path: operand }),
    });
    // GNU cmp -s suppresses ordinary open failures such as ENOENT, but a
    // directory is opened and then fails during reading, so that diagnostic
    // remains visible.
    return stat.type !== 'directory';
  } catch {
    return true;
  }
}

function processWasInterrupted({
  context,
}: {
  context: WeshCommandContext,
}): boolean {
  const waitStatus = context.process.getWaitStatus();
  return waitStatus?.kind === 'signaled' || waitStatus?.kind === 'stopped';
}

export const cmpCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: cmpArgvSpec,
      earlyExitOptions: STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: cmpArgvSpec });

    const diagnostic = parsed.diagnostics[0];
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: cmpArgvSpec,
      parsed,
      findSemanticIssue: ({ parsed: candidate }) => {
        for (const occurrence of candidate.occurrences) {
          if (occurrence.kind !== 'value' || typeof occurrence.value !== 'string') continue;
          if (occurrence.key === 'limit') {
            const result = parseCmpByteCount({ value: occurrence.value, option: '--bytes' });
            if (!result.ok) return result.message;
          }
          if (occurrence.key === 'ignoreInitial') {
            const result = parseCmpIgnoreInitial({ value: occurrence.value });
            if (!result.ok) return result.message;
          }
        }
        return undefined;
      },
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'cmp',
        message: `cmp: ${diagnostic.message}`,
        argvSpec: cmpArgvSpec,
      });
      return { exitCode: 2 };
    }

    // GNU cmp keeps the smallest repeated byte limit and the greatest skip
    // specified for each input across repeated options and positional operands.
    let limit: bigint | undefined;
    let leftSkip = 0n;
    let rightSkip = 0n;
    for (const occurrence of parsed.occurrences) {
      if (occurrence.kind !== 'value' || typeof occurrence.value !== 'string') {
        continue;
      }

      switch (occurrence.key) {
      case 'limit': {
        const parsedLimit = parseCmpByteCount({
          value: occurrence.value,
          option: '--bytes',
        });
        if (!parsedLimit.ok) {
          await writeCommandUsageError({
            context,
            command: 'cmp',
            message: parsedLimit.message,
            argvSpec: cmpArgvSpec,
          });
          return { exitCode: 2 };
        }
        if (limit === undefined || parsedLimit.value < limit) {
          limit = parsedLimit.value;
        }
        break;
      }
      case 'ignoreInitial': {
        const parsedIgnoreInitial = parseCmpIgnoreInitial({ value: occurrence.value });
        if (!parsedIgnoreInitial.ok) {
          await writeCommandUsageError({
            context,
            command: 'cmp',
            message: parsedIgnoreInitial.message,
            argvSpec: cmpArgvSpec,
          });
          return { exitCode: 2 };
        }
        if (parsedIgnoreInitial.left > leftSkip) {
          leftSkip = parsedIgnoreInitial.left;
        }
        if (parsedIgnoreInitial.right > rightSkip) {
          rightSkip = parsedIgnoreInitial.right;
        }
        break;
      }
      default:
        break;
      }
    }


    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cmp',
        argvSpec: cmpArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.version === true) {
      await context.text().print({ text: 'cmp (wesh)\n' });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length < 1) {
      await writeCommandUsageError({
        context,
        command: 'cmp',
        message: 'cmp: missing operand',
        argvSpec: cmpArgvSpec,
      });
      return { exitCode: 2 };
    }
    if (parsed.positionals.length > 4) {
      await writeCommandUsageError({
        context,
        command: 'cmp',
        message: `cmp: extra operand '${parsed.positionals[4] ?? ''}'`,
        argvSpec: cmpArgvSpec,
      });
      return { exitCode: 2 };
    }

    const verbose = parsed.optionValues.verbose === true;
    const quiet = parsed.optionValues.quiet === true;
    if (verbose && quiet) {
      await writeCommandUsageError({
        context,
        command: 'cmp',
        message: 'cmp: options -l and -s are incompatible',
        argvSpec: cmpArgvSpec,
      });
      return { exitCode: 2 };
    }

    const rawLeftSkip = parsed.positionals[2];
    if (rawLeftSkip !== undefined) {
      const parsedLeftSkip = parseCmpByteCount({
        value: rawLeftSkip,
        option: '--ignore-initial',
      });
      if (!parsedLeftSkip.ok) {
        await writeCommandUsageError({
          context,
          command: 'cmp',
          message: parsedLeftSkip.message,
          argvSpec: cmpArgvSpec,
        });
        return { exitCode: 2 };
      }
      if (parsedLeftSkip.value > leftSkip) {
        leftSkip = parsedLeftSkip.value;
      }
    }

    const rawRightSkip = parsed.positionals[3];
    if (rawRightSkip !== undefined) {
      const parsedRightSkip = parseCmpByteCount({
        value: rawRightSkip,
        option: '--ignore-initial',
      });
      if (!parsedRightSkip.ok) {
        await writeCommandUsageError({
          context,
          command: 'cmp',
          message: parsedRightSkip.message,
          argvSpec: cmpArgvSpec,
        });
        return { exitCode: 2 };
      }
      if (parsedRightSkip.value > rightSkip) {
        rightSkip = parsedRightSkip.value;
      }
    }

    const leftName = parsed.positionals[0]!;
    const rightName = parsed.positionals[1] ?? '-';
    if (leftName === '-' && rightName === '-') {
      return { exitCode: 0 };
    }

    let leftInput: CmpInput | undefined;
    let rightInput: CmpInput | undefined;
    try {
      leftInput = await openCmpInput({
        context,
        operand: leftName,
        skip: leftSkip,
      });
    } catch (error: unknown) {
      if (processWasInterrupted({ context })) {
        throw error;
      }
      await writeCmpRuntimeError({
        context,
        quiet: await suppressCmpOpenError({
          context,
          quiet,
          operand: leftName,
        }),
        operand: leftName,
        error,
      });
      return { exitCode: 2 };
    }

    try {
      rightInput = await openCmpInput({
        context,
        operand: rightName,
        skip: rightSkip,
      });
    } catch (error: unknown) {
      await cancelCmpInput({ input: leftInput });
      if (processWasInterrupted({ context })) {
        throw error;
      }
      await writeCmpRuntimeError({
        context,
        quiet: await suppressCmpOpenError({
          context,
          quiet,
          operand: rightName,
        }),
        operand: rightName,
        error,
      });
      return { exitCode: 2 };
    }

    if (
      quiet
      && leftInput.knownRemainingBytes !== undefined
      && rightInput.knownRemainingBytes !== undefined
      && effectiveKnownLength({ length: leftInput.knownRemainingBytes, limit })
        !== effectiveKnownLength({ length: rightInput.knownRemainingBytes, limit })
    ) {
      await cancelCmpInput({ input: leftInput });
      await cancelCmpInput({ input: rightInput });
      return { exitCode: 1 };
    }

    const mode: 'first-difference' | 'verbose' | 'quiet' = verbose
      ? 'verbose'
      : quiet
        ? 'quiet'
        : 'first-difference';
    const writer = verbose
      ? createBufferedTextWriter({
        handle: context.stdout,
        maxBufferLength: 16 * 1024,
      })
      : undefined;
    const positionWidth = verbosePositionWidth({
      leftLength: leftInput.knownRemainingBytes,
      rightLength: rightInput.knownRemainingBytes,
      limit,
    });
    let foundDifference = false;

    try {
      for await (const difference of iterateCmpDifferences({
        leftStream: leftInput.stream,
        rightStream: rightInput.stream,
        leftSkip: leftInput.remainingSkip,
        rightSkip: rightInput.remainingSkip,
        limit,
        tracking: verbose ? 'all-differences' : 'first-difference',
      })) {
        foundDifference = true;
        switch (difference.kind) {
        case 'byte':
          switch (mode) {
          case 'quiet':
            return { exitCode: 1 };
          case 'verbose':
            await writer?.write({
              text: formatCmpVerboseDifference({
                difference,
                printBytes: parsed.optionValues.printBytes === true,
                positionWidth,
              }),
            });
            continue;
          case 'first-difference':
            await context.text().print({
              text: formatCmpByteDifference({
                leftName,
                rightName,
                difference,
                printBytes: parsed.optionValues.printBytes === true,
              }),
            });
            return { exitCode: 1 };
          default: {
            const _ex: never = mode;
            throw new Error(`Unhandled cmp mode: ${_ex}`);
          }
          }
        case 'eof': {
          const shorterName = (() => {
            switch (difference.shorter) {
            case 'left':
              return leftName;
            case 'right':
              return rightName;
            default: {
              const _ex: never = difference.shorter;
              throw new Error(`Unhandled cmp shorter input: ${_ex}`);
            }
            }
          })();

          switch (mode) {
          case 'quiet':
            return { exitCode: 1 };
          case 'verbose':
            await writer?.flush();
            await context.text().error({
              text: formatCmpEofDifference({
                shorterName,
                difference,
                mode: 'verbose',
              }),
            });
            return { exitCode: 1 };
          case 'first-difference':
            await context.text().error({
              text: formatCmpEofDifference({
                shorterName,
                difference,
                mode: 'first-difference',
              }),
            });
            return { exitCode: 1 };
          default: {
            const _ex: never = mode;
            throw new Error(`Unhandled cmp mode: ${_ex}`);
          }
          }
        }
        default: {
          const _ex: never = difference;
          throw new Error(`Unhandled cmp difference: ${JSON.stringify(_ex)}`);
        }
        }
      }

      return { exitCode: foundDifference ? 1 : 0 };
    } catch (error: unknown) {
      if (processWasInterrupted({ context })) {
        throw error;
      }
      const inputOperand = (() => {
        if (!(error instanceof CmpInputError)) {
          return undefined;
        }
        switch (error.side) {
        case 'left':
          return leftName;
        case 'right':
          return rightName;
        default: {
          const _ex: never = error.side;
          throw new Error(`Unhandled cmp input side: ${_ex}`);
        }
        }
      })();
      await writeCmpRuntimeError({
        context,
        // -s suppresses differences and open failures, but GNU cmp still
        // reports errors encountered while reading an already opened input.
        quiet: false,
        operand: inputOperand,
        error: error instanceof CmpInputError ? error.originalError : error,
      });
      return { exitCode: 2 };
    } finally {
      await writer?.flush();
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
