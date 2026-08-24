import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { parseStandardArgv, type ArgvOptionOccurrence, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { parseBackupControlLongOption, resolveBackupControl, selectBackupSuffix, type BackupControl } from '@/features/wesh/commands/_shared/backup';
import { createAffirmativeResponseReader } from '@/features/wesh/commands/_shared/confirmation';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { normalizePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  return normalizePath({ cwd, path });
}

function basename({ path }: { path: string }): string {
  const normalized = path.length > 1 ? path.replace(/\/+$/u, '') : path;
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

function dirname({ path }: { path: string }): string {
  const normalized = normalizePath({ cwd: '/', path });
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function relativePath({ fromDirectory, toPath }: { fromDirectory: string; toPath: string }): string {
  const fromParts = normalizePath({ cwd: '/', path: fromDirectory }).split('/').filter(Boolean);
  const toParts = normalizePath({ cwd: '/', path: toPath }).split('/').filter(Boolean);
  let commonLength = 0;
  while (
    commonLength < fromParts.length
    && commonLength < toParts.length
    && fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength += 1;
  }
  const parts = [
    ...Array.from({ length: fromParts.length - commonLength }, () => '..'),
    ...toParts.slice(commonLength),
  ];
  return parts.length === 0 ? '.' : parts.join('/');
}

const lnArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 's', long: 'symbolic', effects: [{ key: 'symbolic', value: true }], help: { summary: 'make symbolic links instead of hard links', category: 'common' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }, { key: 'interactive', value: false }], help: { summary: 'remove existing destination files', category: 'common' } },
    { kind: 'flag', short: 'i', long: 'interactive', effects: [{ key: 'force', value: false }, { key: 'interactive', value: true }], help: { summary: 'prompt whether to remove destinations', category: 'common' } },
    { kind: 'flag', short: 'b', long: 'backup', effects: [{ key: 'backup', value: true }], help: { summary: 'make a backup of each existing destination file', category: 'common' } },
    { kind: 'value', short: 'S', long: 'suffix', key: 'backupSuffix', valueName: 'SUFFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'override the usual backup suffix', valueName: 'SUFFIX', category: 'advanced' } },
    { kind: 'flag', short: 'v', long: 'verbose', effects: [{ key: 'verbose', value: true }], help: { summary: 'print the name of each linked file', category: 'common' } },
    { kind: 'flag', short: 'n', long: 'no-dereference', effects: [{ key: 'noDereference', value: true }], help: { summary: 'treat a destination symlink to a directory as a normal file', category: 'advanced' } },
    { kind: 'flag', short: 'T', long: 'no-target-directory', effects: [{ key: 'noTargetDirectory', value: true }], help: { summary: 'treat LINK_NAME as a normal file always', category: 'advanced' } },
    { kind: 'flag', short: 'r', long: 'relative', effects: [{ key: 'relative', value: true }], help: { summary: 'create symbolic links relative to link location', category: 'common' } },
    { kind: 'value', short: 't', long: 'target-directory', key: 'targetDirectory', valueName: 'DIRECTORY', allowAttachedValue: true, parseValue: undefined, help: { summary: 'specify the DIRECTORY in which to create the links', valueName: 'DIRECTORY', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [({ token }) => parseBackupControlLongOption({ token })],
};

async function pathStatOrUndefined({
  context,
  path,
  dereference,
}: {
  context: WeshCommandContext;
  path: string;
  dereference: boolean;
}) {
  try {
    return dereference
      ? await context.files.stat({ path })
      : await context.files.lstat({ path });
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) return undefined;
    throw error;
  }
}

async function resolveExplicitTargetDirectory({
  context,
  operand,
}: {
  context: WeshCommandContext;
  operand: string;
}): Promise<string | undefined> {
  const text = context.text();
  if (operand === '') {
    await text.error({ text: "ln: failed to access '': No such file or directory\n" });
    return undefined;
  }

  const requestedPath = resolvePath({ cwd: context.cwd, path: operand });
  const target = await pathStatOrUndefined({ context, path: requestedPath, dereference: true });
  if (target === undefined) {
    await text.error({ text: `ln: failed to access '${operand}': No such file or directory\n` });
    return undefined;
  }
  switch (target.type) {
  case 'directory':
    return (await context.files.resolve({ path: requestedPath })).fullPath;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    await text.error({ text: `ln: target '${operand}' is not a directory\n` });
    return undefined;
  default: {
    const _ex: never = target.type;
    throw new Error(`Unhandled target-directory type: ${_ex}`);
  }
  }
}

export const lnCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'ln',
    description: 'Make links between files',
    usage: 'ln -s [-f] [-n] [-T] [-r] TARGET LINK_NAME',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({ args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: lnArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }), spec: lnArgvSpec });
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

    const targetDirectoryOccurrences = parsed.occurrences.filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => (
      occurrence.kind === 'value' && occurrence.key === 'targetDirectory'
    ));
    const firstTargetDirectory = targetDirectoryOccurrences[0];
    const explicitTargetDirectoryPath = firstTargetDirectory === undefined
      ? undefined
      : await resolveExplicitTargetDirectory({
        context,
        operand: String(firstTargetDirectory.value),
      });
    if (firstTargetDirectory !== undefined && explicitTargetDirectoryPath === undefined) {
      return { exitCode: 1 };
    }
    if (targetDirectoryOccurrences.length > 1) {
      await text.error({ text: 'ln: multiple target directories specified\n' });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'ln', argvSpec: lnArgvSpec });
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

    const targetDirectory = typeof parsed.optionValues.targetDirectory === 'string'
      ? parsed.optionValues.targetDirectory
      : undefined;
    const noTargetDirectory = parsed.optionValues.noTargetDirectory === true;
    if (targetDirectory !== undefined && noTargetDirectory) {
      await text.error({ text: "ln: cannot combine --target-directory and --no-target-directory\n" });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'ln',
        message: 'ln: missing file operand',
        argvSpec: lnArgvSpec,
      });
      return { exitCode: 1 };
    }

    const force = parsed.optionValues.force === true;
    const interactive = parsed.optionValues.interactive === true;
    const backupRequested = parsed.optionValues.backup === true;
    let backupControl: BackupControl = 'simple';
    if (backupRequested) {
      const explicitBackupControl = typeof parsed.optionValues.backupControlRaw === 'string'
        ? parsed.optionValues.backupControlRaw
        : undefined;
      const backupControlResult = resolveBackupControl({
        explicitValue: explicitBackupControl,
        environmentValue: context.env.get('VERSION_CONTROL'),
      });
      if (!backupControlResult.ok) {
        const source = (() => {
          switch (backupControlResult.source) {
          case 'option':
            return '--backup';
          case 'environment':
            return '$VERSION_CONTROL';
          default: {
            const _ex: never = backupControlResult.source;
            return _ex;
          }
          }
        })();
        await writeCommandUsageError({
          context,
          command: 'ln',
          message: `ln: invalid argument '${backupControlResult.value}' for '${source}'`,
          argvSpec: lnArgvSpec,
        });
        return { exitCode: 1 };
      }
      backupControl = backupControlResult.control;
    }
    const backupEnabled = backupRequested && backupControl !== 'none';
    const backupSuffix = typeof parsed.optionValues.backupSuffix === 'string'
      ? parsed.optionValues.backupSuffix
      : '~';
    const verbose = parsed.optionValues.verbose === true;
    const noDereference = parsed.optionValues.noDereference === true;
    const relative = parsed.optionValues.relative === true;
    const readAffirmativeResponse = createAffirmativeResponseReader({ input: text.input });
    const targetPaths = targetDirectory !== undefined
      ? parsed.positionals
      : parsed.positionals.length === 1
        ? parsed.positionals
        : parsed.positionals.slice(0, -1);
    const linkOperand = targetDirectory
      ?? (parsed.positionals.length === 1
        ? basename({ path: parsed.positionals[0]! })
        : parsed.positionals[parsed.positionals.length - 1]!);

    const prepareExistingDestination = async ({
      linkPath,
      displayLinkPath,
    }: {
      linkPath: string,
      displayLinkPath: string,
    }): Promise<boolean> => {
      const existing = await pathStatOrUndefined({ context, path: linkPath, dereference: false });
      if (existing === undefined) return true;
      switch (existing.type) {
      case 'directory':
        throw new Error(`cannot overwrite directory '${displayLinkPath}'`);
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

      if (interactive) {
        await text.error({ text: `ln: replace '${displayLinkPath}'? ` });
        if (!await readAffirmativeResponse()) return false;
      } else if (!force && !backupEnabled) {
        return true;
      }

      if (backupEnabled) {
        const selectedSuffix = await selectBackupSuffix({
          context,
          destinationPath: linkPath,
          control: backupControl,
          simpleSuffix: backupSuffix,
        });
        if (selectedSuffix === undefined) {
          throw new Error('backup control unexpectedly disabled an enabled backup');
        }
        const backupPath = `${linkPath}${selectedSuffix}`;
        const existingBackup = await pathStatOrUndefined({ context, path: backupPath, dereference: false });
        if (existingBackup !== undefined) {
          switch (existingBackup.type) {
          case 'directory':
            throw new Error(`cannot backup '${displayLinkPath}': backup destination is a directory`);
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            await context.files.unlink({ path: backupPath });
            break;
          default: {
            const _ex: never = existingBackup.type;
            throw new Error(`Unhandled backup type: ${_ex}`);
          }
          }
        }
        await context.files.rename({ oldPath: linkPath, newPath: backupPath });
        return true;
      }

      if (force || interactive) {
        await context.files.unlink({ path: linkPath });
      }
      return true;
    };

    const createLink = async ({
      targetPath,
      requestedLinkPath,
      displayLinkPath: initialDisplayLinkPath,
      resolveDirectoryDestination,
    }: {
      targetPath: string;
      requestedLinkPath: string;
      displayLinkPath: string;
      resolveDirectoryDestination: boolean;
    }): Promise<boolean> => {
      if (targetPath.length === 0) {
        throw new Error(
          `failed to create symbolic link '${initialDisplayLinkPath}' -> '': No such file or directory`,
        );
      }

      const requiresDirectory = requestedLinkPath.length > 1 && requestedLinkPath.endsWith('/');
      let displayLinkPath = initialDisplayLinkPath;
      let linkPath = resolvePath({ cwd: context.cwd, path: requestedLinkPath });
      if (resolveDirectoryDestination && !noTargetDirectory) {
        const destinationLstat = await pathStatOrUndefined({ context, path: linkPath, dereference: false });
        const destinationActsAsDirectory = destinationLstat?.type === 'symlink' && noDereference
          ? false
          : (await pathStatOrUndefined({ context, path: linkPath, dereference: true }))?.type === 'directory';
        if (requiresDirectory && !destinationActsAsDirectory) {
          throw new Error(`failed to create symbolic link '${requestedLinkPath}': No such file or directory`);
        }
        if (destinationActsAsDirectory) {
          const resolvedDirectory = await context.files.resolve({ path: linkPath });
          const targetBasename = basename({ path: targetPath });
          linkPath = `${resolvedDirectory.fullPath}/${targetBasename}`;
          displayLinkPath = `${displayLinkPath.replace(/\/+$/u, '')}/${targetBasename}`;
        }
      } else if (requiresDirectory) {
        throw new Error(`failed to create symbolic link '${requestedLinkPath}': No such file or directory`);
      }

      if (force && !backupEnabled) {
        try {
          const sourceEntry = await context.files.resolveEntry({
            path: resolvePath({ cwd: context.cwd, path: targetPath }),
            finalSymlinkTreatment: 'follow',
          });
          const destinationEntry = await context.files.resolveEntry({
            path: linkPath,
            finalSymlinkTreatment: 'no-follow',
          });
          if (sourceEntry.fullPath === destinationEntry.fullPath) {
            throw new Error(`'${targetPath}' and '${displayLinkPath}' are the same file`);
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.includes('are the same file')) {
            throw error;
          }
          if (!isPathNotFoundError({ error })) throw error;
        }
      }
      if (!await prepareExistingDestination({ linkPath, displayLinkPath })) {
        return false;
      }
      const storedTarget = relative
        ? relativePath({
          fromDirectory: dirname({ path: linkPath }),
          toPath: resolvePath({ cwd: context.cwd, path: targetPath }),
        })
        : targetPath;
      await context.files.symlink({ path: linkPath, targetPath: storedTarget });
      if (verbose) {
        await text.print({ text: `'${displayLinkPath}' -> '${storedTarget}'\n` });
      }
      return true;
    };

    const destinationIsDirectoryForm = targetDirectory !== undefined || targetPaths.length > 1;
    let destinationPath: string | undefined;
    if (targetDirectory !== undefined) {
      destinationPath = explicitTargetDirectoryPath;
    } else if (destinationIsDirectoryForm) {
      destinationPath = resolvePath({ cwd: context.cwd, path: linkOperand });
      const destination = await pathStatOrUndefined({ context, path: destinationPath, dereference: true });
      switch (destination) {
      case undefined:
        await text.error({ text: `ln: target '${linkOperand}' is not a directory\n` });
        return { exitCode: 1 };
      default:
        switch (destination.type) {
        case 'directory':
          break;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          await text.error({ text: `ln: target '${linkOperand}' is not a directory\n` });
          return { exitCode: 1 };
        default: {
          const _ex: never = destination.type;
          throw new Error(`Unhandled destination type: ${_ex}`);
        }
        }
        break;
      }
      destinationPath = (await context.files.resolve({ path: destinationPath })).fullPath;
    }

    let exitCode = 0;
    for (const targetPath of targetPaths) {
      try {
        const targetBasename = basename({ path: targetPath });
        const linked = await createLink({
          targetPath,
          requestedLinkPath: destinationPath === undefined
            ? linkOperand
            : `${destinationPath}/${targetBasename}`,
          displayLinkPath: destinationPath === undefined
            ? linkOperand
            : `${linkOperand.replace(/\/+$/u, '')}/${targetBasename}`,
          resolveDirectoryDestination: destinationPath === undefined,
        });
        if (!linked) {
          exitCode = 1;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `ln: ${message}\n` });
        exitCode = 1;
      }
    }
    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
