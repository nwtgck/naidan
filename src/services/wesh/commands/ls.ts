import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '../types';
import { parseFlags } from '../utils/args';

export const lsCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'ls',
    description: 'List directory contents',
    usage: 'ls [path...] [-l] [-a] [-R] [-1] [-h]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional, unknown } = parseFlags({
      args: context.args,
      booleanFlags: ['l', 'a', 'R', '1', 'h'],
      stringFlags: [],
    });

    const text = context.text();
    if (unknown.length > 0) {
      await text.error({ text: `ls: invalid option -- '${unknown[0]}'\n` });
      return { exitCode: 1, data: undefined, error: 'invalid option' };
    }

    const paths = positional.length > 0 ? positional : ['.'];
    const { l, a, '1': one, h } = flags;

    for (const p of paths) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        const entries = await context.kernel.readDir({ path: fullPath });

        const filtered = a ? entries : entries.filter((e) => !e.name.startsWith('.'));

        for (const entry of filtered) {
          let line = entry.name;
          const type = entry.type;
          
          if (type === 'directory') line += '/';
          else if (type === 'fifo') line += '|';
          else if (type === 'chardev') line += '@';

          if (l) {
            const entryPath = fullPath.endsWith('/') ? `${fullPath}${entry.name}` : `${fullPath}/${entry.name}`;
            const st = await context.kernel.stat({ path: entryPath });
            const size = h ? formatSize(st.size) : st.size.toString();
            const typeChar = type === 'directory' ? 'd' : type === 'fifo' ? 'p' : type === 'chardev' ? 'c' : '-';
            line = `${typeChar} ${size.padStart(10)} ${line}`;
          }

          await text.print({ text: line + (one || l ? '\n' : '  ') });
        }

        if (!one && !l && filtered.length > 0) {
          await text.print({ text: '\n' });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `ls: ${p}: ${message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}
