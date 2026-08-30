import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, type StandardArgvRawValue, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type {
  WeshCommandImplementation,
  WeshCommandResult,
  WeshCommandContext,
  WeshEntryRef,
  WeshFileType,
  WeshStat,
} from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';

type LsSymlinkMode = 'logical' | 'command-line' | 'physical';

type LsClassifyMode = 'always' | 'never';

const LS_CLASSIFY_ARGUMENTS: readonly {
  readonly name: string,
  readonly mode: LsClassifyMode,
}[] = [
  { name: 'always', mode: 'always' },
  { name: 'yes', mode: 'always' },
  { name: 'force', mode: 'always' },
  { name: 'never', mode: 'never' },
  { name: 'no', mode: 'never' },
  { name: 'none', mode: 'never' },
  { name: 'auto', mode: 'never' },
  { name: 'tty', mode: 'never' },
  { name: 'if-tty', mode: 'never' },
];

function parseClassifyArgument({ value }: { value: string }): LsClassifyMode | undefined {
  const exact = LS_CLASSIFY_ARGUMENTS.find(entry => entry.name === value);
  if (exact !== undefined) return exact.mode;
  if (value.length === 0) return undefined;

  const matchingModes = new Set(
    LS_CLASSIFY_ARGUMENTS
      .filter(entry => entry.name.startsWith(value))
      .map(entry => entry.mode),
  );
  return matchingModes.size === 1 ? [...matchingModes][0] : undefined;
}

function compareCStrings({ left, right }: { left: string, right: string }): number {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftCodePoint = left.codePointAt(leftOffset);
    const rightCodePoint = right.codePointAt(rightOffset);
    if (leftCodePoint === undefined || rightCodePoint === undefined) {
      throw new Error('Failed to read filename code point');
    }
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
    leftOffset += leftCodePoint > 0xffff ? 2 : 1;
    rightOffset += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftOffset < left.length) return 1;
  if (rightOffset < right.length) return -1;
  return 0;
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

const lsLongOption = {
  semantic: { kind: 'effects', effects: [{ key: 'l', value: true }] },
  forms: [{ kind: 'short', name: 'l', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsAllOption = {
  semantic: { kind: 'effects', effects: [{ key: 'a', value: true }] },
  forms: [
    { kind: 'short', name: 'a', value: { kind: 'none' } },
    { kind: 'long', name: 'all', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsAlmostAllOption = {
  semantic: { kind: 'effects', effects: [{ key: 'almostAll', value: true }] },
  forms: [
    { kind: 'short', name: 'A', value: { kind: 'none' } },
    { kind: 'long', name: 'almost-all', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsRecursiveOption = {
  semantic: { kind: 'effects', effects: [{ key: 'R', value: true }] },
  forms: [
    { kind: 'short', name: 'R', value: { kind: 'none' } },
    { kind: 'long', name: 'recursive', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsDirectoryOption = {
  semantic: { kind: 'effects', effects: [{ key: 'directory', value: true }] },
  forms: [
    { kind: 'short', name: 'd', value: { kind: 'none' } },
    { kind: 'long', name: 'directory', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsOnePerLineOption = {
  semantic: { kind: 'effects', effects: [{ key: '1', value: true }] },
  forms: [{ kind: 'short', name: '1', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsHumanReadableOption = {
  semantic: { kind: 'effects', effects: [{ key: 'h', value: true }] },
  forms: [
    { kind: 'short', name: 'h', value: { kind: 'none' } },
    { kind: 'long', name: 'human-readable', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsDereferenceOption = {
  semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'logical' }] },
  forms: [
    { kind: 'short', name: 'L', value: { kind: 'none' } },
    { kind: 'long', name: 'dereference', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsDereferenceCommandLineOption = {
  semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'command-line' }] },
  forms: [
    { kind: 'short', name: 'H', value: { kind: 'none' } },
    { kind: 'long', name: 'dereference-command-line', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsClassifyShortOption = {
  semantic: { kind: 'effects', effects: [{ key: 'classify', value: true }] },
  forms: [{ kind: 'short', name: 'F', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsClassifyLongOption = {
  semantic: { kind: 'deferred', tag: 'classify' },
  forms: [{ kind: 'long', name: 'classify', value: { kind: 'optional-inline' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;
const lsHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<'classify'>>;

const lsArgvCatalog = defineArgvCatalog<StandardArgvAction<'classify'>>({
  // These are real GNU ls long options intentionally outside Wesh's supported subset.
  // They still participate in GNU unique-prefix ambiguity so a supported option is
  // never accepted under a prefix that real ls rejects as ambiguous.
  nonExecutableLongOptions: [
    'author',
    'block-size',
    'color',
    'context',
    'dereference-command-line-symlink-to-dir',
    'dired',
    'escape',
    'file-type',
    'format',
    'full-time',
    'group-directories-first',
    'hide',
    'hide-control-chars',
    'hyperlink',
    'ignore',
    'ignore-backups',
    'indicator-style',
    'inode',
    'kibibytes',
    'literal',
    'no-group',
    'numeric-uid-gid',
    'quote-name',
    'quoting-style',
    'reverse',
    'show-control-chars',
    'si',
    'size',
    'sort',
    'tabsize',
    'time',
    'time-style',
    'version',
    'width',
    'zero',
  ],
  definitions: [lsLongOption, lsAllOption, lsAlmostAllOption, lsRecursiveOption, lsDirectoryOption, lsClassifyShortOption, lsClassifyLongOption, lsOnePerLineOption, lsHumanReadableOption, lsDereferenceOption, lsDereferenceCommandLineOption, lsHelpOption],
});

const lsArgvHelp = defineArgvHelpPresentation({
  catalog: lsArgvCatalog,
  rows: [
    { forms: lsLongOption.forms, summary: 'use a long listing format', category: 'common' },
    { forms: lsAllOption.forms, summary: 'include directory entries whose names begin with .', category: 'common' },
    { forms: lsAlmostAllOption.forms, summary: 'include hidden entries except . and ..', category: 'common' },
    { forms: lsRecursiveOption.forms, summary: 'list subdirectories recursively', category: 'common' },
    { forms: lsDirectoryOption.forms, summary: 'list directories themselves, not their contents', category: 'common' },
    { forms: [...lsClassifyShortOption.forms, ...lsClassifyLongOption.forms], summary: 'append indicator characters to entries', valueName: 'WHEN', category: 'common' },
    { forms: lsOnePerLineOption.forms, summary: 'list one file per line', category: 'advanced' },
    { forms: lsHumanReadableOption.forms, summary: 'with -l, print sizes in human readable format', category: 'common' },
    { forms: lsDereferenceOption.forms, summary: 'when listing symlinks, show the target type', category: 'advanced' },
    { forms: lsDereferenceCommandLineOption.forms, summary: 'follow command-line symlinks', category: 'advanced' },
    { forms: lsHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});

const lsArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function getClassifyModeFromRawValue({ value }: { value: StandardArgvRawValue }): LsClassifyMode | undefined {
  switch (value.kind) {
  case 'none':
    return 'always';
  case 'inline':
    return parseClassifyArgument({ value: value.rawValue });
  case 'next-argv':
    throw new Error('ls --classify must not claim a following argv value');
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled ls classify raw value: ${JSON.stringify(_ex)}`);
  }
  }
}


export const lsCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: lsArgvCatalog,
        policy: lsArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: lsArgvCatalog,
      policy: lsArgvPolicy,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'ls',
        message: `ls: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: lsArgvHelp }),
      });
      return { exitCode: 2 };
    }

    let classify = parsed.optionValues.classify === true;
    for (const occurrence of parsed.deferred) {
      const mode = getClassifyModeFromRawValue({ value: occurrence.value });
      if (mode === undefined) {
        const invalidValue = (() => {
          switch (occurrence.value.kind) {
          case 'none':
            return '';
          case 'inline':
            return occurrence.value.rawValue;
          case 'next-argv':
            throw new Error('ls --classify must not claim a following argv value');
          default: {
            const _ex: never = occurrence.value;
            throw new Error(`Unhandled ls classify raw value: ${JSON.stringify(_ex)}`);
          }
          }
        })();
        await writeCommandUsageError({
          context,
          command: 'ls',
          message: `ls: invalid argument '${invalidValue}' for '--classify'`,
          usageSummary: formatArgvUsageSummary({ presentation: lsArgvHelp }),
        });
        return { exitCode: 1 };
      }
      switch (mode) {
      case 'always':
        classify = true;
        break;
      case 'never':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled ls classify mode: ${_ex}`);
      }
      }
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'ls',
        optionLines: formatArgvOptionHelp({ presentation: lsArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const pathOperands = parsed.positionals.length > 0 ? parsed.positionals : ['.'];
    const l = parsed.optionValues.l === true;
    const a = parsed.optionValues.a === true;
    const almostAll = parsed.optionValues.almostAll === true;
    // Wesh command handles are not terminal-aware. Captured command output therefore
    // follows GNU ls's non-terminal default of one entry per line.
    const one = true;
    const h = parsed.optionValues.h === true;
    const d = parsed.optionValues.directory === true;
    const R = parsed.optionValues.R === true;
    const explicitSymlinkMode = parsed.optionValues.symlinkMode as LsSymlinkMode | undefined;
    const symlinkMode = explicitSymlinkMode ?? (
      l || d || classify
        ? 'physical'
        : 'command-line'
    );
    let exitCode = 0;
    let listedTopLevelOperand = false;
    const activeRecursiveDirectoryPaths = new Set<string>();

    const resolveListingEntry = async ({
      path,
      entry,
      isCommandLineArgument,
    }: {
      path: string,
      entry: WeshEntryRef | undefined,
      isCommandLineArgument: boolean,
    }): Promise<WeshEntryRef> => {
      const shouldFollow = (() => {
        switch (symlinkMode) {
        case 'logical':
          return true;
        case 'command-line':
          return isCommandLineArgument;
        case 'physical':
          return false;
        default: {
          const _ex: never = symlinkMode;
          throw new Error(`Unhandled symlink mode: ${_ex}`);
        }
        }
      })();
      const directEntry = entry ?? await context.files.resolveEntry({
        path,
        finalSymlinkTreatment: 'no-follow',
      });
      if (!shouldFollow || directEntry.type !== 'symlink') {
        return directEntry;
      }
      try {
        return await context.files.resolveEntry({
          path,
          finalSymlinkTreatment: 'follow',
        });
      } catch (error: unknown) {
        if (isCommandLineArgument && explicitSymlinkMode === undefined) {
          return directEntry;
        }
        throw error;
      }
    };

    async function listPath({
      displayPath,
      fullPath,
      entry: providedEntry,
      isCommandLineArgument,
      printHeader,
    }: {
      displayPath: string,
      fullPath: string,
      entry: WeshEntryRef | undefined,
      isCommandLineArgument: boolean,
      printHeader: boolean,
    }): Promise<void> {
      let activeRecursiveDirectoryPath: string | undefined;
      try {
        const entry = await resolveListingEntry({
          path: fullPath,
          entry: providedEntry,
          isCommandLineArgument,
        });
        const directStat = await context.files.statEntry({ entry });

        if (d || directStat.type !== 'directory') {
          const line = await formatEntry({
            context,
            displayName: displayPath,
            fullPath,
            type: directStat.type,
            longFormat: l,
            humanReadable: h,
            classify,
            stat: directStat,
            getStat: () => context.files.statEntry({ entry }),
          });
          await text.print({ text: `${line}\n` });
          if (isCommandLineArgument) listedTopLevelOperand = true;
          return;
        }

        const directoryEntry = (() => {
          switch (entry.type) {
          case 'directory':
            return entry;
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            throw new Error(`Not a directory: ${fullPath}`);
          default: {
            const _ex: never = entry;
            throw new Error(`Unhandled entry type: ${_ex}`);
          }
          }
        })();
        if (R) {
          if (activeRecursiveDirectoryPaths.has(directoryEntry.fullPath)) {
            await text.error({
              text: `ls: ${displayPath}: not listing already-listed directory\n`,
            });
            exitCode = 2;
            return;
          }
          activeRecursiveDirectoryPaths.add(directoryEntry.fullPath);
          activeRecursiveDirectoryPath = directoryEntry.fullPath;
        }

        const allEntries: WeshEntryRef[] = [];
        for await (const child of context.files.readDirEntry({ entry: directoryEntry })) {
          if (a || almostAll || !child.name.startsWith('.')) {
            allEntries.push(child);
          }
        }
        allEntries.sort((left, right) => compareCStrings({ left: left.name, right: right.name }));

        if (printHeader) {
          if (isCommandLineArgument && listedTopLevelOperand) {
            await text.print({ text: '\n' });
          }
          await text.print({ text: `${displayPath}:\n` });
          if (isCommandLineArgument) listedTopLevelOperand = true;
        }

        let renderedEntryCount = 0;
        if (a) {
          for (const dotName of ['.', '..'] as const) {
            const dotPath = (() => {
              switch (dotName) {
              case '.':
                return fullPath;
              case '..':
                return `${fullPath}/..`;
              default: {
                const _ex: never = dotName;
                throw new Error(`Unhandled dot entry: ${_ex}`);
              }
              }
            })();
            const dotEntry = await resolveListingEntry({
              path: dotPath,
              entry: undefined,
              isCommandLineArgument: false,
            });
            const line = await formatEntry({
              context,
              displayName: dotName,
              fullPath: dotPath,
              type: dotEntry.type,
              longFormat: l,
              humanReadable: h,
              classify,
              stat: undefined,
              getStat: () => context.files.statEntry({ entry: dotEntry }),
            });
            await text.print({ text: line + (one || l ? '\n' : '  ') });
            renderedEntryCount += 1;
          }
        }

        const resolvedEntries: Array<{
          child: WeshEntryRef,
          resolvedChild: WeshEntryRef,
        }> = [];
        for (const child of allEntries) {
          let resolvedChild = child;
          if (l || classify || R) {
            try {
              resolvedChild = await resolveListingEntry({
                path: child.fullPath,
                entry: child,
                isCommandLineArgument: false,
              });
            } catch (error: unknown) {
              const childDisplayPath = displayPath === '/'
                ? `/${child.name}`
                : `${displayPath}/${child.name}`;
              const message = error instanceof Error ? error.message : String(error);
              await text.error({ text: `ls: cannot access '${childDisplayPath}': ${message}\n` });
              exitCode = Math.max(exitCode, 1);
            }
          }
          resolvedEntries.push({ child, resolvedChild });
          const line = await formatEntry({
            context,
            displayName: child.name,
            fullPath: child.fullPath,
            type: resolvedChild.type,
            longFormat: l,
            humanReadable: h,
            classify,
            stat: undefined,
            getStat: () => context.files.statEntry({ entry: resolvedChild }),
          });
          await text.print({ text: line + (one || l ? '\n' : '  ') });
          renderedEntryCount += 1;
        }

        if (!one && !l && renderedEntryCount > 0) {
          await text.print({ text: '\n' });
        }

        if (R) {
          for (const { child, resolvedChild } of resolvedEntries) {
            switch (resolvedChild.type) {
            case 'directory':
              break;
            case 'file':
            case 'fifo':
            case 'chardev':
            case 'symlink':
              continue;
            default: {
              const _ex: never = resolvedChild;
              throw new Error(`Unhandled ls recursion entry: ${((_ex satisfies never) as { readonly type: string }).type}`);
            }
            }
            if (child.name === '.' || child.name === '..') {
              continue;
            }
            const childDisplayPath = displayPath === '/' ? `/${child.name}` : `${displayPath}/${child.name}`;
            if (activeRecursiveDirectoryPaths.has(resolvedChild.fullPath)) {
              await text.error({
                text: `ls: ${childDisplayPath}: not listing already-listed directory\n`,
              });
              exitCode = 2;
              continue;
            }
            await text.print({ text: '\n' });
            await listPath({
              displayPath: childDisplayPath,
              fullPath: child.fullPath,
              entry: resolvedChild,
              isCommandLineArgument: false,
              printHeader: true,
            });
          }
        }
        if (activeRecursiveDirectoryPath !== undefined) {
          activeRecursiveDirectoryPaths.delete(activeRecursiveDirectoryPath);
          activeRecursiveDirectoryPath = undefined;
        }
      } catch (error: unknown) {
        if (activeRecursiveDirectoryPath !== undefined) {
          activeRecursiveDirectoryPaths.delete(activeRecursiveDirectoryPath);
        }
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `ls: ${displayPath}: ${message}\n` });
        exitCode = 2;
      }
    }

    const paths: Array<{ path: string, isDirectory: boolean }> = [];
    for (const path of pathOperands) {
      if (d) {
        paths.push({ path, isDirectory: false });
        continue;
      }
      try {
        const fullPath = resolvePath({ cwd: context.cwd, path });
        const entry = await resolveListingEntry({
          path: fullPath,
          entry: undefined,
          isCommandLineArgument: true,
        });
        const stat = await context.files.statEntry({ entry });
        paths.push({ path, isDirectory: stat.type === 'directory' });
      } catch {
        paths.push({ path, isDirectory: false });
      }
    }
    paths.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? 1 : -1;
      }
      return compareCStrings({ left: left.path, right: right.path });
    });

    for (let index = 0; index < paths.length; index++) {
      const pathInfo = paths[index];
      const path = pathInfo?.path;
      if (path === undefined) {
        continue;
      }
      await listPath({
        displayPath: path,
        fullPath: resolvePath({ cwd: context.cwd, path }),
        entry: undefined,
        isCommandLineArgument: true,
        printHeader: paths.length > 1 || R,
      });
    }

    return { exitCode };
  },
};

function formatSize({ bytes }: { bytes: number }): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

async function formatEntry({
  context,
  displayName,
  fullPath,
  type,
  longFormat,
  humanReadable,
  classify,
  stat,
  getStat,
}: {
  context: WeshCommandContext,
  displayName: string,
  fullPath: string,
  type: WeshFileType,
  longFormat: boolean,
  humanReadable: boolean,
  classify: boolean,
  stat: WeshStat | undefined,
  getStat: () => Promise<WeshStat>,
}): Promise<string> {
  let line = displayName;
  if (classify) {
    switch (type) {
    case 'directory':
      line += '/';
      break;
    case 'fifo':
      line += '|';
      break;
    case 'chardev':
      line += '@';
      break;
    case 'symlink':
      line += '@';
      break;
    case 'file':
      break;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
  }

  if (!longFormat) {
    return line;
  }

  const resolvedStat = stat ?? await getStat();
  const size = humanReadable ? formatSize({ bytes: resolvedStat.size }) : resolvedStat.size.toString();
  let typeChar = '-';
  switch (resolvedStat.type) {
  case 'directory':
    typeChar = 'd';
    break;
  case 'fifo':
    typeChar = 'p';
    break;
  case 'chardev':
    typeChar = 'c';
    break;
  case 'symlink':
    typeChar = 'l';
    break;
  case 'file':
    break;
  default: {
    const _ex: never = resolvedStat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }

  let renderedName = line;
  switch (resolvedStat.type) {
  case 'symlink':
    try {
      const target = await context.files.readlink({ path: fullPath });
      renderedName += ` -> ${target}`;
    } catch {
      // Leave the symlink target suffix off if it cannot be read.
    }
    break;
  case 'directory':
  case 'chardev':
  case 'fifo':
  case 'file':
    break;
  default: {
    const _ex: never = resolvedStat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }

  return `${typeChar} ${size.padStart(10)} ${renderedName}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
