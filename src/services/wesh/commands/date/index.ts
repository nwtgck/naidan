import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const dateCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'date',
    description: 'Print the system date and time',
    usage: 'date [-u]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'u', long: undefined, effects: [{ key: 'utc', value: true }] },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: false,
        specialTokenParsers: [],
      },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'date',
        message: `date: ${diagnostic.message}`,
      });
      return { exitCode: 1 };
    }

    const now = new Date();
    const text = context.text();
    const out = parsed.optionValues.utc === true ? now.toUTCString() : now.toString();
    await text.print({ text: out + '\n' });

    return { exitCode: 0 };
  },
};
