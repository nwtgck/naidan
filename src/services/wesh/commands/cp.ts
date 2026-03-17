import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
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
      return { exitCode: 1 };
    }

    const recursive = !!flags.r;
    const sources = positional.slice(0, -1);
    const dest = positional[positional.length - 1]!;

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

    const copyOne = async (srcPath: string, destPath: string) => {
      const stat = await context.kernel.stat({ path: srcPath });

      switch (stat.type) {
      case 'file': {
        const srcH = await context.kernel.open({ path: srcPath, flags: 0 }); // O_RDONLY
        const destH = await context.kernel.open({ path: destPath, flags: 64 | 512 }); // O_CREAT | O_TRUNC
        try {
          await pump(srcH, destH);
        } finally {
          await srcH.close();
          await destH.close();
        }
        break;
      }
      case 'directory': {
        if (!recursive) {
          throw new Error(`${srcPath} is a directory (use -r)`);
        }
        await context.kernel.mkdir({ path: destPath, recursive: true });
        const entries = await context.kernel.readDir({ path: srcPath });
        for (const entry of entries) {
          await copyOne(
            `${srcPath}/${entry.name}`,
            `${destPath}/${entry.name}`
          );
        }
        break;
      }
      case 'fifo': {
        // Special handling: copy metadata, but don't pump data (it's a pipe)
        await context.kernel.mknod({ path: destPath, type: 'fifo', mode: stat.mode });
        break;
      }
      case 'chardev': {
        throw new Error(`Copying chardev ${srcPath} not implemented`);
      }
      case 'symlink': {
        throw new Error(`Copying symlink ${srcPath} not implemented`);
      }
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled file type: ${_ex}`);
      }
      }
    };

    for (const src of sources) {
      try {
        const fullSrc = src.startsWith('/') ? src : `${context.cwd}/${src}`;
        let fullDest = dest.startsWith('/') ? dest : `${context.cwd}/${dest}`;

        // Check if dest is directory
        try {
          const destStat = await context.kernel.stat({ path: fullDest });
          switch (destStat.type) {
          case 'directory': {
            const srcName = src.split('/').pop()!;
            fullDest = `${fullDest}/${srcName}`;
            break;
          }
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            // do nothing
            break;
          default: {
            const _ex: never = destStat.type;
            throw new Error(`Unhandled file type: ${_ex}`);
          }
          }
        } catch {
          // Dest doesn't exist, which is fine
        }

        await copyOne(fullSrc, fullDest);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `cp: ${src}: ${message}\n` });
        return { exitCode: 1 };
      }
    }

    return { exitCode: 0 };
  },
};
