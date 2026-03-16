import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const touchCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'touch',
    description: 'Update timestamp or create empty file',
    usage: 'touch file...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const files = context.args;
    const text = context.text();

    if (files.length === 0) {
      await text.error({ text: 'touch: missing file operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    for (const f of files) {
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const exists = await context.vfs.exists({ path: fullPath });

        if (!exists) {
          /** Create empty file */
          const emptyStream = new ReadableStream({ start(c) {
            c.close();
          } });
          await context.vfs.writeFile({ path: fullPath, stream: emptyStream });
        } else {
          /** Update timestamp: for now we just re-read/write or ignore as OPFS doesn't expose easy utime */
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `touch: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
