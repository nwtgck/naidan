import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolveInternalTemporaryDirectory } from '@/features/wesh/commands/_shared/temporary-directory';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { decodeWeshZipEntryName } from '@/features/wesh/commands/_shared/zip-entry-name';
import {
  createWebZipCompressionCodec,
  StreamingZipReader,
  StreamingZipWriter,
  type ZipArchiveEntry,
  type ZipCentralDirectoryStore,
  type ZipCompression,
} from '@/utils/zip-stream';
import {
  createWeshZipByteSink,
  createWeshZipCentralDirectoryStore,
  createWeshZipRandomAccessSource,
} from '@/features/wesh/zip-stream';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
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

type SplitZipArgsResult =
  | {
    readonly ok: true,
    readonly mainArgs: string[],
    readonly excludePatterns: string[],
  }
  | {
    readonly ok: false,
    readonly reason: 'missing_exclude_pattern',
  };

interface ZipInputOperand {
  readonly path: string,
  readonly displayPath: string,
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
  const normalized = path.replace(/^\/+/, '').replace(/^(?:\.\/)+/u, '');
  return normalized === '.' ? '' : normalized;
}

function addDefaultZipExtension({ path }: { path: string }): string {
  if (path === '-') {
    return path;
  }
  const slashIndex = path.lastIndexOf('/');
  const name = slashIndex < 0 ? path : path.slice(slashIndex + 1);
  if (name.includes('.')) {
    return path;
  }
  return `${path}.zip`;
}

const ZIP_SHORT_FLAG_OPTIONS_BEFORE_EXCLUDE = new Set([
  'r',
  'j',
  'q',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

function splitZipExcludeStarter({
  token,
}: {
  token: string,
}): {
  readonly optionPrefix: string | undefined,
  readonly attachedPattern: string | undefined,
} | undefined {
  if (!token.startsWith('-') || token.startsWith('--') || token === '-') {
    return undefined;
  }

  const body = token.slice(1);
  const excludeIndex = body.indexOf('x');
  if (excludeIndex < 0) {
    return undefined;
  }
  const prefix = body.slice(0, excludeIndex);
  if ([...prefix].some(character => !ZIP_SHORT_FLAG_OPTIONS_BEFORE_EXCLUDE.has(character))) {
    return undefined;
  }

  const attached = body.slice(excludeIndex + 1);
  return {
    optionPrefix: prefix.length === 0 ? undefined : `-${prefix}`,
    attachedPattern: attached.length === 0 ? undefined : attached,
  };
}

function isZipOptionBoundary({ token }: { token: string }): boolean {
  return token === '--' || (token.startsWith('-') && token !== '-');
}

function splitZipArgs({ args }: { args: string[] }): SplitZipArgsResult {
  const mainArgs: string[] = [];
  const excludePatterns: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      break;
    }
    if (optionsEnded) {
      mainArgs.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      mainArgs.push(token);
      continue;
    }

    const excludeStarter = splitZipExcludeStarter({ token });
    if (excludeStarter === undefined) {
      mainArgs.push(token);
      continue;
    }
    if (excludeStarter.optionPrefix !== undefined) {
      mainArgs.push(excludeStarter.optionPrefix);
    }

    if (excludeStarter.attachedPattern !== undefined) {
      excludePatterns.push(excludeStarter.attachedPattern);
    } else {
      const firstPattern = args[index + 1];
      if (firstPattern === undefined) {
        return { ok: false, reason: 'missing_exclude_pattern' };
      }
      excludePatterns.push(firstPattern);
      index += 1;
    }

    while (index + 1 < args.length) {
      const nextToken = args[index + 1];
      if (nextToken === undefined || isZipOptionBoundary({ token: nextToken })) {
        break;
      }
      excludePatterns.push(nextToken);
      index += 1;
    }
  }

  return { ok: true, mainArgs, excludePatterns };
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
  sourceOperand,
  archiveOperand,
  currentPath,
  junkPaths,
}: {
  sourceOperand: string,
  archiveOperand: string,
  currentPath: string,
  junkPaths: boolean,
}): string {
  if (junkPaths) {
    return basename({ path: currentPath });
  }
  if (sourceOperand === '-') {
    return '-';
  }
  if (currentPath === sourceOperand) {
    return sanitizeArchiveRootName({ path: archiveOperand });
  }
  const normalizedSourceOperand = sourceOperand.endsWith('/')
    ? sourceOperand.slice(0, -1)
    : sourceOperand;
  const prefix = `${normalizedSourceOperand}/`;
  const relativePart = currentPath.startsWith(prefix)
    ? currentPath.slice(prefix.length)
    : basename({ path: currentPath });
  const rootName = sanitizeArchiveRootName({ path: archiveOperand });
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
  directory,
  archiveDirectoryPath,
  junkPaths,
  ancestorDirectoryPaths,
}: {
  context: WeshCommandContext,
  directory: WeshEntryRef<'directory'>,
  archiveDirectoryPath: string,
  junkPaths: boolean,
  ancestorDirectoryPaths: ReadonlySet<string>,
}): AsyncIterable<PendingZipEntry> {
  type DirectoryFrame = {
    readonly iterator: AsyncIterator<WeshEntryRef>,
    readonly archiveDirectoryPath: string,
    readonly directoryPath: string,
  };
  const activeDirectoryPaths = new Set(ancestorDirectoryPaths);
  const frames: DirectoryFrame[] = [{
    iterator: context.files.readDirEntry({ entry: directory })[Symbol.asyncIterator](),
    archiveDirectoryPath,
    directoryPath: directory.fullPath,
  }];
  try {
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const next = await frame.iterator.next();
      if (next.done === true) {
        await frame.iterator.return?.();
        activeDirectoryPaths.delete(frame.directoryPath);
        frames.pop();
        continue;
      }
      const child = next.value;
      const archivePath = junkPaths ? child.name : `${frame.archiveDirectoryPath}${child.name}`;
      const followedChild = await (async (): Promise<WeshEntryRef> => {
        switch (child.type) {
        case 'symlink':
          try {
            return await context.files.resolveEntry({ path: child.fullPath, finalSymlinkTreatment: 'follow' });
          } catch {
            return child;
          }
        case 'directory':
        case 'file':
        case 'fifo':
        case 'chardev':
          return child;
        default: {
          const _exhaustiveCheck: never = child;
          throw new Error(`Unhandled entry type: ${String(((_exhaustiveCheck satisfies never) as { readonly type: string }).type)}`);
        }
        }
      })();
      switch (followedChild.type) {
      case 'directory':
        if (!junkPaths) {
          yield { sourcePath: child.fullPath, archivePath: `${archivePath}/`, type: 'directory', entryRef: followedChild };
        }
        if (activeDirectoryPaths.has(followedChild.fullPath)) {
          await frame.iterator.return?.();
          activeDirectoryPaths.delete(frame.directoryPath);
          frames.pop();
          break;
        }
        activeDirectoryPaths.add(followedChild.fullPath);
        frames.push({
          iterator: context.files.readDirEntry({ entry: asDirectoryEntry({ entry: followedChild }) })[Symbol.asyncIterator](),
          archiveDirectoryPath: junkPaths ? '' : `${archivePath}/`,
          directoryPath: followedChild.fullPath,
        });
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        yield { sourcePath: child.fullPath, archivePath, type: followedChild.type, entryRef: followedChild };
        break;
      default: {
        const _exhaustiveCheck: never = followedChild;
        throw new Error(`Unhandled entry type: ${String(_exhaustiveCheck)}`);
      }
      }
    }
  } finally {
    for (const frame of frames) await frame.iterator.return?.();
  }
}

async function* iterateZipEntriesForOperand({
  context,
  sourceOperand,
  archiveOperand,
  recursive,
  junkPaths,
}: {
  context: WeshCommandContext,
  sourceOperand: string,
  archiveOperand: string,
  recursive: boolean,
  junkPaths: boolean,
}): AsyncIterable<PendingZipEntry> {
  if (sourceOperand === '-') {
    yield {
      sourcePath: '-',
      archivePath: '-',
      type: 'file',
      entryRef: undefined,
    };
    return;
  }

  const entry = await context.files.resolveEntry({
    path: sourceOperand,
    finalSymlinkTreatment: 'follow',
  });
  const archivePath = buildArchivePath({
    sourceOperand,
    archiveOperand,
    currentPath: sourceOperand,
    junkPaths,
  });
  switch (entry.type) {
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    yield {
      sourcePath: sourceOperand,
      archivePath,
      type: entry.type,
      entryRef: entry,
    };
    return;
  case 'directory':
    if (!junkPaths && archivePath !== '') {
      yield {
        sourcePath: sourceOperand,
        archivePath: `${archivePath}/`,
        type: 'directory',
        entryRef: entry,
      };
    }
    if (recursive) {
      yield* iterateDirectoryEntries({
        context,
        directory: asDirectoryEntry({ entry }),
        archiveDirectoryPath: junkPaths || archivePath === '' ? '' : `${archivePath}/`,
        junkPaths,
        ancestorDirectoryPaths: new Set([entry.fullPath]),
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

interface ZipArchiveStorage {
  readonly exists: boolean,
  readonly path: string,
}

async function resolveZipArchiveStorage({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<ZipArchiveStorage> {
  let archiveEntry: WeshEntryRef;
  try {
    archiveEntry = await context.files.resolveEntry({
      path,
      finalSymlinkTreatment: 'no-follow',
    });
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) {
      return { exists: false, path };
    }
    throw error;
  }

  switch (archiveEntry.type) {
  case 'symlink':
    try {
      return {
        exists: true,
        path: (await context.files.resolveEntry({
          path,
          finalSymlinkTreatment: 'follow',
        })).fullPath,
      };
    } catch (error: unknown) {
      if (isPathNotFoundError({ error })) {
        return { exists: false, path: archiveEntry.fullPath };
      }
      throw error;
    }
  case 'file':
  case 'directory':
  case 'fifo':
  case 'chardev':
    return { exists: true, path: archiveEntry.fullPath };
  default: {
    const _ex: never = archiveEntry;
    throw new Error(`Unhandled archive entry type: ${String(((_ex satisfies never) as { readonly type: string }).type)}`);
  }
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

async function getEntryModifiedAt({
  context,
  entry,
}: {
  context: WeshCommandContext,
  entry: PendingZipEntry,
}): Promise<Date> {
  if (entry.entryRef === undefined) {
    return new Date();
  }
  const stat = await context.files.statEntry({ entry: entry.entryRef });
  return new Date(stat.mtime);
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

async function writeZipDiagnostic({
  context,
  text,
  toStderr,
}: {
  context: WeshCommandContext,
  text: string,
  toStderr: boolean,
}): Promise<void> {
  const io = context.text();
  if (toStderr) {
    await io.error({ text });
    return;
  }
  await io.print({ text });
}

async function addPendingEntry({
  context,
  writer,
  entry,
  compression,
  quiet,
  diagnosticsToStderr,
}: {
  context: WeshCommandContext,
  writer: StreamingZipWriter,
  entry: PendingZipEntry,
  compression: ZipCompression,
  quiet: boolean,
  diagnosticsToStderr: boolean,
}): Promise<boolean> {
  switch (entry.type) {
  case 'directory':
    await writer.addDirectory({
      name: entry.archivePath,
      modifiedAt: await getEntryModifiedAt({ context, entry }),
    });
    return false;
  case 'file':
    await writer.addFile({
      name: entry.archivePath,
      modifiedAt: await getEntryModifiedAt({ context, entry }),
      compression,
      stream: await openEntryStream({ context, entry }),
    });
    return false;
  case 'fifo':
  case 'chardev':
  case 'symlink':
    if (!quiet) {
      await writeZipDiagnostic({
        context,
        text: `zip warning: unsupported file type for ${entry.sourcePath}\n`,
        toStderr: diagnosticsToStderr,
      });
    }
    return true;
  default: {
    const _exhaustiveCheck: never = entry.type;
    throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function addExistingEntry({
  writer,
  reader,
  entry,
}: {
  writer: StreamingZipWriter,
  reader: StreamingZipReader,
  entry: ZipArchiveEntry,
}): Promise<void> {
  if (entry.isDirectory) {
    await writer.addDirectory({
      name: entry.name,
      modifiedAt: entry.modifiedAt,
      encodedName: entry.nameBytes,
      nameIsUtf8: entry.nameIsUtf8,
      externalAttributes: entry.externalAttributes,
    });
    return;
  }
  await writer.addFile({
    name: entry.name,
    modifiedAt: entry.modifiedAt,
    compression: entry.compression,
    stream: await reader.openEntry({ entry }),
    encodedName: entry.nameBytes,
    nameIsUtf8: entry.nameIsUtf8,
    externalAttributes: entry.externalAttributes,
  });
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

export const zipCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const splitArgs = splitZipArgs({ args: context.args });
    if (!splitArgs.ok) {
      await context.text().print({
        text: "\nzip error: Invalid command arguments (option 'x' (exclude files matching patterns) requires a value)\n",
      });
      return { exitCode: 16 };
    }
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: splitArgs.mainArgs,
        spec: zipArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: zipArgvSpec,
    });
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
    const writeArchiveToStdout = archiveOperand === '-';
    if (archiveOperand === undefined || parsed.positionals.length < 2) {
      await context.text().print({
        text: `\nzip error: Nothing to do! (${archiveOperand ?? 'zip'})\n`,
      });
      return { exitCode: 12 };
    }

    const archivePath = writeArchiveToStdout
      ? '-'
      : resolvePath({
        cwd: context.cwd,
        path: addDefaultZipExtension({ path: archiveOperand }),
      });
    const archiveStorage = writeArchiveToStdout
      ? undefined
      : await resolveZipArchiveStorage({ context, path: archivePath });
    const archiveStoragePath = archiveStorage?.path ?? archivePath;
    const archiveTemporaryPath = writeArchiveToStdout
      ? undefined
      : createSiblingTemporaryPath({ path: archiveStoragePath });
    const archiveRecoveryPath = archiveTemporaryPath === undefined
      ? undefined
      : `${archiveTemporaryPath}.original`;
    const archiveAlreadyExists = archiveStorage?.exists === true;
    const temporaryDirectory = await resolveInternalTemporaryDirectory({ context });
    const centralDirectoryPath = `${temporaryDirectory}/wesh-zip-central-${createTemporarySuffix()}`;
    const excludeMatchers = splitArgs.excludePatterns.map(pattern => globToRegExp({ pattern }));
    const inputOperands: ZipInputOperand[] = parsed.positionals.slice(1).map(displayPath => ({
      path: displayPath === '-' ? '-' : resolvePath({ cwd: context.cwd, path: displayPath }),
      displayPath,
    }));
    const recursive = parsed.optionValues.recursive === true;
    const junkPaths = parsed.optionValues.junkPaths === true;
    const quiet = parsed.optionValues.quiet === true;
    const compression: ZipCompression = parsed.optionValues.compressionMode === 'store'
      ? 'store'
      : 'deflate';

    let outputHandle: WeshFileHandle | undefined;
    let centralDirectoryHandle: WeshFileHandle | undefined;
    let centralDirectoryStore: ZipCentralDirectoryStore | undefined;
    let matchedInput = false;
    let hadError = false;
    let archiveInstalled = false;
    const inputEntryKeyByArchivePath = new Map<string, string>();
    const internalSourcePaths = new Set([
      archivePath,
      archiveStoragePath,
      archiveTemporaryPath,
      archiveRecoveryPath,
      centralDirectoryPath,
    ].filter((path): path is string => path !== undefined && path !== '-'));
    const pendingUpdateEntries: PendingZipEntry[] | undefined = archiveAlreadyExists
      ? []
      : undefined;
    // Stdout archives cannot be replaced atomically. Preflight their entry names
    // before emitting bytes so a late collision never leaks a partial ZIP stream.
    const pendingNewEntries: PendingZipEntry[] | undefined = !archiveAlreadyExists
      && (junkPaths || writeArchiveToStdout)
      ? []
      : undefined;

    try {
      const archiveOutputHandle = writeArchiveToStdout
        ? context.stdout
        : await context.files.open({
          path: archiveTemporaryPath ?? '/',
          flags: createWriteFlags(),
        });
      if (!writeArchiveToStdout) {
        outputHandle = archiveOutputHandle;
      }
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
        output: createWeshZipByteSink({ handle: archiveOutputHandle }),
        centralDirectoryStore,
        compressionCodec: createWebZipCompressionCodec(),
      });

      for (const operand of inputOperands) {
        try {
          for await (const entry of iterateZipEntriesForOperand({
            context,
            sourceOperand: operand.path,
            archiveOperand: operand.displayPath,
            recursive,
            junkPaths,
          })) {
            if (
              excludeMatchers.some(matcher => matcher.test(entry.archivePath))
              || internalSourcePaths.has(entry.sourcePath)
              || (entry.entryRef !== undefined && internalSourcePaths.has(entry.entryRef.fullPath))
            ) {
              continue;
            }
            const inputEntryKey = `${entry.sourcePath}\0${entry.type}`;
            const existingInputEntryKey = inputEntryKeyByArchivePath.get(entry.archivePath);
            if (existingInputEntryKey === inputEntryKey) {
              continue;
            }
            if (existingInputEntryKey !== undefined) {
              await writeZipDiagnostic({
                context,
                text: '\nzip error: Invalid command arguments (cannot repeat names in zip file)\n',
                toStderr: writeArchiveToStdout,
              });
              return { exitCode: 16 };
            }
            inputEntryKeyByArchivePath.set(entry.archivePath, inputEntryKey);
            matchedInput = true;
            if (pendingUpdateEntries !== undefined) {
              switch (entry.type) {
              case 'directory':
              case 'file':
                pendingUpdateEntries.push(entry);
                break;
              case 'fifo':
              case 'chardev':
              case 'symlink':
                hadError = await addPendingEntry({
                  context,
                  writer,
                  entry,
                  compression,
                  quiet,
                  diagnosticsToStderr: writeArchiveToStdout,
                }) || hadError;
                break;
              default: {
                const _exhaustiveCheck: never = entry.type;
                throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
              }
              }
            } else if (pendingNewEntries !== undefined) {
              pendingNewEntries.push(entry);
            } else {
              hadError = await addPendingEntry({
                context,
                writer,
                entry,
                compression,
                quiet,
                diagnosticsToStderr: writeArchiveToStdout,
              }) || hadError;
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('NotFoundError')) {
            if (!quiet) {
              await writeZipDiagnostic({
                context,
                text: `\tzip warning: name not matched: ${operand.displayPath}\n`,
                toStderr: writeArchiveToStdout,
              });
            }
          } else {
            await writeZipDiagnostic({
              context,
              text: `zip error: ${message}\n`,
              toStderr: writeArchiveToStdout,
            });
            hadError = true;
          }
        }
      }

      if (!matchedInput) {
        await writeZipDiagnostic({
          context,
          text: `\nzip error: Nothing to do! (${archiveOperand})\n`,
          toStderr: writeArchiveToStdout,
        });
        return { exitCode: 12 };
      }

      if (pendingNewEntries !== undefined) {
        for (const entry of pendingNewEntries) {
          hadError = await addPendingEntry({
            context,
            writer,
            entry,
            compression,
            quiet,
            diagnosticsToStderr: writeArchiveToStdout,
          }) || hadError;
        }
      }

      if (pendingUpdateEntries !== undefined) {
        const replacementByName = new Map<string, PendingZipEntry>();
        const replacementOrder: string[] = [];
        for (const entry of pendingUpdateEntries) {
          if (!replacementByName.has(entry.archivePath)) {
            replacementOrder.push(entry.archivePath);
          }
          replacementByName.set(entry.archivePath, entry);
        }
        const archiveHandle = await context.files.open({
          path: archiveStoragePath,
          flags: {
            access: 'read',
            creation: 'never',
            truncate: 'preserve',
            append: 'preserve',
          },
        });
        const reader = new StreamingZipReader({
          source: await createWeshZipRandomAccessSource({ handle: archiveHandle }),
          compressionCodec: createWebZipCompressionCodec(),
          decodeEntryName: decodeWeshZipEntryName,
        });
        try {
          for await (const existingEntry of reader.entries()) {
            const replacement = replacementByName.get(existingEntry.name);
            if (replacement === undefined) {
              await addExistingEntry({ writer, reader, entry: existingEntry });
              continue;
            }
            hadError = await addPendingEntry({
              context,
              writer,
              entry: replacement,
              compression,
              quiet,
              diagnosticsToStderr: writeArchiveToStdout,
            }) || hadError;
            replacementByName.delete(existingEntry.name);
          }
          for (const name of replacementOrder) {
            const entry = replacementByName.get(name);
            if (entry === undefined) {
              continue;
            }
            hadError = await addPendingEntry({
              context,
              writer,
              entry,
              compression,
              quiet,
              diagnosticsToStderr: writeArchiveToStdout,
            }) || hadError;
          }
        } finally {
          await reader.close();
        }
      }

      await writer.finalize();
      await centralDirectoryStore.dispose();
      centralDirectoryStore = undefined;
      if (outputHandle !== undefined) {
        await outputHandle.close();
        outputHandle = undefined;
      }
      centralDirectoryHandle = undefined;

      if (writeArchiveToStdout) {
        archiveInstalled = true;
        return { exitCode: hadError ? 1 : 0 };
      }
      if (archiveTemporaryPath === undefined || archiveRecoveryPath === undefined) {
        throw new Error('zip: missing archive replacement paths');
      }

      let originalMoved = false;
      if (await pathExists({ context, path: archiveStoragePath })) {
        await context.files.rename({
          oldPath: archiveStoragePath,
          newPath: archiveRecoveryPath,
        });
        originalMoved = true;
      }
      try {
        await context.files.rename({
          oldPath: archiveTemporaryPath,
          newPath: archiveStoragePath,
        });
        archiveInstalled = true;
      } catch (replaceError: unknown) {
        if (originalMoved) {
          try {
            await context.files.rename({
              oldPath: archiveRecoveryPath,
              newPath: archiveStoragePath,
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
      if (!archiveInstalled && archiveTemporaryPath !== undefined) {
        await removePathIfPresent({ context, path: archiveTemporaryPath });
      }
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  splitZipArgs,
  splitZipExcludeStarter,
};
