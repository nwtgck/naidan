import type { CommandDefinition, CommandResult, CommandContext } from '../types';

export const help: CommandDefinition = {
  meta: {
    name: 'help',
    description: 'Display information about builtin commands',
    usage: 'help [command]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    const target = context.args[0];

    if (target) {
      const meta = context.getCommandMeta({ name: target });
      if (meta) {
        await text.print({ text: `${meta.name}: ${meta.description}\n` });
        await text.print({ text: `Usage: ${meta.usage}\n` });
        return { exitCode: 0, data: meta, error: undefined };
      } else {
        await text.error({ text: `help: no help topics match '${target}'\n` });
        return { exitCode: 1, data: undefined, error: undefined };
      }
    }

    await text.print({ text: 'Available commands:\n' });
    const names = context.getCommandNames().sort();
    for (const name of names) {
      const meta = context.getCommandMeta({ name });
      const paddedName = name.padEnd(10);
      await text.print({ text: `  ${paddedName} - ${meta?.description || ''}\n` });
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
