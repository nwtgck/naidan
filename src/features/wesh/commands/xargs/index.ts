import { parseStandardArgv, type ArgvOptionOccurrence, type ArgvSpecialParseResult, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { parseXargsDelimiter } from '@/features/wesh/commands/xargs/parse-input';
import {
  iterateReadableStreamChunks,
  iterateUtf8TextChunks,
  iterateXargsDelimitedItems,
  iterateXargsInsertItems,
  iterateXargsLogicalLines,
  iterateXargsStandardItems,
  XargsInputError,
} from '@/features/wesh/commands/xargs/stream-input';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/features/wesh/types';
import { openFileReadStream, openHandleReadStream } from '@/features/wesh/utils/fs';
import { iterateUtf8Lines } from '@/features/wesh/utils/text-records';

const DEFAULT_MAX_CHARS = 131072;
const XARGS_VERSION = 'xargs (wesh) 0.25.1-dev';

function parseDeprecatedIOption({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  if (token === '--replace') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '--replace', key: 'replace', value: '{}' }],
    };
  }

  if (token === '-i') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-i', key: 'replace', value: '{}' }],
    };
  }

  if (token.startsWith('-i') && token.length > 2) {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-i', key: 'replace', value: token.slice(2) }],
    };
  }

  return undefined;
}

function parseDeprecatedLOption({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  if (token === '-l') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-l', key: 'maxLines', value: 1 }],
    };
  }

  if (/^-l\d+$/.test(token)) {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-l', key: 'maxLines', value: Number(token.slice(2)) }],
    };
  }

  return undefined;
}

function parseDeprecatedEOption({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  if (token === '--eof') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [],
    };
  }

  if (token === '-e') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [],
    };
  }

  if (token.startsWith('-e') && token.length > 2) {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-e', key: 'eofString', value: token.slice(2) }],
    };
  }

  return undefined;
}

const xargsArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: '0',
      long: 'null',
      effects: [{ key: 'nullDelimited', value: true }],
      help: { summary: 'input items are terminated by NUL, not whitespace', category: 'common' },
    },
    {
      kind: 'value',
      short: 'a',
      long: 'arg-file',
      key: 'argFile',
      valueName: 'FILE',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'read items from FILE instead of standard input', valueName: 'FILE', category: 'common' },
    },
    {
      kind: 'value',
      short: 'n',
      long: 'max-args',
      key: 'maxArgs',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => /^\d+$/.test(value) && Number(value) > 0
        ? { ok: true, value: Number(value) }
        : { ok: false, message: `invalid max-args value '${value}'` },
      help: { summary: 'use at most MAX arguments per command line', valueName: 'MAX', category: 'common' },
    },
    {
      kind: 'value',
      short: 'P',
      long: 'max-procs',
      key: 'maxProcs',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => /^\d+$/.test(value)
        ? { ok: true, value: Number(value) }
        : { ok: false, message: `invalid max-procs value '${value}'` },
      help: { summary: 'run up to MAX processes at a time', valueName: 'MAX', category: 'advanced' },
    },
    {
      kind: 'value',
      short: 'L',
      long: 'max-lines',
      key: 'maxLines',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => /^\d+$/.test(value) && Number(value) > 0
        ? { ok: true, value: Number(value) }
        : { ok: false, message: `invalid max-lines value '${value}'` },
      help: { summary: 'use at most MAX nonblank input lines per command line', valueName: 'MAX', category: 'common' },
    },
    {
      kind: 'value',
      short: 's',
      long: 'max-chars',
      key: 'maxChars',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => /^\d+$/.test(value) && Number(value) > 0
        ? { ok: true, value: Number(value) }
        : { ok: false, message: `invalid max-chars value '${value}'` },
      help: { summary: 'use at most MAX characters per command line', valueName: 'MAX', category: 'common' },
    },
    {
      kind: 'value',
      short: 'd',
      long: 'delimiter',
      key: 'delimiter',
      valueName: 'DELIM',
      allowAttachedValue: true,
      parseValue: ({ value }) => {
        const parsed = parseXargsDelimiter({ value });
        return parsed.ok ? { ok: true, value: parsed.delimiter } : parsed;
      },
      help: { summary: 'input items are terminated by DELIM, not whitespace', valueName: 'DELIM', category: 'common' },
    },
    {
      kind: 'value',
      short: 'I',
      long: 'replace',
      key: 'replace',
      valueName: 'REPLSTR',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'replace REPLSTR in initial arguments with each input item', valueName: 'REPLSTR', category: 'common' },
    },
    {
      kind: 'value',
      short: 'E',
      long: 'eof',
      key: 'eofString',
      valueName: 'EOFSTR',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'set logical end-of-file marker string', valueName: 'EOFSTR', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'o',
      long: 'open-tty',
      effects: [{ key: 'openTty', value: true }],
      help: { summary: 'reopen stdin as /dev/tty in the child before executing the command', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 'p',
      long: 'interactive',
      effects: [{ key: 'interactive', value: true }, { key: 'trace', value: true }],
      help: { summary: 'prompt before running each command line; implies --verbose', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 'r',
      long: 'no-run-if-empty',
      effects: [{ key: 'noRunIfEmpty', value: true }],
      help: { summary: 'do not run command if there is no input', category: 'common' },
    },
    {
      kind: 'flag',
      short: 't',
      long: 'verbose',
      effects: [{ key: 'trace', value: true }],
      help: { summary: 'print command line before executing it', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'x',
      long: 'exit',
      effects: [{ key: 'exitIfTooLong', value: true }],
      help: { summary: 'exit if the size is exceeded', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'version',
      effects: [{ key: 'version', value: true }],
      help: { summary: 'output version information and exit', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'show-limits',
      effects: [{ key: 'showLimits', value: true }],
      help: { summary: 'display command-line length limits and exit', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    parseDeprecatedIOption,
    parseDeprecatedLOption,
    parseDeprecatedEOption,
  ],
};

function shellQuote({
  text,
}: {
  text: string,
}): string {
  return /^[A-Za-z0-9_./-]+$/.test(text) ? text : `'${text.replaceAll('\'', `'\\''`)}'`;
}

function createDevNullLikeHandle(): WeshFileHandle {
  return {
    async read() {
      return { bytesRead: 0 };
    },
    async write({ buffer, offset, length }) {
      const start = offset ?? 0;
      const written = length ?? (buffer.length - start);
      return { bytesWritten: written };
    },
    async close() {},
    async stat() {
      return { size: 0, mode: 0o666, type: 'chardev', mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
    async truncate() {},
    async ioctl() {
      return { ret: 0 };
    },
  };
}

function describeConflictMode({
  mode,
}: {
  mode: 'replace' | 'maxArgs' | 'maxLines',
}): string {
  switch (mode) {
  case 'replace':
    return 'replace/-I/-i';
  case 'maxArgs':
    return 'max-args';
  case 'maxLines':
    return 'max-lines';
  default: {
    const _exhaustive: never = mode;
    throw new Error(`Unhandled xargs conflict mode: ${_exhaustive}`);
  }
  }
}

function isValueOccurrence(
  occurrence: ArgvOptionOccurrence,
  key: string,
): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> {
  return occurrence.kind === 'value' && occurrence.key === key;
}

function getLastValueOccurrence({
  occurrences,
  key,
}: {
  occurrences: ArgvOptionOccurrence[],
  key: string,
}): Extract<ArgvOptionOccurrence, { kind: 'value' }> | undefined {
  return [...occurrences].reverse().find((occurrence) => isValueOccurrence(occurrence, key));
}

type XargsModeOccurrence = Extract<ArgvOptionOccurrence, { kind: 'value' }> & {
  key: 'replace' | 'maxArgs' | 'maxLines',
};

function isXargsModeOccurrence(
  occurrence: ArgvOptionOccurrence,
): occurrence is XargsModeOccurrence {
  return occurrence.kind === 'value'
    && (occurrence.key === 'replace' || occurrence.key === 'maxArgs' || occurrence.key === 'maxLines');
}

async function resolveExecutionLimits({
  context,
  occurrences,
}: {
  context: WeshCommandContext,
  occurrences: ArgvOptionOccurrence[],
}): Promise<{
  replaceValue: string | undefined,
  maxArgs: number | undefined,
  maxLines: number | undefined,
}> {
  const conflictingOccurrences = occurrences.filter(isXargsModeOccurrence);

  let replaceValue: string | undefined;
  let maxArgs: number | undefined;
  let maxLines: number | undefined;
  let activeMode: 'replace' | 'maxArgs' | 'maxLines' | undefined;

  for (const occurrence of conflictingOccurrences) {
    switch (occurrence.key) {
    case 'replace': {
      if (activeMode !== undefined && activeMode !== 'replace') {
        await context.text().error({
          text: `xargs: warning: options --${describeConflictMode({ mode: activeMode })} and --replace/-I/-i are mutually exclusive; ignoring previous --${describeConflictMode({ mode: activeMode })} value\n`,
        });
      }
      replaceValue = typeof occurrence.value === 'string' ? occurrence.value : undefined;
      maxArgs = undefined;
      maxLines = undefined;
      activeMode = 'replace';
      break;
    }
    case 'maxArgs': {
      const nextValue = typeof occurrence.value === 'number' ? occurrence.value : undefined;
      if (activeMode === 'replace' && nextValue === 1) {
        break;
      }
      if (activeMode !== undefined && activeMode !== 'maxArgs') {
        await context.text().error({
          text: `xargs: warning: options --${describeConflictMode({ mode: activeMode })} and --max-args are mutually exclusive; ignoring previous --${describeConflictMode({ mode: activeMode })} value\n`,
        });
      }
      replaceValue = undefined;
      maxLines = undefined;
      maxArgs = nextValue;
      activeMode = 'maxArgs';
      break;
    }
    case 'maxLines': {
      if (activeMode !== undefined && activeMode !== 'maxLines') {
        await context.text().error({
          text: `xargs: warning: options --${describeConflictMode({ mode: activeMode })} and --max-lines are mutually exclusive; ignoring previous --${describeConflictMode({ mode: activeMode })} value\n`,
        });
      }
      replaceValue = undefined;
      maxArgs = undefined;
      maxLines = typeof occurrence.value === 'number' ? occurrence.value : undefined;
      activeMode = 'maxLines';
      break;
    }
    default: {
      const _exhaustive: never = occurrence.key;
      throw new Error(`Unhandled xargs mode occurrence: ${_exhaustive}`);
    }
    }
  }

  return {
    replaceValue,
    maxArgs,
    maxLines,
  };
}

interface XargsInvocation {
  readonly args: string[],
}

const MAX_AUTOMATIC_PARALLELISM = 32;
const argumentEncoder = new TextEncoder();

function getArgumentBytes({ value }: { value: string }): number {
  return argumentEncoder.encode(value).byteLength;
}

function getCommandBytes({
  command,
  args,
}: {
  command: string,
  args: readonly string[],
}): number {
  let bytes = getArgumentBytes({ value: command });
  for (const arg of args) {
    bytes += 1 + getArgumentBytes({ value: arg });
  }
  return bytes;
}

class XargsArgumentListTooLongError extends Error {}

async function* createBatchedInvocations({
  command,
  items,
  initialArgs,
  maxArgs,
  maxChars,
  exitIfTooLong,
  noRunIfEmpty,
}: {
  command: string,
  items: AsyncIterable<string>,
  initialArgs: readonly string[],
  maxArgs: number | undefined,
  maxChars: number,
  exitIfTooLong: boolean,
  noRunIfEmpty: boolean,
}): AsyncIterable<XargsInvocation> {
  let batch: string[] = [];
  let batchBytes = getCommandBytes({ command, args: initialArgs });
  let sawItem = false;

  for await (const item of items) {
    sawItem = true;
    const itemBytes = 1 + getArgumentBytes({ value: item });
    const exceedsMaxArgs = maxArgs !== undefined && batch.length + 1 > maxArgs;
    const exceedsMaxChars = batchBytes + itemBytes > maxChars;

    if (batch.length > 0 && (exceedsMaxArgs || exceedsMaxChars)) {
      yield { args: [...initialArgs, ...batch] };
      batch = [];
      batchBytes = getCommandBytes({ command, args: initialArgs });
    }

    const exceedsEmptyBatch = (maxArgs !== undefined && 1 > maxArgs)
      || batchBytes + itemBytes > maxChars;
    if (batch.length === 0 && exceedsEmptyBatch) {
      if (exitIfTooLong) {
        throw new XargsArgumentListTooLongError('xargs: argument list too long');
      }
      yield { args: [...initialArgs, item] };
      continue;
    }

    batch.push(item);
    batchBytes += itemBytes;
  }

  if (batch.length > 0) {
    yield { args: [...initialArgs, ...batch] };
    return;
  }

  if (!sawItem && !noRunIfEmpty) {
    yield { args: [...initialArgs] };
  }
}

function replaceTemplateArgs({
  args,
  placeholder,
  value,
}: {
  args: string[],
  placeholder: string,
  value: string,
}): string[] {
  let replaced = false;
  const nextArgs = args.map((arg) => {
    if (!arg.includes(placeholder)) return arg;
    replaced = true;
    return arg.replaceAll(placeholder, value);
  });

  return replaced ? nextArgs : [...args, value];
}

async function* createReplaceInvocations({
  items,
  initialArgs,
  placeholder,
  noRunIfEmpty,
}: {
  items: AsyncIterable<string>,
  initialArgs: readonly string[],
  placeholder: string,
  noRunIfEmpty: boolean,
}): AsyncIterable<XargsInvocation> {
  let sawItem = false;
  for await (const item of items) {
    sawItem = true;
    yield {
      args: replaceTemplateArgs({
        args: [...initialArgs],
        placeholder,
        value: item,
      }),
    };
  }

  if (!sawItem && !noRunIfEmpty) {
    yield {
      args: replaceTemplateArgs({
        args: [...initialArgs],
        placeholder,
        value: '',
      }),
    };
  }
}

async function* createLineInvocations({
  command,
  lines,
  initialArgs,
  maxLines,
  maxChars,
  exitIfTooLong,
}: {
  command: string,
  lines: AsyncIterable<string[]>,
  initialArgs: readonly string[],
  maxLines: number,
  maxChars: number,
  exitIfTooLong: boolean,
}): AsyncIterable<XargsInvocation> {
  let groupedItems: string[] = [];
  let lineCount = 0;

  const buildInvocation = (): XargsInvocation | undefined => {
    if (groupedItems.length === 0) {
      return undefined;
    }
    const args = [...initialArgs, ...groupedItems];
    if (getCommandBytes({ command, args }) > maxChars && exitIfTooLong) {
      throw new XargsArgumentListTooLongError('xargs: argument list too long');
    }
    groupedItems = [];
    lineCount = 0;
    return { args };
  };

  for await (const lineItems of lines) {
    if (lineCount >= maxLines) {
      const invocation = buildInvocation();
      if (invocation !== undefined) {
        yield invocation;
      }
    }
    groupedItems.push(...lineItems);
    lineCount += 1;
  }

  const invocation = buildInvocation();
  if (invocation !== undefined) {
    yield invocation;
  }
}

function normalizeXargsExitCode({
  exitCode,
}: {
  exitCode: number,
}): number {
  if (exitCode === 0) return 0;
  if (exitCode === 255) return 124;
  if (exitCode === 126 || exitCode === 127) return exitCode;
  if (exitCode >= 1 && exitCode <= 125) return 123;
  return exitCode;
}

async function runCommand({
  context,
  command,
  args,
  trace,
  stdin,
}: {
  context: WeshCommandContext,
  command: string,
  args: string[],
  trace: boolean,
  stdin: WeshFileHandle,
}): Promise<WeshCommandResult> {
  if (trace) {
    await context.text().error({
      text: `${[command, ...args].map((item) => shellQuote({ text: item })).join(' ')}\n`,
    });
  }

  return context.executeCommand({
    command,
    args,
    stdin,
    stdout: context.stdout,
    stderr: context.stderr,
  });
}

async function handleCommandResult({
  context,
  result,
}: {
  context: WeshCommandContext,
  result: WeshCommandResult,
}): Promise<{ kind: 'continue', normalizedExitCode: number } | { kind: 'stop', exitCode: number }> {
  if (result.exitCode === 255) {
    await context.text().error({
      text: 'xargs: command exited with status 255; aborting\n',
    });
    return { kind: 'stop', exitCode: 124 };
  }

  return {
    kind: 'continue',
    normalizedExitCode: normalizeXargsExitCode({ exitCode: result.exitCode }),
  };
}

async function executeInvocationStream({
  context,
  command,
  invocations,
  trace,
  stdin,
  maxProcs,
}: {
  context: WeshCommandContext,
  command: string,
  invocations: AsyncIterable<XargsInvocation>,
  trace: boolean,
  stdin: WeshFileHandle,
  maxProcs: number,
}): Promise<WeshCommandResult> {
  const concurrency = maxProcs === 0
    ? MAX_AUTOMATIC_PARALLELISM
    : Math.max(1, maxProcs);
  const active = new Set<Promise<void>>();
  let lastExitCode = 0;
  let stopExitCode: number | undefined;
  let executionError: unknown;

  const startInvocation = ({ invocation }: { invocation: XargsInvocation }): void => {
    const task = (async () => {
      try {
        const result = await runCommand({
          context,
          command,
          args: invocation.args,
          trace,
          stdin,
        });
        const handled = await handleCommandResult({ context, result });
        switch (handled.kind) {
        case 'continue':
          if (handled.normalizedExitCode !== 0) {
            lastExitCode = handled.normalizedExitCode;
          }
          break;
        case 'stop':
          stopExitCode = handled.exitCode;
          break;
        default: {
          const _exhaustive: never = handled;
          throw new Error(`Unhandled xargs command result handling: ${_exhaustive}`);
        }
        }
      } catch (error: unknown) {
        executionError = error;
      }
    })();
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
  };

  try {
    for await (const invocation of invocations) {
      while (active.size >= concurrency) {
        await Promise.race(active);
        if (executionError !== undefined || stopExitCode !== undefined) {
          break;
        }
      }
      if (stopExitCode !== undefined || executionError !== undefined) {
        break;
      }
      startInvocation({ invocation });
    }
  } catch (error: unknown) {
    executionError = error;
  }

  await Promise.all(active);
  if (executionError !== undefined) {
    throw executionError;
  }
  if (stopExitCode !== undefined) {
    return { exitCode: stopExitCode };
  }
  return { exitCode: lastExitCode };
}

export const xargsCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'xargs',
    description: 'Build and run command lines from standard input',
    usage: 'xargs [-0rtx] [-a FILE] [-d DELIM] [-E EOFSTR] [-n MAX] [-L MAX] [-s MAX] [-I REPLSTR] [COMMAND [INITIAL-ARGS]...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: xargsArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'xargs',
        message: `xargs: ${diagnostic.message}`,
        argvSpec: xargsArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'xargs',
        argvSpec: xargsArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.version === true) {
      await context.text().print({
        text: `${XARGS_VERSION}\n`,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.showLimits === true) {
      await context.text().print({
        text: `\
Your environment variables take up 0 bytes
POSIX upper limit on argument length (this system): ${DEFAULT_MAX_CHARS}
POSIX smallest allowable upper limit on argument length (all systems): 4096
Maximum length of command we could actually use: ${DEFAULT_MAX_CHARS}
Size of command buffer we are actually using: ${DEFAULT_MAX_CHARS}
Maximum parallelism (--max-procs must be no greater): ${MAX_AUTOMATIC_PARALLELISM}
`,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.interactive === true) {
      await context.text().error({
        text: 'xargs: interactive prompting with --interactive/-p is not supported in wesh yet\n',
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.openTty === true) {
      await context.text().error({
        text: 'xargs: reopening stdin as /dev/tty with --open-tty/-o is not supported in wesh yet\n',
      });
      return { exitCode: 1 };
    }

    const argFileOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'argFile',
    });
    const argFile = typeof argFileOccurrence?.value === 'string' ? argFileOccurrence.value : undefined;
    const executionLimits = await resolveExecutionLimits({
      context,
      occurrences: parsed.occurrences,
    });
    const replaceValue = executionLimits.replaceValue;
    const maxArgs = executionLimits.maxArgs;
    const maxLines = executionLimits.maxLines;
    const maxCharsOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'maxChars',
    });
    const maxChars = typeof maxCharsOccurrence?.value === 'number' ? maxCharsOccurrence.value : DEFAULT_MAX_CHARS;
    const maxProcsOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'maxProcs',
    });
    const maxProcs = typeof maxProcsOccurrence?.value === 'number' ? maxProcsOccurrence.value : 1;
    const delimiterOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'delimiter',
    });
    const delimiter = typeof delimiterOccurrence?.value === 'string' ? delimiterOccurrence.value : undefined;
    const eofOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'eofString',
    });
    const eofString = typeof eofOccurrence?.value === 'string' ? eofOccurrence.value : undefined;

    if (parsed.optionValues.nullDelimited === true && delimiter !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'xargs',
        message: "xargs: options '--null' and '--delimiter' are mutually exclusive",
        argvSpec: xargsArgvSpec,
      });
      return { exitCode: 1 };
    }

    const [command = 'echo', ...initialArgs] = parsed.positionals;
    const childStdin = argFile === undefined
      ? createDevNullLikeHandle()
      : context.stdin;

    try {
      const inputStream = argFile === undefined
        ? openHandleReadStream({ handle: context.stdin })
        : await openFileReadStream({
          files: context.files,
          path: argFile.startsWith('/') ? argFile : `${context.cwd}/${argFile}`,
        });
      const byteChunks = iterateReadableStreamChunks({ stream: inputStream });
      let invocations: AsyncIterable<XargsInvocation>;

      if (typeof replaceValue === 'string') {
        invocations = createReplaceInvocations({
          items: iterateXargsInsertItems({
            lines: iterateUtf8Lines({ chunks: byteChunks }),
            eofString,
          }),
          initialArgs,
          placeholder: replaceValue,
          noRunIfEmpty: parsed.optionValues.noRunIfEmpty === true,
        });
      } else if (maxLines !== undefined) {
        invocations = createLineInvocations({
          command,
          lines: iterateXargsLogicalLines({
            lines: iterateUtf8Lines({ chunks: byteChunks }),
          }),
          initialArgs,
          maxLines,
          maxChars,
          exitIfTooLong: parsed.optionValues.exitIfTooLong === true,
        });
      } else {
        const textChunks = iterateUtf8TextChunks({ chunks: byteChunks });
        const items = parsed.optionValues.nullDelimited === true
          ? iterateXargsDelimitedItems({ textChunks, delimiter: '\0' })
          : delimiter !== undefined
            ? iterateXargsDelimitedItems({ textChunks, delimiter })
            : iterateXargsStandardItems({ textChunks, eofString });
        invocations = createBatchedInvocations({
          command,
          items,
          initialArgs,
          maxArgs,
          maxChars,
          exitIfTooLong: parsed.optionValues.exitIfTooLong === true,
          noRunIfEmpty: parsed.optionValues.noRunIfEmpty === true,
        });
      }

      return await executeInvocationStream({
        context,
        command,
        invocations,
        trace: parsed.optionValues.trace === true,
        stdin: childStdin,
        maxProcs,
      });
    } catch (error: unknown) {
      const message = error instanceof XargsInputError
        || error instanceof XargsArgumentListTooLongError
        ? error.message
        : `xargs: ${argFile ?? '-'}: ${error instanceof Error ? error.message : String(error)}`;
      await context.text().error({ text: `${message}\n` });
      return { exitCode: 1 };
    }
  },
};
