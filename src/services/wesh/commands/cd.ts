import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const cdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cd',
    description: 'Change current directory',
    usage: 'cd [path]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const target = context.args[0] || '/';
    const text = context.text();

    try {
      let fullPath: string;
      if (target === '-') {
        fullPath = context.env.get('OLDPWD') || '/';
      } else {
        fullPath = target.startsWith('/') ? target : `${context.cwd}/${target}`;
      }

      const res = await context.kernel.resolve({ path: fullPath });
      if (res.stat.type !== 'directory') {
        throw new Error(`Not a directory: ${target}`);
      }

      context.setCwd({ path: res.fullPath });
      return { exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `cd: ${target}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
