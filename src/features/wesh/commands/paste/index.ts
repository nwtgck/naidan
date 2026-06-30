import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { openTextLineIterator } from '@/features/wesh/commands/_shared/text';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';

function delimiterForIndex({
  delimiters,
  index,
}: {
  delimiters: string,
  index: number,
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
  values: string[],
  delimiters: string,
}): string {
  if (values.length === 0) {
    return '';
  }

  let output = values[0] ?? '';
  for (let index = 1; index < values.length; index += 1) {
    output += delimiterForIndex({
      delimiters,
      index: index - 1,
    }) + (values[index] ?? '');
  }
  return output;
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
    const files = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    const writer = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    const iterators = new Set<AsyncIterator<string>>();

    try {
      if (serial) {
        let stdinIterator: AsyncIterator<string> | undefined;
        for (const file of files) {
          const iterator = file === '-'
            ? stdinIterator ??= await openTextLineIterator({ context, path: '-' })
            : await openTextLineIterator({ context, path: file });
          iterators.add(iterator);
          let valueIndex = 0;
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            if (valueIndex > 0) {
              await writer.write({
                text: delimiterForIndex({ delimiters, index: valueIndex - 1 }),
              });
            }
            await writer.write({ text: next.value });
            valueIndex += 1;
          }
          await writer.write({ text: '\n' });
        }
        return { exitCode: 0 };
      }

      let stdinIterator: AsyncIterator<string> | undefined;
      const sources: AsyncIterator<string>[] = [];
      for (const file of files) {
        const iterator = file === '-'
          ? stdinIterator ??= await openTextLineIterator({ context, path: '-' })
          : await openTextLineIterator({ context, path: file });
        sources.push(iterator);
        iterators.add(iterator);
      }

      while (true) {
        const values: string[] = [];
        let hasValue = false;
        for (const iterator of sources) {
          const next = await iterator.next();
          if (next.done) {
            values.push('');
          } else {
            values.push(next.value);
            hasValue = true;
          }
        }
        if (!hasValue) {
          break;
        }
        await writer.write({
          text: `${formatRow({ values, delimiters })}\n`,
        });
      }
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failingPath = parsed.positionals.find((path) => path !== '-') ?? '-';
      await context.text().error({ text: `paste: ${failingPath}: ${message}\n` });
      return { exitCode: 1 };
    } finally {
      await writer.flush();
      for (const iterator of iterators) {
        await iterator.return?.();
      }
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
