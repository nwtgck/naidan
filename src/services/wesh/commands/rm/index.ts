import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const rmCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'rm',
    description: 'Remove files or directories',
    usage: 'rm [-r] [-f] path...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'r', long: undefined, effects: [{ key: 'recursive', value: true }] },
          { kind: 'flag', short: 'f', long: undefined, effects: [{ key: 'force', value: true }] },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: `rm: ${diagnostic.message}`,
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: 'rm: missing operand',
      });
      return { exitCode: 1 };
    }

    const recursive = parsed.optionValues.recursive === true;
    const force = parsed.optionValues.force === true;

    const removeRecursive = async (path: string) => {
      const st = await context.kernel.lstat({ path });
      switch (st.type) {
      case 'directory': {
        if (!recursive) {
          throw new Error('is a directory');
        }
        const entries = await context.kernel.readDir({ path });
        for (const entry of entries) {
          await removeRecursive(`${path}/${entry.name}`);
        }
        await context.kernel.rmdir({ path });
        break;
      }
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        await context.kernel.unlink({ path });
        break;
      default: {
        const _ex: never = st.type;
        throw new Error(`Unhandled type: ${_ex}`);
      }
      }
    };

    for (const p of parsed.positionals) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        await removeRecursive(fullPath);
      } catch (e: unknown) {
        if (!force) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `rm: cannot remove '${p}': ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
