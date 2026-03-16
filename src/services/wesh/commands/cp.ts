import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const cpCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cp',
    description: 'Copy files and directories',
    usage: 'cp [-r] source... destination',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['r'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length < 2) {
      await text.error({ text: 'cp: missing file operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    const recursive = !!flags.r;
    const sources = positional.slice(0, -1);
    const dest = positional[positional.length - 1];

    if (dest === undefined) {
      await text.error({ text: 'cp: missing destination operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing destination' };
    }

    const copyOne = async ({
      srcPath,
      destPath
    }: {
      srcPath: string;
      destPath: string;
    }) => {
      const stat = await context.vfs.stat({ path: srcPath });
      switch (stat.kind) {
      case 'file': {
        const stream = await context.vfs.readFile({ path: srcPath });
        await context.vfs.writeFile({ path: destPath, stream });
        break;
      }
      case 'directory': {
        if (recursive) {
          await context.vfs.mkdir({ path: destPath, recursive: true });
          const entries = await context.vfs.readDir({ path: srcPath });
          for (const entry of entries) {
            await copyOne({
              srcPath: srcPath === '/' ? `/${entry.name}` : `${srcPath}/${entry.name}`,
              destPath: destPath === '/' ? `/${entry.name}` : `${destPath}/${entry.name}`
            });
          }
        } else {
          throw new Error(`${srcPath} is a directory (use -r)`);
        }
        break;
      }
      default: {
        const _ex: never = stat.kind;
        throw new Error(`Unexpected kind: ${_ex}`);
      }
      }
    };

    for (const src of sources) {
      if (src === undefined) continue;
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

        await copyOne({ srcPath: fullSrc, destPath: fullDest });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `cp: ${src}: ${message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
