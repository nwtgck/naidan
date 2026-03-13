import type { CommandDefinition, CommandResult, CommandContext } from '../types';

export const cd: CommandDefinition = {
  meta: {
    name: 'cd',
    description: 'Change current directory',
    usage: 'cd [path]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const target = context.args[0] || '/';
    const text = context.text();

    try {
      let fullPath: string;
      if (target === '-') {
        fullPath = context.env.OLDPWD || '/';
      } else {
        fullPath = target.startsWith('/') ? target : `${context.cwd}/${target}`;
      }

      const res = await context.vfs.resolve({ path: fullPath });
      if (res.handle.kind !== 'directory') {
        throw new Error(`Not a directory: ${target}`);
      }

      context.setCwd({ path: res.fullPath });
      return { exitCode: 0, data: undefined, error: undefined };
    } catch (e: any) {
      await text.error({ text: `cd: ${target}: ${e.message}\n` });
      return { exitCode: 1, data: undefined, error: e.message };
    }
  },
};
