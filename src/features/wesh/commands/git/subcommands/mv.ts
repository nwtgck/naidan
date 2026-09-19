import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { normalizePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import type { GitFiles } from '@/features/wesh/commands/git/files';
import { pathExists } from '@/features/wesh/commands/git/files';
import { readIndex, writeIndex } from '@/features/wesh/commands/git/index-file';
import { joinPath, relativeToWorktree, discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { readEffectiveConfig } from '@/features/wesh/commands/git/config';

const MV_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'dry-run', 'no-dry-run', 'force', 'no-force', 'sparse', 'no-sparse',
  ],
  definitions: [{
    semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
    forms: [
      { kind: 'short', name: 'v', value: { kind: 'none' } },
      { kind: 'long', name: 'verbose', value: { kind: 'none' } },
    ],
  }, {
    semantic: { kind: 'effects', effects: [{ key: 'verbose', value: false }] },
    forms: [{ kind: 'long', name: 'no-verbose', value: { kind: 'none' } }],
  }],
});

const MV_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

interface DirectoryMovePlan {
  directories: readonly { sourcePath: string, destinationPath: string }[],
  leaves: readonly { sourcePath: string, destinationPath: string }[],
}

function parentPath({ path }: { path: string }): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
}

function basename({ path }: { path: string }): string {
  const parts = path.split('/').filter(part => part.length > 0);
  const name = parts[parts.length - 1];
  if (name === undefined) throw new Error(`invalid path: ${path}`);
  return name;
}

async function resolveMoveDestination({ files, sourceAbsolutePath, requestedDestinationAbsolutePath }: {
  files: GitFiles,
  sourceAbsolutePath: string,
  requestedDestinationAbsolutePath: string,
}): Promise<string> {
  if (!await pathExists({ files, path: requestedDestinationAbsolutePath })) return requestedDestinationAbsolutePath;
  const stat = await files.lstat({ path: requestedDestinationAbsolutePath });
  switch (stat.type) {
  case 'directory':
    return joinPath({ base: requestedDestinationAbsolutePath, child: basename({ path: sourceAbsolutePath }) });
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`destination exists: ${requestedDestinationAbsolutePath}`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled destination type: ${_ex}`);
  }
  }
}

async function assertDirectory({ files, path }: { files: GitFiles, path: string }): Promise<void> {
  if (!await pathExists({ files, path })) throw new Error(`destination parent does not exist: ${path}`);
  const stat = await files.lstat({ path });
  switch (stat.type) {
  case 'directory':
    return;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`destination parent is not a directory: ${path}`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled destination parent type: ${_ex}`);
  }
  }
}

async function planDirectoryMove({ files, sourceAbsolutePath, destinationAbsolutePath }: {
  files: GitFiles,
  sourceAbsolutePath: string,
  destinationAbsolutePath: string,
}): Promise<DirectoryMovePlan> {
  if (destinationAbsolutePath.startsWith(`${sourceAbsolutePath}/`)) {
    throw new Error('cannot move a directory into itself');
  }
  await assertDirectory({ files, path: parentPath({ path: destinationAbsolutePath }) });
  if (await pathExists({ files, path: destinationAbsolutePath })) {
    throw new Error(`destination exists: ${destinationAbsolutePath}`);
  }

  const directories: Array<{ sourcePath: string, destinationPath: string }> = [{
    sourcePath: sourceAbsolutePath,
    destinationPath: destinationAbsolutePath,
  }];
  const leaves: Array<{ sourcePath: string, destinationPath: string }> = [];
  const visit = async ({ sourceDirectoryPath, destinationDirectoryPath }: {
    sourceDirectoryPath: string,
    destinationDirectoryPath: string,
  }): Promise<void> => {
    for await (const entry of files.readDir({ path: sourceDirectoryPath })) {
      const destinationPath = joinPath({ base: destinationDirectoryPath, child: entry.name });
      if (await pathExists({ files, path: destinationPath })) throw new Error(`destination exists: ${destinationPath}`);
      switch (entry.type) {
      case 'directory':
        directories.push({ sourcePath: entry.fullPath, destinationPath });
        await visit({ sourceDirectoryPath: entry.fullPath, destinationDirectoryPath: destinationPath });
        break;
      case 'file':
      case 'symlink':
        leaves.push({ sourcePath: entry.fullPath, destinationPath });
        break;
      case 'fifo':
      case 'chardev':
        throw new Error(`unsupported source type: ${entry.type}`);
      default: {
        const _ex: never = entry.type;
        throw new Error(`Unhandled source entry type: ${_ex}`);
      }
      }
    }
  };
  await visit({ sourceDirectoryPath: sourceAbsolutePath, destinationDirectoryPath: destinationAbsolutePath });
  return { directories, leaves };
}

async function applyDirectoryMove({ files, plan }: { files: GitFiles, plan: DirectoryMovePlan }): Promise<void> {
  for (const directory of plan.directories) {
    await files.mkdir({ path: directory.destinationPath, recursive: false });
  }
  for (const leaf of plan.leaves) {
    await files.rename({ oldPath: leaf.sourcePath, newPath: leaf.destinationPath });
  }
  for (const directory of [...plan.directories].sort((left, right) => right.sourcePath.length - left.sourcePath.length)) {
    await files.rmdir({ path: directory.sourcePath });
  }
}

export async function runMv({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  const parsed = parseStandardArgv({ args, catalog: MV_ARGV_CATALOG, policy: MV_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    switch (diagnostic.kind) {
    case 'ambiguous_long_option':
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: diagnostic.option,
          candidateOptions: diagnostic.candidateOptions,
        }),
      });
    case 'unknown_short_option':
    case 'unknown_long_option':
    case 'missing_option_value':
    case 'unexpected_option_value':
    case 'invalid_option_value':
      throw new GitUsageError({ message: `unsupported mv argument: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled mv argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  const operands = parsed.positionals;
  const verbose = parsed.optionValues.verbose === true;
  if (operands.length !== 2) throw new GitUsageError({ message: 'usage: git mv [--] <source> <destination>', prefix: 'none' });

  const sourceAbsolutePath = normalizePath({ cwd: context.cwd, path: operands[0]! });
  const requestedDestinationAbsolutePath = normalizePath({ cwd: context.cwd, path: operands[1]! });
  const destinationAbsolutePath = await resolveMoveDestination({
    files: context.files,
    sourceAbsolutePath,
    requestedDestinationAbsolutePath,
  });
  const sourcePath = relativeToWorktree({ repository, absolutePath: sourceAbsolutePath });
  const destinationPath = relativeToWorktree({ repository, absolutePath: destinationAbsolutePath });
  if (sourcePath.length === 0 || destinationPath.length === 0
    || sourcePath === '.git' || sourcePath.startsWith('.git/')
    || destinationPath === '.git' || destinationPath.startsWith('.git/')) {
    throw new Error('source and destination must be worktree paths');
  }

  const entries = await readIndex({ files: context.files, repository });
  if (entries.some(entry => entry.stage !== 0)) throw new Error('git mv with unmerged index entries is not supported yet');
  const sourceEntries = entries.filter(entry => entry.path === sourcePath || entry.path.startsWith(`${sourcePath}/`));
  if (sourceEntries.length === 0) throw new Error(`bad source, source=${sourcePath}, destination=${destinationPath}`);
  if (entries.some(entry => entry.path === destinationPath || entry.path.startsWith(`${destinationPath}/`))) {
    throw new Error(`destination exists, source=${sourcePath}, destination=${destinationPath}`);
  }
  if (!await pathExists({ files: context.files, path: sourceAbsolutePath })) {
    throw new Error(`bad source, source=${sourcePath}, destination=${destinationPath}`);
  }
  if (await pathExists({ files: context.files, path: destinationAbsolutePath })) {
    throw new Error(`destination exists, source=${sourcePath}, destination=${destinationPath}`);
  }
  await assertDirectory({ files: context.files, path: parentPath({ path: destinationAbsolutePath }) });

  const sourceStat = await context.files.lstat({ path: sourceAbsolutePath });
  switch (sourceStat.type) {
  case 'file':
  case 'symlink':
    if (sourceEntries.length !== 1 || sourceEntries[0]!.path !== sourcePath) {
      throw new Error(`bad source, source=${sourcePath}, destination=${destinationPath}`);
    }
    await context.files.rename({ oldPath: sourceAbsolutePath, newPath: destinationAbsolutePath });
    break;
  case 'directory':
    await applyDirectoryMove({
      files: context.files,
      plan: await planDirectoryMove({ files: context.files, sourceAbsolutePath, destinationAbsolutePath }),
    });
    break;
  case 'fifo':
  case 'chardev':
    throw new Error(`unsupported source type: ${sourceStat.type}`);
  default: {
    const _ex: never = sourceStat.type;
    throw new Error(`Unhandled source type: ${_ex}`);
  }
  }

  await writeIndex({
    files: context.files,
    repository,
    entries: entries.map(entry => {
      if (entry.path === sourcePath) return { ...entry, path: destinationPath };
      if (entry.path.startsWith(`${sourcePath}/`)) {
        return { ...entry, path: `${destinationPath}${entry.path.slice(sourcePath.length)}` };
      }
      return entry;
    }),
  });
  if (verbose)
    await context.text().print({ text: `Renaming ${sourcePath} to ${destinationPath}\n` });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
  planDirectoryMove,
};
