import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const mkfifoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mkfifo',
    description: 'Make FIFOs (named pipes)',
    usage: 'mkfifo [path...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const paths = context.args;
    const text = context.text();

    if (paths.length === 0) {
      await text.error({ text: "mkfifo: missing operand\n" });
      return { exitCode: 1 };
    }

    for (const p of paths) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        // vfs.mknod is now in Kernel.
        await context.kernel.mknod({ path: fullPath, type: 'fifo', mode: 0o644 });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `mkfifo: cannot create fifo '${p}': ${message}\n` });
        return { exitCode: 1 };
      }
    }

    return { exitCode: 0 };
  },
};
