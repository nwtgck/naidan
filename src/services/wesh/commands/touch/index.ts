import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { exists, writeFile } from '@/services/wesh/utils/fs';

export const touchCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'touch',
    description: 'Update file timestamps or create empty files',
    usage: 'touch path...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    if (positional.length === 0) {
      const text = context.text();
      await text.error({ text: 'touch: missing file operand\n' });
      return { exitCode: 1 };
    }

    const text = context.text();

    for (const p of positional) {
      if (p === undefined) continue;
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        const isExists = await exists({ kernel: context.kernel, path: fullPath });

        if (!isExists) {
          // Create empty file
          await writeFile({ kernel: context.kernel, path: fullPath, data: new Uint8Array(0) });
        } else {
          // Just update mtime - we don't have a direct utimes yet,
          // so we could potentially open and close it if we want to simulate it,
          // but the current VFS doesn't support manual mtime update via open.
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await handle.close();
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `touch: cannot touch '${p}': ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
