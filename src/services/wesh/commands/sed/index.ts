import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/services/wesh/types';
import { readAllFileBytes, writeAllStreamToFile, writeAllFileBytes } from '@/services/wesh/utils/fs';

type SedAddress =
  | { kind: 'line'; lineNumber: number }
  | { kind: 'regex'; regex: RegExp };

type SedCommand =
  | { kind: 'substitute'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; regex: RegExp; replacement: string; global: boolean; print: boolean }
  | { kind: 'translate'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; source: string; target: string }
  | { kind: 'append'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; text: string }
  | { kind: 'insert'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; text: string }
  | { kind: 'change'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; text: string }
  | { kind: 'print'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined }
  | { kind: 'delete'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined }
  | { kind: 'quit'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined };

interface SedRuntimeCommand {
  command: SedCommand;
  inRange: boolean;
}

type SedRuntimeExecutableCommand =
  | { kind: 'substitute'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; regex: RegExp; replacement: string; print: boolean }
  | { kind: 'translate'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; lookup: Map<string, string> }
  | { kind: 'append'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; text: string }
  | { kind: 'insert'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; text: string }
  | { kind: 'change'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; text: string }
  | { kind: 'print'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined }
  | { kind: 'delete'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined }
  | { kind: 'quit'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined };

interface SedExecutableRuntimeCommand {
  command: SedRuntimeExecutableCommand;
  inRange: boolean;
}

interface SedTextLine {
  line: string;
  hadNewline: boolean;
}

interface SedLineResult {
  outputs: string[];
  shouldQuit: boolean;
}

function parseLineNumberAddress({
  value,
}: {
  value: string;
}): SedAddress | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  return {
    kind: 'line',
    lineNumber: parseInt(value, 10),
  };
}

function parseRegexLiteral({
  script,
  index,
}: {
  script: string;
  index: number;
}): { ok: true; regex: RegExp; nextIndex: number } | { ok: false; message: string } {
  const delimiter = script[index];
  if (delimiter !== '/') {
    return { ok: false, message: `invalid regex address near '${script.slice(index)}'` };
  }

  let cursor = index + 1;
  let pattern = '';
  let escaped = false;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined) break;

    if (!escaped && char === delimiter) {
      try {
        return {
          ok: true,
          regex: new RegExp(pattern),
          nextIndex: cursor + 1,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message: `invalid regular expression '${pattern}': ${message}` };
      }
    }

    pattern += char;
    escaped = !escaped && char === '\\';
    cursor += 1;
  }

  return { ok: false, message: 'unterminated regex address' };
}

function parseAddress({
  script,
  index,
}: {
  script: string;
  index: number;
}): { ok: true; address: SedAddress | undefined; nextIndex: number } | { ok: false; message: string } {
  const lineMatch = script.slice(index).match(/^\d+/);
  if (lineMatch?.[0] !== undefined) {
    return {
      ok: true,
      address: parseLineNumberAddress({ value: lineMatch[0] }),
      nextIndex: index + lineMatch[0].length,
    };
  }

  if (script[index] === '/') {
    const parsed = parseRegexLiteral({ script, index });
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      address: { kind: 'regex', regex: parsed.regex },
      nextIndex: parsed.nextIndex,
    };
  }

  return {
    ok: true,
    address: undefined,
    nextIndex: index,
  };
}

function parseSubstituteCommand({
  script,
  index,
  address,
  rangeEnd,
}: {
  script: string;
  index: number;
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
}): { ok: true; command: SedCommand; nextIndex: number } | { ok: false; message: string } {
  const delimiter = script[index + 1];
  if (delimiter === undefined) {
    return { ok: false, message: 'unterminated substitute command' };
  }

  let cursor = index + 2;
  let pattern = '';
  let replacement = '';
  let escaped = false;

  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined) break;
    if (!escaped && char === delimiter) {
      cursor += 1;
      break;
    }
    pattern += char;
    escaped = !escaped && char === '\\';
    cursor += 1;
  }

  escaped = false;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined) break;
    if (!escaped && char === delimiter) {
      cursor += 1;
      break;
    }
    replacement += char;
    escaped = !escaped && char === '\\';
    cursor += 1;
  }

  let flags = '';
  let print = false;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined) break;
    if (char === 'g') {
      flags = 'g';
      cursor += 1;
      continue;
    }
    if (char === 'p') {
      print = true;
      cursor += 1;
      continue;
    }
    break;
  }

  try {
    return {
      ok: true,
      command: {
        kind: 'substitute',
        address,
        rangeEnd,
        regex: new RegExp(pattern, flags),
        replacement,
        global: flags === 'g',
        print,
      },
      nextIndex: cursor,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid substitute regex '${pattern}': ${message}` };
  }
}

function parseDelimitedSedText({
  script,
  index,
  label,
}: {
  script: string;
  index: number;
  label: string;
}): { ok: true; text: string; nextIndex: number } | { ok: false; message: string } {
  const delimiter = script[index];
  if (delimiter === undefined) {
    return { ok: false, message: `unterminated ${label} command` };
  }

  let cursor = index + 1;
  let text = '';
  let escaped = false;

  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined) break;
    if (!escaped && char === delimiter) {
      return {
        ok: true,
        text,
        nextIndex: cursor + 1,
      };
    }
    text += char;
    escaped = !escaped && char === '\\';
    cursor += 1;
  }

  return { ok: false, message: `unterminated ${label} command` };
}

function parseTranslateCommand({
  script,
  index,
  address,
  rangeEnd,
}: {
  script: string;
  index: number;
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
}): { ok: true; command: SedCommand; nextIndex: number } | { ok: false; message: string } {
  const source = parseDelimitedSedText({
    script,
    index: index + 1,
    label: 'translate',
  });
  if (!source.ok) return source;

  const target = parseDelimitedSedText({
    script,
    index: source.nextIndex - 1,
    label: 'translate',
  });
  if (!target.ok) return target;

  if (source.text.length !== target.text.length) {
    return { ok: false, message: 'strings for y command are different lengths' };
  }

  return {
    ok: true,
    command: {
      kind: 'translate',
      address,
      rangeEnd,
      source: source.text,
      target: target.text,
    },
    nextIndex: target.nextIndex,
  };
}

function parseTextCommand({
  script,
  index,
  label,
  address,
  rangeEnd,
}: {
  script: string;
  index: number;
  label: 'append' | 'insert' | 'change';
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
}): { ok: true; command: SedCommand; nextIndex: number } | { ok: false; message: string } {
  let cursor = index + 1;
  if (script[cursor] === '\\') {
    cursor += 1;
  }

  let text = '';
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined || char === ';' || char === '\n') {
      break;
    }
    text += char;
    cursor += 1;
  }

  switch (label) {
  case 'append':
    return {
      ok: true,
      command: { kind: 'append', address, rangeEnd, text },
      nextIndex: cursor,
    };
  case 'insert':
    return {
      ok: true,
      command: { kind: 'insert', address, rangeEnd, text },
      nextIndex: cursor,
    };
  case 'change':
    return {
      ok: true,
      command: { kind: 'change', address, rangeEnd, text },
      nextIndex: cursor,
    };
  default: {
    const _ex: never = label;
    throw new Error(`Unhandled sed text command: ${_ex}`);
  }
  }
}

function skipSeparators({
  script,
  index,
}: {
  script: string;
  index: number;
}): number {
  let cursor = index;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === ';' || char === '\n' || char === ' ' || char === '\t') {
      cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

function parseSedScript({
  script,
}: {
  script: string;
}): { ok: true; commands: SedCommand[] } | { ok: false; message: string } {
  const commands: SedCommand[] = [];
  let index = 0;

  while (index < script.length) {
    index = skipSeparators({ script, index });
    if (index >= script.length) break;

    const firstAddress = parseAddress({ script, index });
    if (!firstAddress.ok) return firstAddress;
    const address = firstAddress.address;
    index = firstAddress.nextIndex;

    let rangeEnd: SedAddress | undefined;
    if (script[index] === ',') {
      const secondAddress = parseAddress({ script, index: index + 1 });
      if (!secondAddress.ok || secondAddress.address === undefined) {
        return { ok: false, message: 'invalid range address' };
      }
      rangeEnd = secondAddress.address;
      index = secondAddress.nextIndex;
    }

    const commandChar = script[index];
    if (commandChar === undefined) break;

    switch (commandChar) {
    case 's': {
      const parsed = parseSubstituteCommand({
        script,
        index,
        address,
        rangeEnd,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case 'p':
      commands.push({ kind: 'print', address, rangeEnd });
      index += 1;
      break;
    case 'd':
      commands.push({ kind: 'delete', address, rangeEnd });
      index += 1;
      break;
    case 'q':
      commands.push({ kind: 'quit', address, rangeEnd });
      index += 1;
      break;
    case 'y': {
      const parsed = parseTranslateCommand({
        script,
        index,
        address,
        rangeEnd,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case 'a': {
      const parsed = parseTextCommand({
        script,
        index,
        label: 'append',
        address,
        rangeEnd,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case 'i': {
      const parsed = parseTextCommand({
        script,
        index,
        label: 'insert',
        address,
        rangeEnd,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case 'c': {
      const parsed = parseTextCommand({
        script,
        index,
        label: 'change',
        address,
        rangeEnd,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    default:
      return { ok: false, message: `unsupported sed command '${commandChar}'` };
    }
  }

  return { ok: true, commands };
}

function matchesAddress({
  address,
  lineNumber,
  line,
}: {
  address: SedAddress | undefined;
  lineNumber: number;
  line: string;
}): boolean {
  if (address === undefined) return true;

  switch (address.kind) {
  case 'line':
    return lineNumber === address.lineNumber;
  case 'regex':
    address.regex.lastIndex = 0;
    return address.regex.test(line);
  default: {
    const _ex: never = address;
    throw new Error(`Unhandled sed address kind: ${_ex}`);
  }
  }
}

function commandApplies({
  runtimeCommand,
  lineNumber,
  line,
}: {
  runtimeCommand: SedRuntimeCommand | SedExecutableRuntimeCommand;
  lineNumber: number;
  line: string;
}): boolean {
  const { command } = runtimeCommand;
  if (command.rangeEnd === undefined) {
    return matchesAddress({ address: command.address, lineNumber, line });
  }

  if (runtimeCommand.inRange) {
    if (matchesAddress({ address: command.rangeEnd, lineNumber, line })) {
      runtimeCommand.inRange = false;
    }
    return true;
  }

  const startsRange = matchesAddress({ address: command.address, lineNumber, line });
  if (!startsRange) return false;

  if (!matchesAddress({ address: command.rangeEnd, lineNumber, line })) {
    runtimeCommand.inRange = true;
  }
  return true;
}

function createInputStream({
  handle,
}: {
  handle: WeshFileHandle;
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const buf = new Uint8Array(4096);
      const { bytesRead } = await handle.read({ buffer: buf });
      if (bytesRead === 0) {
        controller.close();
        return;
      }
      controller.enqueue(buf.subarray(0, bytesRead));
    }
  });
}

async function openSedInputStream({
  context,
  file,
}: {
  context: WeshCommandContext;
  file: string;
}): Promise<ReadableStream<Uint8Array>> {
  if (file === '-') {
    return createInputStream({
      handle: context.stdin,
    });
  }

  const path = file.startsWith('/') ? file : `${context.cwd}/${file}`;
  if (context.files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await context.files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob':
      return blobResult.blob.stream() as ReadableStream<Uint8Array>;
    case 'fallback-required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob read result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const handle = await context.files.open({
    path,
    flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
  });
  return createInputStream({ handle });
}

async function *readTextLines({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): AsyncGenerator<SedTextLine> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      if (value === undefined) continue;

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;

        const lineEnd = newlineIndex > 0 && buffer[newlineIndex - 1] === '\r'
          ? newlineIndex - 1
          : newlineIndex;
        yield {
          line: buffer.slice(0, lineEnd),
          hadNewline: true,
        };
        buffer = buffer.slice(newlineIndex + 1);
      }
    }

    if (buffer.length > 0) {
      yield {
        line: buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer,
        hadNewline: false,
      };
    }
  } finally {
    reader.releaseLock();
  }
}

function createSedRuntimeCommands({
  commands,
}: {
  commands: SedCommand[];
}): SedExecutableRuntimeCommand[] {
  return commands.map((command) => {
    switch (command.kind) {
    case 'substitute':
      return {
        command: {
          kind: 'substitute',
          address: command.address,
          rangeEnd: command.rangeEnd,
          regex: command.regex,
          replacement: command.replacement,
          print: command.print,
        },
        inRange: false,
      };
    case 'translate':
      return {
        command: {
          kind: 'translate',
          address: command.address,
          rangeEnd: command.rangeEnd,
          lookup: new Map(Array.from(command.source, (char, index) => [char, command.target[index] ?? char])),
        },
        inRange: false,
      };
    case 'append':
    case 'insert':
    case 'change':
    case 'print':
    case 'delete':
    case 'quit':
      return {
        command,
        inRange: false,
      };
    default: {
      const _ex: never = command;
      throw new Error(`Unhandled sed runtime command kind: ${_ex}`);
    }
    }
  });
}

function executeSedLine({
  runtimeCommands,
  lineNumber,
  current,
  quiet,
}: {
  runtimeCommands: SedExecutableRuntimeCommand[];
  lineNumber: number;
  current: SedTextLine;
  quiet: boolean;
}): SedLineResult {
  let patternSpace = current.line;
  let deleted = false;
  let quitAfterLine = false;
  const explicitPrints: string[] = [];
  const prependedPrints: string[] = [];
  const appendedPrints: string[] = [];
  let changedReplacement: string | undefined;

  for (const runtimeCommand of runtimeCommands) {
    const wasInRange = runtimeCommand.inRange;
    if (!commandApplies({
      runtimeCommand,
      lineNumber,
      line: patternSpace,
    })) {
      continue;
    }

    switch (runtimeCommand.command.kind) {
    case 'substitute': {
      const next = patternSpace.replace(
        runtimeCommand.command.regex,
        runtimeCommand.command.replacement,
      );
      const changed = next !== patternSpace;
      patternSpace = next;
      if (changed && runtimeCommand.command.print) {
        explicitPrints.push(patternSpace);
      }
      break;
    }
    case 'translate': {
      const command = runtimeCommand.command;
      const translated = patternSpace
        .split('')
        .map((char) => command.lookup.get(char) ?? char)
        .join('');
      patternSpace = translated;
      break;
    }
    case 'append':
      appendedPrints.push(runtimeCommand.command.text);
      break;
    case 'insert':
      prependedPrints.push(runtimeCommand.command.text);
      break;
    case 'change':
      if (runtimeCommand.command.rangeEnd === undefined || !wasInRange) {
        changedReplacement = runtimeCommand.command.text;
      }
      deleted = true;
      break;
    case 'print':
      explicitPrints.push(patternSpace);
      break;
    case 'delete':
      deleted = true;
      break;
    case 'quit':
      quitAfterLine = true;
      break;
    default: {
      const _ex: never = runtimeCommand.command;
      throw new Error(`Unhandled sed command kind: ${_ex}`);
    }
    }

    if (deleted) break;
  }

  const outputs: string[] = [];
  for (const printed of prependedPrints) {
    outputs.push(current.hadNewline ? `${printed}\n` : printed);
  }
  for (const printed of explicitPrints) {
    outputs.push(current.hadNewline ? `${printed}\n` : printed);
  }
  if (changedReplacement !== undefined) {
    outputs.push(current.hadNewline ? `${changedReplacement}\n` : changedReplacement);
  } else if (!deleted && !quiet) {
    outputs.push(current.hadNewline ? `${patternSpace}\n` : patternSpace);
  }
  for (const printed of appendedPrints) {
    outputs.push(current.hadNewline ? `${printed}\n` : printed);
  }

  return {
    outputs,
    shouldQuit: quitAfterLine,
  };
}

export const sedCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sed',
    description: 'Stream editor for filtering and transforming text',
    usage: 'sed [OPTION]... {script-only-if-no-other-script} [input-file]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const sedArgvSpec: StandardArgvParserSpec = {
      options: [
        {
          kind: 'flag',
          short: 'n',
          long: 'quiet',
          effects: [{ key: 'quiet', value: true }],
          help: { summary: 'suppress automatic printing of pattern space', category: 'common' },
        },
        {
          kind: 'flag',
          short: undefined,
          long: 'silent',
          effects: [{ key: 'quiet', value: true }],
          help: { summary: 'suppress automatic printing of pattern space', category: 'common' },
        },
        {
          kind: 'value',
          short: 'e',
          long: 'expression',
          key: 'expression',
          valueName: 'script',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'add a script to the commands to be executed', category: 'common' },
        },
        {
          kind: 'value',
          short: 'f',
          long: 'file',
          key: 'scriptFile',
          valueName: 'script-file',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'add a script file to the commands to be executed', category: 'common' },
        },
        {
          kind: 'flag',
          short: 'r',
          long: undefined,
          effects: [{ key: 'extendedRegexp', value: true }],
          help: { summary: 'use extended regular expressions', category: 'common' },
        },
        {
          kind: 'flag',
          short: 'E',
          long: undefined,
          effects: [{ key: 'extendedRegexp', value: true }],
          help: { summary: 'use extended regular expressions', category: 'common' },
        },
        {
          kind: 'value',
          short: 'i',
          long: 'in-place',
          key: 'inPlaceSuffix',
          valueName: 'suffix',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'edit files in place, optionally keeping a backup suffix', category: 'advanced' },
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
      specialTokenParsers: [],
    };

    const parsed = parseStandardArgv({
      args: context.args,
      spec: sedArgvSpec,
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'sed',
        message: `sed: ${parsed.diagnostics[0]!.message}`,
        argvSpec: sedArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'sed',
        argvSpec: sedArgvSpec,
      });
      return { exitCode: 0 };
    }

    const inlineScripts = parsed.occurrences
      .filter((occurrence): occurrence is Extract<typeof parsed.occurrences[number], { kind: 'value' }> => occurrence.kind === 'value' && occurrence.key === 'expression')
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');

    const scriptFiles = parsed.occurrences
      .filter((occurrence): occurrence is Extract<typeof parsed.occurrences[number], { kind: 'value' }> => occurrence.kind === 'value' && occurrence.key === 'scriptFile')
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');

    const scripts = [...inlineScripts];
    for (const scriptFile of scriptFiles) {
      try {
        const fullPath = scriptFile.startsWith('/') ? scriptFile : `${context.cwd}/${scriptFile}`;
        const bytes = await readAllFileBytes({ files: context.files, path: fullPath });
        scripts.push(new TextDecoder().decode(bytes));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `sed: ${scriptFile}: ${message}\n` });
        return { exitCode: 2 };
      }
    }

    const files = [...parsed.positionals];
    if (scripts.length === 0) {
      const expression = files.shift();
      if (expression === undefined) {
        await writeCommandUsageError({
          context,
          command: 'sed',
          message: 'sed: missing expression',
          argvSpec: sedArgvSpec,
        });
        return { exitCode: 1 };
      }
      scripts.push(expression);
    }

    const allCommands: SedCommand[] = [];
    for (const script of scripts) {
      const parsedScript = parseSedScript({ script });
      if (!parsedScript.ok) {
        await writeCommandUsageError({
          context,
          command: 'sed',
          message: `sed: ${parsedScript.message}`,
          argvSpec: sedArgvSpec,
        });
        return { exitCode: 1 };
      }
      allCommands.push(...parsedScript.commands);
    }

    const quiet = parsed.optionValues.quiet === true;
    const inPlace = parsed.optionValues.inPlaceSuffix !== undefined;
    const inPlaceSuffix = typeof parsed.optionValues.inPlaceSuffix === 'string' ? parsed.optionValues.inPlaceSuffix : '';
    const encoder = new TextEncoder();
    const processText = ({
      input,
    }: {
      input: string;
    }): string => {
      const runtimeCommands = createSedRuntimeCommands({
        commands: allCommands,
      });
      const outputParts: string[] = [];
      let lineNumber = 0;
      const parts = input.length === 0 ? [] : input.split('\n');
      for (let index = 0; index < parts.length; index++) {
        lineNumber += 1;
        const current: SedTextLine = {
          line: parts[index] ?? '',
          hadNewline: index < parts.length - 1,
        };
        const result = executeSedLine({
          runtimeCommands,
          lineNumber,
          current,
          quiet,
        });
        outputParts.push(...result.outputs);
        if (result.shouldQuit) {
          break;
        }
      }
      return outputParts.join('');
    };

    if (files.length === 0) {
      if (inPlace) {
        await writeCommandUsageError({
          context,
          command: 'sed',
          message: 'sed: cannot use in-place editing with standard input',
          argvSpec: sedArgvSpec,
        });
        return { exitCode: 1 };
      }

      const runtimeCommands = createSedRuntimeCommands({
        commands: allCommands,
      });
      let lineNumber = 0;
      const stream = createInputStream({
        handle: context.stdin,
      });
      for await (const current of readTextLines({ stream })) {
        lineNumber += 1;
        const result = executeSedLine({
          runtimeCommands,
          lineNumber,
          current,
          quiet,
        });
        for (const output of result.outputs) {
          await context.text().print({ text: output });
        }
        if (result.shouldQuit) {
          break;
        }
      }
      return { exitCode: 0 };
    }

    let exitCode = 0;
    for (const file of files) {
      if (file === undefined) continue;

      try {
        const fullPath = file.startsWith('/') ? file : `${context.cwd}/${file}`;

        if (inPlace) {
          const inputBytes = await readAllFileBytes({ files: context.files, path: fullPath });
          const input = new TextDecoder().decode(inputBytes);
          const output = processText({ input });
          if (inPlaceSuffix.length > 0) {
            await writeAllFileBytes({
              files: context.files,
              path: `${fullPath}${inPlaceSuffix}`,
              data: inputBytes,
            });
          }
          await writeAllStreamToFile({
            files: context.files,
            path: fullPath,
            mode: 'truncate',
            stream: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(output));
                controller.close();
              },
            }),
          });
        } else {
          const runtimeCommands = createSedRuntimeCommands({
            commands: allCommands,
          });
          let lineNumber = 0;
          const stream = await openSedInputStream({
            context,
            file,
          });
          for await (const current of readTextLines({ stream })) {
            lineNumber += 1;
            const result = executeSedLine({
              runtimeCommands,
              lineNumber,
              current,
              quiet,
            });
            for (const output of result.outputs) {
              await context.text().print({ text: output });
            }
            if (result.shouldQuit) {
              break;
            }
          }
        }
      } catch (error: unknown) {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `sed: ${file}: ${message}\n` });
      }
    }

    return { exitCode };
  },
};
