import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshCommandContext,
  WeshDirEntry,
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
    const pathStatCache = new Map<string, Promise<WeshStat>>();
    const resolvedDirectoryPathCache = new Map<string, Promise<string>>();
    let exitCode = 0;

    const getCachedPathStat = ({
      path,
      isCommandLineArgument,
    }: {
      path: string;
      isCommandLineArgument: boolean;
    }): Promise<WeshStat> => {
      const key = (() => {
        switch (symlinkMode) {
        case 'logical':
          return `stat:${path}`;
        case 'command-line':
          return `${isCommandLineArgument ? 'stat' : 'lstat'}:${path}`;
        case 'physical':
          return `lstat:${path}`;
        default: {
          const _ex: never = symlinkMode;
          throw new Error(`Unhandled symlink mode: ${_ex}`);
        }
        }
      })();

      const cached = pathStatCache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      const pending = getPathStat({
        context,
        path,
        symlinkMode,
        isCommandLineArgument,
      });
      pathStatCache.set(key, pending);
      return pending;
    };

    const getCachedDirectoryReadPath = async ({
      path,
      isCommandLineArgument,
    }: {
      path: string;
      isCommandLineArgument: boolean;
    }): Promise<string> => {
      const stat = await getCachedPathStat({
        path,
        isCommandLineArgument,
      });
      switch (stat.type) {
      case 'directory':
      {
        const cached = resolvedDirectoryPathCache.get(path);
        if (cached !== undefined) {
          return cached;
        }
        const pending = context.files.resolve({ path }).then(({ fullPath }) => fullPath);
        resolvedDirectoryPathCache.set(path, pending);
        return pending;
      }
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        return path;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled stat type: ${_ex}`);
      }
      }
    };

    async function listPath({
      displayPath,
      fullPath,
      isCommandLineArgument,
      printHeader,
    }: {
      displayPath: string;
      fullPath: string;
      isCommandLineArgument: boolean;
      printHeader: boolean;
    }): Promise<void> {
      try {
        const directStat = await getCachedPathStat({
          path: fullPath,
          isCommandLineArgument,
        });

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
            getStat: () => getCachedPathStat({ path: fullPath, isCommandLineArgument }),
          });
          await text.print({ text: `${line}\n` });
          return;
        }

        const directoryPath = await getCachedDirectoryReadPath({
          path: fullPath,
          isCommandLineArgument,
        });
        const allEntries: WeshDirEntry[] = [];
        for await (const entry of context.files.readDir({ path: directoryPath })) {
          allEntries.push(entry);
        }
        const filtered = (a ? allEntries : allEntries.filter((entry) => !entry.name.startsWith('.')))
          .sort((left, right) => left.name.localeCompare(right.name));

        if (printHeader) {
          await text.print({ text: `${displayPath}:\n` });
        }

        for (const entry of filtered) {
          const line = await formatEntry({
            context,
            displayName: entry.name,
            fullPath: entry.fullPath,
            type: entry.type,
            longFormat: l,
            humanReadable: h,
            classify,
            stat: undefined,
            getStat: () => getCachedPathStat({ path: entry.fullPath, isCommandLineArgument: false }),
          });
          await text.print({ text: line + (one || l ? '\n' : '  ') });
        }

        if (!one && !l && filtered.length > 0) {
          await text.print({ text: '\n' });
        }

        if (R) {
          const childDirectories = filtered.filter((entry) => entry.type === 'directory');
          for (const entry of childDirectories) {
            if (entry.name === '.' || entry.name === '..') {
              continue;
            }
            const childDisplayPath = displayPath === '/' ? `/${entry.name}` : `${displayPath}/${entry.name}`;
            await text.print({ text: '\n' });
            await listPath({
              displayPath: childDisplayPath,
              fullPath: entry.fullPath,
              isCommandLineArgument: false,
              printHeader: true,
            });
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `ls: ${displayPath}: ${message}\n` });
        exitCode = 1;
      }
    }

    for (let index = 0; index < paths.length; index++) {
      const p = paths[index];
      if (p === undefined) {
        continue;
      }
      if (index > 0) {
        await text.print({ text: '\n' });
      }
      await listPath({
        displayPath: p,
        fullPath: resolvePath({ cwd: context.cwd, path: p }),
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

async function getPathStat({
  context,
  path,
  symlinkMode,
  isCommandLineArgument,
}: {
  context: WeshCommandContext;
  path: string;
  symlinkMode: LsSymlinkMode;
  isCommandLineArgument: boolean;
}): Promise<WeshStat> {
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
