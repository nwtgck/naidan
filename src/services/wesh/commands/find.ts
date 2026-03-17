import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const findCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'find',
    description: 'Search for files in a directory hierarchy',
    usage: 'find [path...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    const text = context.text();
    const paths = positional.length > 0 ? positional : ['.'];

    const walk = async (currentPath: string) => {
      await text.print({ text: currentPath + '\n' });

      try {
        const entries = await context.kernel.readDir({ path: currentPath });
        for (const entry of entries) {
          const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          switch (entry.type) {
          case 'directory':
            await walk(entryPath);
            break;
          case 'file':
            await text.print({ text: entryPath + '\n' });
            break;
          default: {
            const _ex: never = entry.type;
            throw new Error(`Unhandled type: ${_ex}`);
          }
          }
        }
      } catch (e: unknown) {
        // Not a directory or access denied
      }
    };

    for (const p of paths) {
      if (p === undefined) continue;
      const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
      await walk(fullPath);
    }

    return { exitCode: 0 };
  },
};
