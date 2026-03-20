import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

function basename({ path }: { path: string }): string {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

const lnArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 's', long: 'symbolic', effects: [{ key: 'symbolic', value: true }], help: { summary: 'make symbolic links instead of hard links', category: 'common' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }], help: { summary: 'remove existing destination files', category: 'common' } },
    { kind: 'flag', short: 'n', long: 'no-dereference', effects: [{ key: 'noDereference', value: true }], help: { summary: 'treat a destination symlink to a directory as a normal file', category: 'advanced' } },
    { kind: 'flag', short: 'T', long: 'no-target-directory', effects: [{ key: 'noTargetDirectory', value: true }], help: { summary: 'treat LINK_NAME as a normal file always', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const lnCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'ln',
    description: 'Make links between files',
    usage: 'ln -s [-f] [-n] [-T] TARGET LINK_NAME',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: lnArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'ln',
        message: `ln: ${diagnostic.message}`,
        argvSpec: lnArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'ln',
        argvSpec: lnArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.symbolic !== true) {
      await writeCommandUsageError({
        context,
        command: 'ln',
        message: 'ln: hard links are not supported; use -s',
        argvSpec: lnArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 0 || parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'ln',
        message: 'ln: expected one or two operands',
        argvSpec: lnArgvSpec,
      });
      return { exitCode: 1 };
    }

    const targetPath = parsed.positionals[0]!;
    const linkOperand = parsed.positionals[1] ?? basename({ path: targetPath });
    const force = parsed.optionValues.force === true;
    const noDereference = parsed.optionValues.noDereference === true;
    const noTargetDirectory = parsed.optionValues.noTargetDirectory === true;

    try {
      let linkPath = resolvePath({
        cwd: context.cwd,
        path: linkOperand,
      });

      const destinationLstat = await (async () => {
        try {
          return await context.files.lstat({ path: linkPath });
        } catch {
          return undefined;
        }
      })();

      const destinationActsAsDirectory = await (async () => {
        if (noTargetDirectory) {
          return false;
        }

        if (destinationLstat?.type === 'symlink' && noDereference) {
          return false;
        }

        try {
          const stat = await context.files.stat({ path: linkPath });
          return stat.type === 'directory';
        } catch {
          return false;
        }
      })();

      if (destinationActsAsDirectory) {
        const resolvedDirectory = await context.files.resolve({ path: linkPath });
        linkPath = `${resolvedDirectory.fullPath}/${basename({ path: targetPath })}`;
      }

      if (force) {
        const existing = await (async () => {
          try {
            return await context.files.lstat({ path: linkPath });
          } catch {
            return undefined;
          }
        })();
        if (existing !== undefined) {
          switch (existing.type) {
          case 'directory':
            await context.files.rmdir({ path: linkPath });
            break;
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            await context.files.unlink({ path: linkPath });
            break;
          default: {
            const _ex: never = existing.type;
            throw new Error(`Unhandled type: ${_ex}`);
          }
          }
        }
      }

      await context.files.symlink({
        path: linkPath,
        targetPath,
      });
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `ln: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
