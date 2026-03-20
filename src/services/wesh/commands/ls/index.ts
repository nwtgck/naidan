import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshCommandContext,
  WeshFileType,
  WeshStat,
} from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

type LsSymlinkMode = 'logical' | 'command-line' | 'physical';

const lsArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'l', long: 'l', effects: [{ key: 'l', value: true }], help: { summary: 'use a long listing format', category: 'common' } },
    { kind: 'flag', short: 'a', long: 'a', effects: [{ key: 'a', value: true }], help: { summary: 'include directory entries whose names begin with .', category: 'common' } },
    { kind: 'flag', short: 'R', long: 'R', effects: [{ key: 'R', value: true }], help: { summary: 'list subdirectories recursively', category: 'common' } },
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
    const symlinkMode = (parsed.optionValues.symlinkMode as LsSymlinkMode | undefined) ?? 'physical';

    for (let index = 0; index < paths.length; index++) {
      const p = paths[index];
      if (p === undefined) {
        continue;
      }
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        const directStat = await getPathStat({
          context,
          path: fullPath,
          symlinkMode,
          isCommandLineArgument: true,
        });

        switch (directStat.type) {
        case 'directory':
          break;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink': {
          const line = await formatEntry({
            context,
            displayName: p,
            fullPath,
            type: directStat.type,
            longFormat: l,
            humanReadable: h,
            symlinkMode,
            isCommandLineArgument: true,
          });
          await text.print({ text: `${line}\n` });
          continue;
        }
        default: {
          const _ex: never = directStat.type;
          throw new Error(`Unhandled file type: ${_ex}`);
        }
        }

        const directoryPath = await getDirectoryReadPath({
          context,
          path: fullPath,
          symlinkMode,
          isCommandLineArgument: true,
        });
        const entries = await context.files.readDir({ path: directoryPath });
        const filtered = a ? entries : entries.filter((entry) => !entry.name.startsWith('.'));

        if (paths.length > 1) {
          if (index > 0) {
            await text.print({ text: '\n' });
          }
          await text.print({ text: `${p}:\n` });
        }

        for (const entry of filtered) {
          const entryPath = directoryPath.endsWith('/') ? `${directoryPath}${entry.name}` : `${directoryPath}/${entry.name}`;
          const line = await formatEntry({
            context,
            displayName: entry.name,
            fullPath: entryPath,
            type: entry.type,
            longFormat: l,
            humanReadable: h,
            symlinkMode,
            isCommandLineArgument: false,
          });
          await text.print({ text: line + (one || l ? '\n' : '  ') });
        }

        if (!one && !l && filtered.length > 0) {
          await text.print({ text: '\n' });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `ls: ${p}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};

function formatSize(bytes: number): string {
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

async function getDirectoryReadPath({
  context,
  path,
  symlinkMode,
  isCommandLineArgument,
}: {
  context: WeshCommandContext;
  path: string;
  symlinkMode: LsSymlinkMode;
  isCommandLineArgument: boolean;
}): Promise<string> {
  const stat = await getPathStat({
    context,
    path,
    symlinkMode,
    isCommandLineArgument,
  });
  switch (stat.type) {
  case 'directory':
    return (await context.files.resolve({ path })).fullPath;
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
}

async function formatEntry({
  context,
  displayName,
  fullPath,
  type,
  longFormat,
  humanReadable,
  symlinkMode,
  isCommandLineArgument,
}: {
  context: WeshCommandContext;
  displayName: string;
  fullPath: string;
  type: WeshFileType;
  longFormat: boolean;
  humanReadable: boolean;
  symlinkMode: LsSymlinkMode;
  isCommandLineArgument: boolean;
}): Promise<string> {
  let line = displayName;
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
  case 'file':
  case 'symlink':
    break;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }

  if (!longFormat) {
    return line;
  }

  const stat = await getPathStat({
    context,
    path: fullPath,
    symlinkMode,
    isCommandLineArgument,
  });
  const size = humanReadable ? formatSize(stat.size) : stat.size.toString();
  let typeChar = '-';
  switch (stat.type) {
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
    const _ex: never = stat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }

  return `${typeChar} ${size.padStart(10)} ${line}`;
}
