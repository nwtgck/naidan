import {
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';
import { parseBackupControlLongOption, resolveBackupControl, selectBackupSuffix, type BackupControl } from '@/features/wesh/commands/_shared/backup';
import { findCopyMovePreHelpSemanticError } from '@/features/wesh/commands/_shared/copy-move-pre-help';
import { createAffirmativeResponseReader } from '@/features/wesh/commands/_shared/confirmation';
import { getCoreUmaskOrDefault, getOptionalCoreMethod } from '@/features/wesh/commands/_shared/core-capability';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext, WeshEntryRef } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { parseUpdateLongOption, resolveExistingDestinationUpdate, type UpdateMode } from '@/features/wesh/commands/_shared/update';
import { openHandleReadStream, writeAllStreamToHandle } from '@/features/wesh/utils/fs';
import { normalizePath } from '@/features/wesh/path';

type CpSymlinkMode = 'physical' | 'logical' | 'command-line';
type CpOverwriteMode = 'default' | 'interactive' | 'no-clobber';

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
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

function asDirectoryEntryRef({
  entry,
}: {
  entry: WeshEntryRef,
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

async function backupExistingDestination({
  context,
  sourceEntry,
  sourceDisplayPath,
  destinationEntry,
  destinationPath,
  displayPath,
  suffix,
}: {
  context: WeshCommandContext;
  sourceEntry: WeshEntryRef;
  sourceDisplayPath: string;
  destinationEntry: WeshEntryRef;
  destinationPath: string;
  displayPath: string;
  suffix: string;
}): Promise<string> {
  const destinationStat = await context.files.statEntry({ entry: destinationEntry });
  switch (destinationStat.type) {
  case 'directory':
    throw new Error(`cannot backup directory '${displayPath}'`);
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    break;
  default: {
    const _ex: never = destinationStat.type;
    throw new Error(`Unhandled destination type: ${_ex}`);
  }
  }

  const backupPath = `${destinationPath}${suffix}`;
  const backupDisplayPath = `${displayPath}${suffix}`;
  if (backupPath === sourceEntry.fullPath) {
    throw new Error(`backing up '${displayPath}' might destroy source; '${sourceDisplayPath}' not copied`);
  }
  try {
    const existingBackup = await context.files.resolveEntry({
      path: backupPath,
      finalSymlinkTreatment: 'no-follow',
    });
    const existingBackupStat = await context.files.statEntry({ entry: existingBackup });
    switch (existingBackupStat.type) {
    case 'directory':
      throw new Error(`backup destination '${backupDisplayPath}' is a directory`);
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      await context.files.unlink({ path: backupPath });
      break;
    default: {
      const _ex: never = existingBackupStat.type;
      throw new Error(`Unhandled backup type: ${_ex}`);
    }
    }
  } catch (error: unknown) {
    if (!isPathNotFoundError({ error })) {
      throw error;
    }
  }

  await context.files.rename({ oldPath: destinationPath, newPath: backupPath });
  return backupDisplayPath;
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
        { key: 'archive', value: true },
      ],
      help: { summary: 'archive mode', category: 'common' },
    },
    { kind: 'flag', short: 'H', long: undefined, effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'follow command-line symlinks', category: 'advanced' } },
    { kind: 'flag', short: 'L', long: 'dereference', effects: [{ key: 'symlinkMode', value: 'logical' }], help: { summary: 'always follow symlinks', category: 'advanced' } },
    { kind: 'flag', short: 'P', long: 'no-dereference', effects: [{ key: 'symlinkMode', value: 'physical' }], help: { summary: 'never follow symlinks', category: 'advanced' } },
    { kind: 'flag', short: 'T', long: 'no-target-directory', effects: [{ key: 'noTargetDirectory', value: true }], help: { summary: 'treat destination as a normal file', category: 'advanced' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }], help: { summary: 'remove existing destination files', category: 'common' } },
    { kind: 'flag', short: 'i', long: 'interactive', effects: [{ key: 'overwriteMode', value: 'interactive' }], help: { summary: 'prompt before overwrite', category: 'common' } },
    { kind: 'flag', short: 'n', long: 'no-clobber', effects: [{ key: 'overwriteMode', value: 'no-clobber' }], help: { summary: 'do not overwrite existing files', category: 'common' } },
    { kind: 'flag', short: 'u', long: undefined, effects: [{ key: 'updateMode', value: 'older' }], help: { summary: 'copy only when SOURCE is newer than destination', category: 'common' } },
    { kind: 'flag', short: 'b', long: 'backup', effects: [{ key: 'backup', value: true }], help: { summary: 'make a backup of each existing destination file', category: 'common' } },
    {
      kind: 'value',
      short: 'S',
      long: 'suffix',
      key: 'backupSuffix',
      valueName: 'SUFFIX',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'override the usual backup suffix', valueName: 'SUFFIX', category: 'advanced' },
    },
    { kind: 'flag', short: 'v', long: 'verbose', effects: [{ key: 'verbose', value: true }], help: { summary: 'explain what is being done', category: 'common' } },
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
  specialTokenParsers: [
    ({ token }) => parseBackupControlLongOption({ token }),
    ({ token }) => parseUpdateLongOption({ token }),
  ],
};

export const cpCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    const readAffirmativeResponse = createAffirmativeResponseReader({ input: text.input });
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: cpArgvSpec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: cpArgvSpec });

    const diagnostic = parsed.diagnostics[0];
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: cpArgvSpec,
      parsed,
      findSemanticIssue: ({ parsed: candidate }) => findCopyMovePreHelpSemanticError({
        occurrences: candidate.occurrences,
      }),
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: `cp: ${diagnostic.message}`,
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 1 };
    }

    const preHelpSemanticError = findCopyMovePreHelpSemanticError({
      occurrences: parsed.occurrences,
    });
    if (preHelpSemanticError !== undefined) {
      switch (preHelpSemanticError.kind) {
      case 'invalid-update':
        await writeCommandUsageError({
          context,
          command: 'cp',
          message: `cp: invalid argument '${preHelpSemanticError.value}' for '--update'`,
          argvSpec: cpArgvSpec,
        });
        return { exitCode: 1 };
      case 'multiple-target-directories':
        await context.text().error({ text: 'cp: multiple target directories specified\n' });
        return { exitCode: 1 };
      default: {
        const _ex: never = preHelpSemanticError;
        throw new Error(`Unhandled cp pre-help semantic error: ${JSON.stringify(_ex)}`);
      }
      }
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cp',
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 0 };
    }

    const updateMode: UpdateMode = (() => {
      const configured = parsed.optionValues.updateMode;
      if (configured === 'all' || configured === 'none' || configured === 'none-fail' || configured === 'older') {
        return configured;
      }
      return 'all';
    })();

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
          command: 'cp',
          message: `cp: invalid argument '${backupControlResult.value}' for '${source}'`,
          argvSpec: cpArgvSpec,
        });
        return { exitCode: 1 };
      }
      backupControl = backupControlResult.control;
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
    const preserveMode = parsed.optionValues.archive === true;
    const setMode = getOptionalCoreMethod<({
      path,
      mode,
      finalSymlinkTreatment,
    }: {
      path: string;
      mode: number;
      finalSymlinkTreatment: 'follow' | 'no-follow';
    }) => Promise<void>>({ object: context.files, name: 'setMode' });
    const setMtime = getOptionalCoreMethod<({
      path,
      mtime,
      finalSymlinkTreatment,
    }: {
      path: string;
      mtime: number;
      finalSymlinkTreatment: 'follow' | 'no-follow';
    }) => Promise<void>>({ object: context.files, name: 'setMtime' });
    if (preserveMode && (setMode === undefined || setMtime === undefined)) {
      await text.error({
        text: 'cp: archive mode requires Wesh core file metadata mutation support\n',
      });
      return { exitCode: 1 };
    }
    const overwriteMode: CpOverwriteMode = (() => {
      const configured = parsed.optionValues.overwriteMode;
      if (configured === 'interactive' || configured === 'no-clobber') {
        return configured;
      }
      return 'default';
    })();
    let interactiveDeclined = false;
    let hadError = false;
    const backupEnabled = backupRequested && backupControl !== 'none';
    const backupSuffix = typeof parsed.optionValues.backupSuffix === 'string'
      && parsed.optionValues.backupSuffix.length > 0
      ? parsed.optionValues.backupSuffix
      : '~';
    const verbose = parsed.optionValues.verbose === true;
    const noTargetDirectory = parsed.optionValues.noTargetDirectory === true;

    if (
      backupRequested
      && (overwriteMode === 'no-clobber' || updateMode === 'none' || updateMode === 'none-fail')
    ) {
      await text.error({ text: 'cp: --backup is mutually exclusive with -n or --update=none-fail\n' });
      return { exitCode: 1 };
    }
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

    if (noTargetDirectory && targetDirectory !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: 'cp: cannot combine --target-directory (-t) and --no-target-directory (-T)',
        argvSpec: cpArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (targetDirectory === '') {
      await text.error({ text: "cp: target directory '': No such file or directory\n" });
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

    const resolveSourceEntry = ({
      path,
      isCommandLineArgument,
    }: {
      path: string,
      isCommandLineArgument: boolean,
    }): Promise<WeshEntryRef> => {
      const finalSymlinkTreatment = (() => {
        if (path.length > 1 && path.endsWith('/')) {
          return 'follow' as const;
        }
        switch (symlinkMode) {
        case 'logical':
          return 'follow' as const;
        case 'command-line':
          return isCommandLineArgument ? 'follow' as const : 'no-follow' as const;
        case 'physical':
          return 'no-follow' as const;
        default: {
          const _ex: never = symlinkMode;
          throw new Error(`Unhandled symlink mode: ${_ex}`);
        }
        }
      })();
      return context.files.resolveEntry({ path, finalSymlinkTreatment });
    };

    const destinationCreationMode = ({
      sourceMode,
      type,
    }: {
      sourceMode: number,
      type: 'file' | 'directory',
    }): number => {
      if (preserveMode) {
        return sourceMode & 0o7777;
      }
      const maskedPermissions = (sourceMode & 0o777) & ~getCoreUmaskOrDefault({ context });
      switch (type) {
      case 'directory':
        return (sourceMode & 0o7000) | maskedPermissions;
      case 'file':
        return maskedPermissions;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled cp destination type: ${_ex}`);
      }
      }
    };

    const copyRegularFile = async ({
      entry,
      destPath,
      mode,
    }: {
      entry: WeshEntryRef,
      destPath: string,
      mode: number,
    }): Promise<void> => {
      const source = await context.files.openEntry({
        entry,
        flags: {
          access: 'read',
          creation: 'never',
          truncate: 'preserve',
          append: 'preserve',
        },
      });
      const destination = await context.files.open({
        path: destPath,
        flags: {
          access: 'write',
          creation: 'if-needed',
          truncate: 'truncate',
          append: 'preserve',
        },
        mode,
      });
      await writeAllStreamToHandle({
        stream: openHandleReadStream({ handle: source }),
        handle: destination,
        closeHandle: true,
      });
    };

    const prepareExistingTarget = async ({
      sourceEntry,
      sourceDisplayPath,
      destPath,
      destDisplayPath,
    }: {
      sourceEntry: WeshEntryRef,
      sourceDisplayPath: string,
      destPath: string,
      destDisplayPath: string,
    }): Promise<
      | {
        readonly status: 'ready'
        readonly backupDisplayPath: string | undefined
        readonly destinationDirectoryExisted: boolean
      }
      | { readonly status: 'skipped' }
    > => {
      try {
        const existing = await context.files.resolveEntry({
          path: destPath,
          finalSymlinkTreatment: 'no-follow',
        });
        switch (overwriteMode) {
        case 'no-clobber':
          return { status: 'skipped' };
        case 'default':
        case 'interactive':
          break;
        default: {
          const _ex: never = overwriteMode;
          throw new Error(`Unhandled overwrite mode: ${_ex}`);
        }
        }
        if (updateMode !== 'all' && sourceEntry.type !== 'directory' && existing.type !== 'directory') {
          const sourceStat = await context.files.statEntry({ entry: sourceEntry });
          const destinationStat = await context.files.statEntry({ entry: existing });
          const updateDecision = resolveExistingDestinationUpdate({
            mode: updateMode,
            sourceMtime: sourceStat.mtime,
            destinationMtime: destinationStat.mtime,
          });
          switch (updateDecision) {
          case 'skip':
            return { status: 'skipped' };
          case 'skip-error':
            hadError = true;
            await text.error({ text: `cp: not replacing '${destDisplayPath}'\n` });
            return { status: 'skipped' };
          case 'replace':
            break;
          default: {
            const _ex: never = updateDecision;
            throw new Error(`Unhandled update decision: ${_ex}`);
          }
          }
        }
        switch (overwriteMode) {
        case 'interactive':
          switch (existing.type) {
          case 'directory':
            return {
              status: 'ready',
              backupDisplayPath: undefined,
              destinationDirectoryExisted: true,
            };
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            await text.error({ text: `cp: overwrite '${destPath}'? ` });
            if (!await readAffirmativeResponse()) {
              interactiveDeclined = true;
              return { status: 'skipped' };
            }
            break;
          default: {
            const _ex: never = existing;
            throw new Error(
              `Unhandled type: ${((_ex satisfies never) as { readonly type: string }).type}`,
            );
          }
          }
          break;
        case 'default':
          break;
        default: {
          const _ex: never = overwriteMode;
          throw new Error(`Unhandled overwrite mode: ${_ex}`);
        }
        }
        switch (existing.type) {
        case 'directory':
          return {
            status: 'ready',
            backupDisplayPath: undefined,
            destinationDirectoryExisted: true,
          };
        case 'file':
        case 'fifo':
        case 'chardev':
          break;
        case 'symlink':
          if (!backupEnabled) {
            try {
              await context.files.stat({ path: destPath });
            } catch (error: unknown) {
              if (!isPathNotFoundError({ error })) {
                throw error;
              }
              throw new Error(`not writing through dangling symlink '${destPath}'`);
            }
          }
          break;
        default: {
          const _ex: never = existing;
          throw new Error(
            `Unhandled type: ${((_ex satisfies never) as { readonly type: string }).type}`,
          );
        }
        }
        const selectedBackupSuffix = backupEnabled
          ? await selectBackupSuffix({
            context,
            destinationPath: destPath,
            control: backupControl,
            simpleSuffix: backupSuffix,
          })
          : undefined;
        const backupDisplayPath = selectedBackupSuffix !== undefined
          ? await backupExistingDestination({
            context,
            sourceEntry,
            sourceDisplayPath,
            destinationEntry: existing,
            destinationPath: destPath,
            displayPath: destDisplayPath,
            suffix: selectedBackupSuffix,
          })
          : undefined;
        return {
          status: 'ready',
          backupDisplayPath,
          destinationDirectoryExisted: false,
        };
      } catch (error: unknown) {
        if (isPathNotFoundError({ error })) {
          return {
            status: 'ready',
            backupDisplayPath: undefined,
            destinationDirectoryExisted: false,
          };
        }
        throw error;
      }
    };

    const writeVerboseCopy = async ({
      srcDisplayPath,
      destDisplayPath,
      backupDisplayPath,
    }: {
      srcDisplayPath: string,
      destDisplayPath: string,
      backupDisplayPath: string | undefined,
    }): Promise<void> => {
      if (!verbose) {
        return;
      }
      const backupText = backupDisplayPath === undefined
        ? ''
        : ` (backup: '${backupDisplayPath}')`;
      await text.print({
        text: `'${srcDisplayPath}' -> '${destDisplayPath}'${backupText}
`,
      });
    };

    const copyOne = async ({
      srcPath,
      srcDisplayPath,
      sourceEntry,
      destPath,
      destDisplayPath,
      isCommandLineArgument,
      ancestorDirectoryPaths,
    }: {
      srcPath: string,
      srcDisplayPath: string,
      sourceEntry: WeshEntryRef | undefined,
      destPath: string,
      destDisplayPath: string,
      isCommandLineArgument: boolean,
      ancestorDirectoryPaths: ReadonlySet<string>,
    }): Promise<void> => {
      const entry = sourceEntry ?? await resolveSourceEntry({
        path: srcPath,
        isCommandLineArgument,
      });
      const stat = await context.files.statEntry({ entry });

      try {
        const destinationEntry = await context.files.resolveEntry({
          path: destPath,
          finalSymlinkTreatment: 'no-follow',
        });
        if (destinationEntry.fullPath === entry.fullPath) {
          throw new Error(`'${srcPath}' and '${destPath}' are the same file`);
        }
        if (
          stat.type !== 'symlink'
          && overwriteMode !== 'no-clobber'
          && !backupEnabled
          && destinationEntry.type === 'symlink'
        ) {
          const followedDestinationEntry = await context.files.resolveEntry({
            path: destPath,
            finalSymlinkTreatment: 'follow',
          });
          if (followedDestinationEntry.fullPath === entry.fullPath) {
            throw new Error(`'${srcPath}' and '${destPath}' are the same file`);
          }
        }
        if (
          stat.type === 'symlink'
          && destinationEntry.type !== 'symlink'
          && overwriteMode !== 'no-clobber'
        ) {
          const followedSourceEntry = await context.files.resolveEntry({
            path: srcPath,
            finalSymlinkTreatment: 'follow',
          });
          if (followedSourceEntry.fullPath === destinationEntry.fullPath) {
            throw new Error(`'${srcPath}' and '${destPath}' are the same file`);
          }
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('are the same file')) {
          throw error;
        }
        if (!isPathNotFoundError({ error })) {
          throw error;
        }
      }

      switch (stat.type) {
      case 'directory': {
        const normalizedDestination = normalizePath({ cwd: '/', path: destPath });
        if (normalizedDestination.startsWith(`${entry.fullPath}/`)) {
          throw new Error(`cannot copy '${srcPath}' into a subdirectory of itself`);
        }
        break;
      }
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled file type: ${_ex}`);
      }
      }

      switch (stat.type) {
      case 'directory':
        if (!recursive) {
          throw new Error(`-r not specified; omitting directory '${srcPath}'`);
        }
        if (ancestorDirectoryPaths.has(entry.fullPath)) {
          throw new Error(`cannot copy cyclic symbolic link '${srcPath}'`);
        }
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled file type: ${_ex}`);
      }
      }

      const existingTarget = await prepareExistingTarget({
        sourceEntry: entry,
        sourceDisplayPath: srcDisplayPath,
        destPath,
        destDisplayPath,
      });
      switch (existingTarget.status) {
      case 'skipped':
        return;
      case 'ready':
        break;
      default: {
        const _ex: never = existingTarget;
        throw new Error(`Unhandled destination state: ${_ex}`);
      }
      }

      switch (stat.type) {
      case 'directory': {
        const childAncestorDirectoryPaths = new Set(ancestorDirectoryPaths);
        childAncestorDirectoryPaths.add(entry.fullPath);
        await context.files.mkdir({
          path: destPath,
          mode: destinationCreationMode({ sourceMode: stat.mode, type: 'directory' }),
          recursive: true,
        });
        if (!existingTarget.destinationDirectoryExisted) {
          await writeVerboseCopy({
            srcDisplayPath,
            destDisplayPath,
            backupDisplayPath: undefined,
          });
        }
        for await (const child of context.files.readDirEntry({
          entry: asDirectoryEntryRef({ entry }),
        })) {
          await copyOne({
            srcPath: child.fullPath,
            srcDisplayPath: `${srcDisplayPath.replace(/\/+$/u, '')}/${child.name}`,
            sourceEntry: symlinkMode === 'logical' && child.type === 'symlink'
              ? undefined
              : child,
            destPath: `${destPath}/${child.name}`,
            destDisplayPath: `${destDisplayPath.replace(/\/+$/u, '')}/${child.name}`,
            isCommandLineArgument: false,
            ancestorDirectoryPaths: childAncestorDirectoryPaths,
          });
        }
        if (preserveMode) {
          await setMode!({
            path: destPath,
            mode: stat.mode,
            finalSymlinkTreatment: 'follow',
          });
          await setMtime!({
            path: destPath,
            mtime: stat.mtime,
            finalSymlinkTreatment: 'follow',
          });
        }
        break;
      }
      case 'file':
        await copyRegularFile({
          entry,
          destPath,
          mode: destinationCreationMode({ sourceMode: stat.mode, type: 'file' }),
        });
        if (preserveMode) {
          await setMode!({
            path: destPath,
            mode: stat.mode,
            finalSymlinkTreatment: 'follow',
          });
          await setMtime!({
            path: destPath,
            mtime: stat.mtime,
            finalSymlinkTreatment: 'follow',
          });
        }
        await writeVerboseCopy({
          srcDisplayPath,
          destDisplayPath,
          backupDisplayPath: existingTarget.backupDisplayPath,
        });
        break;
      case 'symlink':
        if (symlinkMode === 'physical' || (symlinkMode === 'command-line' && !isCommandLineArgument)) {
          if (existingTarget.destinationDirectoryExisted) {
            throw new Error(`cannot overwrite directory '${destDisplayPath}' with non-directory`);
          }
          if (existingTarget.backupDisplayPath === undefined) {
            try {
              await context.files.unlink({ path: destPath });
            } catch (error: unknown) {
              if (!isPathNotFoundError({ error })) {
                throw error;
              }
            }
          }
          const linkTarget = await context.files.readlink({ path: srcPath });
          await context.files.symlink({
            path: destPath,
            targetPath: linkTarget,
          });
          if (preserveMode) {
            await setMtime!({
              path: destPath,
              mtime: stat.mtime,
              finalSymlinkTreatment: 'no-follow',
            });
          }
          await writeVerboseCopy({
            srcDisplayPath,
            destDisplayPath,
            backupDisplayPath: existingTarget.backupDisplayPath,
          });
          break;
        }
        await copyRegularFile({
          entry,
          destPath,
          mode: destinationCreationMode({ sourceMode: stat.mode, type: 'file' }),
        });
        if (preserveMode) {
          await setMtime!({
            path: destPath,
            mtime: stat.mtime,
            finalSymlinkTreatment: 'follow',
          });
        }
        await writeVerboseCopy({
          srcDisplayPath,
          destDisplayPath,
          backupDisplayPath: existingTarget.backupDisplayPath,
        });
        break;
      case 'fifo':
      case 'chardev':
        await context.files.mknod({
          path: destPath,
          type: stat.type,
          mode: destinationCreationMode({ sourceMode: stat.mode, type: 'file' }),
        });
        if (preserveMode) {
          await setMtime!({
            path: destPath,
            mtime: stat.mtime,
            finalSymlinkTreatment: 'follow',
          });
        }
        await writeVerboseCopy({
          srcDisplayPath,
          destDisplayPath,
          backupDisplayPath: existingTarget.backupDisplayPath,
        });
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled type: ${_ex}`);
      }
      }
    };

    const resolveDestinationTarget = async ({
      srcPath,
      destPath,
      destDisplayPath,
      treatDestAsDirectory,
    }: {
      srcPath: string,
      destPath: string,
      destDisplayPath: string,
      treatDestAsDirectory: boolean,
    }): Promise<{ readonly path: string, readonly displayPath: string }> => {
      const sourceBasename = basename({ path: srcPath });
      if (treatDestAsDirectory) {
        return {
          path: `${destPath}/${sourceBasename}`,
          displayPath: `${destDisplayPath.replace(/\/+$/u, '')}/${sourceBasename}`,
        };
      }

      try {
        const destStat = await context.files.stat({ path: destPath });
        switch (destStat.type) {
        case 'directory': {
          if (noTargetDirectory) {
            throw new Error(`cannot overwrite directory '${destDisplayPath}' with non-directory`);
          }
          return {
            path: `${destPath}/${sourceBasename}`,
            displayPath: `${destDisplayPath.replace(/\/+$/u, '')}/${sourceBasename}`,
          };
        }
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          return { path: destPath, displayPath: destDisplayPath };
        default: {
          const _ex: never = destStat.type;
          throw new Error(`Unhandled type: ${_ex}`);
        }
        }
      } catch (error: unknown) {
        if (!isPathNotFoundError({ error })) {
          throw error;
        }
        return { path: destPath, displayPath: destDisplayPath };
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
        return destOperand.endsWith('/');
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

      for (const sourceOperand of sourceOperands) {
        try {
          const fullSrc = resolvePath({ cwd: context.cwd, path: sourceOperand });
          const target = await resolveDestinationTarget({
            srcPath: fullSrc,
            destPath: fullDest,
            destDisplayPath: destOperand,
            treatDestAsDirectory,
          });
          await copyOne({
            srcPath: fullSrc,
            srcDisplayPath: sourceOperand,
            sourceEntry: undefined,
            destPath: target.path,
            destDisplayPath: target.displayPath,
            isCommandLineArgument: true,
            ancestorDirectoryPaths: new Set(),
          });
        } catch (e: unknown) {
          hadError = true;
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `cp: ${sourceOperand}: ${message}\n` });
        }
      }
      return { exitCode: hadError || interactiveDeclined ? 1 : 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `cp: ${sourceOperands[0] ?? ''}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
