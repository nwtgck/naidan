import { resolveBackupControl, selectBackup, type BackupControl } from '@/features/wesh/commands/_shared/backup';
import { parseCopyMoveOptions, type CopyMoveOption } from '@/features/wesh/commands/_shared/copy-move-pre-help';
import { createAffirmativeResponseReader } from '@/features/wesh/commands/_shared/confirmation';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { getOptionalCoreMethod } from '@/features/wesh/commands/_shared/core-capability';
import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { resolveExistingDestinationUpdate } from '@/features/wesh/commands/_shared/update';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext, WeshEntryRef } from '@/features/wesh/types';

type MvOverwriteMode = 'default' | 'force' | 'interactive' | 'no-clobber';

class MvSourceBackupAliasError extends Error {
  readonly destinationDisplayPath: string;
  readonly sourceDisplayPath: string;

  constructor({
    destinationDisplayPath,
    sourceDisplayPath,
  }: {
    destinationDisplayPath: string;
    sourceDisplayPath: string;
  }) {
    super('selected backup path aliases source');
    this.name = 'MvSourceBackupAliasError';
    this.destinationDisplayPath = destinationDisplayPath;
    this.sourceDisplayPath = sourceDisplayPath;
  }
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function basename({
  path,
}: {
  path: string,
}): string {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function resolveMvSimpleBackupSuffix({
  explicitSuffix,
  environmentSuffix,
}: {
  explicitSuffix: string | undefined;
  environmentSuffix: string | undefined;
}): string {
  const selected = explicitSuffix !== undefined
    ? explicitSuffix
    : environmentSuffix;
  return selected === undefined || selected.length === 0 || selected.includes('/') ? '~' : selected;
}


function asDirectoryEntry({
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

async function copyRegularFile({
  context,
  sourceEntry,
  destinationPath,
  mode,
}: {
  context: WeshCommandContext,
  sourceEntry: WeshEntryRef,
  destinationPath: string,
  mode: number,
}): Promise<void> {
  const source = await context.files.openEntry({
    entry: sourceEntry,
    flags: {
      access: 'read',
      creation: 'never',
      truncate: 'preserve',
      append: 'preserve',
    },
  });
  const destination = await context.files.open({
    path: destinationPath,
    flags: {
      access: 'write',
      creation: 'if-needed',
      truncate: 'truncate',
      append: 'preserve',
    },
    mode: mode & 0o777,
  });

  try {
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const { bytesRead } = await source.read({ buffer });
      if (bytesRead === 0) {
        break;
      }
      await destination.write({
        buffer,
        offset: 0,
        length: bytesRead,
      });
    }
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
}

async function copyEntryRecursively({
  context,
  sourceEntry,
  destinationPath,
}: {
  context: WeshCommandContext,
  sourceEntry: WeshEntryRef,
  destinationPath: string,
}): Promise<void> {
  const stat = await context.files.statEntry({ entry: sourceEntry });
  switch (stat.type) {
  case 'directory': {
    await context.files.mkdir({
      path: destinationPath,
      mode: stat.mode & 0o777,
      recursive: false,
    });
    for await (const child of context.files.readDirEntry({
      entry: asDirectoryEntry({ entry: sourceEntry }),
    })) {
      await copyEntryRecursively({
        context,
        sourceEntry: child,
        destinationPath: `${destinationPath}/${child.name}`,
      });
    }
    break;
  }
  case 'file':
    await copyRegularFile({
      context,
      sourceEntry,
      destinationPath,
      mode: stat.mode,
    });
    break;
  case 'symlink':
    await context.files.symlink({
      path: destinationPath,
      targetPath: await context.files.readlink({ path: sourceEntry.fullPath }),
      mode: stat.mode & 0o777,
    });
    break;
  case 'fifo':
  case 'chardev':
    await context.files.mknod({
      path: destinationPath,
      type: stat.type,
      mode: stat.mode & 0o777,
    });
    break;
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled entry type: ${_ex}`);
  }
  }
  const setMtime = getOptionalCoreMethod<({
    path,
    mtime,
    finalSymlinkTreatment,
  }: {
    path: string;
    mtime: number;
    finalSymlinkTreatment: 'follow' | 'no-follow';
  }) => Promise<void>>({ object: context.files, name: 'setMtime' });
  if (setMtime === undefined) {
    throw new Error('cross-filesystem move requires Wesh core mtime mutation support');
  }
  await setMtime({
    path: destinationPath,
    mtime: stat.mtime,
    finalSymlinkTreatment: (() => {
      switch (stat.type) {
      case 'symlink':
        return 'no-follow';
      case 'directory':
      case 'file':
      case 'fifo':
      case 'chardev':
        return 'follow';
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled entry type: ${_ex}`);
      }
      }
    })(),
  });
}

async function removeEntryRecursively({
  context,
  entry,
}: {
  context: WeshCommandContext,
  entry: WeshEntryRef,
}): Promise<void> {
  const stat = await context.files.statEntry({ entry });
  switch (stat.type) {
  case 'directory': {
    const children: WeshEntryRef[] = [];
    for await (const child of context.files.readDirEntry({
      entry: asDirectoryEntry({ entry }),
    })) {
      children.push(child);
    }
    for (const child of children) {
      await removeEntryRecursively({ context, entry: child });
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
    throw new Error(`Unhandled entry type: ${_ex}`);
  }
  }
}

async function moveDirectoryRecursively({
  context,
  sourceEntry,
  destinationPath,
}: {
  context: WeshCommandContext,
  sourceEntry: WeshEntryRef<'directory'>,
  destinationPath: string,
}): Promise<void> {
  if (destinationPath.startsWith(`${sourceEntry.fullPath}/`)) {
    throw new Error(`cannot move '${sourceEntry.fullPath}' to a subdirectory of itself`);
  }

  try {
    await context.files.lstat({ path: destinationPath });
    throw new Error(`destination exists: ${destinationPath}`);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('destination exists:')) {
      throw error;
    }
    if (!isPathNotFoundError({ error })) {
      throw error;
    }
  }

  try {
    await copyEntryRecursively({
      context,
      sourceEntry,
      destinationPath,
    });
  } catch (error: unknown) {
    try {
      const partial = await context.files.resolveEntry({
        path: destinationPath,
        finalSymlinkTreatment: 'no-follow',
      });
      await removeEntryRecursively({ context, entry: partial });
    } catch {
      // Preserve the original copy error. Best-effort rollback may itself fail.
    }
    throw error;
  }

  await removeEntryRecursively({ context, entry: sourceEntry });
}

async function moveWithBackup({
  context,
  sourceEntry,
  sourceDisplayPath,
  destinationEntry,
  destinationPath,
  displayPath,
  suffix,
  numbered,
}: {
  context: WeshCommandContext,
  sourceEntry: WeshEntryRef,
  sourceDisplayPath: string,
  destinationEntry: WeshEntryRef,
  destinationPath: string,
  displayPath: string,
  suffix: string,
  numbered: boolean,
}): Promise<{ displayPath: string, moved: boolean }> {
  switch (destinationEntry.type) {
  case 'directory':
    throw new Error(`cannot backup directory '${displayPath}'`);
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    break;
  default: {
    const _ex: never = destinationEntry;
    throw new Error(`Unhandled destination type: ${String(_ex)}`);
  }
  }

  const backupPath = `${destinationPath}${suffix}`;
  const backupDisplayPath = `${displayPath}${suffix}`;
  let existingBackup: WeshEntryRef | undefined;
  try {
    existingBackup = await context.files.resolveEntry({ path: backupPath, finalSymlinkTreatment: 'no-follow', pinBacking: true });
  } catch (error: unknown) {
    if (!isPathNotFoundError({ error })) {
      throw error;
    }
  }

  if (existingBackup !== undefined) {
    if (numbered) {
      throw new Error(`File exists: ${backupDisplayPath}`);
    }
    switch (existingBackup.type) {
    case 'directory':
      throw new Error(`backup destination '${backupDisplayPath}' is a directory`);
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      break;
    default: {
      const _ex: never = existingBackup;
      throw new Error(`Unhandled backup type: ${String(_ex)}`);
    }
    }
    const sourceIdentity = await context.files.compareEntryIdentity({ first: sourceEntry, second: existingBackup });
    if (sourceIdentity === 'same' && sourceEntry.type === 'symlink' && existingBackup.type === 'symlink') {
      // Backing up the destination to the source's name and moving it back only removes this link.
      await context.files.unlink({ path: sourceEntry.fullPath, expected: { entry: sourceEntry, retainedEntries: [destinationEntry] } });
      return { displayPath: backupDisplayPath, moved: true };
    }
    switch (sourceIdentity) {
    case 'unknown':
      throw new Error(`cannot verify that backup '${backupDisplayPath}' is separate from '${sourceDisplayPath}'`);
    case 'shared-backing':
    case 'same':
      throw new MvSourceBackupAliasError({ destinationDisplayPath: displayPath, sourceDisplayPath });
    case 'different':
      break;
    default: {
      const _ex: never = sourceIdentity;
      throw new Error(`Unhandled entry identity: ${_ex}`);
    }
    }
    const backupIdentity = await context.files.compareEntryIdentity({ first: destinationEntry, second: existingBackup });
    switch (backupIdentity) {
    case 'different':
      break;
    case 'same':
    case 'shared-backing':
    case 'unknown':
      throw new Error(`cannot verify that backup '${backupDisplayPath}' is separate from '${displayPath}'`);
    default: {
      const _ex: never = backupIdentity;
      throw new Error(`Unhandled entry identity: ${_ex}`);
    }
    }
  }

  if (context.files.getReadOnlyForPath({ path: sourceEntry.fullPath })) {
    const sourcePath = resolvePath({ cwd: context.cwd, path: sourceDisplayPath });
    throw new Error(`Read-only source: ${sourcePath}`);
  }
  switch (sourceEntry.type) {
  case 'directory':
    await context.files.rename({
      oldPath: destinationPath,
      newPath: backupPath,
      expectedSource: destinationEntry,
      expectedDestination: existingBackup,
      noReplace: existingBackup === undefined ? true : undefined,
    });
    return { displayPath: backupDisplayPath, moved: false };
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    await context.files.replaceEntry({
      entry: sourceEntry,
      path: destinationPath,
      expected: destinationEntry,
      backupPath,
      expectedBackup: { entry: existingBackup },
    });
    return { displayPath: backupDisplayPath, moved: true };
  default: {
    const _ex: never = sourceEntry;
    throw new Error(`Unhandled source type: ${String(_ex)}`);
  }
  }
}

const mvOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'overwriteMode', value: 'force' }] },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'none' } },
      { kind: 'long', name: 'force', value: { kind: 'none' } },
    ],
    summary: 'remove existing destination files',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'overwriteMode', value: 'interactive' }] },
    forms: [
      { kind: 'short', name: 'i', value: { kind: 'none' } },
      { kind: 'long', name: 'interactive', value: { kind: 'none' } },
    ],
    summary: 'prompt before overwrite',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'overwriteMode', value: 'no-clobber' }] },
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'none' } },
      { kind: 'long', name: 'no-clobber', value: { kind: 'none' } },
    ],
    summary: 'do not overwrite existing files',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'update' },
    forms: [
      { kind: 'short', name: 'u', value: { kind: 'none' } },
      { kind: 'long', name: 'update', value: { kind: 'optional-inline' } },
    ],
    summary: 'move only when SOURCE is newer than destination',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'backup' },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'none' } },
      { kind: 'long', name: 'backup', value: { kind: 'optional-inline' } },
    ],
    summary: 'make a backup of each existing destination file',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'backupSuffix', parse: undefined },
    forms: [
      { kind: 'short', name: 'S', value: { kind: 'required-attached-or-following', missingValueName: 'SUFFIX' } },
      { kind: 'long', name: 'suffix', value: { kind: 'required', missingValueName: 'SUFFIX' } },
    ],
    summary: 'override the usual backup suffix',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
    forms: [
      { kind: 'short', name: 'v', value: { kind: 'none' } },
      { kind: 'long', name: 'verbose', value: { kind: 'none' } },
    ],
    summary: 'explain what is being done',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'noTargetDirectory', value: true }] },
    forms: [
      { kind: 'short', name: 'T', value: { kind: 'none' } },
      { kind: 'long', name: 'no-target-directory', value: { kind: 'none' } },
    ],
    summary: 'treat destination as a normal file',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'targetDirectory', parse: undefined },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'DIRECTORY' } },
      { kind: 'long', name: 'target-directory', value: { kind: 'required', missingValueName: 'DIRECTORY' } },
    ],
    summary: 'move all source arguments into DIRECTORY',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const mvArgvCatalog = defineArgvCatalog<StandardArgvAction<CopyMoveOption>>({
  definitions: mvOptions,
  nonExecutableLongOptions: [],
});
const mvArgvHelp = defineArgvHelpPresentation({ catalog: mvArgvCatalog, rows: mvOptions });
const mvArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

export const mvCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopArgvAtFirstEarlyExit({
      args: context.args,
      catalog: mvArgvCatalog,
      policy: mvArgvPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, catalog: mvArgvCatalog, policy: mvArgvPolicy });

    const options = parseCopyMoveOptions({ parsed });
    switch (options.kind) {
    case 'invalid-option':
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: `mv: ${options.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: mvArgvHelp }),
      });
      return { exitCode: 1 };
    case 'multiple-target-directories':
      await context.text().error({ text: 'mv: multiple target directories specified\n' });
      return { exitCode: 1 };
    case 'options':
      break;
    default: {
      const _ex: never = options;
      throw new Error(`Unhandled mv options: ${JSON.stringify(_ex)}`);
    }
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mv',
        optionLines: formatArgvOptionHelp({ presentation: mvArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const { updateMode, backupRequested } = options;
    let backupControl: BackupControl = 'simple';
    if (backupRequested) {
      const backupControlResult = resolveBackupControl({
        explicitValue: options.backupControl,
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
          command: 'mv',
          message: `mv: invalid argument '${backupControlResult.value}' for '${source}'`,
          usageSummary: formatArgvUsageSummary({ presentation: mvArgvHelp }),
        });
        return { exitCode: 1 };
      }
      backupControl = backupControlResult.control;
    }
    const readAffirmativeResponse = createAffirmativeResponseReader({ input: text.input });
    const targetDirectory = typeof parsed.optionValues.targetDirectory === 'string'
      ? parsed.optionValues.targetDirectory
      : undefined;
    const overwriteMode: MvOverwriteMode = (() => {
      const configured = parsed.optionValues.overwriteMode;
      if (configured === 'force' || configured === 'interactive' || configured === 'no-clobber') {
        return configured;
      }
      return 'default';
    })();
    let interactiveDeclined = false;
    const backupEnabled = backupRequested && backupControl !== 'none';
    const guardRename = backupEnabled || overwriteMode === 'no-clobber' || overwriteMode === 'interactive' || updateMode !== 'all';
    const pinBacking = guardRename ? true : undefined;
    const backupSuffix = resolveMvSimpleBackupSuffix({
      explicitSuffix: typeof parsed.optionValues.backupSuffix === 'string'
        ? parsed.optionValues.backupSuffix
        : undefined,
      environmentSuffix: context.env.get('SIMPLE_BACKUP_SUFFIX'),
    });
    const verbose = parsed.optionValues.verbose === true;
    const noTargetDirectory = parsed.optionValues.noTargetDirectory === true;

    if (
      backupRequested
      && (overwriteMode === 'no-clobber' || updateMode === 'none' || updateMode === 'none-fail')
    ) {
      await text.error({ text: 'mv: cannot combine --backup with -n or --update=none-fail\n' });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length < (targetDirectory === undefined ? 2 : 1)) {
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: 'mv: missing file operand',
        usageSummary: formatArgvUsageSummary({ presentation: mvArgvHelp }),
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
        usageSummary: formatArgvUsageSummary({ presentation: mvArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (noTargetDirectory && targetDirectory !== undefined) {
      await text.error({ text: 'mv: cannot combine --target-directory (-t) and --no-target-directory (-T)\n' });
      return { exitCode: 1 };
    }
    if (targetDirectory === '') {
      await text.error({ text: "mv: target directory '': No such file or directory\n" });
      return { exitCode: 1 };
    }
    if (noTargetDirectory && sourceOperands.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: 'mv: extra operand with -T',
        usageSummary: formatArgvUsageSummary({ presentation: mvArgvHelp }),
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

      let hadError = false;

      for (const sourceOperand of sourceOperands) {
        try {
          const fullSrc = resolvePath({ cwd: context.cwd, path: sourceOperand });
          const target = await (async (): Promise<{ path: string, displayPath: string }> => {
            const sourceBasename = basename({ path: fullSrc });
            if (treatDestAsDirectory) {
              return {
                path: `${fullDest}/${sourceBasename}`,
                displayPath: `${destOperand.replace(/\/+$/u, '')}/${sourceBasename}`,
              };
            }

            let destinationStat:
              | Awaited<ReturnType<WeshCommandContext['files']['stat']>>
              | undefined;
            try {
              destinationStat = noTargetDirectory
                ? await context.files.lstat({ path: fullDest })
                : await context.files.stat({ path: fullDest });
            } catch (error: unknown) {
              if (!isPathNotFoundError({ error })) {
                throw error;
              }
              destinationStat = undefined;
            }

            if (destinationStat === undefined) {
              if (destOperand.length > 1 && destOperand.endsWith('/')) {
                throw new Error(`cannot move '${sourceOperand}' to '${destOperand}': Not a directory`);
              }
              return { path: fullDest, displayPath: destOperand };
            }

            switch (destinationStat.type) {
            case 'directory':
              return noTargetDirectory
                ? { path: fullDest, displayPath: destOperand }
                : {
                  path: `${fullDest}/${sourceBasename}`,
                  displayPath: `${destOperand.replace(/\/+$/u, '')}/${sourceBasename}`,
                };
            case 'file':
            case 'fifo':
            case 'chardev':
            case 'symlink':
              return { path: fullDest, displayPath: destOperand };
            default: {
              const _ex: never = destinationStat.type;
              throw new Error(`Unhandled destination type: ${_ex}`);
            }
            }
          })();
          const targetPath = target.path;

          const sourceEntry = await context.files.resolveEntry({
            path: fullSrc,
            finalSymlinkTreatment: 'no-follow',
            pinBacking,
          });
          const sourceStat = await context.files.statEntry({ entry: sourceEntry });
          if (sourceOperand.length > 1 && sourceOperand.endsWith('/') && sourceStat.type !== 'directory') {
            throw new Error(`cannot move '${sourceOperand}' to '${destOperand}': Not a directory`);
          }
          const destinationEntry = await (async () => {
            try {
              return await context.files.resolveEntry({
                path: targetPath,
                finalSymlinkTreatment: 'no-follow',
                pinBacking,
              });
            } catch (error: unknown) {
              if (isPathNotFoundError({ error })) {
                return undefined;
              }
              throw error;
            }
          })();
          if (destinationEntry?.fullPath === sourceEntry.fullPath) {
            throw new Error(`'${sourceOperand}' and '${destOperand}' are the same file`);
          }
          if (destinationEntry !== undefined && overwriteMode === 'no-clobber') {
            continue;
          }
          if (destinationEntry !== undefined && updateMode !== 'all' && sourceStat.type !== 'directory' && destinationEntry.type !== 'directory') {
            const destinationStat = await context.files.statEntry({ entry: destinationEntry });
            const updateDecision = resolveExistingDestinationUpdate({
              mode: updateMode,
              sourceMtime: sourceStat.mtime,
              destinationMtime: destinationStat.mtime,
            });
            switch (updateDecision) {
            case 'skip':
              continue;
            case 'skip-error':
              throw new Error(`not replacing '${target.displayPath}'`);
            case 'replace':
              break;
            default: {
              const _ex: never = updateDecision;
              throw new Error(`Unhandled update decision: ${_ex}`);
            }
            }
          }
          if (
            sourceStat.type === 'symlink'
            && destinationEntry !== undefined
            && destinationEntry.type !== 'symlink'
            && overwriteMode !== 'no-clobber'
            && !backupEnabled
          ) {
            const followedSourceEntry = await context.files.resolveEntry({
              path: fullSrc,
              finalSymlinkTreatment: 'follow',
            });
            if (followedSourceEntry.fullPath === destinationEntry.fullPath) {
              throw new Error(`'${sourceOperand}' and '${destOperand}' are the same file`);
            }
          }
          if (destinationEntry !== undefined) {
            switch (overwriteMode) {
            case 'no-clobber':
              continue;
            case 'interactive':
              await text.error({ text: `mv: overwrite '${target.displayPath}'? ` });
              if (!await readAffirmativeResponse()) {
                interactiveDeclined = true;
                continue;
              }
              break;
            case 'default':
            case 'force':
              break;
            default: {
              const _ex: never = overwriteMode;
              throw new Error(`Unhandled overwrite mode: ${_ex}`);
            }
            }
          }

          if (sourceStat.type === 'directory' && getOptionalCoreMethod({ object: context.files, name: 'setMtime' }) === undefined) {
            throw new Error('cross-filesystem move requires Wesh core mtime mutation support');
          }
          if (backupEnabled && destinationEntry !== undefined) {
            const identity = await context.files.compareEntryIdentity({ first: sourceEntry, second: destinationEntry });
            switch (identity) {
            case 'unknown':
              throw new Error(`cannot verify that '${sourceOperand}' and '${target.displayPath}' are separate files`);
            case 'same':
            case 'shared-backing':
              throw new Error(`'${sourceOperand}' and '${destOperand}' are the same file`);
            case 'different':
              break;
            default: {
              const _ex: never = identity;
              throw new Error(`Unhandled entry identity: ${_ex}`);
            }
            }
          }

          const selectedBackup = backupEnabled && destinationEntry !== undefined
            ? await selectBackup({
              context,
              destinationPath: targetPath,
              control: backupControl,
              simpleSuffix: backupSuffix,
            })
            : undefined;
          const backup = selectedBackup !== undefined && destinationEntry !== undefined
            ? await moveWithBackup({
              context,
              sourceEntry,
              sourceDisplayPath: sourceOperand,
              destinationEntry,
              destinationPath: targetPath,
              displayPath: target.displayPath,
              suffix: selectedBackup.suffix,
              numbered: selectedBackup.numbered,
            })
            : undefined;
          if (backup?.moved !== true) {
            switch (sourceStat.type) {
            case 'directory': {
              if (backup === undefined && destinationEntry !== undefined) {
                const destinationStat = await context.files.statEntry({ entry: destinationEntry });
                switch (destinationStat.type) {
                case 'directory':
                  break;
                case 'file':
                case 'fifo':
                case 'chardev':
                case 'symlink':
                  throw new Error(`cannot overwrite non-directory '${destOperand}' with directory '${sourceOperand}'`);
                default: {
                  const _ex: never = destinationStat.type;
                  throw new Error(`Unhandled destination type: ${_ex}`);
                }
                }
                if (!noTargetDirectory) {
                  throw new Error(`destination exists: ${targetPath}`);
                }
                for await (const _child of context.files.readDirEntry({
                  entry: asDirectoryEntry({ entry: destinationEntry }),
                })) {
                  throw new Error(`cannot overwrite directory '${destOperand}': Directory not empty`);
                }
                await context.files.rmdir({ path: destinationEntry.fullPath });
              }
              await moveDirectoryRecursively({
                context,
                sourceEntry: asDirectoryEntry({ entry: sourceEntry }),
                destinationPath: targetPath,
              });
              break;
            }
            case 'file':
            case 'fifo':
            case 'chardev':
            case 'symlink': {
              switch (destinationEntry?.type) {
              case undefined:
              case 'file':
              case 'fifo':
              case 'chardev':
              case 'symlink':
                break;
              case 'directory':
                throw new Error(`cannot overwrite directory '${destOperand}' with non-directory`);
              default: {
                const _ex: never = destinationEntry;
                throw new Error(`Unhandled destination type: ${((_ex satisfies never) as { readonly type: string }).type}`);
              }
              }
              const noReplace = guardRename && destinationEntry === undefined ? true : undefined;
              try {
                await context.files.rename({
                  oldPath: fullSrc,
                  newPath: targetPath,
                  expectedSource: guardRename ? sourceEntry : undefined,
                  expectedDestination: guardRename ? destinationEntry : undefined,
                  noReplace,
                });
              } catch (error: unknown) {
                if (!noReplace || !(error instanceof DOMException)
                  || error.name !== 'InvalidModificationError' || !error.message.startsWith('File exists: ')) {
                  throw error;
                }
                if (overwriteMode === 'no-clobber' || updateMode === 'none') {
                  continue;
                }
                switch (updateMode) {
                case 'none-fail':
                  throw new Error(`not replacing '${target.displayPath}'`, { cause: error });
                case 'all':
                case 'older':
                  throw new Error(error.message, { cause: error });
                default: {
                  const _ex: never = updateMode;
                  throw new Error(`Unhandled update mode: ${_ex}`);
                }
                }
              }
              break;
            }
            default: {
              const _ex: never = sourceStat.type;
              throw new Error(`Unhandled source type: ${_ex}`);
            }
            }
          }

          if (verbose) {
            const backupText = backup === undefined
              ? ''
              : ` (backup: '${backup.displayPath}')`;
            await text.print({
              text: `renamed '${sourceOperand}' -> '${target.displayPath}'${backupText}\n`,
            });
          }
        } catch (e: unknown) {
          hadError = true;
          if (e instanceof MvSourceBackupAliasError) {
            await text.error({
              text: `mv: backing up '${e.destinationDisplayPath}' might destroy source;  '${e.sourceDisplayPath}' not moved\n`,
            });
            continue;
          }
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `mv: ${sourceOperand}: ${message}\n` });
        }
      }

      return { exitCode: hadError || interactiveDeclined ? 1 : 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `mv: ${sourceOperands[0] ?? ''}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
