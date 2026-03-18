import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';

export const catCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const files = context.args;
    const buf = new Uint8Array(64 * 1024); // 64KB buffer for efficiency

    // Helper to pump data from one handle to another
    const pump = async (src: WeshFileHandle, dst: WeshFileHandle) => {
      try {
        while (true) {
          const { bytesRead } = await src.read({ buffer: buf });
          if (bytesRead === 0) break; // EOF

          let written = 0;
          while (written < bytesRead) {
            const { bytesWritten } = await dst.write({
              buffer: buf,
              offset: written,
              length: bytesRead - written
            });
            written += bytesWritten;
          }
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.message === 'Broken pipe') return;
        throw e;
      }
    };

    if (files.length === 0) {
      await pump(context.stdin, context.stdout);
      return { exitCode: 0 };
    }

    for (const f of files) {
      if (f === undefined || f === '') continue;

      try {
        if (f === '-') {
          await pump(context.stdin, context.stdout);
        } else {
          const path = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          // Use WeshOpenFlags for kernel.open
          const handle = await context.kernel.open({
            path,
            flags: {
              access: 'read',
              creation: 'never',
              truncate: 'preserve',
              append: 'preserve',
            }
          });
          try {
            await pump(handle, context.stdout);
          } finally {
            await handle.close();
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const encoder = new TextEncoder();
        await context.stderr.write({ buffer: encoder.encode(`cat: ${f}: ${message}\n`) });
        return { exitCode: 1 };
      }
    }

    return { exitCode: 0 };
  },
};
