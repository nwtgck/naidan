import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const trCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'tr',
    description: 'Translate or delete characters',
    usage: 'tr [-d] set1 [set2]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'd', long: undefined, effects: [{ key: 'delete', value: true }] },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const text = context.text();
    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: `tr: ${parsed.diagnostics[0]!.message}`,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length < 1) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: 'tr: missing operand',
      });
      return { exitCode: 1 };
    }

    const set1 = parsed.positionals[0]!;
    const set2 = parsed.positionals[1] || '';
    const deleteMode = parsed.optionValues.delete === true;

    const map = new Map<string, string>();
    if (!deleteMode) {
      for (let i = 0; i < set1.length; i++) {
        const char1 = set1[i];
        if (char1 !== undefined) {
          map.set(char1, set2[i] || set2[set2.length - 1] || char1);
        }
      }
    }

    for await (const line of text.input) {
      let out = '';
      for (const char of line) {
        if (deleteMode) {
          if (!set1.includes(char)) out += char;
        } else {
          out += map.get(char) || char;
        }
      }
      await text.print({ text: out + '\n' });
    }

    return { exitCode: 0 };
  },
};
