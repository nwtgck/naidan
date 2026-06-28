import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { openTextLineIterator } from '@/features/wesh/commands/_shared/text';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';

function shuffleInPlace<T>({
  items,
}: {
  items: T[],
}): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const value = items[index];
    items[index] = items[swapIndex]!;
    items[swapIndex] = value!;
  }
  return items;
}

function parseCount({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `invalid count '${value}'` };
  }
  return { ok: true, value: Number.parseInt(value, 10) };
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
    const path = parsed.positionals[0] ?? '-';
    let iterator: AsyncIterator<string> | undefined;
    try {
      iterator = await openTextLineIterator({ context, path });
      const lines: string[] = [];
      let seen = 0;
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        if (count === undefined) {
          lines.push(next.value);
        } else if (lines.length < count) {
          lines.push(next.value);
        } else if (count > 0) {
          const replacementIndex = Math.floor(Math.random() * (seen + 1));
          if (replacementIndex < count) {
            lines[replacementIndex] = next.value;
          }
        }
        seen += 1;
      }

      shuffleInPlace({ items: lines });
      const writer = createBufferedTextWriter({
        handle: context.stdout,
        maxBufferLength: 16 * 1024,
      });
      try {
        for (const line of lines) {
          await writer.write({ text: `${line}\n` });
        }
      } finally {
        await writer.flush();
      }
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `shuf: ${path}: ${message}\n` });
      return { exitCode: 1 };
    } finally {
      await iterator?.return?.();
    }
  },
};
