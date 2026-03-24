import { parseStandardArgv } from '@/services/wesh/argv';
import type { ArgvOptionOccurrence, StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { parseAwkProgram } from '@/services/wesh/commands/awk/parser';
import { createAwkRuntime, executeAwkProgram } from '@/services/wesh/commands/awk/runtime';
import type { AwkValue } from '@/services/wesh/commands/awk/types';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { handleToStream, readFile, readFileAsText } from '@/services/wesh/utils/fs';

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
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'read the awk program from FILE', valueName: 'FILE', category: 'common' },
    },
    {
      kind: 'value',
      short: 'v',
      long: undefined,
      key: 'assignment',
      valueName: 'var=value',
      allowAttachedValue: false,
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

function parseAssignment({
  raw,
}: {
  raw: string;
}): { ok: true; name: string; value: AwkValue } | { ok: false; message: string } {
  const equalsIndex = raw.indexOf('=');
  if (equalsIndex <= 0) {
    return { ok: false, message: `awk: invalid assignment '${raw}'` };
  }

  const name = raw.slice(0, equalsIndex);
  const value = raw.slice(equalsIndex + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, message: `awk: invalid variable name '${name}'` };
  }

  return { ok: true, name, value };
}

export const awkCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'awk',
    description: 'Pattern scanning and processing language',
    usage: 'awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
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
    const runtimeVariables = new Map<string, AwkValue>();
    if (typeof parsed.optionValues.fieldSeparator === 'string') {
      runtimeVariables.set('FS', parsed.optionValues.fieldSeparator);
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
          const bytes = await readFile({
            files: context.files,
            path: resolvePath({ cwd: context.cwd, path: programFile }),
          });
          fragments.push(new TextDecoder().decode(bytes));
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

    const inputs = positionals.length === 0 ? ['-'] : positionals;
    const contents: string[] = [];
    let stdinText: string | undefined;
    let exitCode = 0;

    for (const input of inputs) {
      try {
        const content = input === '-'
          ? stdinText ??= await readTextStream({ stream: handleToStream({ handle: context.stdin }) })
          : await readFileAsText({ files: context.files, path: resolvePath({ cwd: context.cwd, path: input }) });
        contents.push(content);
      } catch (error: unknown) {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `awk: ${input}: ${message}\n` });
      }
    }

    if (contents.length === 0 && exitCode !== 0) {
      return { exitCode };
    }

    const runtime = createAwkRuntime({
      variables: runtimeVariables,
    });
    try {
      await text.print({
        text: executeAwkProgram({
          program: parsedProgram.program,
          runtime,
          inputs: contents,
        }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `${message}\n` });
      return { exitCode: 2 };
    }

    return { exitCode };
  },
};
