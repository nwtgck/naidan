import { resolveBackupControl, selectBackup, type BackupControl } from '@/features/wesh/commands/_shared/backup';
import { parseCopyMoveOptions, type CopyMoveOption } from '@/features/wesh/commands/_shared/copy-move-pre-help';
import { createAffirmativeResponseReader } from '@/features/wesh/commands/_shared/confirmation';
import { getCoreUmaskOrDefault, getOptionalCoreMethod } from '@/features/wesh/commands/_shared/core-capability';
import { getPathErrorReason, isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { dirnamePath } from '@/features/wesh/commands/_shared/path';
import { WeshRenameIncompleteError, type WeshCommandImplementation, type WeshCommandResult, type WeshCommandContext, type WeshEntryRef, type WeshFileHandle, type WeshTemporaryEntry, type WeshTemporaryFile } from '@/features/wesh/types';
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

interface CpBackup {
  readonly path: string,
  readonly displayPath: string,
  readonly entry: WeshEntryRef | undefined,
}

interface CpExistingTarget {
  readonly status: 'ready',
  readonly entry: WeshEntryRef | undefined,
  readonly writeEntry: WeshEntryRef | undefined,
  readonly backup: CpBackup | undefined,
  readonly destinationDirectoryExisted: boolean,
}

function resolveOptionalDestination({ context, path, pinBacking }: {
  context: WeshCommandContext,
  path: string,
  pinBacking: true | undefined,
}): Promise<WeshEntryRef | undefined> {
  return context.files.resolveEntry({ path, finalSymlinkTreatment: 'no-follow', pinBacking }).catch((error: unknown) => {
    if (isPathNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  });
}

async function planDestinationBackup({ context, sourceEntry, sourceDisplayPath, destinationPath, displayPath, suffix, numbered }: {
  context: WeshCommandContext,
  sourceEntry: WeshEntryRef,
  sourceDisplayPath: string,
  destinationPath: string,
  displayPath: string,
  suffix: string,
  numbered: boolean,
}): Promise<CpBackup> {
  const path = `${destinationPath}${suffix}`;
  const backupDisplayPath = `${displayPath}${suffix}`;
  if (path === sourceEntry.fullPath) {
    throw new Error(`backing up '${displayPath}' might destroy source; '${sourceDisplayPath}' not copied`);
  }
  const entry = numbered ? undefined : await resolveOptionalDestination({ context, path, pinBacking: true });
  switch (entry?.type) {
  case 'directory':
    throw new Error(`backup destination '${backupDisplayPath}' is a directory`);
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
  case undefined:
    break;
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled backup type: ${_ex}`);
  }
  }
  if (entry !== undefined) {
    const relation = await context.files.compareEntryIdentity({ first: sourceEntry, second: entry });
    switch (relation) {
    case 'unknown':
      throw new Error(`cannot verify that backup '${backupDisplayPath}' is separate from '${sourceDisplayPath}'`);
    case 'same':
    case 'shared-backing':
      throw new Error(`backing up '${displayPath}' might destroy source; '${sourceDisplayPath}' not copied`);
    case 'different':
      break;
    default: {
      const _ex: never = relation;
      throw new Error(`Unhandled entry identity: ${_ex}`);
    }
    }
  }
  return { path, displayPath: backupDisplayPath, entry };
}

const cpOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
    forms: [
      { kind: 'short', name: 'R', value: { kind: 'none' } },
      { kind: 'long', name: 'recursive', value: { kind: 'none' } },
    ],
    summary: 'copy directories recursively',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'none' } },
      { kind: 'long', name: 'r', value: { kind: 'none' } },
    ],
    summary: 'copy directories recursively',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [ { key: 'recursive', value: true }, { key: 'symlinkMode', value: 'physical' }, { key: 'archive', value: true }, ] },
    forms: [
      { kind: 'short', name: 'a', value: { kind: 'none' } },
      { kind: 'long', name: 'archive', value: { kind: 'none' } },
    ],
    summary: 'archive mode',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'command-line' }] },
    forms: [{ kind: 'short', name: 'H', value: { kind: 'none' } }],
    summary: 'follow command-line symlinks',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'logical' }] },
    forms: [
      { kind: 'short', name: 'L', value: { kind: 'none' } },
      { kind: 'long', name: 'dereference', value: { kind: 'none' } },
    ],
    summary: 'always follow symlinks',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'physical' }] },
    forms: [
      { kind: 'short', name: 'P', value: { kind: 'none' } },
      { kind: 'long', name: 'no-dereference', value: { kind: 'none' } },
    ],
    summary: 'never follow symlinks',
    category: 'advanced',
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
    semantic: { kind: 'effects', effects: [{ key: 'parents', value: true }] },
    forms: [{ kind: 'long', name: 'parents', value: { kind: 'none' } }],
    summary: 'use full source file name under DIRECTORY',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'force', value: true }] },
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
    summary: 'copy only when SOURCE is newer than destination',
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
    semantic: { kind: 'required-value', key: 'targetDirectory', parse: undefined },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'DIRECTORY' } },
      { kind: 'long', name: 'target-directory', value: { kind: 'required', missingValueName: 'DIRECTORY' } },
    ],
    summary: 'copy all source arguments into DIRECTORY',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const cpArgvCatalog = defineArgvCatalog<StandardArgvAction<CopyMoveOption>>({
  definitions: cpOptions,
  nonExecutableLongOptions: [],
});
const cpArgvHelp = defineArgvHelpPresentation({ catalog: cpArgvCatalog, rows: cpOptions });
const cpArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

export const cpCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    const readAffirmativeResponse = createAffirmativeResponseReader({ input: text.input });
    const parsedArgs = stopArgvAtFirstEarlyExit({
      args: context.args,
      catalog: cpArgvCatalog,
      policy: cpArgvPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, catalog: cpArgvCatalog, policy: cpArgvPolicy });

    const options = parseCopyMoveOptions({ parsed });
    switch (options.kind) {
    case 'invalid-option':
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: `cp: ${options.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: cpArgvHelp }),
      });
      return { exitCode: 1 };
    case 'multiple-target-directories':
      await context.text().error({ text: 'cp: multiple target directories specified\n' });
      return { exitCode: 1 };
    case 'options':
      break;
    default: {
      const _ex: never = options;
      throw new Error(`Unhandled cp options: ${JSON.stringify(_ex)}`);
    }
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cp',
        optionLines: formatArgvOptionHelp({ presentation: cpArgvHelp }),
      });
      return { exitCode: 0 };
    }

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
          command: 'cp',
          message: `cp: invalid argument '${backupControlResult.value}' for '${source}'`,
          usageSummary: formatArgvUsageSummary({ presentation: cpArgvHelp }),
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
        usageSummary: formatArgvUsageSummary({ presentation: cpArgvHelp }),
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
    const pinBackupSource = backupEnabled && backupControl !== 'numbered';
    const backupSuffix = typeof parsed.optionValues.backupSuffix === 'string'
      && parsed.optionValues.backupSuffix.length > 0
      ? parsed.optionValues.backupSuffix
      : '~';
    const verbose = parsed.optionValues.verbose === true;
    const noTargetDirectory = parsed.optionValues.noTargetDirectory === true;
    const parents = parsed.optionValues.parents === true;

    const rejectReplacement = overwriteMode === 'no-clobber' || updateMode === 'none' || updateMode === 'none-fail';
    if (backupRequested && rejectReplacement) {
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
        usageSummary: formatArgvUsageSummary({ presentation: cpArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (noTargetDirectory && targetDirectory !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: 'cp: cannot combine --target-directory (-t) and --no-target-directory (-T)',
        usageSummary: formatArgvUsageSummary({ presentation: cpArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parents && noTargetDirectory) {
      await writeCommandUsageError({
        context,
        command: 'cp',
        message: 'cp: cannot combine --parents and --no-target-directory (-T)',
        usageSummary: formatArgvUsageSummary({ presentation: cpArgvHelp }),
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
        usageSummary: formatArgvUsageSummary({ presentation: cpArgvHelp }),
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
      return context.files.resolveEntry({ path, finalSymlinkTreatment, pinBacking: pinBackupSource ? true : undefined });
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

    const protectExistingTarget = backupEnabled || overwriteMode === 'interactive' || updateMode === 'older';

    const prepareExistingTarget = async ({ sourceEntry, sourceDisplayPath, destPath, destDisplayPath }: {
      sourceEntry: WeshEntryRef,
      sourceDisplayPath: string,
      destPath: string,
      destDisplayPath: string,
    }): Promise<CpExistingTarget | { readonly status: 'skipped' }> => {
      const existing = await resolveOptionalDestination({ context, path: destPath, pinBacking: protectExistingTarget ? true : undefined });
      if (existing === undefined) {
        return { status: 'ready', entry: undefined, writeEntry: undefined, backup: undefined, destinationDirectoryExisted: false };
      }
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
      switch (existing.type) {
      case 'directory':
        return { status: 'ready', entry: existing, writeEntry: existing, backup: undefined, destinationDirectoryExisted: true };
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _ex: never = existing;
        throw new Error(`Unhandled destination type: ${_ex}`);
      }
      }

      // Use the same referent for the update decision and the checked writer.
      const followed = protectExistingTarget && !rejectReplacement && !backupEnabled && sourceEntry.type === 'file' && existing.type === 'symlink'
        ? await context.files.resolveEntry({ path: destPath, finalSymlinkTreatment: 'follow', pinBacking: true }).then(
          entry => ({ entry }),
          (error: unknown) => ({ error }),
        )
        : undefined;

      const writeEntry = followed === undefined ? existing : 'entry' in followed ? followed.entry : undefined;

      if (updateMode !== 'all' && sourceEntry.type !== 'directory' && writeEntry !== undefined) {
        const sourceStat = await context.files.statEntry({ entry: sourceEntry });
        const destinationStat = await context.files.statEntry({ entry: writeEntry });
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
        await text.error({ text: `cp: overwrite '${destPath}'? ` });
        if (!await readAffirmativeResponse()) {
          interactiveDeclined = true;
          return { status: 'skipped' };
        }
        break;
      case 'default':
        break;
      default: {
        const _ex: never = overwriteMode;
        throw new Error(`Unhandled overwrite mode: ${_ex}`);
      }
      }

      if (existing.type === 'symlink' && !backupEnabled) {
        try {
          if (followed === undefined) {
            await context.files.stat({ path: destPath });
          } else if ('error' in followed) {
            throw followed.error;
          }
        } catch (error: unknown) {
          if (!isPathNotFoundError({ error })) {
            throw error;
          }
          throw new Error(`not writing through dangling symlink '${destPath}'`);
        }
      }

      const selectedBackup = backupEnabled
        ? await selectBackup({ context, destinationPath: destPath, control: backupControl, simpleSuffix: backupSuffix })
        : undefined;
      const backup = selectedBackup === undefined ? undefined : await planDestinationBackup({
        context,
        sourceEntry,
        sourceDisplayPath,
        destinationPath: destPath,
        displayPath: destDisplayPath,
        ...selectedBackup,
      });
      return { status: 'ready', entry: existing, writeEntry, backup, destinationDirectoryExisted: false };
    };

    const skipCreationConflict = async ({ error, sourceEntry, sourceDisplayPath, destPath, destDisplayPath }: {
      error: unknown,
      sourceEntry: WeshEntryRef,
      sourceDisplayPath: string,
      destPath: string,
      destDisplayPath: string,
    }): Promise<boolean> => {
      if (!rejectReplacement || !((error instanceof Error || error instanceof DOMException) && error.message.startsWith('File exists: '))) {
        return false;
      }
      const target = await prepareExistingTarget({ sourceEntry, sourceDisplayPath, destPath, destDisplayPath });
      switch (target.status) {
      case 'skipped':
        return true;
      case 'ready':
        return false;
      default: {
        const _ex: never = target;
        throw new Error(`Unhandled destination state: ${_ex}`);
      }
      }
    };

    const temporaryCopyPath = ({ destPath }: { destPath: string }): string => resolvePath({
      cwd: dirnamePath({ path: destPath }),
      path: `.wesh-cp-${crypto.randomUUID()}`,
    });

    const publishPreparedCopy = async ({ temporary, target, destPath }: {
      temporary: WeshTemporaryEntry,
      target: CpExistingTarget,
      destPath: string,
    }): Promise<void> => {
      const { entry, backup } = target;
      try {
        await context.files.replaceEntry({
          entry: temporary.entry,
          path: destPath,
          expected: entry,
          backupPath: backup?.path,
          expectedBackup: backup === undefined ? undefined : { entry: backup.entry },
        });
      } catch (error: unknown) {
        if (!(error instanceof WeshRenameIncompleteError)) {
          await temporary.discard().catch(() => {});
        }
        throw error;
      }
    };

    const writeCheckedCopy = async ({ source, entry, destPath }: {
      source: WeshFileHandle,
      entry: WeshEntryRef<'file'>,
      destPath: string,
    }): Promise<void> => {
      const acquired = await context.files.tryCreateFileWriterEfficiently({ path: destPath, expected: entry, mode: 'truncate' });
      switch (acquired.kind) {
      case 'writer': {
        const { writer } = acquired;
        await openHandleReadStream({ handle: source }).pipeTo(new WritableStream<Uint8Array>({
          write: chunk => writer.write({ chunk }),
          close: () => writer.close(),
          abort: (reason: unknown) => writer.abort({ reason }),
        }));
        return;
      }
      case 'fallback_required':
        throw new Error(`Cannot verify the copy destination: ${destPath}`);
      default: {
        const _ex: never = acquired;
        throw new Error(`Unhandled copy writer: ${_ex}`);
      }
      }
    };

    const copyRegularFile = async ({ entry, sourceDisplayPath, destPath, destDisplayPath, mode, target }: {
      entry: WeshEntryRef,
      sourceDisplayPath: string,
      destPath: string,
      destDisplayPath: string,
      mode: number,
      target: CpExistingTarget,
    }): Promise<boolean> => {
      const source = await context.files.openEntry({
        entry,
        flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      });
      let temporary: WeshTemporaryFile | undefined;
      try {
        const expected = protectExistingTarget && target.backup === undefined ? target.writeEntry : undefined;
        switch (expected?.type) {
        case 'file':
          await writeCheckedCopy({ source, entry: expected, destPath });
          return true;
        case 'directory':
          throw new Error(`Not a file: ${destPath}`);
        case 'fifo':
        case 'chardev':
          break;
        case 'symlink':
          throw new Error(`Cannot verify the copy destination: ${destPath}`);
        case undefined:
          break;
        default: {
          const _ex: never = expected;
          throw new Error(`Unhandled copy destination: ${_ex}`);
        }
        }

        let destination: WeshFileHandle;
        if (expected !== undefined) {
          destination = await context.files.openEntry({
            entry: expected,
            flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' },
            mode,
          });
        } else if (rejectReplacement || protectExistingTarget) {
          const path = target.backup === undefined ? destPath : temporaryCopyPath({ destPath });
          temporary = await context.files.createTemporaryFile({ path });
          destination = temporary.handle;
        } else {
          destination = await context.files.open({
            path: destPath,
            flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
            mode,
          });
        }
        await writeAllStreamToHandle({ stream: openHandleReadStream({ handle: source }), handle: destination, closeHandle: true });
      } catch (error: unknown) {
        await source.close().catch(() => {});
        await temporary?.discard().catch(() => {});
        if (await skipCreationConflict({ error, sourceEntry: entry, sourceDisplayPath, destPath, destDisplayPath })) {
          return false;
        }
        throw error;
      }

      if (target.backup !== undefined && temporary !== undefined) {
        await publishPreparedCopy({ temporary, target, destPath });
      }
      return true;
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

      switch (entry.type) {
      case 'directory': {
        const { entry: previous, backup } = existingTarget;
        if (previous !== undefined && backup !== undefined) {
          await context.files.rename({
            oldPath: destPath,
            newPath: backup.path,
            expectedSource: previous,
            expectedDestination: backup.entry,
            noReplace: backup.entry === undefined ? true : undefined,
          });
        }
        const childAncestorDirectoryPaths = new Set(ancestorDirectoryPaths);
        childAncestorDirectoryPaths.add(entry.fullPath);
        let created = false;
        await context.files.mkdir({
          path: destPath,
          mode: destinationCreationMode({ sourceMode: stat.mode, type: 'directory' }),
          recursive: true,
          onCreate: backup === undefined ? undefined : async ({ path }) => {
            if (path === destPath) {
              created = true;
            }
          },
        });
        if (backup !== undefined && !created) {
          throw new Error(`Destination entry changed: ${destPath}`);
        }
        if (!existingTarget.destinationDirectoryExisted) {
          await writeVerboseCopy({
            srcDisplayPath,
            destDisplayPath,
            backupDisplayPath: undefined,
          });
        }
        for await (const child of context.files.readDirEntry({
          entry,
        })) {
          await copyOne({
            srcPath: child.fullPath,
            srcDisplayPath: `${srcDisplayPath.replace(/\/+$/u, '')}/${child.name}`,
            sourceEntry: (symlinkMode === 'logical' && child.type === 'symlink')
              || (pinBackupSource && child.type !== 'file' && child.type !== 'directory')
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
        if (!await copyRegularFile({
          entry,
          sourceDisplayPath: srcDisplayPath,
          destPath,
          destDisplayPath,
          mode: destinationCreationMode({ sourceMode: stat.mode, type: 'file' }),
          target: existingTarget,
        })) {
          return;
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
        await writeVerboseCopy({
          srcDisplayPath,
          destDisplayPath,
          backupDisplayPath: existingTarget.backup?.displayPath,
        });
        break;
      case 'symlink':
        if (symlinkMode === 'physical' || (symlinkMode === 'command-line' && !isCommandLineArgument)) {
          if (existingTarget.destinationDirectoryExisted) {
            throw new Error(`cannot overwrite directory '${destDisplayPath}' with non-directory`);
          }
          if (!rejectReplacement && !protectExistingTarget) {
            try {
              await context.files.unlink({ path: destPath });
            } catch (error: unknown) {
              if (!isPathNotFoundError({ error })) {
                throw error;
              }
            }
          }
          const linkTarget = await context.files.readlinkEntry({ entry });
          if (protectExistingTarget && existingTarget.entry !== undefined) {
            const temporary = await context.files.createTemporarySymlink({ path: temporaryCopyPath({ destPath }), targetPath: linkTarget });
            await publishPreparedCopy({ temporary, target: existingTarget, destPath });
          } else {
            try {
              await context.files.symlink({ path: destPath, targetPath: linkTarget });
            } catch (error: unknown) {
              if (await skipCreationConflict({ error, sourceEntry: entry, sourceDisplayPath: srcDisplayPath, destPath, destDisplayPath })) {
                return;
              }
              throw error;
            }
          }
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
            backupDisplayPath: existingTarget.backup?.displayPath,
          });
          break;
        }
        if (!await copyRegularFile({
          entry,
          sourceDisplayPath: srcDisplayPath,
          destPath,
          destDisplayPath,
          mode: destinationCreationMode({ sourceMode: stat.mode, type: 'file' }),
          target: existingTarget,
        })) {
          return;
        }
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
          backupDisplayPath: existingTarget.backup?.displayPath,
        });
        break;
      case 'fifo':
      case 'chardev':
        if (existingTarget.backup === undefined) {
          await context.files.mknod({
            path: destPath,
            type: entry.type,
            mode: destinationCreationMode({ sourceMode: stat.mode, type: 'file' }),
          });
        } else {
          const path = temporaryCopyPath({ destPath });
          await context.files.mknod({
            path,
            type: entry.type,
            mode: destinationCreationMode({ sourceMode: stat.mode, type: 'file' }),
          });
          const staged = await context.files.resolveEntry({ path, finalSymlinkTreatment: 'no-follow', pinBacking: true });
          await publishPreparedCopy({
            temporary: { entry: staged, discard: () => context.files.unlink({ path, expected: { entry: staged } }) },
            target: existingTarget,
            destPath,
          });
        }
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
          backupDisplayPath: existingTarget.backup?.displayPath,
        });
        break;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled type: ${_ex}`);
      }
      }
    };

    const resolveParentsRelativePath = ({
      sourceOperand,
    }: {
      sourceOperand: string,
    }): string => {
      const normalizedSource = normalizePath({ cwd: context.cwd, path: sourceOperand });
      if (sourceOperand.startsWith('/')) {
        return normalizedSource.replace(/^\/+/u, '');
      }

      const normalizedCwd = normalizePath({ cwd: '/', path: context.cwd });
      if (normalizedSource === normalizedCwd) {
        return basename({ path: normalizedSource });
      }
      const prefix = normalizedCwd === '/' ? '/' : `${normalizedCwd}/`;
      if (!normalizedSource.startsWith(prefix)) {
        throw new Error(`with --parents, source '${sourceOperand}' resolves outside the current directory`);
      }
      return normalizedSource.slice(prefix.length);
    };

    const resolveDestinationTarget = async ({
      srcPath,
      destPath,
      destDisplayPath,
      treatDestAsDirectory,
      parentsRelativePath,
    }: {
      srcPath: string,
      destPath: string,
      destDisplayPath: string,
      treatDestAsDirectory: boolean,
      parentsRelativePath: string | undefined,
    }): Promise<{ readonly path: string, readonly displayPath: string }> => {
      const sourceBasename = basename({ path: srcPath });
      if (treatDestAsDirectory) {
        const relativeTarget = parentsRelativePath ?? sourceBasename;
        return {
          path: `${destPath}/${relativeTarget}`,
          displayPath: `${destDisplayPath.replace(/\/+$/u, '')}/${relativeTarget}`,
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
        if (targetDirectory !== undefined || parents) {
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
          const parentsRelativePath = parents
            ? resolveParentsRelativePath({ sourceOperand })
            : undefined;
          const target = await resolveDestinationTarget({
            srcPath: fullSrc,
            destPath: fullDest,
            destDisplayPath: destOperand,
            treatDestAsDirectory,
            parentsRelativePath,
          });
          if (parentsRelativePath !== undefined) {
            await context.files.mkdir({
              path: dirnamePath({ path: target.path }),
              recursive: true,
            });
          }
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
          const message = getPathErrorReason({ error: e })
            ?? (e instanceof Error ? e.message : String(e));
          await text.error({ text: `cp: ${sourceOperand}: ${message}\n` });
        }
      }
      return { exitCode: hadError || interactiveDeclined ? 1 : 0 };
    } catch (e: unknown) {
      const message = getPathErrorReason({ error: e })
        ?? (e instanceof Error ? e.message : String(e));
      await text.error({ text: `cp: ${sourceOperands[0] ?? ''}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
