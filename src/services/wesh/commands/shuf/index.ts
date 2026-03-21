import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readTextFromFile, readTextFromHandle, splitTextLines } from '@/services/wesh/commands/_shared/text';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { resolvePath } from '@/services/wesh/path';

function shuffleInPlace<T>({
  items,
}: {
  items: T[];
}): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const value = shuffled[index];
    shuffled[index] = shuffled[swapIndex]!;
    shuffled[swapIndex] = value!;
  }
  return shuffled;
}

function parseCount({
  value,
}: {
  value: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `invalid count '${value}'` };
  }
  return { ok: true, value: parseInt(value, 10) };
}

async function readInputLines({
  context,
  path,
  stdinText,
}: {
  context: WeshCommandContext;
  path: string | undefined;
  stdinText: string | undefined;
}): Promise<string[]> {
  if (path === undefined || path === '-') {
    const text = stdinText ?? await readTextFromHandle({ handle: context.stdin });
    return splitTextLines({
      text,
    });
  }

  const fullPath = resolvePath({ cwd: context.cwd, path });
  return splitTextLines({
    text: await readTextFromFile({ files: context.files, path: fullPath }),
  });
}

const shufArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'n',
      long: 'head-count',
      key: 'count',
      valueName: 'count',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseCount({ value }),
      help: { summary: 'output at most COUNT lines', valueName: 'COUNT', category: 'common' },
    },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const shufCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'shuf',
    description: 'Randomly shuffle lines',
    usage: 'shuf [OPTION]... [FILE]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: shufArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'shuf',
        message: `shuf: ${diagnostic.message}`,
        argvSpec: shufArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'shuf',
        argvSpec: shufArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'shuf',
        message: `shuf: extra operand '${parsed.positionals[1] ?? ''}'`,
        argvSpec: shufArgvSpec,
      });
      return { exitCode: 1 };
    }

    const countValue = parsed.optionValues.count;
    const count = typeof countValue === 'number' ? countValue : undefined;
    const inputs = parsed.positionals.length > 0 ? parsed.positionals : [undefined];
    const lines: string[] = [];
    let stdinText: string | undefined;

    for (const input of inputs) {
      try {
        const inputLines = await readInputLines({
          context,
          path: input,
          stdinText,
        });
        if (input === '-') {
          stdinText ??= inputLines.join('\n');
        }
        lines.push(...inputLines);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const failingPath = input ?? '-';
        await context.text().error({ text: `shuf: ${failingPath}: ${message}\n` });
        return { exitCode: 1 };
      }
    }

    const shuffled = shuffleInPlace({ items: lines });
    const selected = count === undefined ? shuffled : shuffled.slice(0, count);
    const output = selected.map((line) => `${line}\n`).join('');
    await context.text().print({ text: output });
    return { exitCode: 0 };
  },
};
