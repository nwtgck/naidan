import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const rmArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'r', long: 'recursive', effects: [{ key: 'recursive', value: true }], help: { summary: 'remove directories and their contents recursively' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }], help: { summary: 'ignore nonexistent files and arguments, never prompt' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const rmCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'rm',
    description: 'Remove files or directories',
    usage: 'rm [-r] [-f] path...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: rmArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: `rm: ${diagnostic.message}`,
        argvSpec: rmArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'rm',
        argvSpec: rmArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: 'rm: missing operand',
        argvSpec: rmArgvSpec,
      });
      return { exitCode: 1 };
    }

    const recursive = parsed.optionValues.recursive === true;
    const force = parsed.optionValues.force === true;
    let exitCode = 0;

    const removeRecursive = async (path: string) => {
      const st = await context.files.lstat({ path });
      switch (st.type) {
      case 'directory': {
        if (!recursive) {
          throw new Error('is a directory');
        }
        const entries = await context.files.readDir({ path });
        for (const entry of entries) {
          await removeRecursive(`${path}/${entry.name}`);
        }
        await context.files.rmdir({ path });
        break;
      }
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        await context.files.unlink({ path });
        break;
      default: {
        const _ex: never = st.type;
        throw new Error(`Unhandled type: ${_ex}`);
      }
      }
    };

    for (const p of parsed.positionals) {
      try {
        const fullPath = p.startsWith('/') ? p : (context.cwd === '/' ? `/${p}` : `${context.cwd}/${p}`);
        await removeRecursive(fullPath);
      } catch (e: unknown) {
        if (!force) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `rm: cannot remove '${p}': ${message}\n` });
          exitCode = 1;
        }
      }
    }

    return { exitCode };
  },
};
