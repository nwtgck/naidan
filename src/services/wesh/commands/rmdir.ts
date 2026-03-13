import type { CommandDefinition, CommandResult, CommandContext } from '../types';

export const rmdir: CommandDefinition = {
  meta: {
    name: 'rmdir',
    description: 'Remove empty directories',
    usage: 'rmdir directory...',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    if (context.args.length === 0) {
      await text.error({ text: 'rmdir: missing operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    for (const p of context.args) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        const entries = await context.vfs.readDir({ path: fullPath });
        if (entries.length > 0) {
          throw new Error('Directory not empty');
        }
        await context.vfs.rm({ path: fullPath, recursive: false });
      } catch (e: any) {
        await text.error({ text: `rmdir: failed to remove '${p}': ${e.message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
