import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream, streamToHandle } from '@/services/wesh/utils/fs';

type CpSymlinkMode = 'physical' | 'logical' | 'command-line';

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function basename({ path }: { path: string }): string {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

const cpArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'R', long: 'recursive', effects: [{ key: 'recursive', value: true }], help: { summary: 'copy directories recursively', category: 'common' } },
    { kind: 'flag', short: 'r', long: 'r', effects: [{ key: 'recursive', value: true }], help: { summary: 'copy directories recursively', category: 'advanced' } },
    {
      kind: 'flag',
      short: 'a',
      long: 'archive',
      effects: [
        { key: 'recursive', value: true },
        { key: 'symlinkMode', value: 'physical' },
      ],
      help: { summary: 'archive mode', category: 'common' },
    },
    { kind: 'flag', short: 'H', long: undefined, effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'follow command-line symlinks', category: 'advanced' } },
    { kind: 'flag', short: 'L', long: 'dereference', effects: [{ key: 'symlinkMode', value: 'logical' }], help: { summary: 'always follow symlinks', category: 'advanced' } },
    { kind: 'flag', short: 'P', long: 'no-dereference', effects: [{ key: 'symlinkMode', value: 'physical' }], help: { summary: 'never follow symlinks', category: 'advanced' } },
    { kind: 'flag', short: 'T', long: 'no-target-directory', effects: [{ key: 'noTargetDirectory', value: true }], help: { summary: 'treat destination as a normal file', category: 'advanced' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }], help: { summary: 'remove existing destination files', category: 'common' } },
    { kind: 'flag', short: 'n', long: 'no-clobber', effects: [{ key: 'noClobber', value: true }], help: { summary: 'do not overwrite existing files', category: 'common' } },
    {
      kind: 'value',
      short: 't',
      long: 'target-directory',
      key: 'targetDirectory',
      valueName: 'DIRECTORY',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'copy all source arguments into DIRECTORY', valueName: 'DIRECTORY', category: 'common' },
    },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const cpCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cp',
    description: 'Copy files',
    usage: 'cp [-R] [-H|-L|-P] [-f|-n] [-T] [-t DIR] source... destination',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    const parsed = parseStandardArgv({
      args: context.args,
      spec: cpArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: `cp: ${diagnostic.message}`,
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cp',
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 0 };
    }

    const targetDirectory = typeof parsed.optionValues.targetDirectory === 'string'
      ? parsed.optionValues.targetDirectory
      : undefined;

    if (parsed.positionals.length < (targetDirectory === undefined ? 2 : 1)) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: 'cp: missing file operand',
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 1 };
    }

    const recursive = parsed.optionValues.recursive === true;
    const force = parsed.optionValues.force === true;
    const noClobber = parsed.optionValues.noClobber === true;
    const noTargetDirectory = parsed.optionValues.noTargetDirectory === true;
    const symlinkMode: CpSymlinkMode = (() => {
      const configured = parsed.optionValues.symlinkMode;
      if (configured === 'logical' || configured === 'physical' || configured === 'command-line') {
        return configured;
      }
      return recursive ? 'physical' : 'logical';
    })();

    const sourceOperands = targetDirectory === undefined
      ? parsed.positionals.slice(0, -1)
      : parsed.positionals.slice();
    const destOperand = targetDirectory ?? parsed.positionals[parsed.positionals.length - 1];
    if (destOperand === undefined) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: 'cp: missing destination file operand',
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (noTargetDirectory && sourceOperands.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: 'cp: extra operand with -T',
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 1 };
    }

    const statSource = async ({
      path,
      isCommandLineArgument,
    }: {
      path: string;
      isCommandLineArgument: boolean;
    }) => {
      switch (symlinkMode) {
      case 'logical':
        return context.files.stat({ path });
      case 'command-line':
        return isCommandLineArgument ? context.files.stat({ path }) : context.files.lstat({ path });
      case 'physical':
        return context.files.lstat({ path });
      default: {
        const _ex: never = symlinkMode;
        throw new Error(`Unhandled symlink mode: ${_ex}`);
      }
      }
    };

    const copyRegularFile = async ({
      srcPath,
      destPath,
    }: {
      srcPath: string;
      destPath: string;
    }) => {
      const srcH = await context.files.open({
        path: srcPath,
        flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
      });
      const destH = await context.files.open({
        path: destPath,
        flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' }
      });

      await streamToHandle({
        stream: handleToStream({ handle: srcH }),
        handle: destH
      });
    };

    const removeExistingTargetIfNeeded = async ({
      destPath,
    }: {
      destPath: string;
    }): Promise<'removed' | 'skipped' | 'missing'> => {
      try {
        const existing = await context.files.lstat({ path: destPath });
        if (noClobber) {
          return 'skipped';
        }
        if (!force) {
          switch (existing.type) {
          case 'directory':
            return 'missing';
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            break;
          default: {
            const _ex: never = existing.type;
            throw new Error(`Unhandled type: ${_ex}`);
          }
          }
          return 'missing';
        }

        switch (existing.type) {
        case 'directory':
          throw new Error(`cannot overwrite directory '${destPath}'`);
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          await context.files.unlink({ path: destPath });
          return 'removed';
        default: {
          const _ex: never = existing.type;
          throw new Error(`Unhandled type: ${_ex}`);
        }
        }
      } catch {
        return 'missing';
      }
    };

    const copyOne = async ({
      srcPath,
      destPath,
      isCommandLineArgument,
    }: {
      srcPath: string;
      destPath: string;
      isCommandLineArgument: boolean;
    }): Promise<void> => {
      const stat = await statSource({ path: srcPath, isCommandLineArgument });

      const existingTargetState = await removeExistingTargetIfNeeded({ destPath });
      switch (existingTargetState) {
      case 'skipped':
        return;
      case 'removed':
      case 'missing':
        break;
      default: {
        const _ex: never = existingTargetState;
        throw new Error(`Unhandled destination state: ${_ex}`);
      }
      }

      switch (stat.type) {
      case 'directory': {
        if (!recursive) {
          throw new Error(`-r not specified; omitting directory '${srcPath}'`);
        }
        await context.files.mkdir({ path: destPath, recursive: true });
        const readPath = (await context.files.resolve({ path: srcPath })).fullPath;
        const entries = await context.files.readDir({ path: readPath });
        for (const entry of entries) {
          await copyOne({
            srcPath: `${readPath}/${entry.name}`,
            destPath: `${destPath}/${entry.name}`,
            isCommandLineArgument: false,
          });
        }
        break;
      }
      case 'file':
        await copyRegularFile({ srcPath, destPath });
        break;
      case 'symlink':
        if (symlinkMode === 'physical' || (symlinkMode === 'command-line' && !isCommandLineArgument)) {
          const linkTarget = await context.files.readlink({ path: srcPath });
          await context.files.symlink({
            path: destPath,
            targetPath: linkTarget,
          });
          break;
        }
        await copyRegularFile({ srcPath, destPath });
        break;
      case 'fifo':
      case 'chardev':
        throw new Error(`Unsupported file type: ${stat.type}`);
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled type: ${_ex}`);
      }
      }
    };

    const resolveDestinationPath = async ({
      srcPath,
      destPath,
      treatDestAsDirectory,
    }: {
      srcPath: string;
      destPath: string;
      treatDestAsDirectory: boolean;
    }) => {
      if (treatDestAsDirectory) {
        return `${destPath}/${basename({ path: srcPath })}`;
      }

      try {
        const destStat = await context.files.stat({ path: destPath });
        switch (destStat.type) {
        case 'directory': {
          if (noTargetDirectory) {
            throw new Error(`cannot overwrite directory '${destPath}' with non-directory`);
          }
          return `${destPath}/${basename({ path: srcPath })}`;
        }
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          return destPath;
        default: {
          const _ex: never = destStat.type;
          throw new Error(`Unhandled type: ${_ex}`);
        }
        }
      } catch {
        return destPath;
      }
    };

    try {
      const fullDest = resolvePath({ cwd: context.cwd, path: destOperand });
      const treatDestAsDirectory = (() => {
        if (targetDirectory !== undefined) {
          return true;
        }
        if (sourceOperands.length > 1) {
          return true;
        }
        return false;
      })();

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

      let hadError = false;

      for (const sourceOperand of sourceOperands) {
        try {
          const fullSrc = resolvePath({ cwd: context.cwd, path: sourceOperand });
          const targetPath = await resolveDestinationPath({
            srcPath: fullSrc,
            destPath: fullDest,
            treatDestAsDirectory,
          });
          await copyOne({
            srcPath: fullSrc,
            destPath: targetPath,
            isCommandLineArgument: true,
          });
        } catch (e: unknown) {
          hadError = true;
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `cp: ${sourceOperand}: ${message}\n` });
        }
      }
      return { exitCode: hadError ? 1 : 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `cp: ${sourceOperands[0] ?? ''}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
