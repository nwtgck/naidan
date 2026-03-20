import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readTextFromFile, readTextFromHandle, splitTextLines } from '@/services/wesh/commands/_shared/text';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { resolvePath } from '@/services/wesh/path';

function delimiterForIndex({
  delimiters,
  index,
}: {
  delimiters: string;
  index: number;
}): string {
  if (delimiters.length === 0) {
    return '';
  }
  return delimiters[index % delimiters.length] ?? '';
}

function formatRow({
  values,
  delimiters,
}: {
  values: string[];
  delimiters: string;
}): string {
  if (values.length === 0) {
    return '';
  }

  let output = values[0] ?? '';
  for (let index = 1; index < values.length; index++) {
    output += delimiterForIndex({
      delimiters,
      index: index - 1,
    }) + (values[index] ?? '');
  }
  return output;
}

async function readFileLines({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<string[]> {
  const fullPath = resolvePath({ cwd: context.cwd, path });
  const text = await readTextFromFile({ files: context.files, path: fullPath });
  return splitTextLines({ text });
}

const pasteArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'd',
      long: 'delimiters',
      key: 'delimiters',
      valueName: 'list',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'reuse characters from LIST as output delimiters', valueName: 'LIST', category: 'common' },
    },
    { kind: 'flag', short: 's', long: 'serial', effects: [{ key: 'serial', value: true }], help: { summary: 'paste one file at a time instead of in parallel', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const pasteCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'paste',
    description: 'Merge lines of files in parallel or serially',
    usage: 'paste [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: pasteArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'paste',
        message: `paste: ${diagnostic.message}`,
        argvSpec: pasteArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'paste',
        argvSpec: pasteArgvSpec,
      });
      return { exitCode: 0 };
    }

    const delimiters = typeof parsed.optionValues.delimiters === 'string' ? parsed.optionValues.delimiters : '\t';
    const serial = parsed.optionValues.serial === true;
    const files = parsed.positionals.length > 0 ? parsed.positionals : [undefined];

    try {
      const fileLinesByPath = new Map<string, string[]>();
      for (const file of files) {
        if (file === undefined || file === '-') {
          continue;
        }

        if (fileLinesByPath.has(file)) {
          continue;
        }

        fileLinesByPath.set(file, await readFileLines({
          context,
          path: file,
        }));
      }

      const stdinInputs = files.filter((file) => file === undefined || file === '-').length;
      const stdinLines = stdinInputs > 0
        ? splitTextLines({
          text: await readTextFromHandle({ handle: context.stdin }),
        })
        : [];
      let stdinCursor = 0;

      const sources: string[][] = [];
      if (serial) {
        for (const file of files) {
          if (file === undefined || file === '-') {
            const lines = stdinLines.slice(stdinCursor);
            stdinCursor = stdinLines.length;
            sources.push(lines);
            continue;
          }

          sources.push(fileLinesByPath.get(file) ?? []);
        }
      } else {
        const nonStdinMaxLength = Array.from(fileLinesByPath.values()).reduce((max, lines) => Math.max(max, lines.length), 0);
        const stdinRowCount = stdinInputs > 0 ? Math.ceil(stdinLines.length / stdinInputs) : 0;
        const rowCount = Math.max(nonStdinMaxLength, stdinRowCount);
        const outputLines: string[] = [];

        for (let row = 0; row < rowCount; row++) {
          const values: string[] = [];
          for (const file of files) {
            if (file === undefined || file === '-') {
              values.push(stdinLines[stdinCursor++] ?? '');
              continue;
            }

            values.push(fileLinesByPath.get(file)?.[row] ?? '');
          }

          outputLines.push(formatRow({
            values,
            delimiters,
          }));
        }

        await context.text().print({
          text: outputLines.map((line) => `${line}\n`).join(''),
        });
        return { exitCode: 0 };
      }

      const outputLines = sources.map((lines) => formatRow({
        values: lines,
        delimiters,
      }));

      await context.text().print({
        text: outputLines.map((line) => `${line}\n`).join(''),
      });
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failingPath = parsed.positionals.find((path) => path !== '-') ?? '-';
      await context.text().error({ text: `paste: ${failingPath}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
