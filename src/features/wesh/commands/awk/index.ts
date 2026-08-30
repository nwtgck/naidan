import { parseStandardArgv } from '@/features/wesh/argv';
import type { ArgvOptionOccurrence, StandardArgvParserSpec } from '@/features/wesh/argv';
import { createBufferedCommandDataWriter, decodeCommandDataBytes, encodeCommandDataText } from '@/features/wesh/commands/_shared/data-codec';
import { splitByPosixLeftmostLongestMatches } from '@/features/wesh/commands/_shared/posix-regexp';
import { compileAwkRegularExpression } from '@/features/wesh/commands/awk/regexp';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit, stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import { parseAwkProgram } from '@/features/wesh/commands/awk/parser';
import { createAwkRuntime, executeAwkBegin, executeAwkEnd, executeAwkRecord, flushAwkRuntimeCommandPipes, flushAwkRuntimeIo, getAwkRuntimeArrayEntryAsString, getAwkRuntimeVariableAsString, isAwkFunctionExitControl } from '@/features/wesh/commands/awk/runtime';
import type { AwkValue } from '@/features/wesh/commands/awk/types';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { openHandleReadStream, openFileReadStream, readAllFileBytes, readAllHandleBytes, writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { createReadHandleFromStream, createWriteHandleFromStream, iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { iterateByteRecordEntries } from '@/features/wesh/utils/text-records';

const awkArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
    {
      kind: 'value',
      short: 'F',
      long: undefined,
      key: 'fieldSeparator',
      valueName: 'fs',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'use FS for the input field separator', valueName: 'FS', category: 'common' },
    },
    {
      kind: 'value',
      short: 'f',
      long: undefined,
      key: 'programFile',
      valueName: 'file',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'read the awk program from FILE', valueName: 'FILE', category: 'common' },
    },
    {
      kind: 'value',
      short: 'v',
      long: undefined,
      key: 'assignment',
      valueName: 'var=value',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'assign VALUE to VAR before program execution', valueName: 'VAR=VALUE', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isValueOccurrenceForKey(
  occurrence: ArgvOptionOccurrence,
  key: string,
): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> {
  return occurrence.kind === 'value' && occurrence.key === key;
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

async function openAwkInputStream({
  context,
  input,
}: {
  context: WeshCommandContext,
  input: string,
}): Promise<ReadableStream<Uint8Array>> {
  if (input === '-') {
    return openHandleReadStream({ handle: context.stdin });
  }

  return await openFileReadStream({
    files: context.files,
    path: resolvePath({ cwd: context.cwd, path: input }),
  });
}

async function readAllStreamBytes({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function *readSingleCharacterSeparatedAwkRecords({
  stream,
  recordSeparator,
}: {
  stream: ReadableStream<Uint8Array>;
  recordSeparator: string;
}): AsyncGenerator<{ text: string; fields: string[]; hadNewline: boolean }> {
  const separatorBytes = encodeCommandDataText({ text: recordSeparator });
  if (separatorBytes.byteLength === 1) {
    for await (const record of iterateByteRecordEntries({
      chunks: iterateReadableStreamChunks({ stream }),
      delimiterByte: separatorBytes[0]!,
    })) {
      yield {
        text: decodeCommandDataBytes({ bytes: record.bytes }),
        fields: [],
        hadNewline: record.termination === 'delimiter',
      };
    }
    return;
  }

  const input = decodeCommandDataBytes({ bytes: await readAllStreamBytes({ stream }) });
  let recordStart = 0;
  let separatorIndex = input.indexOf(recordSeparator, recordStart);
  while (separatorIndex >= 0) {
    yield {
      text: input.slice(recordStart, separatorIndex),
      fields: [],
      hadNewline: true,
    };
    recordStart = separatorIndex + recordSeparator.length;
    separatorIndex = input.indexOf(recordSeparator, recordStart);
  }
  if (recordStart < input.length) {
    yield { text: input.slice(recordStart), fields: [], hadNewline: false };
  }
}

async function *readAwkRecords({
  stream,
  recordSeparator,
}: {
  stream: ReadableStream<Uint8Array>;
  recordSeparator: string;
}): AsyncGenerator<{ text: string; fields: string[]; hadNewline: boolean }> {
  if (recordSeparator !== '\n') {
    if (recordSeparator.length === 1) {
      yield *readSingleCharacterSeparatedAwkRecords({ stream, recordSeparator });
      return;
    }

    const input = decodeCommandDataBytes({ bytes: await readAllStreamBytes({ stream }) });
    if (recordSeparator === '') {
      const records = input
        .replace(/^(?:[ \t]*\r?\n)+/, '')
        .replace(/(?:\r?\n[ \t]*)+$/, '')
        .split(/\r?\n(?:[ \t]*\r?\n)+/);
      if (records.at(-1) === '') records.pop();
      for (const record of records) {
        yield {
          text: record,
          fields: [],
          hadNewline: true,
        };
      }
      return;
    }

    const parts = splitByPosixLeftmostLongestMatches({
      regex: compileAwkRegularExpression({
        source: recordSeparator,
        flags: '',
      }),
      source: input,
    });
    for (const part of parts) {
      if (part.text === '' && !part.terminatedByMatch) continue;
      yield {
        text: part.text,
        fields: [],
        hadNewline: part.terminatedByMatch,
      };
    }
    return;
  }

  for await (const record of iterateByteRecordEntries({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte: 0x0a,
  })) {
    yield {
      text: decodeCommandDataBytes({ bytes: record.bytes }),
      fields: [],
      hadNewline: record.termination === 'delimiter',
    };
  }
}

function createTextReadHandle({ text }: { text: string }) {
  return createReadHandleFromStream({
    source: new ReadableStream<Uint8Array>({
      start(controller) {
        if (text.length > 0) controller.enqueue(encodeCommandDataText({ text }));
        controller.close();
      },
    }),
  });
}

function createTextCaptureHandle() {
  const chunks: Uint8Array[] = [];
  const handle = createWriteHandleFromStream({
    target: new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      },
    }),
  });
  return {
    handle,
    readText(): string {
      const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return decodeCommandDataBytes({ bytes });
    },
  };
}

function decodeAwkAssignmentSingleCharacterEscape({
  escaped,
}: {
  escaped: string,
}): string | undefined {
  switch (escaped) {
  case 'a': return '\u0007';
  case 'b': return '\b';
  case 'f': return '\f';
  case 'n': return '\n';
  case 'r': return '\r';
  case 't': return '\t';
  case 'v': return '\v';
  case '\\': return '\\';
  case '"': return '"';
  default: return undefined;
  }
}

function decodeAwkAssignmentEscapes({
  value,
}: {
  value: string,
}): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!;
    if (current !== '\\' || index + 1 >= value.length) {
      result += current;
      continue;
    }

    const escaped = value[index + 1]!;
    const decodedCharacter = decodeAwkAssignmentSingleCharacterEscape({ escaped });
    if (decodedCharacter !== undefined) {
      result += decodedCharacter;
      index += 1;
      continue;
    }

    if (/^[0-7]$/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3) {
        const next = value[index + 1 + digits.length];
        if (next === undefined || !/^[0-7]$/.test(next)) break;
        digits += next;
      }
      result += String.fromCodePoint(Number.parseInt(digits, 8) & 0xff);
      index += digits.length;
      continue;
    }

    if (escaped === 'x') {
      let digits = '';
      while (digits.length < 2) {
        const next = value[index + 2 + digits.length];
        if (next === undefined || !/^[0-9A-Fa-f]$/.test(next)) break;
        digits += next;
      }
      if (digits.length > 0) {
        result += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 1 + digits.length;
        continue;
      }
    }

    result += `\\${escaped}`;
    index += 1;
  }
  return result;
}

function parseAssignment({
  raw,
}: {
  raw: string,
}): { ok: true, name: string, value: AwkValue } | { ok: false, message: string } {
  const equalsIndex = raw.indexOf('=');
  if (equalsIndex <= 0) {
    return { ok: false, message: `awk: invalid assignment '${raw}'` };
  }

  const name = raw.slice(0, equalsIndex);
  const value = decodeAwkAssignmentEscapes({ value: raw.slice(equalsIndex + 1) });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, message: `awk: invalid variable name '${name}'` };
  }

  return { ok: true, name, value };
}

export const awkCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const optionStoppedArgs = stopStandardOptionParsingAtFirstPositional({
      args: context.args,
      spec: awkArgvSpec,
    });
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: optionStoppedArgs,
        spec: awkArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: awkArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'awk',
        message: `awk: ${diagnostic.message}`,
        argvSpec: awkArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'awk',
        argvSpec: awkArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const outputWriter = createBufferedCommandDataWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    const runtimeVariables = new Map<string, AwkValue>();
    if (typeof parsed.optionValues.fieldSeparator === 'string') {
      runtimeVariables.set('FS', decodeAwkAssignmentEscapes({
        value: parsed.optionValues.fieldSeparator,
      }));
    }

    const assignments = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> =>
        isValueOccurrenceForKey(occurrence, 'assignment'))
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');

    for (const assignment of assignments) {
      const parsedAssignment = parseAssignment({ raw: assignment });
      if (!parsedAssignment.ok) {
        await writeCommandUsageError({
          context,
          command: 'awk',
          message: parsedAssignment.message,
          argvSpec: awkArgvSpec,
        });
        return { exitCode: 2 };
      }

      runtimeVariables.set(parsedAssignment.name, parsedAssignment.value);
    }

    const programFiles = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> =>
        isValueOccurrenceForKey(occurrence, 'programFile'))
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');

    const positionals = [...parsed.positionals];
    let script = '';
    if (programFiles.length > 0) {
      const fragments: string[] = [];
      for (const programFile of programFiles) {
        try {
          const bytes = programFile === '-'
            ? await readAllHandleBytes({ handle: context.stdin })
            : await readAllFileBytes({
              files: context.files,
              path: resolvePath({ cwd: context.cwd, path: programFile }),
            });
          fragments.push(decodeCommandDataBytes({ bytes }));
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await text.error({ text: `awk: ${programFile}: ${message}\n` });
          return { exitCode: 2 };
        }
      }
      script = fragments.join('\n');
    } else {
      const inlineProgram = positionals.shift();
      if (inlineProgram === undefined) {
        await writeCommandUsageError({
          context,
          command: 'awk',
          message: 'awk: missing program source',
          argvSpec: awkArgvSpec,
        });
        return { exitCode: 1 };
      }
      script = inlineProgram;
    }

    const parsedProgram = parseAwkProgram({ script });
    if (!parsedProgram.ok) {
      await text.error({ text: `awk: ${parsedProgram.message}\n` });
      return { exitCode: 2 };
    }

    const operands: Array<{
      argvIndex: number | undefined,
      raw: string,
    }> = positionals.map((raw, index) => ({
      argvIndex: index + 1,
      raw,
    }));
    if (!positionals.some((raw) => !parseAssignment({ raw }).ok)) {
      operands.push({ argvIndex: undefined, raw: '-' });
    }

    const argvEntries = new Map<string, AwkValue>([
      ['0', 'awk'],
      ...positionals.map((value, index): [string, AwkValue] => [String(index + 1), value]),
    ]);
    runtimeVariables.set('ARGC', positionals.length + 1);

    type InputRecord = {
      text: string,
      fields: string[],
      hadNewline: boolean,
    };
    type InputRecordIterator = AsyncIterator<InputRecord>;
    type CommandInput = {
      iterator: InputRecordIterator,
      exitCode: number,
    };

    let nextOperandIndex = 0;
    let currentInputIterator: InputRecordIterator | undefined;
    const fileInputIterators = new Map<string, InputRecordIterator>();
    const commandInputs = new Map<string, CommandInput>();

    const createInputIterator = async ({
      input,
    }: {
      input: string,
    }): Promise<InputRecordIterator> => {
      const stream = await openAwkInputStream({ context, input });
      return readAwkRecords({
        stream,
        recordSeparator: getAwkRuntimeVariableAsString({
          runtime,
          name: 'RS',
        }),
      })[Symbol.asyncIterator]();
    };

    const readCurrentInput = async (): Promise<{
      status: -1 | 0 | 1,
      record: InputRecord | undefined,
    }> => {
      while (true) {
        if (currentInputIterator !== undefined) {
          const next = await currentInputIterator.next();
          if (!next.done) return { status: 1, record: next.value };
          currentInputIterator = undefined;
        }

        const operand = operands[nextOperandIndex];
        nextOperandIndex += 1;
        if (operand === undefined) return { status: 0, record: undefined };

        const currentOperand = operand.argvIndex === undefined
          ? operand.raw
          : getAwkRuntimeArrayEntryAsString({
            runtime,
            arrayName: 'ARGV',
            index: String(operand.argvIndex),
          });
        if (currentOperand === undefined || currentOperand === '') continue;

        const assignment = parseAssignment({ raw: currentOperand });
        if (assignment.ok) {
          runtime.variables.set(assignment.name, assignment.value);
          continue;
        }

        runtime.fnr = 0;
        runtime.filename = currentOperand;
        try {
          currentInputIterator = await createInputIterator({ input: currentOperand });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`awk: ${currentOperand}: ${message}`);
        }
      }
    };

    const readFileInput = async ({
      path: inputPath,
    }: {
      path: string,
    }): Promise<{
      status: -1 | 0 | 1,
      record: InputRecord | undefined,
    }> => {
      let iterator = fileInputIterators.get(inputPath);
      if (iterator === undefined) {
        try {
          iterator = await createInputIterator({ input: inputPath });
        } catch {
          return { status: -1, record: undefined };
        }
        fileInputIterators.set(inputPath, iterator);
      }

      const next = await iterator.next();
      return next.done
        ? { status: 0, record: undefined }
        : { status: 1, record: next.value };
    };

    const readCommandInput = async ({
      command,
    }: {
      command: string,
    }): Promise<{
      status: -1 | 0 | 1,
      record: InputRecord | undefined,
    }> => {
      let commandInput = commandInputs.get(command);
      if (commandInput === undefined) {
        const capture = createTextCaptureHandle();
        let exitCode: number;
        try {
          const result = await context.executeShell({
            script: command,
            stdin: context.stdin,
            stdout: capture.handle,
            stderr: context.stderr,
          });
          exitCode = result.exitCode;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('Command not found:')) {
            await text.error({ text: `${message}\n` });
            exitCode = 127;
          } else {
            throw error;
          }
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const output = capture.readText();
            if (output.length > 0) controller.enqueue(encodeCommandDataText({ text: output }));
            controller.close();
          },
        });
        commandInput = {
          iterator: readAwkRecords({
            stream,
            recordSeparator: getAwkRuntimeVariableAsString({ runtime, name: 'RS' }),
          })[Symbol.asyncIterator](),
          exitCode,
        };
        commandInputs.set(command, commandInput);
      }

      const next = await commandInput.iterator.next();
      return next.done
        ? { status: 0, record: undefined }
        : { status: 1, record: next.value };
    };

    const closeInput = async ({ path: inputPath }: { path: string }): Promise<number | undefined> => {
      const fileIterator = fileInputIterators.get(inputPath);
      const commandInput = commandInputs.get(inputPath);
      fileInputIterators.delete(inputPath);
      commandInputs.delete(inputPath);
      await fileIterator?.return?.();
      await commandInput?.iterator.return?.();
      if (commandInput !== undefined) return commandInput.exitCode;
      return fileIterator === undefined ? undefined : 0;
    };

    const skipCurrentInput = async (): Promise<void> => {
      const iterator = currentInputIterator;
      currentInputIterator = undefined;
      await iterator?.return?.();
    };

    const runtime = createAwkRuntime({
      variables: runtimeVariables,
      arrays: new Map([
        ['ARGV', argvEntries],
        ['ENVIRON', new Map<string, AwkValue>(context.env)],
      ]),
      functions: parsedProgram.program.functions,
      readCurrentInput,
      readFileInput,
      readCommandInput,
      closeInput,
      flushOutput: async ({ output: pendingOutput }) => {
        for (const fragment of pendingOutput.splice(0, pendingOutput.length)) {
          await outputWriter.write({ text: fragment });
        }
        await outputWriter.flush();
      },
      executeSystem: async ({ script: systemScript, output: pendingOutput }) => {
        for (const fragment of pendingOutput) {
          await outputWriter.write({ text: fragment });
        }
        await outputWriter.flush();
        try {
          const result = await context.executeShell({
            script: systemScript,
            stdin: context.stdin,
            stdout: context.stdout,
            stderr: context.stderr,
          });
          return result.exitCode;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.startsWith('Command not found:')) throw error;
          await text.error({ text: `${message}\n` });
          return 127;
        }
      },
      executeOutputPipe: async ({ command, input }) => {
        const capture = createTextCaptureHandle();
        try {
          const result = await context.executeShell({
            script: command,
            stdin: createTextReadHandle({ text: input }),
            stdout: capture.handle,
            stderr: context.stderr,
          });
          return { exitCode: result.exitCode, output: capture.readText() };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.startsWith('Command not found:')) throw error;
          await text.error({ text: `${message}\n` });
          return { exitCode: 127, output: capture.readText() };
        }
      },
      writeRedirect: async ({ path, mode, text: redirectedText }) => {
        const flags = (() => {
          switch (mode) {
          case 'truncate':
            return { truncate: 'truncate', append: 'preserve' } as const;
          case 'append':
            return { truncate: 'preserve', append: 'append' } as const;
          default: {
            const _ex: never = mode;
            throw new Error(`Unhandled awk redirection mode: ${_ex}`);
          }
          }
        })();
        const handle = await context.files.open({
          path: resolvePath({ cwd: context.cwd, path }),
          flags: {
            access: 'write',
            creation: 'if-needed',
            ...flags,
          },
        });
        try {
          await writeAllBytesToHandle({
            handle,
            data: encodeCommandDataText({ text: redirectedText }),
          });
        } finally {
          await handle.close();
        }
      },
    });
    try {
      const output: string[] = [];
      try {
        await executeAwkBegin({
          program: parsedProgram.program,
          runtime,
          output,
        });
      } catch (error: unknown) {
        if (!isAwkFunctionExitControl({ error })) throw error;
      }
      await flushAwkRuntimeIo({ runtime });

      for (const fragment of output) {
        await outputWriter.write({ text: fragment });
      }

      const shouldReadRecordInput = parsedProgram.program.rules.some(
        rule => rule.pattern.kind !== 'begin',
      );
      while (shouldReadRecordInput && runtime.exitCode === undefined) {
        const next = await readCurrentInput();
        if (next.status === 0 || next.record === undefined) break;
        if (next.status === -1) {
          return { exitCode: 2 };
        }

        const recordOutput: string[] = [];
        try {
          await executeAwkRecord({
            program: parsedProgram.program,
            runtime,
            record: next.record,
            output: recordOutput,
          });
        } catch (error: unknown) {
          if (!isAwkFunctionExitControl({ error })) throw error;
        }
        await flushAwkRuntimeIo({ runtime });

        for (const fragment of recordOutput) {
          await outputWriter.write({ text: fragment });
        }

        if (runtime.nextFileRequested) {
          runtime.nextFileRequested = false;
          await skipCurrentInput();
        }
      }

      const endOutput: string[] = [];
      try {
        await executeAwkEnd({
          program: parsedProgram.program,
          runtime,
          output: endOutput,
        });
      } catch (error: unknown) {
        if (!isAwkFunctionExitControl({ error })) throw error;
      }
      await flushAwkRuntimeCommandPipes({ runtime });
      await flushAwkRuntimeIo({ runtime });
      for (const fragment of endOutput) {
        await outputWriter.write({ text: fragment });
      }
      await outputWriter.flush();
    } catch (error: unknown) {
      await outputWriter.flush();
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `${message}\n` });
      return { exitCode: 2 };
    }

    return { exitCode: runtime.exitCode ?? 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
