import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshCommandContext,
  WeshEntryRef,
  WeshFileType,
  WeshStat,
} from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';

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

function parseClassifyLongOption({ token }: { token: string }) {
  const prefix = '--classify=';
  if (!token.startsWith(prefix)) return undefined;

  const value = token.slice(prefix.length);
  const mode = parseClassifyArgument({ value });
  const effects = (() => {
    if (mode === undefined) return [{ key: 'classifyParseError', value }];
    switch (mode) {
    case 'always':
      return [{ key: 'classify', value: true }];
    case 'never':
      return [];
    default: {
      const _ex: never = mode;
      return _ex;
    }
    }
  })();
  return {
    kind: 'matched' as const,
    consumeCount: 1,
    effects,
    occurrences: [{
      kind: 'special' as const,
      option: '--classify',
      effects,
    }],
  };
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

const lsArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'l', long: 'l', effects: [{ key: 'l', value: true }], help: { summary: 'use a long listing format', category: 'common' } },
    { kind: 'flag', short: 'a', long: 'all', effects: [{ key: 'a', value: true }], help: { summary: 'include directory entries whose names begin with .', category: 'common' } },
    { kind: 'flag', short: 'A', long: 'almost-all', effects: [{ key: 'almostAll', value: true }], help: { summary: 'include hidden entries except . and ..', category: 'common' } },
    { kind: 'flag', short: 'R', long: 'recursive', effects: [{ key: 'R', value: true }], help: { summary: 'list subdirectories recursively', category: 'common' } },
    { kind: 'flag', short: 'd', long: 'directory', effects: [{ key: 'directory', value: true }], help: { summary: 'list directories themselves, not their contents', category: 'common' } },
    { kind: 'flag', short: 'F', long: 'classify', effects: [{ key: 'classify', value: true }], help: { summary: 'append indicator characters to entries', category: 'common' } },
    { kind: 'flag', short: '1', long: '1', effects: [{ key: '1', value: true }], help: { summary: 'list one file per line', category: 'advanced' } },
    { kind: 'flag', short: 'h', long: 'human-readable', effects: [{ key: 'h', value: true }], help: { summary: 'with -l, print sizes in human readable format', category: 'common' } },
    { kind: 'flag', short: 'L', long: 'dereference', effects: [{ key: 'symlinkMode', value: 'logical' }], help: { summary: 'when listing symlinks, show the target type', category: 'advanced' } },
    { kind: 'flag', short: 'H', long: 'dereference-command-line', effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'follow command-line symlinks', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [({ token }) => parseClassifyLongOption({ token })],
};

export const lsCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'ls',
    description: 'List directory contents',
    usage: 'ls [path...] [-l] [-a] [-A] [-R] [-1] [-h] [-L] [-H]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: lsArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: lsArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'ls',
        message: `ls: ${diagnostic.message}`,
        argvSpec: lsArgvSpec,
      });
      return { exitCode: 2 };
    }

    const classifyParseError = typeof parsed.optionValues.classifyParseError === 'string'
      ? parsed.optionValues.classifyParseError
      : undefined;
    if (classifyParseError !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'ls',
        message: `ls: invalid argument '${classifyParseError}' for '--classify'`,
        argvSpec: lsArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'ls',
        argvSpec: lsArgvSpec,
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
    const classify = parsed.optionValues.classify === true;
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
