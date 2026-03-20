import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { handleToStream, readFile, writeFile } from '@/services/wesh/utils/fs';

type SedAddress =
  | { kind: 'line'; lineNumber: number }
  | { kind: 'regex'; regex: RegExp };

type SedCommand =
  | { kind: 'substitute'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined; regex: RegExp; replacement: string; global: boolean; print: boolean }
  | { kind: 'print'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined }
  | { kind: 'delete'; address: SedAddress | undefined; rangeEnd: SedAddress | undefined };

interface SedRuntimeCommand {
  command: SedCommand;
  inRange: boolean;
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
  runtimeCommand: SedRuntimeCommand;
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
  context,
}: {
  context: WeshCommandContext;
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const buf = new Uint8Array(4096);
      const { bytesRead } = await context.stdin.read({ buffer: buf });
      if (bytesRead === 0) {
        controller.close();
        return;
      }
      controller.enqueue(buf.subarray(0, bytesRead));
    }
  });
}

async function readStreamText({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  reader.releaseLock();
  return result;
}

function splitLines({
  text,
}: {
  text: string;
}): Array<{ line: string; hadNewline: boolean }> {
  if (text.length === 0) return [];

  const parts = text.split('\n');
  return parts.map((part, index) => ({
    line: part,
    hadNewline: index < parts.length - 1,
  }));
}

function buildSedOutput({
  input,
  commands,
  quiet,
}: {
  input: string;
  commands: SedCommand[];
  quiet: boolean;
}): string {
  const runtimeCommands = commands.map((command) => ({
    command,
    inRange: false,
  }));
  const outputParts: string[] = [];
  const lines = splitLines({ text: input });

  for (let index = 0; index < lines.length; index++) {
    const current = lines[index];
    if (current === undefined) continue;

    let patternSpace = current.line;
    let deleted = false;
    const explicitPrints: string[] = [];

    for (const runtimeCommand of runtimeCommands) {
      if (!commandApplies({
        runtimeCommand,
        lineNumber: index + 1,
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
      case 'print':
        explicitPrints.push(patternSpace);
        break;
      case 'delete':
        deleted = true;
        break;
      default: {
        const _ex: never = runtimeCommand.command;
        throw new Error(`Unhandled sed command kind: ${_ex}`);
      }
      }

      if (deleted) break;
    }

    for (const printed of explicitPrints) {
      outputParts.push(current.hadNewline ? `${printed}\n` : printed);
    }

    if (!deleted && !quiet) {
      outputParts.push(current.hadNewline ? `${patternSpace}\n` : patternSpace);
    }
  }

  return outputParts.join('');
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
        { kind: 'flag', short: 'n', long: 'quiet', effects: [{ key: 'quiet', value: true }] },
        { kind: 'flag', short: undefined, long: 'silent', effects: [{ key: 'quiet', value: true }] },
        {
          kind: 'value',
          short: 'e',
          long: 'expression',
          key: 'expression',
          valueName: 'script',
          allowAttachedValue: true,
          parseValue: undefined,
        },
        {
          kind: 'value',
          short: 'f',
          long: 'file',
          key: 'scriptFile',
          valueName: 'script-file',
          allowAttachedValue: true,
          parseValue: undefined,
        },
        { kind: 'flag', short: 'r', long: undefined, effects: [{ key: 'extendedRegexp', value: true }] },
        { kind: 'flag', short: 'E', long: undefined, effects: [{ key: 'extendedRegexp', value: true }] },
        {
          kind: 'value',
          short: 'i',
          long: 'in-place',
          key: 'inPlaceSuffix',
          valueName: 'suffix',
          allowAttachedValue: true,
          parseValue: undefined,
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
      });
      return { exitCode: 2 };
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
        const bytes = await readFile({ kernel: context.kernel, path: fullPath });
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
    }): string => buildSedOutput({
      input,
      commands: allCommands,
      quiet,
    });

    if (files.length === 0) {
      if (inPlace) {
        await writeCommandUsageError({
          context,
          command: 'sed',
          message: 'sed: cannot use in-place editing with standard input',
        });
        return { exitCode: 1 };
      }

      const output = processText({
        input: await readStreamText({ stream: createInputStream({ context }) }),
      });
      await context.text().print({ text: output });
      return { exitCode: 0 };
    }

    let exitCode = 0;
    for (const file of files) {
      if (file === undefined) continue;

      try {
        const fullPath = file.startsWith('/') ? file : `${context.cwd}/${file}`;
        const handle = await context.kernel.open({
          path: fullPath,
          flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
        });
        const input = await readStreamText({ stream: handleToStream({ handle }) });
        const output = processText({ input });

        if (inPlace) {
          if (inPlaceSuffix.length > 0) {
            await writeFile({
              kernel: context.kernel,
              path: `${fullPath}${inPlaceSuffix}`,
              data: new TextEncoder().encode(input),
            });
          }
          await writeFile({
            kernel: context.kernel,
            path: fullPath,
            data: encoder.encode(output),
          });
        } else {
          await context.text().print({ text: output });
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
