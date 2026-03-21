import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { JsonValue } from '@/services/wesh/commands/jq/ast';
import { formatJsonOutput, parseJsonSequence } from '@/services/wesh/commands/jq/json';
import { parseJqProgram } from '@/services/wesh/commands/jq/parser';
import { evaluateJqFilter } from '@/services/wesh/commands/jq/runtime';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { handleToStream } from '@/services/wesh/utils/fs';

const jqArgvSpec: StandardArgvParserSpec = {
  options: [
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

function resolvePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

async function readTextStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
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

async function readInputText({
  context,
  path,
  stdinText,
}: {
  context: WeshCommandContext;
  path: string;
  stdinText: string | undefined;
}): Promise<{ ok: true; text: string; stdinText: string | undefined } | { ok: false; message: string }> {
  try {
    if (path === '-') {
      const nextStdinText = stdinText ?? await readTextStream({
        stream: handleToStream({ handle: context.stdin }),
      });
      return { ok: true, text: nextStdinText, stdinText: nextStdinText };
    }

    const handle = await context.files.open({
      path: resolvePath({ cwd: context.cwd, path }),
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    return {
      ok: true,
      text: await readTextStream({ stream: handleToStream({ handle }) }),
      stdinText,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `jq: ${path}: ${message}` };
  }
}

export const jqCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'jq',
    description: 'Query and transform JSON values with jq-style filters',
    usage: 'jq [FILTER] [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: jqArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'jq',
        message: `jq: ${diagnostic.message}`,
        argvSpec: jqArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'jq',
        argvSpec: jqArgvSpec,
      });
      return { exitCode: 0 };
    }

    const filterSource = parsed.positionals[0];
    if (filterSource === undefined) {
      await writeCommandUsageError({
        context,
        command: 'jq',
        message: 'jq: missing filter',
        argvSpec: jqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const program = parseJqProgram({ source: filterSource });
    if (!program.ok) {
      await context.text().error({ text: `jq: parse error: ${program.message}\n` });
      return { exitCode: 3 };
    }

    const paths = parsed.positionals.slice(1);
    const inputs = paths.length === 0 ? ['-'] : paths;
    let stdinText: string | undefined;
    const values: JsonValue[] = [];
    let exitCode = 0;

    for (const path of inputs) {
      const loaded = await readInputText({
        context,
        path,
        stdinText,
      });
      if (!loaded.ok) {
        await context.text().error({ text: `${loaded.message}\n` });
        exitCode = 4;
        continue;
      }
      stdinText = loaded.stdinText;

      const parsedInput = parseJsonSequence({ text: loaded.text });
      if (!parsedInput.ok) {
        await context.text().error({ text: `jq: ${parsedInput.message}\n` });
        exitCode = 4;
        continue;
      }

      values.push(...parsedInput.values);
    }

    for (const value of values) {
      const result = evaluateJqFilter({
        filter: program.program.filter,
        input: value,
      });
      if (!result.ok) {
        await context.text().error({ text: `jq: error: ${result.error.message}\n` });
        return { exitCode: 4 };
      }

      for (const output of result.outputs) {
        await context.text().print({ text: formatJsonOutput({ value: output }) });
      }
    }

    return { exitCode };
  },
};
