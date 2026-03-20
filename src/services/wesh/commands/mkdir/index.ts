import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { parseFlags } from '@/services/wesh/utils/args';

export const mkdirCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mkdir',
    description: 'Create directories',
    usage: 'mkdir [-p] path...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['p'],
      stringFlags: [],
    });

    if (positional.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'mkdir',
        message: 'mkdir: missing operand',
      });
      return { exitCode: 1 };
    }

    const recursive = !!flags.p;
    const text = context.text();

    for (const p of positional) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        await context.kernel.mkdir({ path: fullPath, recursive });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `mkdir: cannot create directory '${p}': ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
