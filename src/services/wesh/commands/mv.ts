import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const mvCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mv',
    description: 'Move or rename files',
    usage: 'mv source destination',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    if (context.args.length < 2) {
      await text.error({ text: 'mv: missing file operand\n' });
      return { exitCode: 1 };
    }

    const src = context.args[0]!;
    const dest = context.args[1]!;

    try {
      const fullSrc = src.startsWith('/') ? src : `${context.cwd}/${src}`;
      let fullDest = dest.startsWith('/') ? dest : `${context.cwd}/${dest}`;

      try {
        const destStat = await context.kernel.stat({ path: fullDest });
        if (destStat.type === 'directory') {
          const srcName = src.split('/').filter(Boolean).pop()!;
          fullDest = `${fullDest}/${srcName}`;
        }
      } catch {
        // Destination does not exist, which is fine for rename
      }

      await context.kernel.rename({ oldPath: fullSrc, newPath: fullDest });
      return { exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `mv: ${src}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
