import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const rmdirCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'rmdir',
    description: 'Remove empty directories',
    usage: 'rmdir directory...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    if (context.args.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: 'rmdir: missing operand',
      });
      return { exitCode: 1 };
    }

    for (const p of context.args) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        const entries = await context.kernel.readDir({ path: fullPath });
        if (entries.length > 0) {
          throw new Error('Directory not empty');
        }
        await context.kernel.rmdir({ path: fullPath });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `rmdir: failed to remove '${p}': ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
