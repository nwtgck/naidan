import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';

export const echoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'echo',
    description: 'Display a line of text',
    usage: 'echo [-n] [string...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'n', long: undefined, effects: [{ key: 'noNewline', value: true }], help: { summary: 'do not output the trailing newline' } },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const text = context.text();
    await text.print({ text: parsed.positionals.join(' ') });

    if (parsed.optionValues.noNewline !== true) {
      await text.print({ text: '\n' });
    }

    return { exitCode: 0 };
  },
};
