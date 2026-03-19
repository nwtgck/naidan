import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const commandCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'command',
    description: 'Run command with arguments, ignoring any function or alias',
    usage: 'command [-v] command [argument...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'v', long: undefined, effects: [{ key: 'verbose', value: true }] },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: false,
        specialTokenParsers: [],
      },
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'command',
        message: `command: ${diagnostic.message}`,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 0) return { exitCode: 0 };

    const cmdName = parsed.positionals[0]!;
    const meta = context.getWeshCommandMeta({ name: cmdName });

    if (parsed.optionValues.verbose === true) {
      if (meta) {
        await text.print({ text: `${cmdName}\n` });
        return { exitCode: 0 };
      }
      return { exitCode: 1 };
    }

    if (!meta) {
      await text.error({ text: `command: ${cmdName} not found\n` });
      return { exitCode: 1 };
    }

    return { exitCode: 0 };
  },
};
