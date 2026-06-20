import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshEntryRef } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';


function asDirectoryEntryRef({
  entry,
}: {
  entry: WeshEntryRef;
}): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${_ex}`);
  }
  }
}

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

    const removeRecursive = async ({
      entry,
    }: {
      entry: WeshEntryRef;
    }): Promise<void> => {
      const stat = await context.files.statEntry({ entry });
      switch (stat.type) {
      case 'directory': {
        if (!recursive) {
          throw new Error('is a directory');
        }
        for await (const child of context.files.readDirEntry({
          entry: asDirectoryEntryRef({ entry }),
        })) {
          await removeRecursive({ entry: child });
        }
        await context.files.rmdir({ path: entry.fullPath });
        break;
      }
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        await context.files.unlink({ path: entry.fullPath });
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled type: ${_ex}`);
      }
      }
    };

    for (const p of parsed.positionals) {
      try {
        const fullPath = p.startsWith('/') ? p : (context.cwd === '/' ? `/${p}` : `${context.cwd}/${p}`);
        await removeRecursive({
          entry: await context.files.resolveEntry({
            path: fullPath,
            finalSymlinkTreatment: 'no-follow',
          }),
        });
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
