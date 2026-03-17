import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const rmCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'rm',
    description: 'Remove files or directories',
    usage: 'rm [-r] [-f] path...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['r', 'f'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'rm: missing operand\n' });
      return { exitCode: 1 };
    }

    const recursive = !!flags.r;
    const force = !!flags.f;

    const removeRecursive = async (path: string) => {
      const st = await context.kernel.stat({ path });
      switch (st.type) {
      case 'directory': {
        if (!recursive) {
          throw new Error('is a directory');
        }
        const entries = await context.kernel.readDir({ path });
        for (const entry of entries) {
          await removeRecursive(`${path}/${entry.name}`);
        }
        await context.kernel.rmdir({ path });
        break;
      }      case 'file':
        await context.kernel.unlink({ path });
        break;
      default: {
        const _ex: never = st.type;
        throw new Error(`Unhandled type: ${_ex}`);
      }
      }
    };

    for (const p of positional) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        await removeRecursive(fullPath);
      } catch (e: unknown) {
        if (!force) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `rm: cannot remove '${p}': ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
