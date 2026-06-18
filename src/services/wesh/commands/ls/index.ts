import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshCommandContext,
  WeshEntryRef,
  WeshFileType,
  WeshStat,
} from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

type LsSymlinkMode = 'logical' | 'command-line' | 'physical';

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

const lsArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'l', long: 'l', effects: [{ key: 'l', value: true }], help: { summary: 'use a long listing format', category: 'common' } },
    { kind: 'flag', short: 'a', long: 'a', effects: [{ key: 'a', value: true }], help: { summary: 'include directory entries whose names begin with .', category: 'common' } },
    { kind: 'flag', short: 'R', long: 'R', effects: [{ key: 'R', value: true }], help: { summary: 'list subdirectories recursively', category: 'common' } },
    { kind: 'flag', short: 'd', long: 'directory', effects: [{ key: 'directory', value: true }], help: { summary: 'list directories themselves, not their contents', category: 'common' } },
    { kind: 'flag', short: 'F', long: 'classify', effects: [{ key: 'classify', value: true }], help: { summary: 'append indicator characters to entries', category: 'common' } },
    { kind: 'flag', short: '1', long: '1', effects: [{ key: '1', value: true }], help: { summary: 'list one file per line', category: 'advanced' } },
    { kind: 'flag', short: 'h', long: 'h', effects: [{ key: 'h', value: true }], help: { summary: 'with -l, print sizes in human readable format', category: 'common' } },
    { kind: 'flag', short: 'L', long: undefined, effects: [{ key: 'symlinkMode', value: 'logical' }], help: { summary: 'when listing symlinks, show the target type', category: 'advanced' } },
    { kind: 'flag', short: 'H', long: undefined, effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'follow command-line symlinks', category: 'advanced' } },
    { kind: 'flag', short: 'P', long: undefined, effects: [{ key: 'symlinkMode', value: 'physical' }], help: { summary: 'do not follow symlinks', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const lsCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'ls',
    description: 'List directory contents',
    usage: 'ls [path...] [-l] [-a] [-R] [-1] [-h] [-L] [-H] [-P]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
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

    const paths = parsed.positionals.length > 0 ? parsed.positionals : ['.'];
    const l = parsed.optionValues.l === true;
    const a = parsed.optionValues.a === true;
    const one = parsed.optionValues['1'] === true;
    const h = parsed.optionValues.h === true;
    const d = parsed.optionValues.directory === true;
    const R = parsed.optionValues.R === true;
    const classify = parsed.optionValues.classify === true;
    const symlinkMode = (parsed.optionValues.symlinkMode as LsSymlinkMode | undefined) ?? 'physical';
    let exitCode = 0;

    const resolveListingEntry = async ({
      path,
      entry,
      isCommandLineArgument,
    }: {
      path: string;
      entry: WeshEntryRef | undefined;
      isCommandLineArgument: boolean;
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
      if (entry !== undefined && (!shouldFollow || entry.type !== 'symlink')) {
        return entry;
      }
      return context.files.resolveEntry({
        path,
        finalSymlinkTreatment: shouldFollow ? 'follow' : 'no-follow',
      });
    };

    async function listPath({
      displayPath,
      fullPath,
      entry: providedEntry,
      isCommandLineArgument,
      printHeader,
    }: {
      displayPath: string;
      fullPath: string;
      entry: WeshEntryRef | undefined;
      isCommandLineArgument: boolean;
      printHeader: boolean;
    }): Promise<void> {
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
        const allEntries: WeshEntryRef[] = [];
        for await (const child of context.files.readDirEntry({ entry: directoryEntry })) {
          if (a || !child.name.startsWith('.')) {
            allEntries.push(child);
          }
        }
        allEntries.sort((left, right) => left.name.localeCompare(right.name));

        if (printHeader) {
          await text.print({ text: `${displayPath}:\n` });
        }

        const resolvedEntries: WeshEntryRef[] = [];
        for (const child of allEntries) {
          const resolvedChild = await resolveListingEntry({
            path: child.fullPath,
            entry: child,
            isCommandLineArgument: false,
          });
          resolvedEntries.push(resolvedChild);
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
        }

        if (!one && !l && resolvedEntries.length > 0) {
          await text.print({ text: '\n' });
        }

        if (R) {
          for (let index = 0; index < resolvedEntries.length; index += 1) {
            const child = allEntries[index];
            const resolvedChild = resolvedEntries[index];
            if (child === undefined || resolvedChild === undefined || resolvedChild.type !== 'directory') {
              continue;
            }
            if (child.name === '.' || child.name === '..') {
              continue;
            }
            const childDisplayPath = displayPath === '/' ? `/${child.name}` : `${displayPath}/${child.name}`;
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
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `ls: ${displayPath}: ${message}\n` });
        exitCode = 1;
      }
    }

    for (let index = 0; index < paths.length; index++) {
      const path = paths[index];
      if (path === undefined) {
        continue;
      }
      if (index > 0) {
        await text.print({ text: '\n' });
      }
      await listPath({
        displayPath: path,
        fullPath: resolvePath({ cwd: context.cwd, path }),
        entry: undefined,
        isCommandLineArgument: true,
        printHeader: paths.length > 1,
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
  context: WeshCommandContext;
  displayName: string;
  fullPath: string;
  type: WeshFileType;
  longFormat: boolean;
  humanReadable: boolean;
  classify: boolean;
  stat: WeshStat | undefined;
  getStat: () => Promise<WeshStat>;
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
