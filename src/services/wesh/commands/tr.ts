import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const tr: CommandDefinition = {
  meta: {
    name: 'tr',
    description: 'Translate or delete characters',
    usage: 'tr [-d] set1 [set2]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['d'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length < 1) {
      await text.error({ text: 'tr: missing operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    const set1 = positional[0]!;
    const set2 = positional[1] || '';
    const deleteMode = !!flags.d;

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

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
