import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

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
        const entries = await context.vfs.readDir({ path: fullPath });

        const filtered = a ? entries : entries.filter((e) => !e.name.startsWith('.'));

        for (const entry of filtered) {
          let line = entry.name;
          switch (entry.kind) {
          case 'directory':
            line += '/';
            break;
          case 'file':
            break;
          default: {
            const _ex: never = entry.kind;
            throw new Error(`Unexpected entry kind: ${_ex}`);
          }
          }

          if (l) {
            const stat = await context.vfs.stat({ path: `${fullPath}/${entry.name}` });
            const size = h ? formatSize(stat.size) : stat.size.toString();
            line = `${entry.kind.charAt(0)} ${size.padStart(10)} ${line}`;
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
