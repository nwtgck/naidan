import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { jqArgvSpec, parseJqArgv, type JqInjectedArgument } from '@/services/wesh/commands/jq/argv';
import type { JsonValue } from '@/services/wesh/commands/jq/ast';
import { validateJqProgram } from '@/services/wesh/commands/jq/compile';
import { formatJsonOutput, iterateJsonSequence, parseJsonSequence } from '@/services/wesh/commands/jq/json';
import { parseJqProgram } from '@/services/wesh/commands/jq/parser';
import { evaluateJqFilter } from '@/services/wesh/commands/jq/runtime';
import { createJsonObject, defineJsonProperty } from '@/services/wesh/commands/jq/value';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { openHandleReadStream, readAllFileText } from '@/services/wesh/utils/fs';

const OUTPUT_BUFFER_LIMIT = 16 * 1024;
const JQ_WESH_VERSION = 'jq-wesh-1.7-compatible';

interface JqOutputOptions {
  compact: boolean,
  raw: boolean,
  join: boolean,
  asciiOnly: boolean,
  sortKeys: boolean,
  indentation: number | '\t',
  nullSeparator: boolean,
  unbuffered: boolean,
}

interface JqInputOptions {
  nullInput: boolean,
  rawInput: boolean,
  slurp: boolean,
}

class BufferedStdout {
  private readonly context: WeshCommandContext;
  private pending = '';

  public constructor({
    context,
  }: {
    context: WeshCommandContext,
  }) {
    this.context = context;
  }

  public async write({
    text,
    flush,
  }: {
    text: string,
    flush: boolean,
  }): Promise<void> {
    if (text.length >= OUTPUT_BUFFER_LIMIT && this.pending.length === 0) {
      await this.context.text().print({ text });
      return;
    }

    this.pending += text;
    if (flush || this.pending.length >= OUTPUT_BUFFER_LIMIT) {
      await this.flush();
    }
  }

  public async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const text = this.pending;
    this.pending = '';
    await this.context.text().print({ text });
  }
}

function optionBoolean({
  optionValues,
  key,
}: {
  optionValues: Record<string, boolean | string | number>,
  key: string,
}): boolean {
  return optionValues[key] === true;
}

function optionString({
  optionValues,
  key,
}: {
  optionValues: Record<string, boolean | string | number>,
  key: string,
}): string | undefined {
  const value = optionValues[key];
  return typeof value === 'string' ? value : undefined;
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) return path;
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

async function readTextStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function readPathText({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<{ ok: true, text: string } | { ok: false, message: string }> {
  try {
    return {
      ok: true,
      text: await readAllFileText({
        files: context.files,
        path: resolvePath({ cwd: context.cwd, path }),
      }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `jq: error: Could not open file ${path}: ${message}` };
  }
}

async function readInputText({
  context,
  path,
  stdinState,
}: {
  context: WeshCommandContext,
  path: string,
  stdinState: { consumed: boolean },
}): Promise<{ ok: true, text: string } | { ok: false, message: string }> {
  if (path !== '-') return readPathText({ context, path });
  if (stdinState.consumed) return { ok: true, text: '' };

  stdinState.consumed = true;
  try {
    return {
      ok: true,
      text: await readTextStream({
        stream: openHandleReadStream({ handle: context.stdin }),
      }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `jq: error: Could not read standard input: ${message}` };
  }
}

function rawInputLines({
  text,
}: {
  text: string,
}): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function parseSingleJson({
  source,
  label,
}: {
  source: string,
  label: string,
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  const parsed = parseJsonSequence({ text: source });
  if (!parsed.ok) return { ok: false, message: `${label}: ${parsed.message}` };
  if (parsed.values.length !== 1) {
    return { ok: false, message: `${label}: expected exactly one JSON value` };
  }
  return { ok: true, value: parsed.values[0]! };
}

function createArgsVariable({
  named,
  positional,
}: {
  named: { [key: string]: JsonValue },
  positional: JsonValue[],
}): JsonValue {
  const args = createJsonObject();
  defineJsonProperty({ object: args, key: 'positional', value: positional });
  defineJsonProperty({ object: args, key: 'named', value: named });
  return args;
}

async function resolveVariables({
  context,
  injectedArguments,
  positionalArguments,
  jsonArguments,
}: {
  context: WeshCommandContext,
  injectedArguments: readonly JqInjectedArgument[],
  positionalArguments: readonly string[],
  jsonArguments: boolean,
}): Promise<
  | { ok: true, variables: Readonly<Record<string, JsonValue>> }
  | { ok: false, message: string }
> {
  const variables = createJsonObject();
  const named = createJsonObject();

  for (const argument of injectedArguments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument.name)) {
      return { ok: false, message: `jq: invalid variable name '${argument.name}'` };
    }

    let value: JsonValue;
    switch (argument.kind) {
    case 'string':
      value = argument.value;
      break;
    case 'json': {
      const parsed = parseSingleJson({
        source: argument.value,
        label: `jq: invalid JSON text passed to --argjson ${argument.name}`,
      });
      if (!parsed.ok) return parsed;
      value = parsed.value;
      break;
    }
    case 'rawfile': {
      const loaded = await readPathText({ context, path: argument.value });
      if (!loaded.ok) return loaded;
      value = loaded.text;
      break;
    }
    case 'slurpfile': {
      const loaded = await readPathText({ context, path: argument.value });
      if (!loaded.ok) return loaded;
      const parsed = parseJsonSequence({ text: loaded.text });
      if (!parsed.ok) {
        return { ok: false, message: `jq: ${argument.value}: ${parsed.message}` };
      }
      value = parsed.values;
      break;
    }
    default: {
      const _ex: never = argument.kind;
      throw new Error(`Unhandled jq injected argument: ${_ex}`);
    }
    }

    defineJsonProperty({ object: variables, key: argument.name, value });
    defineJsonProperty({ object: named, key: argument.name, value });
  }

  const positional: JsonValue[] = [];
  for (const argument of positionalArguments) {
    if (!jsonArguments) {
      positional.push(argument);
      continue;
    }
    const parsed = parseSingleJson({ source: argument, label: 'jq: invalid JSON text passed to --jsonargs' });
    if (!parsed.ok) return parsed;
    positional.push(parsed.value);
  }

  defineJsonProperty({
    object: variables,
    key: 'ARGS',
    value: createArgsVariable({ named, positional }),
  });
  return { ok: true, variables };
}

function resolveOutputIndentation({
  occurrences,
  indentValue,
}: {
  occurrences: readonly { option: string }[],
  indentValue: boolean | string | number | undefined,
}): number | '\t' {
  let indentation: number | '\t' = 2;
  for (const occurrence of occurrences) {
    if (occurrence.option === '--tab') indentation = '\t';
    if (occurrence.option === '--indent' && typeof indentValue === 'number') indentation = indentValue;
  }
  return indentation;
}

type JqArgumentMode = 'files' | 'strings' | 'json';

function resolveArgumentMode({
  occurrences,
}: {
  occurrences: readonly { option: string }[],
}): JqArgumentMode {
  let mode: JqArgumentMode = 'files';
  for (const occurrence of occurrences) {
    if (occurrence.option === '--args') mode = 'strings';
    if (occurrence.option === '--jsonargs') mode = 'json';
  }
  return mode;
}

function resolveArgumentConfiguration({
  mode,
  operands,
}: {
  mode: JqArgumentMode,
  operands: string[],
}): {
  positionalArguments: string[],
  jsonArguments: boolean,
  inputPaths: string[],
} {
  switch (mode) {
  case 'files':
    return {
      positionalArguments: [],
      jsonArguments: false,
      inputPaths: operands.length > 0 ? operands : ['-'],
    };
  case 'strings':
    return {
      positionalArguments: operands,
      jsonArguments: false,
      inputPaths: ['-'],
    };
  case 'json':
    return {
      positionalArguments: operands,
      jsonArguments: true,
      inputPaths: ['-'],
    };
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled jq argument mode: ${_ex}`);
  }
  }
}

async function writeRuntimeError({
  context,
  stdout,
  message,
}: {
  context: WeshCommandContext,
  stdout: BufferedStdout,
  message: string,
}): Promise<WeshCommandResult> {
  await stdout.flush();
  await context.text().error({ text: `jq: error: ${message}\n` });
  return { exitCode: 5 };
}

export const jqCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'jq',
    description: 'Query and transform JSON values with jq-style filters',
    usage: 'jq [OPTION]... FILTER [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedJq = parseJqArgv({ args: context.args });
    const parsed = parsedJq.standard;
    const diagnostic = parsedJq.grammarDiagnostic ?? parsed.diagnostics[0]?.message;
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'jq',
        message: `jq: ${diagnostic}`,
        argvSpec: jqArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (optionBoolean({ optionValues: parsed.optionValues, key: 'help' })) {
      await writeCommandHelp({
        context,
        command: 'jq',
        argvSpec: jqArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (optionBoolean({ optionValues: parsed.optionValues, key: 'version' })) {
      await context.text().print({ text: `${JQ_WESH_VERSION}\n` });
      return { exitCode: 0 };
    }

    const filterFile = optionString({ optionValues: parsed.optionValues, key: 'filterFile' });
    let filterSource: string;
    let operands: string[];
    if (filterFile !== undefined) {
      const loaded = await readPathText({ context, path: filterFile });
      if (!loaded.ok) {
        await context.text().error({ text: `${loaded.message}\n` });
        return { exitCode: 2 };
      }
      filterSource = loaded.text;
      operands = parsed.positionals;
    } else {
      const positionalFilter = parsed.positionals[0];
      if (positionalFilter === undefined) {
        await writeCommandUsageError({
          context,
          command: 'jq',
          message: 'jq: missing filter',
          argvSpec: jqArgvSpec,
        });
        return { exitCode: 2 };
      }
      filterSource = positionalFilter;
      operands = parsed.positionals.slice(1);
    }

    const program = parseJqProgram({ source: filterSource });
    if (!program.ok) {
      await context.text().error({ text: `jq: parse error: ${program.message}\n` });
      return { exitCode: 3 };
    }

    const argumentMode = resolveArgumentMode({ occurrences: parsed.occurrences });
    const argumentConfiguration = resolveArgumentConfiguration({
      mode: argumentMode,
      operands,
    });
    const variables = await resolveVariables({
      context,
      injectedArguments: parsedJq.injectedArguments,
      positionalArguments: argumentConfiguration.positionalArguments,
      jsonArguments: argumentConfiguration.jsonArguments,
    });
    if (!variables.ok) {
      await context.text().error({ text: `${variables.message}\n` });
      return { exitCode: 2 };
    }

    const compiled = validateJqProgram({
      program: program.program,
      variables: Object.keys(variables.variables),
    });
    if (!compiled.ok) {
      await context.text().error({ text: `jq: error: ${compiled.message}\n` });
      return { exitCode: 3 };
    }

    const inputOptions: JqInputOptions = {
      nullInput: optionBoolean({ optionValues: parsed.optionValues, key: 'nullInput' }),
      rawInput: optionBoolean({ optionValues: parsed.optionValues, key: 'rawInput' }),
      slurp: optionBoolean({ optionValues: parsed.optionValues, key: 'slurp' }),
    };
    const rawOutput0 = optionBoolean({ optionValues: parsed.optionValues, key: 'rawOutput0' });
    const outputOptions: JqOutputOptions = {
      compact: optionBoolean({ optionValues: parsed.optionValues, key: 'compactOutput' }),
      raw: rawOutput0 || optionBoolean({ optionValues: parsed.optionValues, key: 'rawOutput' }),
      join: optionBoolean({ optionValues: parsed.optionValues, key: 'joinOutput' }),
      asciiOnly: optionBoolean({ optionValues: parsed.optionValues, key: 'asciiOutput' }),
      sortKeys: optionBoolean({ optionValues: parsed.optionValues, key: 'sortKeys' }),
      indentation: resolveOutputIndentation({
        occurrences: parsed.occurrences,
        indentValue: parsed.optionValues.indent,
      }),
      nullSeparator: rawOutput0,
      unbuffered: optionBoolean({ optionValues: parsed.optionValues, key: 'unbuffered' }),
    };

    const stdout = new BufferedStdout({ context });
    let hadOutput = false;
    let lastOutput: JsonValue | undefined;

    const evaluateInput = async ({
      value,
    }: {
      value: JsonValue,
    }): Promise<WeshCommandResult | undefined> => {
      const result = evaluateJqFilter({
        filter: program.program.filter,
        input: value,
        variables: variables.variables,
      });
      if (!result.ok) {
        return writeRuntimeError({ context, stdout, message: result.error.message });
      }

      for (const output of result.outputs) {
        hadOutput = true;
        lastOutput = output;
        await stdout.write({
          text: formatJsonOutput({
            value: output,
            compact: outputOptions.compact,
            raw: outputOptions.raw,
            join: outputOptions.join,
            asciiOnly: outputOptions.asciiOnly,
            sortKeys: outputOptions.sortKeys,
            indentation: outputOptions.indentation,
            nullSeparator: outputOptions.nullSeparator,
          }),
          flush: outputOptions.unbuffered,
        });
      }
      return undefined;
    };

    if (inputOptions.nullInput) {
      const failed = await evaluateInput({ value: null });
      if (failed !== undefined) return failed;
    } else {
      const paths = argumentConfiguration.inputPaths;
      const stdinState = { consumed: false };
      const slurpedValues: JsonValue[] = [];
      let slurpedRaw = '';
      let inputExitCode = 0;

      for (const path of paths) {
        const loaded = await readInputText({ context, path, stdinState });
        if (!loaded.ok) {
          await stdout.flush();
          await context.text().error({ text: `${loaded.message}\n` });
          inputExitCode = 2;
          continue;
        }

        if (inputOptions.rawInput) {
          if (inputOptions.slurp) {
            slurpedRaw += loaded.text;
            continue;
          }
          for (const line of rawInputLines({ text: loaded.text })) {
            const failed = await evaluateInput({ value: line });
            if (failed !== undefined) return failed;
          }
          continue;
        }

        for (const entry of iterateJsonSequence({ text: loaded.text })) {
          if (!entry.ok) {
            await stdout.flush();
            await context.text().error({ text: `jq: parse error: ${entry.message}\n` });
            return { exitCode: 5 };
          }
          if (inputOptions.slurp) {
            slurpedValues.push(entry.value);
          } else {
            const failed = await evaluateInput({ value: entry.value });
            if (failed !== undefined) return failed;
          }
        }
      }

      if (inputOptions.slurp) {
        const failed = await evaluateInput({
          value: inputOptions.rawInput ? slurpedRaw : slurpedValues,
        });
        if (failed !== undefined) return failed;
      }

      if (inputExitCode !== 0) {
        await stdout.flush();
        return { exitCode: inputExitCode };
      }
    }

    await stdout.flush();
    if (!optionBoolean({ optionValues: parsed.optionValues, key: 'exitStatus' })) {
      return { exitCode: 0 };
    }
    if (!hadOutput) return { exitCode: 4 };
    return { exitCode: lastOutput === false || lastOutput === null ? 1 : 0 };
  },
};
