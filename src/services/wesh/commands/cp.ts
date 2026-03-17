import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { handleToStream, streamToHandle } from '@/services/wesh/utils/fs';

export const cpCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cp',
    description: 'Copy files',
    usage: 'cp source destination',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    if (context.args.length < 2) {
      await text.error({ text: 'cp: missing file operand\n' });
      return { exitCode: 1 };
    }

    const src = context.args[0]!;
    const dest = context.args[1]!;

    const copyOne = async (srcPath: string, destPath: string) => {
      const stat = await context.kernel.stat({ path: srcPath });

      if (stat.type === 'directory') {
        await context.kernel.mkdir({ path: destPath, recursive: true });
        const entries = await context.kernel.readDir({ path: srcPath });
        for (const entry of entries) {
          await copyOne(
            `${srcPath}/${entry.name}`,
            `${destPath}/${entry.name}`
          );
        }
      } else {
        const srcH = await context.kernel.open({
          path: srcPath,
          flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
        });
        const destH = await context.kernel.open({
          path: destPath,
          flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' }
        });

        await streamToHandle({
          stream: handleToStream({ handle: srcH }),
          handle: destH
        });
      }
    };

    try {
      const fullSrc = src.startsWith('/') ? src : `${context.cwd}/${src}`;
      let fullDest = dest.startsWith('/') ? dest : `${context.cwd}/${dest}`;

      try {
        const destStat = await context.kernel.stat({ path: fullDest });
        if (destStat.type === 'directory') {
          const srcName = src.split('/').pop()!;
          fullDest = `${fullDest}/${srcName}`;
        }
      } catch {
        // Dest doesn't exist
      }

      await copyOne(fullSrc, fullDest);
      return { exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `cp: ${src}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
