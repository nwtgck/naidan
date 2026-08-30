import packageJson from '../../../../../package.json';
import {
  parseStandardArgv,
  type ParsedStandardArgv,
  type StandardArgvParserSpec,
} from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
} from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import {
  escapeChecksumFileName,
  iterateChecksumLines,
  parseChecksumRecord,
} from './checksum-record';
import { createSha256Hasher } from './sha256';

const COMMAND_NAME = 'sha256sum';
const HASH_ALGORITHM_NAME = 'SHA256';
const OUTPUT_BUFFER_LENGTH = 16 * 1024;

type OperationMode = 'check' | 'compute';
type InputMode = 'binary' | 'text';
type OutputFormat = 'bsd' | 'gnu';
type RecordTerminator = 'newline' | 'nul';
type CheckResultStatus = 'FAILED' | 'FAILED open or read' | 'OK';
type CheckOutputMode = 'normal' | 'quiet' | 'status' | 'warn';

interface CheckOptions {
  ignoreMissing: 'disabled' | 'enabled',
  outputMode: CheckOutputMode,
  strict: 'disabled' | 'enabled',
}

interface VerificationCounts {
  formattedRecords: number,
  ignoredMissingFiles: number,
  malformedLines: number,
  mismatchedFiles: number,
  unreadableFiles: number,
  verifiedFiles: number,
}

const sha256sumArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'b',
      long: 'binary',
      effects: [{ key: 'inputMode', value: 'binary' }],
      help: { summary: 'read in binary mode', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'c',
      long: 'check',
      effects: [{ key: 'operationMode', value: 'check' }],
      help: { summary: 'read checksums from files and check them', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'tag',
      effects: [
        { key: 'outputFormat', value: 'bsd' },
        { key: 'inputMode', value: 'binary' },
      ],
      help: { summary: 'create a BSD-style checksum', category: 'common' },
    },
    {
      kind: 'flag',
      short: 't',
      long: 'text',
      effects: [{ key: 'inputMode', value: 'text' }],
      help: { summary: 'read in text mode (default)', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'z',
      long: 'zero',
      effects: [{ key: 'recordTerminator', value: 'nul' }],
      help: { summary: 'end each output line with NUL and disable file name escaping', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'ignore-missing',
      effects: [{ key: 'ignoreMissing', value: true }],
      help: { summary: "don't fail or report status for missing files", category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'quiet',
      effects: [{ key: 'checkOutputMode', value: 'quiet' }],
      help: { summary: "don't print OK for each successfully verified file", category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'status',
      effects: [{ key: 'checkOutputMode', value: 'status' }],
      help: { summary: "don't output anything; status code shows success", category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'strict',
      effects: [{ key: 'strict', value: true }],
      help: { summary: 'exit non-zero for improperly formatted checksum lines', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 'w',
      long: 'warn',
      effects: [{ key: 'checkOutputMode', value: 'warn' }],
      help: { summary: 'warn about improperly formatted checksum lines', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'version',
      effects: [{ key: 'version', value: true }],
      help: { summary: 'output version information and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function getBooleanOption({
  parsed,
  key,
}: {
  parsed: ParsedStandardArgv,
  key: string,
}): 'disabled' | 'enabled' {
  return parsed.optionValues[key] === true ? 'enabled' : 'disabled';
}

function isToggleEnabled({
  value,
}: {
  value: 'disabled' | 'enabled',
}): boolean {
  switch (value) {
  case 'disabled':
    return false;
  case 'enabled':
    return true;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled toggle state: ${_ex}`);
  }
  }
}

function getParsedCheckOutputMode({
  parsed,
}: {
  parsed: ParsedStandardArgv,
}): CheckOutputMode {
  const value = parsed.optionValues.checkOutputMode;
  if (value === 'quiet') {
    return 'quiet';
  }
  if (value === 'status') {
    return 'status';
  }
  if (value === 'warn') {
    return 'warn';
  }
  return 'normal';
}

function getArgumentsThroughFirstEarlyExit({
  args,
}: {
  args: string[],
}): string[] {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      break;
    }
    if (argument === '--help' || argument === '--version') {
      return args.slice(0, index + 1);
    }
  }
  return args;
}

function shouldWriteMalformedLineWarning({
  outputMode,
}: {
  outputMode: CheckOutputMode,
}): boolean {
  switch (outputMode) {
  case 'normal':
  case 'quiet':
  case 'status':
    return false;
  case 'warn':
    return true;
  default: {
    const _ex: never = outputMode;
    throw new Error(`Unhandled check output mode: ${_ex}`);
  }
  }
}

function shouldWriteCheckResult({
  outputMode,
  status,
}: {
  outputMode: CheckOutputMode,
  status: CheckResultStatus,
}): boolean {
  switch (outputMode) {
  case 'normal':
  case 'warn':
    return true;
  case 'quiet':
    switch (status) {
    case 'FAILED':
    case 'FAILED open or read':
      return true;
    case 'OK':
      return false;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled check result status: ${_ex}`);
    }
    }
  case 'status':
    return false;
  default: {
    const _ex: never = outputMode;
    throw new Error(`Unhandled check output mode: ${_ex}`);
  }
  }
}

function shouldWriteCheckSummaries({
  outputMode,
}: {
  outputMode: CheckOutputMode,
}): boolean {
  switch (outputMode) {
  case 'normal':
  case 'quiet':
  case 'warn':
    return true;
  case 'status':
    return false;
  default: {
    const _ex: never = outputMode;
    throw new Error(`Unhandled check output mode: ${_ex}`);
  }
  }
}

function getRecordTerminator({
  recordTerminator,
}: {
  recordTerminator: RecordTerminator,
}): string {
  switch (recordTerminator) {
  case 'newline':
    return '\n';
  case 'nul':
    return '\0';
  default: {
    const _ex: never = recordTerminator;
    throw new Error(`Unhandled record terminator: ${_ex}`);
  }
  }
}

function getOutputFileName({
  input,
  recordTerminator,
}: {
  input: string,
  recordTerminator: RecordTerminator,
}): ReturnType<typeof escapeChecksumFileName> {
  switch (recordTerminator) {
  case 'newline':
    return escapeChecksumFileName({ fileName: input });
  case 'nul':
    return { escaped: 'plain', value: input };
  default: {
    const _ex: never = recordTerminator;
    throw new Error(`Unhandled record terminator: ${_ex}`);
  }
  }
}

function getEscapePrefix({
  escaped,
}: {
  escaped: 'escaped' | 'plain',
}): string {
  switch (escaped) {
  case 'escaped':
    return '\\';
  case 'plain':
    return '';
  default: {
    const _ex: never = escaped;
    throw new Error(`Unhandled escape mode: ${_ex}`);
  }
  }
}

function getInputModeMarker({
  inputMode,
}: {
  inputMode: InputMode,
}): string {
  switch (inputMode) {
  case 'binary':
    return '*';
  case 'text':
    return ' ';
  default: {
    const _ex: never = inputMode;
    throw new Error(`Unhandled input mode: ${_ex}`);
  }
  }
}

function getParsedInputMode({
  parsed,
}: {
  parsed: ParsedStandardArgv,
}): InputMode {
  return parsed.optionValues.inputMode === 'binary' ? 'binary' : 'text';
}

function getParsedOutputFormat({
  parsed,
}: {
  parsed: ParsedStandardArgv,
}): OutputFormat {
  return parsed.optionValues.outputFormat === 'bsd' ? 'bsd' : 'gnu';
}

function wasOptionKeySpecified({
  parsed,
  key,
}: {
  parsed: ParsedStandardArgv,
  key: string,
}): boolean {
  return parsed.occurrences.some(occurrence => {
    switch (occurrence.kind) {
    case 'flag':
    case 'special':
      return occurrence.effects.some(effect => effect.key === key);
    case 'value':
      return occurrence.key === key;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled option occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  });
}

function describeInput({ input }: { input: string }): string {
  return input === '-' ? "'standard input'" : input;
}

function getErrorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingInputError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'NotFoundError') {
    return true;
  }
  return /(?:no such file|not found|does not exist)/iu.test(error.message);
}

async function hashInput({
  context,
  input,
}: {
  context: WeshCommandContext,
  input: string,
}): Promise<string> {
  const hasher = createSha256Hasher();
  const stream = await openCommandInputStream({ context, input });
  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    hasher.update({ bytes: chunk });
  }
  return hasher.digestHex();
}

function formatChecksumRecord({
  hash,
  input,
  inputMode,
  outputFormat,
  recordTerminator,
}: {
  hash: string,
  input: string,
  inputMode: InputMode,
  outputFormat: OutputFormat,
  recordTerminator: RecordTerminator,
}): string {
  const terminator = getRecordTerminator({ recordTerminator });
  const fileName = getOutputFileName({ input, recordTerminator });
  const prefix = getEscapePrefix({ escaped: fileName.escaped });

  switch (outputFormat) {
  case 'gnu':
    return `${prefix}${hash} ${getInputModeMarker({ inputMode })}${fileName.value}${terminator}`;
  case 'bsd':
    return `${prefix}${HASH_ALGORITHM_NAME} (${fileName.value}) = ${hash}${terminator}`;
  default: {
    const _ex: never = outputFormat;
    throw new Error(`Unhandled output format: ${_ex}`);
  }
  }
}

function formatCheckResult({
  fileName,
  status,
}: {
  fileName: string,
  status: CheckResultStatus,
}): string {
  const escapedFileName = escapeChecksumFileName({ fileName });
  const prefix = getEscapePrefix({ escaped: escapedFileName.escaped });
  return `${prefix}${escapedFileName.value}: ${status}\n`;
}

async function writeUsageFailure({
  context,
  message,
}: {
  context: WeshCommandContext,
  message: string,
}): Promise<void> {
  await context.text().error({
    text: `${COMMAND_NAME}: ${message}\nTry '${COMMAND_NAME} --help' for more information.\n`,
  });
}

async function validateOptionCombinations({
  context,
  parsed,
  operationMode,
}: {
  context: WeshCommandContext,
  parsed: ParsedStandardArgv,
  operationMode: OperationMode,
}): Promise<'invalid' | 'valid'> {
  switch (operationMode) {
  case 'check':
    if (parsed.optionValues.recordTerminator === 'nul') {
      await writeUsageFailure({
        context,
        message: 'the --zero option is not supported when verifying checksums',
      });
      return 'invalid';
    }
    if (parsed.optionValues.outputFormat === 'bsd') {
      await writeUsageFailure({
        context,
        message: 'the --tag option is meaningless when verifying checksums',
      });
      return 'invalid';
    }
    if (wasOptionKeySpecified({ parsed, key: 'inputMode' })) {
      await writeUsageFailure({
        context,
        message: 'the --binary and --text options are meaningless when verifying checksums',
      });
      return 'invalid';
    }
    return 'valid';
  case 'compute': {
    const outputFormat = getParsedOutputFormat({ parsed });
    switch (outputFormat) {
    case 'bsd':
      if (wasOptionKeySpecified({ parsed, key: 'inputMode' })) {
        const inputMode = getParsedInputMode({ parsed });
        switch (inputMode) {
        case 'binary':
          break;
        case 'text':
          await writeUsageFailure({
            context,
            message: '--tag does not support --text mode',
          });
          return 'invalid';
        default: {
          const _ex: never = inputMode;
          throw new Error(`Unhandled input mode: ${_ex}`);
        }
        }
      }
      break;
    case 'gnu':
      break;
    default: {
      const _ex: never = outputFormat;
      throw new Error(`Unhandled output format: ${_ex}`);
    }
    }

    for (const occurrence of parsed.occurrences) {
      switch (occurrence.kind) {
      case 'flag':
      case 'special': {
        for (const effect of occurrence.effects) {
          let optionName: string | undefined;
          if (effect.key === 'ignoreMissing') {
            optionName = '--ignore-missing';
          } else if (effect.key === 'strict') {
            optionName = '--strict';
          } else if (effect.key === 'checkOutputMode') {
            if (effect.value === 'quiet') {
              optionName = '--quiet';
            } else if (effect.value === 'status') {
              optionName = '--status';
            } else if (effect.value === 'warn') {
              optionName = '--warn';
            }
          }
          if (optionName !== undefined) {
            await writeUsageFailure({
              context,
              message: `the ${optionName} option is meaningful only when verifying checksums`,
            });
            return 'invalid';
          }
        }
        break;
      }
      case 'value':
        break;
      default: {
        const _ex: never = occurrence;
        throw new Error(`Unhandled option occurrence: ${JSON.stringify(_ex)}`);
      }
      }
    }
    return 'valid';
  }
  default: {
    const _ex: never = operationMode;
    throw new Error(`Unhandled operation mode: ${_ex}`);
  }
  }
}

async function runComputeMode({
  context,
  inputs,
  inputMode,
  outputFormat,
  recordTerminator,
}: {
  context: WeshCommandContext,
  inputs: string[],
  inputMode: InputMode,
  outputFormat: OutputFormat,
  recordTerminator: RecordTerminator,
}): Promise<WeshCommandResult> {
  const writer = createBufferedTextWriter({
    handle: context.stdout,
    maxBufferLength: OUTPUT_BUFFER_LENGTH,
  });
  let exitCode = 0;

  try {
    for (const input of inputs) {
      try {
        const hash = await hashInput({ context, input });
        await writer.write({
          text: formatChecksumRecord({
            hash,
            input,
            inputMode,
            outputFormat,
            recordTerminator,
          }),
        });
      } catch (error: unknown) {
        await context.text().error({
          text: `${COMMAND_NAME}: ${describeInput({ input })}: ${getErrorMessage({ error })}\n`,
        });
        exitCode = 1;
      }
    }
  } finally {
    await writer.flush();
  }

  return { exitCode };
}

function createVerificationCounts(): VerificationCounts {
  return {
    formattedRecords: 0,
    ignoredMissingFiles: 0,
    malformedLines: 0,
    mismatchedFiles: 0,
    unreadableFiles: 0,
    verifiedFiles: 0,
  };
}

function formatMalformedWarning({ count }: { count: number }): string {
  return count === 1
    ? `${COMMAND_NAME}: WARNING: 1 line is improperly formatted\n`
    : `${COMMAND_NAME}: WARNING: ${count} lines are improperly formatted\n`;
}

function formatMismatchWarning({ count }: { count: number }): string {
  return count === 1
    ? `${COMMAND_NAME}: WARNING: 1 computed checksum did NOT match\n`
    : `${COMMAND_NAME}: WARNING: ${count} computed checksums did NOT match\n`;
}

function formatUnreadableWarning({ count }: { count: number }): string {
  return count === 1
    ? `${COMMAND_NAME}: WARNING: 1 listed file could not be read\n`
    : `${COMMAND_NAME}: WARNING: ${count} listed files could not be read\n`;
}

async function writeMalformedLineWarning({
  context,
  source,
  lineNumber,
}: {
  context: WeshCommandContext,
  source: string,
  lineNumber: number,
}): Promise<void> {
  await context.text().error({
    text: `${COMMAND_NAME}: ${describeInput({ input: source })}: ${lineNumber}: improperly formatted ${HASH_ALGORITHM_NAME} checksum line\n`,
  });
}

async function verifyChecksumSource({
  context,
  source,
  options,
  writer,
}: {
  context: WeshCommandContext,
  source: string,
  options: CheckOptions,
  writer: ReturnType<typeof createBufferedTextWriter>,
}): Promise<'failed' | 'passed'> {
  const counts = createVerificationCounts();
  let sourceReadFailed = false;

  try {
    const stream = await openCommandInputStream({ context, input: source });
    for await (const line of iterateChecksumLines({ stream })) {
      const parsedRecord = line.text === undefined
        ? { kind: 'malformed' as const }
        : parseChecksumRecord({ text: line.text });

      switch (parsedRecord.kind) {
      case 'ignored':
        continue;
      case 'malformed':
        counts.malformedLines += 1;
        if (shouldWriteMalformedLineWarning({ outputMode: options.outputMode })) {
          await writeMalformedLineWarning({
            context,
            source,
            lineNumber: line.lineNumber,
          });
        }
        continue;
      case 'record':
        break;
      default: {
        const _ex: never = parsedRecord;
        throw new Error(`Unhandled checksum record result: ${JSON.stringify(_ex)}`);
      }
      }

      if (source === '-' && parsedRecord.record.fileName === '-') {
        counts.malformedLines += 1;
        if (shouldWriteMalformedLineWarning({ outputMode: options.outputMode })) {
          await writeMalformedLineWarning({
            context,
            source,
            lineNumber: line.lineNumber,
          });
        }
        continue;
      }

      counts.formattedRecords += 1;
      let actualHash: string;
      try {
        actualHash = await hashInput({
          context,
          input: parsedRecord.record.fileName,
        });
      } catch (error: unknown) {
        if (
          isToggleEnabled({ value: options.ignoreMissing })
          && isMissingInputError({ error })
        ) {
          counts.ignoredMissingFiles += 1;
          continue;
        }

        counts.unreadableFiles += 1;
        if (shouldWriteCheckResult({
          outputMode: options.outputMode,
          status: 'FAILED open or read',
        })) {
          await writer.write({
            text: formatCheckResult({
              fileName: parsedRecord.record.fileName,
              status: 'FAILED open or read',
            }),
          });
        }
        await context.text().error({
          text: `${COMMAND_NAME}: ${parsedRecord.record.fileName}: ${getErrorMessage({ error })}\n`,
        });
        continue;
      }

      counts.verifiedFiles += 1;
      if (actualHash === parsedRecord.record.expectedHash) {
        if (shouldWriteCheckResult({
          outputMode: options.outputMode,
          status: 'OK',
        })) {
          await writer.write({
            text: formatCheckResult({
              fileName: parsedRecord.record.fileName,
              status: 'OK',
            }),
          });
        }
        continue;
      }

      counts.mismatchedFiles += 1;
      if (shouldWriteCheckResult({
        outputMode: options.outputMode,
        status: 'FAILED',
      })) {
        await writer.write({
          text: formatCheckResult({
            fileName: parsedRecord.record.fileName,
            status: 'FAILED',
          }),
        });
      }
    }
  } catch (error: unknown) {
    sourceReadFailed = true;
    await context.text().error({
      text: `${COMMAND_NAME}: ${describeInput({ input: source })}: ${getErrorMessage({ error })}\n`,
    });
  }

  if (sourceReadFailed) {
    return 'failed';
  }

  if (counts.formattedRecords === 0) {
    await context.text().error({
      text: `${COMMAND_NAME}: ${describeInput({ input: source })}: no properly formatted checksum lines found\n`,
    });
    return 'failed';
  }

  const writeSummaries = shouldWriteCheckSummaries({
    outputMode: options.outputMode,
  });
  if (writeSummaries) {
    if (counts.malformedLines > 0) {
      await context.text().error({
        text: formatMalformedWarning({ count: counts.malformedLines }),
      });
    }
    if (counts.unreadableFiles > 0) {
      await context.text().error({
        text: formatUnreadableWarning({ count: counts.unreadableFiles }),
      });
    }
    if (counts.mismatchedFiles > 0) {
      await context.text().error({
        text: formatMismatchWarning({ count: counts.mismatchedFiles }),
      });
    }
  }

  if (
    isToggleEnabled({ value: options.ignoreMissing })
    && counts.verifiedFiles === 0
    && counts.unreadableFiles === 0
  ) {
    if (writeSummaries) {
      await context.text().error({
        text: `${COMMAND_NAME}: ${describeInput({ input: source })}: no file was verified\n`,
      });
    }
    return 'failed';
  }

  if (
    counts.unreadableFiles > 0
    || counts.mismatchedFiles > 0
    || (isToggleEnabled({ value: options.strict }) && counts.malformedLines > 0)
  ) {
    return 'failed';
  }

  return 'passed';
}

async function runCheckMode({
  context,
  sources,
  options,
}: {
  context: WeshCommandContext,
  sources: string[],
  options: CheckOptions,
}): Promise<WeshCommandResult> {
  const writer = createBufferedTextWriter({
    handle: context.stdout,
    maxBufferLength: OUTPUT_BUFFER_LENGTH,
  });
  let exitCode = 0;

  try {
    for (const source of sources) {
      const result = await verifyChecksumSource({
        context,
        source,
        options,
        writer,
      });
      switch (result) {
      case 'failed':
        exitCode = 1;
        break;
      case 'passed':
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled verification result: ${_ex}`);
      }
      }
    }
  } finally {
    await writer.flush();
  }

  return { exitCode };
}

export const sha256sumCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: getArgumentsThroughFirstEarlyExit({ args: context.args }),
      spec: sha256sumArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeUsageFailure({
        context,
        message: diagnostic.message,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: COMMAND_NAME,
        argvSpec: sha256sumArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.version === true) {
      await context.text().print({
        text: `${COMMAND_NAME} (wesh) ${packageJson.version}\n`,
      });
      return { exitCode: 0 };
    }

    const operationMode: OperationMode = parsed.optionValues.operationMode === 'check'
      ? 'check'
      : 'compute';
    const validation = await validateOptionCombinations({
      context,
      parsed,
      operationMode,
    });
    switch (validation) {
    case 'invalid':
      return { exitCode: 1 };
    case 'valid':
      break;
    default: {
      const _ex: never = validation;
      throw new Error(`Unhandled option validation result: ${_ex}`);
    }
    }

    const inputs = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
    switch (operationMode) {
    case 'compute':
      return runComputeMode({
        context,
        inputs,
        inputMode: getParsedInputMode({ parsed }),
        outputFormat: getParsedOutputFormat({ parsed }),
        recordTerminator: parsed.optionValues.recordTerminator === 'nul' ? 'nul' : 'newline',
      });
    case 'check':
      return runCheckMode({
        context,
        sources: inputs,
        options: {
          ignoreMissing: getBooleanOption({ parsed, key: 'ignoreMissing' }),
          outputMode: getParsedCheckOutputMode({ parsed }),
          strict: getBooleanOption({ parsed, key: 'strict' }),
        },
      });
    default: {
      const _ex: never = operationMode;
      throw new Error(`Unhandled operation mode: ${_ex}`);
    }
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
