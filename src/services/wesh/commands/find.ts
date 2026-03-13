import type { CommandDefinition, CommandResult, CommandContext } from '../types';
import { parseFlags } from '../utils/args';

export const find: CommandDefinition = {
  meta: {
    name: 'find',
    description: 'Search for files in a directory hierarchy',
    usage: 'find [path...] [-name pattern] [-type f|d]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: ['name', 'type'],
    });

    const paths = positional.length > 0 ? positional : ['.'];
    const namePattern = flags.name as string | undefined;
    const typeFilter = flags.type as string | undefined;
    const text = context.text();

    const walk = async ({ currentPath }: { currentPath: string }) => {
      try {
        const entries = await context.vfs.readDir({ path: currentPath });
        for (const entry of entries) {
          const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          
          let matches = true;
          if (namePattern) {
            /** Very simple glob-to-regex conversion */
            const globRegex = new RegExp('^' + namePattern.replace(/\*/g, '.*') + '$');
            if (!globRegex.test(entry.name)) matches = false;
          }
          if (typeFilter) {
            if (typeFilter === 'f' && entry.kind !== 'file') matches = false;
            if (typeFilter === 'd' && entry.kind !== 'directory') matches = false;
          }

          if (matches) {
            await text.print({ text: fullPath + '\n' });
          }

          if (entry.kind === 'directory') {
            await walk({ currentPath: fullPath });
          }
        }
      } catch (e: any) {
        await text.error({ text: `find: ${currentPath}: ${e.message}\n` });
      }
    };

    for (const p of paths) {
      const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
      await walk({ currentPath: fullPath });
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
