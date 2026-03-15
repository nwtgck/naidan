import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';

export const mvCommandDefinition: CommandDefinition = {
  meta: {
    name: 'mv',
    description: 'Move or rename files',
    usage: 'mv source destination',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    if (context.args.length < 2) {
      await text.error({ text: 'mv: missing file operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    const src = context.args[0]!;
    const dest = context.args[1]!;

    try {
      const fullSrc = src.startsWith('/') ? src : `${context.cwd}/${src}`;
      let fullDest = dest.startsWith('/') ? dest : `${context.cwd}/${dest}`;

      const destExists = await context.vfs.exists({ path: fullDest });
      if (destExists) {
        const destStat = await context.vfs.stat({ path: fullDest });
        switch (destStat.kind) {
        case 'directory': {
          const srcName = src.split('/').pop()!;
          fullDest = fullDest === '/' ? `/${srcName}` : `${fullDest}/${srcName}`;
          break;
        }
        case 'file':
          break;
        default: {
          const _ex: never = destStat.kind;
          throw new Error(`Unexpected kind: ${_ex}`);
        }
        }
      }

      const copyRecursive = async ({ s, d }: { s: string, d: string }) => {
        const stat = await context.vfs.stat({ path: s });
        switch (stat.kind) {
        case 'file': {
          const stream = await context.vfs.readFile({ path: s });
          await context.vfs.writeFile({ path: d, stream });
          break;
        }
        case 'directory': {
          await context.vfs.mkdir({ path: d, recursive: true });
          const entries = await context.vfs.readDir({ path: s });
          for (const e of entries) {
            await copyRecursive({
              s: s === '/' ? `/${e.name}` : `${s}/${e.name}`,
              d: d === '/' ? `/${e.name}` : `${d}/${e.name}`
            });
          }
          break;
        }
        default: {
          const _ex: never = stat.kind;
          throw new Error(`Unexpected kind: ${_ex}`);
        }
        }
      };

      await copyRecursive({ s: fullSrc, d: fullDest });
      await context.vfs.rm({ path: fullSrc, recursive: true });

      return { exitCode: 0, data: undefined, error: undefined };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `mv: ${src}: ${message}\n` });
      return { exitCode: 1, data: undefined, error: message };
    }
  },
};
