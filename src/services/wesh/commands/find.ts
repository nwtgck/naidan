import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const findCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'find',
    description: 'Search for files in a directory hierarchy',
    usage: 'find [path...] [-name pattern] [-type f|d]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
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
            switch (entry.kind) {
            case 'file':
              if (typeFilter !== 'f') matches = false;
              break;
            case 'directory':
              if (typeFilter !== 'd') matches = false;
              break;
            default: {
              const _ex: never = entry.kind;
              throw new Error(`Unexpected entry kind: ${_ex}`);
            }
            }
          }

          if (matches) {
            await text.print({ text: fullPath + '\n' });
          }

          switch (entry.kind) {
          case 'directory':
            await walk({ currentPath: fullPath });
            break;
          case 'file':
            break;
          default: {
            const _ex: never = entry.kind;
            throw new Error(`Unexpected entry kind: ${_ex}`);
          }
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `find: ${currentPath}: ${message}\n` });
      }
    };

    for (const p of paths) {
      const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
      await walk({ currentPath: fullPath });
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
