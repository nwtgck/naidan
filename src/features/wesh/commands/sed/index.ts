import {
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
} from '@/features/wesh/argv-v2';
import {
  resolveCharacterLocaleMode,
  type WeshCharacterLocaleMode,
} from "@/features/wesh/commands/_shared/locale";
import {
  writeCommandHelp,
  writeCommandUsageError,
} from "@/features/wesh/commands/_shared/usage-output";
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshFileHandle,
} from "@/features/wesh/types";
import {
  openFileReadStream,
  readAllFileBytes,
  readAllHandleBytes,
} from "@/features/wesh/utils/fs";
import {
  createBufferedCommandDataWriter,
  decodeCommandDataBytes,
} from "@/features/wesh/commands/_shared/data-codec";
import {
  createSedWriteFileManager,
  type SedWriteFileManager,
} from "./write-file-manager";
import {
  createSedReadFileManager,
  type SedPreparedReadFileLine,
  type SedReadFileTermination,
} from "./read-file-manager";
import {
  parseSedLineLengthOption,
} from "./numeric-semantics";
import { sedArgvCatalog, sedArgvHelp, sedArgvPolicy } from "./argv";
import type { SedRegularExpressionSyntax } from "./regexp";
import { decodeSedDataBytes, fromSedLocaleText } from "./locale-text";
import { substituteSedPattern } from "./replacement";
import {
  type SedCommand,
} from "./command-model";
import { parseSedScripts, validateSedLabels } from "./script-parser";
import { renderSedList } from "./list-renderer";
import {
  commandApplies,
  commandNeedsLastLine,
  settleActiveRangeEnds,
} from "./range-runtime";
import {
  createSedRuntimeCommands,
  type SedExecutableRuntimeCommand,
} from "./runtime-command";
import { createSedOutputWriter, type SedOutputWriter } from "./output-writer";
import {
  createSedTemporaryFile,
  isSedInputDirectory,
  openSedInputStream,
  readSedFiles,
  readSedTextRecords,
  resolveSedCommandPath,
  resolveSedFollowSymlinkInput,
  resolveSedInPlaceRecoveryPath,
} from "./file-runtime";
import {
  captureSedShellCommandOutput,
  executeSedShellCommand,
} from "./shell-runtime";
import type {
  SedAction,
  SedExecutionState,
  SedInputReadPhase,
  SedInputReadState,
  SedLineResult,
  SedProcessTermination,
  SedSeparateFileState,
  SedSpace,
  SedTextLine,
} from "./runtime-model";


const SED_EXECUTION_YIELD_INTERVAL = 16 * 1024;

async function processSedLines({
  context,
  lines,
  commands,
  quiet,
  writer,
  shellStdout,
  writeFiles,
  delimiterByte,
  characterLocaleMode,
  separateFileState,
  inputReadState,
  unbuffered,
}: {
  context: WeshCommandContext;
  lines: AsyncIterable<SedTextLine>;
  commands: SedCommand[];
  quiet: boolean;
  writer: SedOutputWriter;
  shellStdout: WeshFileHandle;
  writeFiles: SedWriteFileManager;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
  separateFileState?: SedSeparateFileState;
  inputReadState?: SedInputReadState;
  unbuffered: boolean;
}): Promise<SedProcessTermination | undefined> {
  const runtimeCommands = createSedRuntimeCommands({ commands });
  const readFiles = createSedReadFileManager({
    context,
    openLines: async ({ path }) =>
      readSedTextRecords({
        stream: await openFileReadStream({
          files: context.files,
          path: resolveSedCommandPath({ context, path }),
        }),
        sourceName: path,
        delimiterByte,
        characterLocaleMode,
      }),
  });
  const executionState: SedExecutionState = {
    holdSpace: {
      text: "",
      hadNewline: separateFileState?.holdSpaceHadNewline ?? true,
    },
    characterLocaleMode,
  };
  const iterator = lines[Symbol.asyncIterator]();
  let currentResult: IteratorResult<SedTextLine>;
  let lookahead: IteratorResult<SedTextLine> | undefined;
  let lineNumber = 0;

  const readNext = async ({
    phase,
  }: {
    phase: SedInputReadPhase;
  }): Promise<IteratorResult<SedTextLine>> => {
    if (inputReadState !== undefined) inputReadState.phase = phase;
    return await iterator.next();
  };

  const ensureLookahead = async (): Promise<IteratorResult<SedTextLine>> => {
    lookahead ??= await readNext({ phase: "inCycle" });
    return lookahead;
  };

  const executeActions = async ({
    actions,
  }: {
    actions: readonly SedAction[];
  }): Promise<SedProcessTermination | undefined> => {
    for (const action of actions) {
      switch (action.kind) {
      case "output":
        await writer.write({ output: action.output });
        break;
      case "terminatePendingOutput":
        await writer.terminatePendingOutput();
        break;
      case "appendText":
        await writer.writeAppendText({ text: action.text });
        break;
      case "readFile": {
        const termination = await readFiles.writeAll({
          path: action.path,
          writer,
        });
        if (termination !== undefined) return termination;
        break;
      }
      case "readFileLine":
        await readFiles.writeLine({
          prepared: action.prepared,
          writer,
        });
        break;
      case "writeFile":
        await writeFiles.write({
          path: action.path,
          output: action.output,
        });
        break;
      default: {
        const _ex: never = action;
        throw new Error(`Unhandled sed action: ${JSON.stringify(_ex)}`);
      }
      }
    }
    return undefined;
  };

  const closeInputs = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await iterator.return?.();
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      await readFiles.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "sed: failed to close input streams");
    }
  };

  try {
    currentResult = await readNext({ phase: "cycleStart" });
    while (!currentResult.done) {
      lineNumber += 1;
      const current = currentResult.value;
      const result = await executeSedLine({
        context,
        writer,
        shellStdout,
        delimiterByte,
        runtimeCommands,
        lineNumber,
        current,
        quiet,
        resolveIsLastLine: async () => {
          const next = await ensureLookahead();
          return {
            isLastLine: next.done === true,
            lookaheadSourceName: next.done ? undefined : next.value.sourceName,
          };
        },
        executionState,
        patternSeparator: String.fromCharCode(delimiterByte),
        consumeNextLine: async () => {
          const next = await ensureLookahead();
          if (next.done) return undefined;
          lineNumber += 1;
          const consumed = next.value;
          lookahead = undefined;
          return {
            current: consumed,
            lineNumber,
          };
        },
        prepareReadFileLine: async ({ path }) =>
          await readFiles.prepareLine({ path }),
        flushActions: async ({ actions }) =>
          await executeActions({ actions }),
        unbuffered,
        yieldExecution: async () => {
          const waitStatus = await context.process.waitForSignalOrTimeout({
            timeoutMs: 1,
            pollIntervalMs: 1,
          });
          return waitStatus === undefined ? "continue" : "interrupted";
        },
      });
      if (separateFileState !== undefined) {
        separateFileState.holdSpaceHadNewline = executionState.holdSpace.hadNewline;
      }
      if (result.termination !== undefined) {
        const interrupted = (() => {
          switch (result.termination.kind) {
          case "interrupted":
            return true;
          case "quit":
          case "fatal":
            return false;
          default: {
            const _ex: never = result.termination;
            throw new Error(
              `Unhandled sed termination: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
            );
          }
          }
        })();
        if (interrupted) {
          try {
            await closeInputs();
          } catch {
            // The process signal may already have closed input descriptors.
          }
          return result.termination;
        }
      }
      const actionTermination = await executeActions({
        actions: result.actions,
      });
      const termination = actionTermination ?? result.termination;
      if (termination !== undefined) {
        await writer.flush();
        await closeInputs();
        return termination;
      }

      if (lookahead !== undefined) {
        currentResult = lookahead;
        lookahead = undefined;
      } else {
        currentResult = await readNext({ phase: "cycleStart" });
      }
    }
  } catch (error: unknown) {
    try {
      await closeInputs();
    } catch {
      // Preserve the original sed execution failure.
    }
    throw error;
  }

  await closeInputs();
  await writer.flush();
  return undefined;
}

async function processSedStream({
  context,
  stream,
  sourceName,
  commands,
  quiet,
  writer,
  shellStdout,
  writeFiles,
  delimiterByte,
  characterLocaleMode,
  separateFileState,
  unbuffered,
}: {
  context: WeshCommandContext;
  stream: ReadableStream<Uint8Array>;
  sourceName: string;
  commands: SedCommand[];
  quiet: boolean;
  writer: SedOutputWriter;
  shellStdout: WeshFileHandle;
  writeFiles: SedWriteFileManager;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
  separateFileState?: SedSeparateFileState;
  unbuffered: boolean;
}): Promise<SedProcessTermination | undefined> {
  return await processSedLines({
    context,
    lines: readSedTextRecords({
      stream,
      sourceName,
      delimiterByte,
      characterLocaleMode,
    }),
    commands,
    quiet,
    writer,
    shellStdout,
    writeFiles,
    delimiterByte,
    characterLocaleMode,
    separateFileState,
    unbuffered,
  });
}

async function executeSedLine({
  context,
  writer,
  shellStdout,
  delimiterByte,
  runtimeCommands,
  lineNumber: initialLineNumber,
  current,
  quiet,
  resolveIsLastLine,
  executionState,
  consumeNextLine,
  prepareReadFileLine,
  patternSeparator,
  flushActions,
  unbuffered,
  yieldExecution,
}: {
  context: WeshCommandContext;
  writer: SedOutputWriter;
  shellStdout: WeshFileHandle;
  delimiterByte: number;
  runtimeCommands: SedExecutableRuntimeCommand[];
  lineNumber: number;
  current: SedTextLine;
  quiet: boolean;
  resolveIsLastLine: () => Promise<{
    isLastLine: boolean;
    lookaheadSourceName: string | undefined;
  }>;
  executionState: SedExecutionState;
  consumeNextLine: () => Promise<
    | {
        current: SedTextLine;
        lineNumber: number;
      }
    | undefined
  >;
  prepareReadFileLine: ({
    path,
  }: {
    path: string;
  }) => Promise<SedPreparedReadFileLine | SedReadFileTermination>;
  patternSeparator: string;
  flushActions: ({
    actions,
  }: {
    actions: readonly SedAction[];
  }) => Promise<SedProcessTermination | undefined>;
  unbuffered: boolean;
  yieldExecution: () => Promise<"continue" | "interrupted">;
}): Promise<SedLineResult> {
  let lineNumber = initialLineNumber;
  let isLastLine: boolean | undefined;
  let patternSpace: SedSpace = {
    text: current.line,
    hadNewline: current.hadNewline,
  };
  let sourceName = current.sourceName;
  let deleted = false;
  let termination: SedProcessTermination | undefined;
  const actions: SedAction[] = [];
  const pendingAppends: SedAction[] = [];
  let substitutionSucceeded = false;

  const flushPendingAppends = (): void => {
    for (const pendingAppend of pendingAppends) actions.push(pendingAppend);
    pendingAppends.length = 0;
  };
  let commandIndex = 0;
  let executionSteps = 0;

  const getIsLastLine = async (): Promise<boolean> => {
    if (isLastLine === undefined) {
      const resolution = await resolveIsLastLine();
      isLastLine = resolution.isLastLine;
      if (resolution.lookaheadSourceName !== undefined) {
        sourceName = resolution.lookaheadSourceName;
      }
    }
    return isLastLine;
  };

  const settleRanges = ({
    startIndex,
    endIndex,
    line,
    reason,
  }: {
    startIndex: number;
    endIndex: number;
    line: string;
    reason: "cycleTermination" | "inputConsumption";
  }): void => {
    settleActiveRangeEnds({
      runtimeCommands,
      startIndex,
      endIndex,
      lineNumber,
      line,
      reason,
    });
  };

  while (commandIndex < runtimeCommands.length) {
    executionSteps += 1;
    if (executionSteps % SED_EXECUTION_YIELD_INTERVAL === 0) {
      const yieldResult = await yieldExecution();
      const interrupted = (() => {
        switch (yieldResult) {
        case "continue":
          return false;
        case "interrupted":
          return true;
        default: {
          const _ex: never = yieldResult;
          throw new Error(`Unhandled sed execution yield result: ${_ex}`);
        }
        }
      })();
      if (interrupted) {
        termination = { kind: "interrupted" };
        break;
      }
    }
    const runtimeCommand = runtimeCommands[commandIndex]!;
    let nextCommandIndex = commandIndex + 1;
    const needsLastLine = commandNeedsLastLine({
      runtimeCommand,
      lineNumber,
      line: patternSpace.text,
    });
    if (
      !commandApplies({
        runtimeCommand,
        lineNumber,
        line: patternSpace.text,
        isLastLine: needsLastLine ? await getIsLastLine() : false,
      })
    ) {
      commandIndex = (() => {
        switch (runtimeCommand.command.kind) {
        case "groupStart":
          return runtimeCommand.command.targetIndex;
        case "substitute":
        case "translate":
        case "append":
        case "insert":
        case "change":
        case "print":
        case "printFirst":
        case "list":
        case "lineNumber":
        case "hold":
        case "holdAppend":
        case "get":
        case "getAppend":
        case "exchange":
        case "delete":
        case "deleteFirst":
        case "next":
        case "nextAppend":
        case "readFile":
        case "readFileLine":
        case "writeFile":
        case "writeFileFirst":
        case "clear":
        case "fileName":
        case "execute":
        case "quit":
        case "label":
        case "branch":
        case "branchIfSubstituted":
        case "branchIfNotSubstituted":
        case "groupEnd":
          return nextCommandIndex;
        default: {
          const _ex: never = runtimeCommand.command;
          throw new Error(
            `Unhandled sed runtime command: ${JSON.stringify(_ex)}`,
          );
        }
        }
      })();
      continue;
    }

    switch (runtimeCommand.command.kind) {
    case "substitute": {
      const substitution = substituteSedPattern({
        source: patternSpace.text,
        regex: runtimeCommand.command.regex,
        replacement: runtimeCommand.command.replacement,
        occurrence: runtimeCommand.command.occurrence,
        replaceFollowing: runtimeCommand.command.replaceFollowing,
        characterLocaleMode: executionState.characterLocaleMode,
      });
      patternSpace.text = substitution.text;
      substitutionSucceeded ||= substitution.matched;
      if (substitution.matched) {
        switch (runtimeCommand.command.printPhase) {
        case "afterSubstitution":
          actions.push({ kind: "output", output: { ...patternSpace } });
          break;
        case "none":
        case "afterExecution":
          break;
        default: {
          const _ex: never = runtimeCommand.command.printPhase;
          throw new Error(`Unhandled sed substitution print phase: ${_ex}`);
        }
        }
        if (runtimeCommand.command.execute) {
          const shellOutput = await captureSedShellCommandOutput({
            context,
            command: fromSedLocaleText({
              text: patternSpace.text,
              characterLocaleMode: executionState.characterLocaleMode,
            }),
          });
          let outputLength = shellOutput.byteLength;
          if (
            outputLength > 0 &&
            shellOutput[outputLength - 1] === delimiterByte
          ) {
            outputLength -= 1;
          }
          patternSpace = {
            text: decodeSedDataBytes({
              bytes: shellOutput.subarray(0, outputLength),
              characterLocaleMode: executionState.characterLocaleMode,
            }),
            hadNewline: patternSpace.hadNewline,
          };
        }
        switch (runtimeCommand.command.printPhase) {
        case "afterExecution":
          actions.push({ kind: "output", output: { ...patternSpace } });
          break;
        case "none":
        case "afterSubstitution":
          break;
        default: {
          const _ex: never = runtimeCommand.command.printPhase;
          throw new Error(`Unhandled sed substitution print phase: ${_ex}`);
        }
        }
        if (runtimeCommand.command.writePath !== undefined) {
          actions.push({
            kind: "writeFile",
            path: runtimeCommand.command.writePath,
            output: { ...patternSpace },
          });
        }
      }
      break;
    }
    case "translate": {
      const command = runtimeCommand.command;
      let translated = "";
      for (const character of patternSpace.text) {
        translated += command.lookup.get(character) ?? character;
      }
      patternSpace.text = translated;
      break;
    }
    case "append":
      if (runtimeCommand.command.text !== undefined) {
        pendingAppends.push({
          kind: "appendText",
          text: runtimeCommand.command.text,
        });
      }
      break;
    case "insert":
      if (runtimeCommand.command.text !== undefined) {
        actions.push({
          kind: "output",
          output: { text: runtimeCommand.command.text, hadNewline: true },
        });
      }
      break;
    case "change":
      if (
        runtimeCommand.command.text !== undefined &&
          (runtimeCommand.command.rangeEnd === undefined ||
            !runtimeCommand.inRange)
      ) {
        actions.push({
          kind: "output",
          output: { text: runtimeCommand.command.text, hadNewline: true },
        });
      }
      deleted = true;
      break;
    case "print":
      actions.push({ kind: "output", output: { ...patternSpace } });
      break;
    case "printFirst": {
      const newlineIndex = patternSpace.text.indexOf(patternSeparator);
      actions.push({
        kind: "output",
        output:
            newlineIndex < 0
              ? { ...patternSpace }
              : {
                text: patternSpace.text.slice(0, newlineIndex),
                hadNewline: true,
              },
      });
      break;
    }
    case "list":
      actions.push({
        kind: "output",
        output: {
          text: renderSedList({
            text: patternSpace.text,
            width: runtimeCommand.command.width,
            continuationSeparator: patternSeparator,
            characterLocaleMode: executionState.characterLocaleMode,
          }),
          hadNewline: true,
        },
      });
      break;
    case "lineNumber":
      actions.push({
        kind: "output",
        output: { text: String(lineNumber), hadNewline: true },
      });
      break;
    case "hold":
      executionState.holdSpace = { ...patternSpace };
      break;
    case "holdAppend":
      executionState.holdSpace = {
        text: `${executionState.holdSpace.text}${patternSeparator}${patternSpace.text}`,
        hadNewline: patternSpace.hadNewline,
      };
      break;
    case "get":
      patternSpace = { ...executionState.holdSpace };
      break;
    case "getAppend":
      patternSpace = {
        text: `${patternSpace.text}${patternSeparator}${executionState.holdSpace.text}`,
        hadNewline: executionState.holdSpace.hadNewline,
      };
      break;
    case "exchange": {
      const previousPatternSpace = patternSpace;
      patternSpace = executionState.holdSpace;
      executionState.holdSpace = previousPatternSpace;
      break;
    }
    case "delete":
      deleted = true;
      break;
    case "deleteFirst": {
      const newlineIndex = patternSpace.text.indexOf(patternSeparator);
      if (newlineIndex < 0) {
        deleted = true;
        break;
      }
      patternSpace = {
        text: patternSpace.text.slice(newlineIndex + 1),
        hadNewline: patternSpace.hadNewline,
      };
      commandIndex = 0;
      continue;
    }
    case "next": {
      if (!quiet)
        actions.push({ kind: "output", output: { ...patternSpace } });
      flushPendingAppends();
      const actionTermination = await flushActions({ actions });
      actions.length = 0;
      if (actionTermination !== undefined) {
        termination = actionTermination;
        break;
      }
      const next = await consumeNextLine();
      if (next === undefined) {
        deleted = true;
        break;
      }
      patternSpace = {
        text: next.current.line,
        hadNewline: next.current.hadNewline,
      };
      sourceName = next.current.sourceName;
      lineNumber = next.lineNumber;
      isLastLine = undefined;
      settleRanges({
        startIndex: 0,
        endIndex: runtimeCommands.length,
        line: next.current.line,
        reason: "inputConsumption",
      });
      substitutionSucceeded = false;
      break;
    }
    case "nextAppend": {
      const next = await consumeNextLine();
      if (next === undefined) {
        commandIndex = runtimeCommands.length;
        continue;
      }
      flushPendingAppends();
      const actionTermination = await flushActions({ actions });
      actions.length = 0;
      if (actionTermination !== undefined) {
        termination = actionTermination;
        break;
      }
      patternSpace = {
        text: `${patternSpace.text}${patternSeparator}${next.current.line}`,
        hadNewline: next.current.hadNewline,
      };
      sourceName = next.current.sourceName;
      lineNumber = next.lineNumber;
      isLastLine = undefined;
      settleRanges({
        startIndex: 0,
        endIndex: runtimeCommands.length,
        line: next.current.line,
        reason: "inputConsumption",
      });
      substitutionSucceeded = false;
      break;
    }
    case "readFile":
      pendingAppends.push({
        kind: "readFile",
        path: runtimeCommand.command.path,
      });
      break;
    case "readFileLine": {
      const preparation = await prepareReadFileLine({
        path: runtimeCommand.command.path,
      });
      switch (preparation.kind) {
      case "fatal":
        termination = preparation;
        break;
      case "preparedReadFileLine":
        pendingAppends.push({
          kind: "readFileLine",
          prepared: preparation,
        });
        break;
      default: {
        const _ex: never = preparation;
        throw new Error(`Unhandled sed read-file preparation: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case "writeFile":
      actions.push({
        kind: "writeFile",
        path: runtimeCommand.command.path,
        output: { ...patternSpace },
      });
      break;
    case "writeFileFirst": {
      const newlineIndex = patternSpace.text.indexOf(patternSeparator);
      actions.push({
        kind: "writeFile",
        path: runtimeCommand.command.path,
        output:
            newlineIndex < 0
              ? { ...patternSpace }
              : {
                text: patternSpace.text.slice(0, newlineIndex),
                hadNewline: true,
              },
      });
      break;
    }
    case "clear":
      patternSpace = { text: "", hadNewline: patternSpace.hadNewline };
      break;
    case "fileName":
      actions.push({
        kind: "output",
        output: { text: sourceName, hadNewline: true },
      });
      break;
    case "execute": {
      const command = runtimeCommand.command.command;
      if (command === undefined) {
        const shellOutput = await captureSedShellCommandOutput({
          context,
          command: fromSedLocaleText({
            text: patternSpace.text,
            characterLocaleMode: executionState.characterLocaleMode,
          }),
        });
        let outputLength = shellOutput.byteLength;
        if (
          outputLength > 0 &&
          shellOutput[outputLength - 1] === delimiterByte
        ) {
          outputLength -= 1;
        }
        patternSpace = {
          text: decodeSedDataBytes({
            bytes: shellOutput.subarray(0, outputLength),
            characterLocaleMode: executionState.characterLocaleMode,
          }),
          hadNewline: true,
        };
      } else {
        const actionTermination = await flushActions({ actions });
        actions.length = 0;
        if (actionTermination !== undefined) {
          termination = actionTermination;
          break;
        }
        await writer.terminatePendingOutput();
        await writer.flush();
        await executeSedShellCommand({
          context,
          command: fromSedLocaleText({
            text: command,
            characterLocaleMode: executionState.characterLocaleMode,
          }),
          stdout: shellStdout,
        });
      }
      break;
    }
    case "quit":
      termination = {
        kind: "quit",
        exitCode: runtimeCommand.command.exitCode,
      };
      if (runtimeCommand.command.printPattern) {
        actions.push({ kind: "terminatePendingOutput" });
        patternSpace.hadNewline = true;
      } else {
        deleted = true;
        pendingAppends.length = 0;
      }
      break;
    case "label":
    case "groupStart":
    case "groupEnd":
      break;
    case "branch":
      nextCommandIndex =
          runtimeCommand.command.targetIndex ?? runtimeCommands.length;
      break;
    case "branchIfSubstituted": {
      const shouldBranch = substitutionSucceeded;
      substitutionSucceeded = false;
      if (shouldBranch) {
        nextCommandIndex =
            runtimeCommand.command.targetIndex ?? runtimeCommands.length;
      }
      break;
    }
    case "branchIfNotSubstituted": {
      const shouldBranch = !substitutionSucceeded;
      substitutionSucceeded = false;
      if (shouldBranch) {
        nextCommandIndex =
            runtimeCommand.command.targetIndex ?? runtimeCommands.length;
      }
      break;
    }
    default: {
      const _ex: never = runtimeCommand.command;
      throw new Error(`Unhandled sed command kind: ${_ex}`);
    }
    }

    if (unbuffered && actions.length > 0) {
      const actionTermination = await flushActions({ actions });
      actions.length = 0;
      if (actionTermination !== undefined) termination = actionTermination;
    }

    if (termination !== undefined) break;
    if (deleted) {
      settleRanges({
        startIndex: commandIndex + 1,
        endIndex: runtimeCommands.length,
        line: patternSpace.text,
        reason: "cycleTermination",
      });
      break;
    }
    commandIndex = nextCommandIndex;
  }

  const shouldFlushCycleOutput = (() => {
    if (termination === undefined) return true;
    switch (termination.kind) {
    case "quit":
      return true;
    case "fatal":
    case "interrupted":
      return false;
    default: {
      const _ex: never = termination;
      throw new Error(
        `Unhandled sed termination: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
      );
    }
    }
  })();
  if (shouldFlushCycleOutput) {
    if (!deleted && !quiet) {
      actions.push({ kind: "output", output: patternSpace });
    }
    flushPendingAppends();
  }

  return {
    actions,
    termination,
  };
}

export const sedCommandImplementation: WeshCommandImplementation = {
  fn: async ({
    context,
  }: {
    context: WeshCommandContext;
  }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: sedArgvCatalog,
        policy: sedArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: sedArgvCatalog,
      policy: sedArgvPolicy,
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: "sed",
        message: `sed: ${parsed.diagnostics[0]!.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: sedArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: "sed",
        optionLines: formatArgvOptionHelp({ presentation: sedArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const nullData = parsed.optionValues.nullData === true;
    const unbuffered = parsed.optionValues.unbuffered === true;
    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
    const delimiterByte = nullData ? 0x00 : 0x0a;
    const recordTerminator = nullData ? "\0" : "\n";
    const syntax: SedRegularExpressionSyntax =
      parsed.optionValues.extendedRegexp === true ? "extended" : "basic";
    const createWriteFiles = async ({
      paths,
    }: {
      paths: readonly string[];
    }): Promise<SedWriteFileManager> =>
      await createSedWriteFileManager({
        context,
        paths,
        recordTerminator,
        encodeText: ({ text }) =>
          fromSedLocaleText({ text, characterLocaleMode }),
        maxBufferLength: unbuffered ? 1 : 16 * 1024,
      });

    const scripts: string[] = [];
    for (const occurrence of parsed.occurrences ?? []) {
      const semantic = occurrence.semantic;
      switch (semantic.kind) {
      case "effects":
      case "deferred":
        continue;
      case "required-value":
        break;
      default: {
        const _ex: never = semantic;
        throw new Error(
          `Unhandled sed argv semantic: ${(((_ex satisfies never) as { readonly kind: string }).kind)}`,
        );
      }
      }
      const rawValue = (() => {
        switch (occurrence.value.kind) {
        case "inline":
        case "next-argv":
          return occurrence.value.rawValue;
        case "none":
          return undefined;
        default: {
          const _ex: never = occurrence.value;
          throw new Error(`Unhandled sed argv occurrence value: ${JSON.stringify(_ex)}`);
        }
        }
      })();
      if (rawValue === undefined) continue;
      if (semantic.key === "expression") {
        scripts.push(rawValue);
        continue;
      }
      if (semantic.key !== "scriptFile") continue;
      const scriptFile = rawValue;
      try {
        if (scriptFile.length === 0) {
          throw new Error("No such file or directory");
        }
        const bytes = scriptFile === "-"
          ? await readAllHandleBytes({ handle: context.stdin })
          : await (async (): Promise<Uint8Array> => {
            const path = resolveSedCommandPath({ context, path: scriptFile });
            const stat = await context.files.stat({ path });
            switch (stat.type) {
            case "directory":
              return new Uint8Array();
            case "file":
            case "symlink":
            case "fifo":
            case "chardev":
              return await readAllFileBytes({ files: context.files, path });
            default: {
              const _ex: never = stat.type;
              throw new Error(`Unhandled sed script source type: ${_ex}`);
            }
            }
          })();
        scripts.push(decodeCommandDataBytes({ bytes }));
      } catch (error: unknown) {
        if (scripts.length > 0) {
          const prefixCompilation = parseSedScripts({
            scripts,
            syntax,
            characterLocaleMode,
            nullData,
          });
          if (prefixCompilation.compileEffects.writePaths.length > 0) {
            try {
              const prefixWriteFiles = await createWriteFiles({
                paths: prefixCompilation.compileEffects.writePaths,
              });
              await prefixWriteFiles.close();
            } catch (writeError: unknown) {
              const message =
                writeError instanceof Error ? writeError.message : String(writeError);
              await context.text().error({ text: `sed: ${message}\n` });
              return { exitCode: 4 };
            }
          }
          if (
            !prefixCompilation.parsedScript.ok
            && prefixCompilation.parsedScript.deferUntilFinalSource !== true
          ) {
            await writeCommandUsageError({
              context,
              command: "sed",
              message: `sed: ${prefixCompilation.parsedScript.message}`,
              usageSummary: formatArgvUsageSummary({ presentation: sedArgvHelp }),
            });
            return { exitCode: 1 };
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        await context
          .text()
          .error({ text: `sed: ${scriptFile}: ${message}\n` });
        return { exitCode: 4 };
      }
    }

    const files = [...parsed.positionals];
    if (scripts.length === 0) {
      const expression = files.shift();
      if (expression === undefined) {
        await writeCommandUsageError({
          context,
          command: "sed",
          message: "sed: missing expression",
          usageSummary: formatArgvUsageSummary({ presentation: sedArgvHelp }),
        });
        return { exitCode: 1 };
      }
      scripts.push(expression);
    }

    const { parsedScript, compileEffects } = parseSedScripts({
      scripts,
      syntax,
      characterLocaleMode,
      nullData,
    });
    if (!parsedScript.ok) {
      if (compileEffects.writePaths.length > 0) {
        let partialWriteFiles: SedWriteFileManager;
        try {
          partialWriteFiles = await createWriteFiles({
            paths: compileEffects.writePaths,
          });
          await partialWriteFiles.close();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `sed: ${message}\n` });
          return { exitCode: 4 };
        }
      }
      await writeCommandUsageError({
        context,
        command: "sed",
        message: `sed: ${parsedScript.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: sedArgvHelp }),
      });
      return { exitCode: 1 };
    }
    const lineLengthValue = parsed.optionValues.lineLength;
    const defaultListWidth =
      typeof lineLengthValue === "string"
        ? parseSedLineLengthOption({ value: lineLengthValue })
        : undefined;
    const allCommands = parsedScript.commands.map((command): SedCommand =>
      command.kind === "list" &&
      command.width === undefined &&
      defaultListWidth !== undefined
        ? { ...command, width: defaultListWidth }
        : command,
    );
    const usesFileNameCommand = allCommands.some(
      (command) => command.kind === "fileName",
    );
    const quiet =
      parsed.optionValues.quiet === true ||
      scripts[0]?.startsWith("#n") === true;
    const inPlaceSuffix = (() => {
      let suffix: string | undefined;
      for (const occurrence of parsed.deferred) {
        if (occurrence.semantic.tag !== "in-place") continue;
        switch (occurrence.value.kind) {
        case "none":
          suffix = "";
          break;
        case "inline":
          suffix = occurrence.value.rawValue;
          break;
        case "next-argv":
          throw new Error("sed in-place argv must not claim a following value");
        default: {
          const _ex: never = occurrence.value;
          throw new Error(`Unhandled sed in-place argv value: ${JSON.stringify(_ex)}`);
        }
        }
      }
      return suffix;
    })();
    const inPlace = inPlaceSuffix !== undefined;
    const followSymlinks = parsed.optionValues.followSymlinks === true;
    const separate = parsed.optionValues.separate === true;
    const bufferedStdout = createBufferedCommandDataWriter({
      handle: context.stdout,
      maxBufferLength: unbuffered ? 1 : 16 * 1024,
    });
    const stdoutWriter = createSedOutputWriter({
      writer: bufferedStdout,
      recordTerminator,
      characterLocaleMode,
    });

    let writeFiles: SedWriteFileManager;
    try {
      writeFiles = await createWriteFiles({
        paths: compileEffects.writePaths,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `sed: ${message}\n` });
      return { exitCode: 4 };
    }

    const labelValidation = validateSedLabels({ commands: allCommands });
    if (!labelValidation.ok) {
      try {
        await writeFiles.close();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `sed: ${message}\n` });
        return { exitCode: 4 };
      }
      await context.text().error({
        text: `sed: ${labelValidation.message}
`,
      });
      return { exitCode: 4 };
    }

    if (files.length === 0 && inPlace) {
      try {
        await writeFiles.close();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `sed: ${message}\n` });
        return { exitCode: 4 };
      }
      await context.text().error({ text: "sed: no input files\n" });
      return { exitCode: 4 };
    }

    const finish = async ({
      exitCode,
    }: {
      exitCode: number;
    }): Promise<WeshCommandResult> => {
      await writeFiles.close();
      return { exitCode };
    };

    try {
      if (files.length === 0) {
        const termination = await processSedStream({
          context,
          stream: await openSedInputStream({
            context,
            file: "-",
            unbuffered,
          }),
          sourceName: "-",
          commands: allCommands,
          quiet,
          writer: stdoutWriter,
          shellStdout: context.stdout,
          writeFiles,
          delimiterByte,
          characterLocaleMode,
          unbuffered,
        });
        if (termination === undefined) return await finish({ exitCode: 0 });
        switch (termination.kind) {
        case "quit":
        case "fatal":
          return await finish({ exitCode: termination.exitCode });
        case "interrupted":
          return { exitCode: 0 };
        default: {
          const _ex: never = termination;
          throw new Error(
            `Unhandled sed termination: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
          );
        }
        }
      }

      let exitCode = 0;
      if (!inPlace && !separate) {
        const inputReadState: SedInputReadState = { phase: "cycleStart" };
        const termination = await processSedLines({
          context,
          lines: readSedFiles({
            context,
            files,
            delimiterByte,
            characterLocaleMode,
            unbuffered,
            resolveFile: followSymlinks
              ? async ({ file }) =>
                await resolveSedFollowSymlinkInput({
                  context,
                  file,
                  dashIsStdin: true,
                  resolveSourceName: usesFileNameCommand,
                })
              : undefined,
            onError: async ({ file, issue, phase }) => {
              switch (issue.kind) {
              case "directory":
                switch (phase) {
                case "inCycle":
                  return true;
                case "cycleStart":
                  exitCode = 4;
                  await context.text().error({
                    text: `sed: read error on ${file}: Is a directory\n`,
                  });
                  return false;
                default: {
                  const _ex: never = phase;
                  throw new Error(`Unhandled sed input read phase: ${_ex}`);
                }
                }
              case "readError": {
                exitCode = followSymlinks ? 4 : 2;
                const message =
                  issue.error instanceof Error
                    ? issue.error.message
                    : String(issue.error);
                await context.text().error({
                  text: followSymlinks
                    ? `sed: couldn't follow symlink ${file}: ${message}\n`
                    : `sed: ${file}: ${message}\n`,
                });
                return !followSymlinks;
              }
              default: {
                const _ex: never = issue;
                throw new Error(`Unhandled sed input issue: ${JSON.stringify(_ex)}`);
              }
              }
            },
            inputReadState,
          }),
          inputReadState,
          commands: allCommands,
          quiet,
          writer: stdoutWriter,
          shellStdout: context.stdout,
          writeFiles,
          delimiterByte,
          characterLocaleMode,
          unbuffered,
        });
        const processResult = (() => {
          if (termination === undefined) {
            return { kind: "continue" as const, exitCode: undefined };
          }
          switch (termination.kind) {
          case "quit":
            return { kind: "quit" as const, exitCode: termination.exitCode };
          case "fatal":
            return { kind: "fatal" as const, exitCode: termination.exitCode };
          case "interrupted":
            return { kind: "interrupted" as const, exitCode: undefined };
          default: {
            const _ex: never = termination;
            throw new Error(
              `Unhandled sed termination: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
            );
          }
          }
        })();
        switch (processResult.kind) {
        case "continue":
        case "quit":
          return await finish({
            exitCode: exitCode !== 0 ? exitCode : (processResult.exitCode ?? 0),
          });
        case "fatal":
          return await finish({ exitCode: processResult.exitCode });
        case "interrupted":
          return { exitCode: 0 };
        default: {
          const _ex: never = processResult;
          throw new Error(
            `Unhandled sed process result: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
          );
        }
        }
      }

      const separateFileState: SedSeparateFileState = {
        holdSpaceHadNewline: true,
      };

      if (!inPlace) {
        for (const file of files) {
          try {
            const resolvedInput = followSymlinks
              ? await resolveSedFollowSymlinkInput({
                context,
                file,
                dashIsStdin: true,
                resolveSourceName: usesFileNameCommand,
              })
              : { path: file, sourceName: file };
            if (await isSedInputDirectory({ context, file: resolvedInput.path })) {
              exitCode = 4;
              await context.text().error({
                text: `sed: read error on ${file}: Is a directory\n`,
              });
              break;
            }
            const termination = await processSedStream({
              context,
              stream: await openSedInputStream({
                context,
                file: resolvedInput.path,
                unbuffered,
              }),
              sourceName: resolvedInput.sourceName,
              commands: allCommands,
              quiet,
              writer: stdoutWriter,
              shellStdout: context.stdout,
              writeFiles,
              delimiterByte,
              characterLocaleMode,
              separateFileState,
              unbuffered,
            });
            if (termination !== undefined) {
              switch (termination.kind) {
              case "quit":
                if (exitCode === 0) exitCode = termination.exitCode;
                break;
              case "fatal":
                exitCode = termination.exitCode;
                break;
              case "interrupted":
                return { exitCode: 0 };
              default: {
                const _ex: never = termination;
                throw new Error(`Unhandled sed termination: ${JSON.stringify(_ex)}`);
              }
              }
              break;
            }
          } catch (error: unknown) {
            exitCode = followSymlinks ? 4 : 2;
            const message =
              error instanceof Error ? error.message : String(error);
            await context.text().error({
              text: followSymlinks
                ? `sed: couldn't follow symlink ${file}: ${message}\n`
                : `sed: ${file}: ${message}\n`,
            });
            if (followSymlinks) break;
          }
        }
        await bufferedStdout.flush();
        return await finish({ exitCode });
      }

      inPlaceFileLoop: for (const file of files) {
        if (file === undefined) continue;

        try {
          const lexicalFullPath = file.startsWith("/")
            ? file
            : `${context.cwd}/${file}`;
          let fullPath = lexicalFullPath;
          let sourceName = file;
          if (followSymlinks) {
            try {
              const resolvedInput = await resolveSedFollowSymlinkInput({
                context,
                file,
                dashIsStdin: false,
                resolveSourceName: usesFileNameCommand,
              });
              fullPath = resolvedInput.path;
              sourceName = resolvedInput.sourceName;
            } catch (error: unknown) {
              exitCode = 4;
              const message =
                error instanceof Error ? error.message : String(error);
              await context.text().error({
                text: `sed: couldn't follow symlink ${file}: ${message}\n`,
              });
              break;
            }
          }

          const originalStat = await context.files.stat({ path: fullPath });
          switch (originalStat.type) {
          case "file":
            break;
          case "directory":
          case "fifo":
          case "chardev":
          case "symlink":
            exitCode = 4;
            await context.text().error({
              text: `sed: couldn't edit ${file}: not a regular file
`,
            });
            break;
          default: {
            const _ex: never = originalStat.type;
            throw new Error(`Unhandled sed in-place input type: ${_ex}`);
          }
          }
          if (exitCode === 4) break;

          let temporary: Awaited<ReturnType<typeof createSedTemporaryFile>>;
          try {
            temporary = await createSedTemporaryFile({
              context,
              targetPath: fullPath,
              mode: originalStat.mode,
            });
          } catch (error: unknown) {
            exitCode = 4;
            const message = error instanceof Error ? error.message : String(error);
            await context.text().error({
              text: `sed: couldn't edit ${file}: ${message}
`,
            });
            break;
          }
          let temporaryExists = true;
          try {
            const temporaryWriter = createBufferedCommandDataWriter({
              handle: temporary.handle,
              maxBufferLength: 16 * 1024,
            });
            const sedTemporaryWriter = createSedOutputWriter({
              writer: temporaryWriter,
              recordTerminator,
              characterLocaleMode,
            });
            const termination = await processSedStream({
              context,
              stream: await openSedInputStream({
                context,
                file: followSymlinks ? fullPath : file,
                unbuffered,
              }),
              sourceName,
              commands: allCommands,
              quiet,
              writer: sedTemporaryWriter,
              shellStdout: temporary.handle,
              writeFiles,
              delimiterByte,
              characterLocaleMode,
              separateFileState,
              unbuffered,
            });
            if (termination !== undefined) {
              switch (termination.kind) {
              case "interrupted":
                return { exitCode: 0 };
              case "quit":
              case "fatal":
                break;
              default: {
                const _ex: never = termination;
                throw new Error(
                  `Unhandled sed termination: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
                );
              }
              }
            }
            await temporary.handle.close();

            if (termination !== undefined) {
              switch (termination.kind) {
              case "quit":
                break;
              case "fatal":
                exitCode = termination.exitCode;
                break inPlaceFileLoop;
              default: {
                const _ex: never = termination;
                throw new Error(
                  `Unhandled sed termination: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
                );
              }
              }
            }

            const recoveryPath =
              inPlaceSuffix.length > 0
                ? resolveSedInPlaceRecoveryPath({
                  cwd: context.cwd,
                  file: followSymlinks ? fullPath : file,
                  fullPath,
                  suffix: inPlaceSuffix,
                })
                : `${temporary.path}.original`;
            let originalMoved = false;
            try {
              await context.files.rename({
                oldPath: fullPath,
                newPath: recoveryPath,
              });
              originalMoved = true;
              try {
                await context.files.rename({
                  oldPath: temporary.path,
                  newPath: fullPath,
                });
                temporaryExists = false;
              } catch (replaceError: unknown) {
                try {
                  await context.files.rename({
                    oldPath: recoveryPath,
                    newPath: fullPath,
                  });
                  originalMoved = false;
                } catch (restoreError: unknown) {
                  throw new AggregateError(
                    [replaceError, restoreError],
                    `sed: failed to replace and restore ${fullPath}`,
                  );
                }
                throw replaceError;
              }

              if (inPlaceSuffix.length === 0) {
                await context.files.unlink({ path: recoveryPath });
                originalMoved = false;
              }

              if (termination !== undefined) {
                if (exitCode === 0) exitCode = termination.exitCode;
                break inPlaceFileLoop;
              }
            } catch (error: unknown) {
              if (originalMoved && inPlaceSuffix.length === 0) {
                try {
                  await context.files.rename({
                    oldPath: recoveryPath,
                    newPath: fullPath,
                  });
                } catch {
                  // Preserve the original replacement error.
                }
              }
              exitCode = 4;
              const message = error instanceof Error ? error.message : String(error);
              await context.text().error({
                text: `sed: cannot rename ${file}: ${message}
`,
              });
              break;
            }
          } finally {
            await temporary.handle.close();
            if (temporaryExists) {
              try {
                await context.files.unlink({ path: temporary.path });
              } catch {
                // Preserve the original sed error when temporary cleanup fails.
              }
            }
          }
        } catch (error: unknown) {
          exitCode = 2;
          const message =
            error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `sed: ${file}: ${message}\n` });
        }
      }

      await bufferedStdout.flush();

      return await finish({ exitCode });
    } catch (error: unknown) {
      await writeFiles.abort({ reason: error });
      throw error;
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
