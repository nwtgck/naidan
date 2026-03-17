import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const helpCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'help',
    description: 'Display information about builtin commands',
    usage: 'help [command]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    const target = context.args[0];

    if (target) {
      const meta = context.getCommandMeta({ name: target });
      if (meta) {
        await text.print({ text: `${meta.name}: ${meta.description}\n` });
        await text.print({ text: `Usage: ${meta.usage}\n` });
        return { exitCode: 0 };
      } else {
        await text.error({ text: `help: no help topics match '${target}'\n` });
        return { exitCode: 1 };
      }
    }

    await text.print({ text: 'Available commands:\n' });
    const names = context.getCommandNames().sort();
    for (const name of names) {
      const meta = context.getCommandMeta({ name });
      const paddedName = name.padEnd(10);
      await text.print({ text: `  ${paddedName} - ${meta?.description || ''}\n` });
    }

    return { exitCode: 0 };
  },
};
