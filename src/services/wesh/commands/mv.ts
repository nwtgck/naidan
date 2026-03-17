import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';

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

    const buf = new Uint8Array(64 * 1024);
    const pump = async (src: WeshFileHandle, dst: WeshFileHandle) => {
      while (true) {
        const { bytesRead } = await src.read({ buffer: buf });
        if (bytesRead === 0) break;
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
    };

    const moveOne = async (srcPath: string, destPath: string) => {
      const stat = await context.kernel.stat({ path: srcPath });

      if (stat.type === 'file') {
        const srcH = await context.kernel.open({ path: srcPath, flags: 0 });
        const destH = await context.kernel.open({ path: destPath, flags: 64 | 512 });
        try {
          await pump(srcH, destH);
        } finally {
          await srcH.close();
          await destH.close();
        }
        await context.kernel.unlink({ path: srcPath });
      } else if (stat.type === 'directory') {
        await context.kernel.mkdir({ path: destPath, recursive: true });
        const entries = await context.kernel.readDir({ path: srcPath });
        for (const entry of entries) {
          await moveOne(
            `${srcPath}/${entry.name}`,
            `${destPath}/${entry.name}`
          );
        }
        await context.kernel.rmdir({ path: srcPath });
      } else if (stat.type === 'fifo') {
        await context.kernel.mknod({ path: destPath, type: 'fifo', mode: stat.mode });
        await context.kernel.unlink({ path: srcPath });
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

      await moveOne(fullSrc, fullDest);
      return { exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `mv: ${src}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
