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

      const res = await context.vfs.resolve({ path: fullPath });
      switch (res.handle.kind) {
      case 'directory':
        break;
      case 'file':
        throw new Error(`Not a directory: ${target}`);
      default: {
        const _ex: never = res.handle.kind;
        throw new Error(`Unexpected handle kind: ${_ex}`);
      }
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
