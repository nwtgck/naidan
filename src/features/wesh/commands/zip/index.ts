import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import {
  createWebZipCompressionCodec,
  StreamingZipWriter,
  type ZipCentralDirectoryStore,
  type ZipCompression,
} from '@/lib/zip-stream';
import {
  createWeshZipByteSink,
  createWeshZipCentralDirectoryStore,
} from '@/features/wesh/zip-stream';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshEntryRef,
  WeshFileHandle,
  WeshFileType,
  WeshOpenFlags,
} from '@/features/wesh/types';
import { openFileReadStream, openHandleReadStream } from '@/features/wesh/utils/fs';

const zipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'r', long: 'recurse-paths', effects: [{ key: 'recursive', value: true }], help: { summary: 'travel the directory structure recursively', category: 'common' } },
    { kind: 'flag', short: 'j', long: 'junk-paths', effects: [{ key: 'junkPaths', value: true }], help: { summary: 'store just the name of a saved file, without path information', category: 'common' } },
    { kind: 'flag', short: 'q', long: 'quiet', effects: [{ key: 'quiet', value: true }], help: { summary: 'quiet operation', category: 'common' } },
    { kind: 'flag', short: '0', long: undefined, effects: [{ key: 'compressionMode', value: 'store' }], help: { summary: 'store only', category: 'common' } },
    { kind: 'flag', short: '1', long: undefined, effects: [{ key: 'compressionLevel', value: 1 }], help: { summary: 'compress faster', category: 'advanced' } },
    { kind: 'flag', short: '2', long: undefined, effects: [{ key: 'compressionLevel', value: 2 }], help: { summary: 'compress faster', category: 'advanced' } },
    { kind: 'flag', short: '3', long: undefined, effects: [{ key: 'compressionLevel', value: 3 }], help: { summary: 'compress faster', category: 'advanced' } },
    { kind: 'flag', short: '4', long: undefined, effects: [{ key: 'compressionLevel', value: 4 }], help: { summary: 'compress faster', category: 'advanced' } },
    { kind: 'flag', short: '5', long: undefined, effects: [{ key: 'compressionLevel', value: 5 }], help: { summary: 'compress faster', category: 'advanced' } },
    { kind: 'flag', short: '6', long: undefined, effects: [{ key: 'compressionLevel', value: 6 }], help: { summary: 'compress faster', category: 'advanced' } },
    { kind: 'flag', short: '7', long: undefined, effects: [{ key: 'compressionLevel', value: 7 }], help: { summary: 'compress better', category: 'advanced' } },
    { kind: 'flag', short: '8', long: undefined, effects: [{ key: 'compressionLevel', value: 8 }], help: { summary: 'compress better', category: 'advanced' } },
    { kind: 'flag', short: '9', long: undefined, effects: [{ key: 'compressionLevel', value: 9 }], help: { summary: 'compress better', category: 'advanced' } },
    {
      kind: 'value',
      short: 'x',
      long: undefined,
      key: 'excludePattern',
      valueName: 'PATTERN',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'exclude the following names', valueName: 'PATTERN', category: 'common' },
    },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

interface PendingZipEntry {
  readonly sourcePath: string,
  readonly archivePath: string,
  readonly type: WeshFileType,
  readonly entryRef: WeshEntryRef | undefined,
}

interface SplitZipArgsResult {
  readonly mainArgs: string[],
  readonly excludePatterns: string[],
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

function basename({ path }: { path: string }): string {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function sanitizeArchiveRootName({ path }: { path: string }): string {
  return path.replace(/^\/+/, '');
}

function splitZipArgs({ args }: { args: string[] }): SplitZipArgsResult {
  const excludeIndex = args.indexOf('-x');
  if (excludeIndex === -1) {
    return { mainArgs: args, excludePatterns: [] };
  }
  return {
    mainArgs: args.slice(0, excludeIndex),
    excludePatterns: args.slice(excludeIndex + 1),
  };
}

function globToRegExp({ pattern }: { pattern: string }): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) {
      continue;
    }
    if (char === '*') {
      source += '.*';
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    if (char === '[') {
      const endIndex = pattern.indexOf(']', index + 1);
      if (endIndex > index) {
        source += pattern.slice(index, endIndex + 1);
        index = endIndex;
        continue;
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  source += '$';
  return new RegExp(source);
}

function buildArchivePath({
  operand,
  currentPath,
  junkPaths,
}: {
  operand: string,
  currentPath: string,
  junkPaths: boolean,
}): string {
  if (junkPaths) {
    return basename({ path: currentPath });
  }
  if (operand === '-') {
    return '-';
  }
  if (currentPath === operand) {
    return sanitizeArchiveRootName({ path: operand });
  }
  const normalizedOperand = operand.endsWith('/') ? operand.slice(0, -1) : operand;
  const prefix = `${normalizedOperand}/`;
  const relativePart = currentPath.startsWith(prefix)
    ? currentPath.slice(prefix.length)
    : basename({ path: currentPath });
  const rootName = sanitizeArchiveRootName({ path: normalizedOperand });
  return rootName === '' ? relativePart : `${rootName}/${relativePart}`;
}

function asDirectoryEntry({ entry }: { entry: WeshEntryRef }): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Expected directory entry: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${String(_ex)}`);
  }
  }
}

async function* iterateDirectoryEntries({
  context,
  operand,
  directory,
  junkPaths,
}: {
  context: WeshCommandContext,
  operand: string,
  directory: WeshEntryRef<'directory'>,
  junkPaths: boolean,
}): AsyncIterable<PendingZipEntry> {
  for await (const child of context.files.readDirEntry({ entry: directory })) {
    const archivePath = buildArchivePath({
      operand,
      currentPath: child.fullPath,
      junkPaths,
    });
    switch (child.type) {
    case 'directory':
      yield {
        sourcePath: child.fullPath,
        archivePath: `${archivePath}/`,
        type: 'directory',
        entryRef: child,
      };
      yield* iterateDirectoryEntries({
        context,
        operand,
        directory: asDirectoryEntry({ entry: child }),
        junkPaths,
      });
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      yield {
        sourcePath: child.fullPath,
        archivePath,
        type: child.type,
        entryRef: child,
      };
      break;
    default: {
      const _exhaustiveCheck: never = child;
      throw new Error(`Unhandled entry type: ${String(_exhaustiveCheck)}`);
    }
    }
  }
}

async function* iterateZipEntriesForOperand({
  context,
  operand,
  recursive,
  junkPaths,
}: {
  context: WeshCommandContext,
  operand: string,
  recursive: boolean,
  junkPaths: boolean,
}): AsyncIterable<PendingZipEntry> {
  if (operand === '-') {
    yield {
      sourcePath: '-',
      archivePath: '-',
      type: 'file',
      entryRef: undefined,
    };
    return;
  }

  const entry = await context.files.resolveEntry({
    path: operand,
    finalSymlinkTreatment: 'follow',
  });
  const archivePath = buildArchivePath({ operand, currentPath: operand, junkPaths });
  switch (entry.type) {
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    yield {
      sourcePath: operand,
      archivePath,
      type: entry.type,
      entryRef: entry,
    };
    return;
  case 'directory':
    yield {
      sourcePath: operand,
      archivePath: `${archivePath}/`,
      type: 'directory',
      entryRef: entry,
    };
    if (recursive) {
      yield* iterateDirectoryEntries({
        context,
        operand,
        directory: asDirectoryEntry({ entry }),
        junkPaths,
      });
    }
    return;
  default: {
    const _exhaustiveCheck: never = entry;
    throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
  }
  }
}

function createTemporarySuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createSiblingTemporaryPath({ path }: { path: string }): string {
  const slashIndex = path.lastIndexOf('/');
  const parent = slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
  const name = slashIndex < 0 ? path : path.slice(slashIndex + 1);
  const temporaryName = `.${name}.wesh-zip-${createTemporarySuffix()}`;
  return parent === '/' ? `/${temporaryName}` : `${parent}/${temporaryName}`;
}

async function removePathIfPresent({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<void> {
  try {
    await context.files.unlink({ path });
  } catch {
    // Cleanup is best-effort and must not hide the primary command result.
  }
}

async function pathExists({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<boolean> {
  try {
    await context.files.lstat({ path });
    return true;
  } catch {
    return false;
  }
}

function createWriteFlags(): WeshOpenFlags {
  return {
    access: 'write',
    creation: 'always',
    truncate: 'truncate',
    append: 'preserve',
  };
}

async function openEntryStream({
  context,
  entry,
}: {
  context: WeshCommandContext,
  entry: PendingZipEntry,
}): Promise<ReadableStream<Uint8Array>> {
  if (entry.sourcePath === '-') {
    return openHandleReadStream({ handle: context.stdin });
  }
  if (entry.entryRef !== undefined) {
    const handle = await context.files.openEntry({
      entry: entry.entryRef,
      flags: {
        access: 'read',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    return openHandleReadStream({ handle });
  }
  return openFileReadStream({ files: context.files, path: entry.sourcePath });
}

async function closeHandleSafely({ handle }: { handle: WeshFileHandle | undefined }): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // Cleanup is best-effort and must not hide the primary command result.
  }
}

async function disposeCentralDirectoryStoreSafely({
  store,
}: {
  store: ZipCentralDirectoryStore | undefined,
}): Promise<void> {
  if (store === undefined) {
    return;
  }
  try {
    await store.dispose();
  } catch {
    // Continue closing handles and removing temporary paths after any store failure.
  }
}

export const zipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'zip',
    description: 'Package and compress files into ZIP archives',
    usage: 'zip [-rjq0-9] zipfile file...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const splitArgs = splitZipArgs({ args: context.args });
    const parsed = parseStandardArgv({ args: splitArgs.mainArgs, spec: zipArgvSpec });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'zip',
        message: `zip: ${diagnostic.message}`,
        argvSpec: zipArgvSpec,
      });
      return { exitCode: 2 };
    }
    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'zip', argvSpec: zipArgvSpec });
      return { exitCode: 0 };
    }

    const archiveOperand = parsed.positionals[0];
    if (archiveOperand === undefined || parsed.positionals.length < 2) {
      await context.text().error({
        text: `zip error: Nothing to do! (${archiveOperand ?? 'zip'})\n`,
      });
      return { exitCode: 12 };
    }

    const archivePath = resolvePath({ cwd: context.cwd, path: archiveOperand });
    const archiveTemporaryPath = createSiblingTemporaryPath({ path: archivePath });
    const archiveRecoveryPath = `${archiveTemporaryPath}.original`;
    const temporaryDirectory = (context.env.get('TMPDIR') || '/tmp').replace(/\/$/u, '');
    const centralDirectoryPath = `${temporaryDirectory}/wesh-zip-central-${createTemporarySuffix()}`;
    const excludeMatchers = splitArgs.excludePatterns.map(pattern => globToRegExp({ pattern }));
    const inputOperands = parsed.positionals.slice(1).map(path => path === '-'
      ? '-'
      : resolvePath({ cwd: context.cwd, path }));
    const recursive = parsed.optionValues.recursive === true;
    const junkPaths = parsed.optionValues.junkPaths === true;
    const compression: ZipCompression = parsed.optionValues.compressionMode === 'store'
      ? 'store'
      : 'deflate';

    await context.files.mkdir({ path: temporaryDirectory, recursive: true });
    let outputHandle: WeshFileHandle | undefined;
    let centralDirectoryHandle: WeshFileHandle | undefined;
    let centralDirectoryStore: ZipCentralDirectoryStore | undefined;
    let matchedInput = false;
    let hadError = false;
    let archiveInstalled = false;

    try {
      outputHandle = await context.files.open({
        path: archiveTemporaryPath,
        flags: createWriteFlags(),
      });
      centralDirectoryHandle = await context.files.open({
        path: centralDirectoryPath,
        flags: createWriteFlags(),
      });
      centralDirectoryStore = createWeshZipCentralDirectoryStore({
        files: context.files,
        path: centralDirectoryPath,
        handle: centralDirectoryHandle,
      });
      const writer = new StreamingZipWriter({
        output: createWeshZipByteSink({ handle: outputHandle }),
        centralDirectoryStore,
        compressionCodec: createWebZipCompressionCodec(),
      });

      for (const operand of inputOperands) {
        try {
          for await (const entry of iterateZipEntriesForOperand({
            context,
            operand,
            recursive,
            junkPaths,
          })) {
            if (excludeMatchers.some(matcher => matcher.test(entry.archivePath))) {
              continue;
            }
            matchedInput = true;
            switch (entry.type) {
            case 'directory':
              await writer.addDirectory({
                name: entry.archivePath,
                modifiedAt: new Date(),
              });
              break;
            case 'file':
              await writer.addFile({
                name: entry.archivePath,
                modifiedAt: new Date(),
                compression,
                stream: await openEntryStream({ context, entry }),
              });
              break;
            case 'fifo':
            case 'chardev':
            case 'symlink':
              await context.text().error({
                text: `zip warning: unsupported file type for ${entry.sourcePath}\n`,
              });
              hadError = true;
              break;
            default: {
              const _exhaustiveCheck: never = entry.type;
              throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
            }
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('NotFoundError')) {
            await context.text().error({
              text: `\tzip warning: name not matched: ${operand}\n`,
            });
          } else {
            await context.text().error({ text: `zip error: ${message}\n` });
            hadError = true;
          }
        }
      }

      if (!matchedInput) {
        await context.text().error({
          text: `zip error: Nothing to do! (${archiveOperand})\n`,
        });
        return { exitCode: 12 };
      }

      await writer.finalize();
      await centralDirectoryStore.dispose();
      centralDirectoryStore = undefined;
      await outputHandle.close();
      outputHandle = undefined;
      centralDirectoryHandle = undefined;

      let originalMoved = false;
      if (await pathExists({ context, path: archivePath })) {
        await context.files.rename({
          oldPath: archivePath,
          newPath: archiveRecoveryPath,
        });
        originalMoved = true;
      }
      try {
        await context.files.rename({
          oldPath: archiveTemporaryPath,
          newPath: archivePath,
        });
        archiveInstalled = true;
      } catch (replaceError: unknown) {
        if (originalMoved) {
          try {
            await context.files.rename({
              oldPath: archiveRecoveryPath,
              newPath: archivePath,
            });
            originalMoved = false;
          } catch (restoreError: unknown) {
            throw new AggregateError(
              [replaceError, restoreError],
              `zip: failed to replace and restore ${archivePath}`,
            );
          }
        }
        throw replaceError;
      }
      if (originalMoved) {
        await removePathIfPresent({ context, path: archiveRecoveryPath });
      }
      return { exitCode: hadError ? 1 : 0 };
    } finally {
      await disposeCentralDirectoryStoreSafely({ store: centralDirectoryStore });
      await closeHandleSafely({ handle: centralDirectoryHandle });
      await closeHandleSafely({ handle: outputHandle });
      await removePathIfPresent({ context, path: centralDirectoryPath });
      if (!archiveInstalled) {
        await removePathIfPresent({ context, path: archiveTemporaryPath });
      }
    }
  },
};
