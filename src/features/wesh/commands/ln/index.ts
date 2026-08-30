import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type ParsedStandardArgv, type StandardArgvAction, type StandardArgvPolicy, type StandardArgvRawValue, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { resolveBackupControl, selectBackupSuffix, type BackupControl } from '@/features/wesh/commands/_shared/backup-domain';
import { createAffirmativeResponseReader } from '@/features/wesh/commands/_shared/confirmation';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
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

type LnDeferredOption = 'backup' | 'target-directory';

const lnSymbolicOption = {
  semantic: { kind: 'effects', effects: [{ key: 'symbolic', value: true }] },
  forms: [
    { kind: 'short', name: 's', value: { kind: 'none' } },
    { kind: 'long', name: 'symbolic', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnForceOption = {
  semantic: { kind: 'effects', effects: [{ key: 'force', value: true }, { key: 'interactive', value: false }] },
  forms: [
    { kind: 'short', name: 'f', value: { kind: 'none' } },
    { kind: 'long', name: 'force', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnInteractiveOption = {
  semantic: { kind: 'effects', effects: [{ key: 'force', value: false }, { key: 'interactive', value: true }] },
  forms: [
    { kind: 'short', name: 'i', value: { kind: 'none' } },
    { kind: 'long', name: 'interactive', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnBackupOption = {
  semantic: { kind: 'deferred', tag: 'backup' },
  forms: [
    { kind: 'short', name: 'b', value: { kind: 'none' } },
    { kind: 'long', name: 'backup', value: { kind: 'optional-inline' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnSuffixOption = {
  semantic: { kind: 'required-value', key: 'backupSuffix', parse: undefined },
  forms: [
    { kind: 'short', name: 'S', value: { kind: 'required-attached-or-following', missingValueName: 'SUFFIX' } },
    { kind: 'long', name: 'suffix', value: { kind: 'required', missingValueName: 'SUFFIX' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnVerboseOption = {
  semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
  forms: [
    { kind: 'short', name: 'v', value: { kind: 'none' } },
    { kind: 'long', name: 'verbose', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnNoDereferenceOption = {
  semantic: { kind: 'effects', effects: [{ key: 'noDereference', value: true }] },
  forms: [
    { kind: 'short', name: 'n', value: { kind: 'none' } },
    { kind: 'long', name: 'no-dereference', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnNoTargetDirectoryOption = {
  semantic: { kind: 'effects', effects: [{ key: 'noTargetDirectory', value: true }] },
  forms: [
    { kind: 'short', name: 'T', value: { kind: 'none' } },
    { kind: 'long', name: 'no-target-directory', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnRelativeOption = {
  semantic: { kind: 'effects', effects: [{ key: 'relative', value: true }] },
  forms: [
    { kind: 'short', name: 'r', value: { kind: 'none' } },
    { kind: 'long', name: 'relative', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnTargetDirectoryOption = {
  semantic: { kind: 'deferred', tag: 'target-directory' },
  forms: [
    { kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'DIRECTORY' } },
    { kind: 'long', name: 'target-directory', value: { kind: 'required', missingValueName: 'DIRECTORY' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;
const lnHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<LnDeferredOption>>;

const lnArgvCatalog = defineArgvCatalog<StandardArgvAction<LnDeferredOption>>({
  nonExecutableLongOptions: [
    'directory',
    'logical',
    'physical',
    'version',
  ],
  definitions: [
    lnSymbolicOption, lnForceOption, lnInteractiveOption, lnBackupOption,
    lnSuffixOption, lnVerboseOption, lnNoDereferenceOption,
    lnNoTargetDirectoryOption, lnRelativeOption, lnTargetDirectoryOption,
    lnHelpOption,
  ],
});

const lnArgvHelp = defineArgvHelpPresentation({
  catalog: lnArgvCatalog,
  rows: [
    { forms: lnSymbolicOption.forms, summary: 'make symbolic links instead of hard links', category: 'common' },
    { forms: lnForceOption.forms, summary: 'remove existing destination files', category: 'common' },
    { forms: lnInteractiveOption.forms, summary: 'prompt whether to remove destinations', category: 'common' },
    { forms: lnBackupOption.forms, summary: 'make a backup of each existing destination file', valueName: 'CONTROL', category: 'common' },
    { forms: lnSuffixOption.forms, summary: 'override the usual backup suffix', valueName: 'SUFFIX', category: 'advanced' },
    { forms: lnVerboseOption.forms, summary: 'print the name of each linked file', category: 'common' },
    { forms: lnNoDereferenceOption.forms, summary: 'treat a destination symlink to a directory as a normal file', category: 'advanced' },
    { forms: lnNoTargetDirectoryOption.forms, summary: 'treat LINK_NAME as a normal file always', category: 'advanced' },
    { forms: lnRelativeOption.forms, summary: 'create symbolic links relative to link location', category: 'common' },
    { forms: lnTargetDirectoryOption.forms, summary: 'specify the DIRECTORY in which to create the links', valueName: 'DIRECTORY', category: 'common' },
    { forms: lnHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});

const lnArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function getRequiredLnDeferredValue({
  value,
  option,
}: {
  value: StandardArgvRawValue,
  option: string,
}): string {
  switch (value.kind) {
  case 'inline':
  case 'next-argv':
    return value.rawValue;
  case 'none':
    throw new Error(`${option} deferred occurrence is missing its required value`);
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled ${option} raw value: ${JSON.stringify(_ex)}`);
  }
  }
}

function applyLnDeferredOptions({
  parsed,
}: {
  parsed: ParsedStandardArgv<LnDeferredOption>,
}): {
  backupRequested: boolean,
  backupControlRaw: string | undefined,
  targetDirectories: readonly string[],
} {
  let backupRequested = false;
  let backupControlRaw: string | undefined;
  const targetDirectories: string[] = [];

  for (const occurrence of parsed.deferred) {
    switch (occurrence.semantic.tag) {
    case 'backup':
      backupRequested = true;
      switch (occurrence.value.kind) {
      case 'none':
        break;
      case 'inline':
        backupControlRaw = occurrence.value.rawValue;
        break;
      case 'next-argv':
        throw new Error('--backup must not claim a following argv value');
      default: {
        const _ex: never = occurrence.value;
        throw new Error(`Unhandled --backup raw value: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    case 'target-directory':
      targetDirectories.push(getRequiredLnDeferredValue({
        value: occurrence.value,
        option: '--target-directory',
      }));
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled ln deferred option: ${_ex}`);
    }
    }
  }

  return { backupRequested, backupControlRaw, targetDirectories };
}

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
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: lnArgvCatalog,
        policy: lnArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: lnArgvCatalog,
      policy: lnArgvPolicy,
    });
    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'ln',
        message: `ln: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: lnArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const deferredState = applyLnDeferredOptions({ parsed });
    const firstTargetDirectory = deferredState.targetDirectories[0];
    const explicitTargetDirectoryPath = firstTargetDirectory === undefined
      ? undefined
      : await resolveExplicitTargetDirectory({
        context,
        operand: firstTargetDirectory,
      });
    if (firstTargetDirectory !== undefined && explicitTargetDirectoryPath === undefined) {
      return { exitCode: 1 };
    }
    if (deferredState.targetDirectories.length > 1) {
      await text.error({ text: 'ln: multiple target directories specified\n' });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'ln', optionLines: formatArgvOptionHelp({ presentation: lnArgvHelp }) });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.symbolic !== true) {
      await writeCommandUsageError({
        context,
        command: 'ln',
        message: 'ln: hard links are not supported; use -s',
        usageSummary: formatArgvUsageSummary({ presentation: lnArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const targetDirectory = firstTargetDirectory;
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
        usageSummary: formatArgvUsageSummary({ presentation: lnArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const force = parsed.optionValues.force === true;
    const interactive = parsed.optionValues.interactive === true;
    const backupRequested = deferredState.backupRequested;
    let backupControl: BackupControl = 'simple';
    if (backupRequested) {
      const backupControlResult = resolveBackupControl({
        explicitValue: deferredState.backupControlRaw,
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
          usageSummary: formatArgvUsageSummary({ presentation: lnArgvHelp }),
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
