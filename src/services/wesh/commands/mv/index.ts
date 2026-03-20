import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

function resolvePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function basename({
  path,
}: {
  path: string;
}): string {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

const mvArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'f',
      long: 'force',
      effects: [{ key: 'force', value: true }],
      help: { summary: 'remove existing destination files', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'n',
      long: 'no-clobber',
      effects: [{ key: 'noClobber', value: true }],
      help: { summary: 'do not overwrite existing files', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'T',
      long: 'no-target-directory',
      effects: [{ key: 'noTargetDirectory', value: true }],
      help: { summary: 'treat destination as a normal file', category: 'advanced' },
    },
    {
      kind: 'value',
      short: 't',
      long: 'target-directory',
      key: 'targetDirectory',
      valueName: 'DIRECTORY',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'move all source arguments into DIRECTORY', valueName: 'DIRECTORY', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const mvCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mv',
    description: 'Move or rename files',
    usage: 'mv source destination',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: mvArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: `mv: ${diagnostic.message}`,
        argvSpec: mvArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mv',
        argvSpec: mvArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const targetDirectory = typeof parsed.optionValues.targetDirectory === 'string'
      ? parsed.optionValues.targetDirectory
      : undefined;
    const noClobber = parsed.optionValues.noClobber === true;
    const noTargetDirectory = parsed.optionValues.noTargetDirectory === true;

    if (parsed.positionals.length < (targetDirectory === undefined ? 2 : 1)) {
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: 'mv: missing file operand',
        argvSpec: mvArgvSpec,
      });
      return { exitCode: 1 };
    }

    const sourceOperands = targetDirectory === undefined
      ? parsed.positionals.slice(0, -1)
      : parsed.positionals.slice();
    const destOperand = targetDirectory ?? parsed.positionals[parsed.positionals.length - 1];

    if (destOperand === undefined) {
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: 'mv: missing destination file operand',
        argvSpec: mvArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (noTargetDirectory && sourceOperands.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: 'mv: extra operand with -T',
        argvSpec: mvArgvSpec,
      });
      return { exitCode: 1 };
    }

    try {
      const fullDest = resolvePath({ cwd: context.cwd, path: destOperand });
      const treatDestAsDirectory = targetDirectory !== undefined || sourceOperands.length > 1;

      if (treatDestAsDirectory) {
        const destStat = await context.files.stat({ path: fullDest });
        switch (destStat.type) {
        case 'directory':
          break;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          throw new Error(`target '${destOperand}' is not a directory`);
        default: {
          const _ex: never = destStat.type;
          throw new Error(`Unhandled destination type: ${_ex}`);
        }
        }
      }

      for (const sourceOperand of sourceOperands) {
        const fullSrc = resolvePath({ cwd: context.cwd, path: sourceOperand });
        const targetPath = await (async () => {
          if (treatDestAsDirectory) {
            return `${fullDest}/${basename({ path: fullSrc })}`;
          }

          let destinationStat:
            | Awaited<ReturnType<WeshCommandContext['files']['stat']>>
            | undefined;
          try {
            destinationStat = await context.files.stat({ path: fullDest });
          } catch {
            destinationStat = undefined;
          }

          if (destinationStat === undefined) {
            return fullDest;
          }

          switch (destinationStat.type) {
          case 'directory':
            if (noTargetDirectory) {
              throw new Error(`cannot overwrite directory '${destOperand}' with non-directory`);
            }
            return `${fullDest}/${basename({ path: fullSrc })}`;
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            return fullDest;
          default: {
            const _ex: never = destinationStat.type;
            throw new Error(`Unhandled destination type: ${_ex}`);
          }
          }
        })();

        if (noClobber) {
          try {
            await context.files.lstat({ path: targetPath });
            continue;
          } catch {
            // missing destination is fine
          }
        }

        await context.files.rename({ oldPath: fullSrc, newPath: targetPath });
      }

      return { exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `mv: ${sourceOperands[0] ?? ''}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
