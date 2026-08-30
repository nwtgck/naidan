import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolveInternalTemporaryDirectory } from '@/features/wesh/commands/_shared/temporary-directory';
import {
  createBlobZipSource,
  createWebZipCompressionCodec,
  StreamingZipReader,
  type ZipArchiveEntry,
} from '@/utils/zip-stream';
import { createWeshZipRandomAccessSource } from '@/features/wesh/zip-stream';
import { decodeWeshZipEntryName } from '@/features/wesh/commands/_shared/zip-entry-name';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
} from '@/features/wesh/types';
import {
  openHandleReadStream,
  writeAllStreamToFile,
  writeAllStreamToHandle,
} from '@/features/wesh/utils/fs';
import {
  createBufferedCommandDataWriter,
  decodeCommandDataBytes,
} from '@/features/wesh/commands/_shared/data-codec';

const unzipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'l', long: undefined, effects: [{ key: 'list', value: true }], help: { summary: 'list archive files', category: 'common' } },
    { kind: 'flag', short: 't', long: undefined, effects: [{ key: 'test', value: true }], help: { summary: 'test compressed archive data', category: 'common' } },
    { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'pipeToStdout', value: true }], help: { summary: 'extract files to stdout', category: 'common' } },
    { kind: 'flag', short: 'j', long: undefined, effects: [{ key: 'junkPaths', value: true }], help: { summary: 'junk paths', category: 'common' } },
    { kind: 'flag', short: 'n', long: undefined, effects: [{ key: 'neverOverwrite', value: true }], help: { summary: 'never overwrite existing files', category: 'common' } },
    { kind: 'flag', short: 'o', long: undefined, effects: [{ key: 'overwrite', value: true }], help: { summary: 'overwrite files without prompting', category: 'common' } },
    { kind: 'flag', short: 'q', long: 'quiet', effects: [{ key: 'quiet', value: true }], help: { summary: 'perform operations quietly', category: 'common' } },
    {
      kind: 'value',
      short: 'd',
      long: undefined,
      key: 'destination',
      valueName: 'DIR',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'extract into exdir', valueName: 'DIR', category: 'common' },
    },
    {
      kind: 'value',
      short: 'x',
      long: undefined,
      key: 'excludePattern',
      valueName: 'PATTERN',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'exclude files that match a pattern', valueName: 'PATTERN', category: 'common' },
    },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

interface SplitUnzipArgsResult {
  readonly mainArgs: string[],
  readonly excludePatterns: string[],
  readonly missingDestinationValue: boolean,
}

interface OpenedZipArchive {
  readonly reader: StreamingZipReader,
  readonly usedImplicitSuffix?: boolean,
  close(): Promise<void>,
}

class UnzipParentPathConflictError extends Error {
}

class UnzipReplacementConflictError extends Error {
}

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
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

function padLeft({ text, width }: { text: string, width: number }): string {
  return text.padStart(width, ' ');
}

const MAX_ZIP_SYMBOLIC_LINK_TARGET_BYTES = 64 * 1024;

const utf8Encoder = new TextEncoder();

function padEntryName({ name, width }: { name: string, width: number }): string {
  const byteLength = utf8Encoder.encode(name).byteLength;
  return `${name}${' '.repeat(Math.max(0, width - byteLength))}`;
}

function formatListDate({ date }: { date: Date }): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
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

interface UnzipPreArchiveOptionState {
  readonly archiveIndex: number | undefined,
  readonly destinationSelectionCount: number,
  readonly quietCount: number,
  readonly ignoredSingleDashIndices: readonly number[],
}

function analyzeOptionsBeforeArchive({ args }: { args: readonly string[] }): UnzipPreArchiveOptionState {
  let destinationSelectionCount = 0;
  let quietCount = 0;
  const ignoredSingleDashIndices: number[] = [];
  let sawOptionToken = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;

    if (token === '--') {
      return {
        archiveIndex: index + 1 < args.length ? index + 1 : undefined,
        destinationSelectionCount,
        quietCount,
        ignoredSingleDashIndices,
      };
    }
    if (token === '-') {
      if (sawOptionToken) {
        return {
          archiveIndex: index,
          destinationSelectionCount,
          quietCount,
          ignoredSingleDashIndices,
        };
      }
      ignoredSingleDashIndices.push(index);
      continue;
    }
    if (!token.startsWith('-')) {
      return {
        archiveIndex: index,
        destinationSelectionCount,
        quietCount,
        ignoredSingleDashIndices,
      };
    }

    sawOptionToken = true;
    const shortBody = token.slice(1);
    for (let shortIndex = 0; shortIndex < shortBody.length; shortIndex += 1) {
      const short = shortBody[shortIndex];
      if (short === 'q') {
        quietCount += 1;
        continue;
      }
      if (short !== 'd') continue;

      destinationSelectionCount += 1;
      const attachedValue = shortBody.slice(shortIndex + 1);
      if (attachedValue === '') {
        index += 1;
      }
      break;
    }
  }

  return {
    archiveIndex: undefined,
    destinationSelectionCount,
    quietCount,
    ignoredSingleDashIndices,
  };
}

interface PostArchiveDestinationOption {
  readonly token: string,
  readonly consumesFollowingValue: boolean,
}

function parsePostArchiveDestinationOption({ token }: { token: string }): PostArchiveDestinationOption | undefined {
  if (token === '-d') {
    return { token, consumesFollowingValue: true };
  }
  if (token.startsWith('-d') && token.length > 2) {
    return { token, consumesFollowingValue: false };
  }
  return undefined;
}

function splitUnzipArgs({
  args,
  preArchiveOptions,
}: {
  args: readonly string[],
  preArchiveOptions: UnzipPreArchiveOptionState,
}): SplitUnzipArgsResult {
  const archiveIndex = preArchiveOptions.archiveIndex;
  if (archiveIndex === undefined) {
    return {
      mainArgs: [...args],
      excludePatterns: [],
      missingDestinationValue: false,
    };
  }

  const archiveOperand = args[archiveIndex];
  if (archiveOperand === undefined) {
    return {
      mainArgs: [...args],
      excludePatterns: [],
      missingDestinationValue: false,
    };
  }

  const ignoredSingleDashIndices = new Set(preArchiveOptions.ignoredSingleDashIndices);
  const preArchiveArgs = args
    .slice(0, archiveIndex)
    .filter((_token, index) => !ignoredSingleDashIndices.has(index));
  if (preArchiveArgs.at(-1) === '--') {
    preArchiveArgs.pop();
  }

  const postArchiveDestinationArgs: string[] = [];
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];
  let collectingExcludes = false;
  let destinationSelected = preArchiveOptions.destinationSelectionCount > 0;
  let missingDestinationValue = false;

  for (let index = archiveIndex + 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;

    if (!destinationSelected) {
      const destinationOption = parsePostArchiveDestinationOption({ token });
      if (destinationOption !== undefined) {
        destinationSelected = true;
        if (destinationOption.consumesFollowingValue) {
          const value = args[index + 1];
          if (value === undefined) {
            missingDestinationValue = true;
          } else {
            postArchiveDestinationArgs.push(destinationOption.token, value);
            index += 1;
          }
        } else {
          postArchiveDestinationArgs.push(destinationOption.token);
        }
        continue;
      }
    }

    if (token === '-x') {
      collectingExcludes = true;
      continue;
    }

    if (collectingExcludes) {
      excludePatterns.push(token);
    } else {
      includePatterns.push(token);
    }
  }

  const mainArgs = [
    ...preArchiveArgs,
    ...postArchiveDestinationArgs,
    '--',
    archiveOperand,
    ...includePatterns,
  ];

  return { mainArgs, excludePatterns, missingDestinationValue };
}

function isNotFoundError({ message }: { message: string }): boolean {
  return message.includes('NotFoundError') || message.includes('ENOENT');
}

function createTemporarySuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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

async function openPathZipArchive({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<OpenedZipArchive> {
  const blobResult = await context.files.tryReadBlobEfficiently({ path });
  switch (blobResult.kind) {
  case 'blob': {
    const reader = new StreamingZipReader({
      source: createBlobZipSource({ blob: blobResult.blob }),
      compressionCodec: createWebZipCompressionCodec(),
      decodeEntryName: decodeWeshZipEntryName,
    });
    return {
      reader,
      close: () => reader.close(),
    };
  }
  case 'fallback_required': {
    const handle = await context.files.open({
      path,
      flags: {
        access: 'read',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    const source = await createWeshZipRandomAccessSource({ handle });
    const reader = new StreamingZipReader({
      source,
      compressionCodec: createWebZipCompressionCodec(),
      decodeEntryName: decodeWeshZipEntryName,
    });
    return {
      reader,
      close: () => reader.close(),
    };
  }
  default: {
    const _exhaustiveCheck: never = blobResult;
    throw new Error(`Unhandled blob result: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
}

async function openZipArchive({
  context,
  archivePath,
}: {
  context: WeshCommandContext,
  archivePath: string,
}): Promise<OpenedZipArchive> {
  if (archivePath !== '-') {
    return openPathZipArchive({ context, path: archivePath });
  }

  const temporaryDirectory = await resolveInternalTemporaryDirectory({ context });
  const temporaryPath = `${temporaryDirectory}/wesh-unzip-stdin-${createTemporarySuffix()}.zip`;
  try {
    const temporaryHandle = await context.files.open({
      path: temporaryPath,
      flags: {
        access: 'write',
        creation: 'always',
        truncate: 'truncate',
        append: 'preserve',
      },
    });
    await writeAllStreamToHandle({
      stream: openHandleReadStream({ handle: context.stdin }),
      handle: temporaryHandle,
      closeHandle: true,
    });
    const archive = await openPathZipArchive({ context, path: temporaryPath });
    return {
      reader: archive.reader,
      async close() {
        try {
          await archive.close();
        } finally {
          await removePathIfPresent({ context, path: temporaryPath });
        }
      },
    };
  } catch (error: unknown) {
    await removePathIfPresent({ context, path: temporaryPath });
    throw error;
  }
}

async function openZipArchiveWithImplicitSuffix({
  context,
  archivePath,
}: {
  context: WeshCommandContext,
  archivePath: string,
}): Promise<OpenedZipArchive> {
  try {
    return await openZipArchive({ context, archivePath });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      archivePath === '-'
      || archivePath.toLowerCase().endsWith('.zip')
      || !isNotFoundError({ message })
    ) {
      throw error;
    }
    const archive = await openZipArchive({ context, archivePath: `${archivePath}.zip` });
    return { ...archive, usedImplicitSuffix: true };
  }
}

function entryMatches({
  entry,
  includeMatchers,
  excludeMatchers,
  matchedIncludeIndexes,
  matchedExcludeIndexes,
}: {
  entry: ZipArchiveEntry,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
  matchedIncludeIndexes: Set<number>,
  matchedExcludeIndexes: Set<number>,
}): boolean {
  if (includeMatchers.length > 0) {
    let included = false;
    for (const [index, matcher] of includeMatchers.entries()) {
      if (!matcher.test(entry.name)) {
        continue;
      }
      matchedIncludeIndexes.add(index);
      included = true;
    }
    if (!included) {
      return false;
    }
  }

  let excluded = false;
  for (const [index, matcher] of excludeMatchers.entries()) {
    if (!matcher.test(entry.name)) {
      continue;
    }
    matchedExcludeIndexes.add(index);
    excluded = true;
  }
  return !excluded;
}

function hasUnmatchedPatterns({
  patterns,
  matchedIndexes,
}: {
  patterns: readonly string[],
  matchedIndexes: ReadonlySet<number>,
}): boolean {
  return patterns.some((_pattern, index) => !matchedIndexes.has(index));
}

async function reportUnmatchedIncludes({
  context,
  includePatterns,
  matchedIncludeIndexes,
}: {
  context: WeshCommandContext,
  includePatterns: readonly string[],
  matchedIncludeIndexes: ReadonlySet<number>,
}): Promise<boolean> {
  let hadUnmatchedPattern = false;
  for (const [index, pattern] of includePatterns.entries()) {
    if (matchedIncludeIndexes.has(index)) {
      continue;
    }
    hadUnmatchedPattern = true;
    await context.text().error({ text: `caution: filename not matched:  ${pattern}\n` });
  }
  return hadUnmatchedPattern;
}

async function reportUnmatchedExcludes({
  context,
  excludePatterns,
  matchedExcludeIndexes,
}: {
  context: WeshCommandContext,
  excludePatterns: readonly string[],
  matchedExcludeIndexes: ReadonlySet<number>,
}): Promise<void> {
  for (const [index, pattern] of excludePatterns.entries()) {
    if (matchedExcludeIndexes.has(index)) {
      continue;
    }
    await context.text().error({
      text: `caution: excluded filename not matched:  ${pattern}\n`,
    });
  }
}

function sanitizeArchivePath({ path }: { path: string }): string {
  if (path.includes('\0')) {
    throw new Error('unsafe null byte in ZIP entry name');
  }
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/')) {
    throw new Error(`unsafe absolute path in ZIP entry: ${path}`);
  }
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new Error(`unsafe parent path in ZIP entry: ${path}`);
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function appendPathSegment({ path, segment }: { path: string, segment: string }): string {
  return path === '/' ? `/${segment}` : `${path}/${segment}`;
}

async function ensureAbsoluteDirectoryPath({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<void> {
  let currentPath = '/';
  for (const segment of path.split('/').filter(Boolean)) {
    currentPath = appendPathSegment({ path: currentPath, segment });
    const existingType = await getPathType({ context, path: currentPath });
    switch (existingType) {
    case undefined:
      await context.files.mkdir({ path: currentPath, recursive: false });
      break;
    case 'directory':
      break;
    case 'file':
    case 'symlink':
    case 'fifo':
    case 'chardev':
      throw new UnzipParentPathConflictError(`${currentPath} exists but is not a directory`);
    default: {
      const _exhaustiveCheck: never = existingType;
      throw new Error(`Unhandled path type: ${String(_exhaustiveCheck)}`);
    }
    }
  }
}

async function ensureArchiveDirectoryPath({
  context,
  destinationRoot,
  relativeDirectoryPath,
}: {
  context: WeshCommandContext,
  destinationRoot: string,
  relativeDirectoryPath: string,
}): Promise<void> {
  await ensureAbsoluteDirectoryPath({ context, path: destinationRoot });
  let currentPath = destinationRoot;
  for (const segment of relativeDirectoryPath.split('/').filter(Boolean)) {
    currentPath = appendPathSegment({ path: currentPath, segment });
    const existingType = await getPathType({ context, path: currentPath });
    switch (existingType) {
    case undefined:
      await context.files.mkdir({ path: currentPath, recursive: false });
      break;
    case 'directory':
      break;
    case 'file':
    case 'symlink':
    case 'fifo':
    case 'chardev':
      throw new UnzipParentPathConflictError(`${currentPath} exists but is not a directory`);
    default: {
      const _exhaustiveCheck: never = existingType;
      throw new Error(`Unhandled path type: ${String(_exhaustiveCheck)}`);
    }
    }
  }
}

async function ensureArchiveEntryParent({
  context,
  destinationRoot,
  relativePath,
}: {
  context: WeshCommandContext,
  destinationRoot: string,
  relativePath: string,
}): Promise<void> {
  const slashIndex = relativePath.lastIndexOf('/');
  const relativeParent = slashIndex < 0 ? '' : relativePath.slice(0, slashIndex);
  await ensureArchiveDirectoryPath({
    context,
    destinationRoot,
    relativeDirectoryPath: relativeParent,
  });
}

async function getPathType({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<'directory' | 'file' | 'symlink' | 'fifo' | 'chardev' | undefined> {
  try {
    return (await context.files.lstat({ path })).type;
  } catch {
    return undefined;
  }
}

async function readEntryBytes({
  reader,
  entry,
}: {
  reader: StreamingZipReader,
  entry: ZipArchiveEntry,
}): Promise<Uint8Array> {
  if (entry.uncompressedSize > MAX_ZIP_SYMBOLIC_LINK_TARGET_BYTES) {
    throw new Error(`ZIP symbolic-link target is too large: ${entry.name}`);
  }
  const output = new Uint8Array(entry.uncompressedSize);
  let offset = 0;
  const streamReader = (await reader.openEntry({ entry })).getReader();
  try {
    while (true) {
      const result = await streamReader.read();
      if (result.done) {
        break;
      }
      if (result.value.byteLength > output.byteLength - offset) {
        throw new Error(`ZIP symbolic-link target exceeds declared size: ${entry.name}`);
      }
      output.set(result.value, offset);
      offset += result.value.byteLength;
    }
  } finally {
    streamReader.releaseLock();
  }
  if (offset !== output.byteLength) {
    throw new Error(`ZIP symbolic-link target size mismatch: ${entry.name}`);
  }
  return output;
}

async function writeSymbolicLinkEntry({
  context,
  reader,
  entry,
  destinationPath,
}: {
  context: WeshCommandContext,
  reader: StreamingZipReader,
  entry: ZipArchiveEntry,
  destinationPath: string,
}): Promise<void> {
  const targetBytes = await readEntryBytes({ reader, entry });
  const nullByteIndex = targetBytes.indexOf(0);
  const effectiveTargetBytes = nullByteIndex < 0
    ? targetBytes
    : targetBytes.subarray(0, nullByteIndex);
  if (effectiveTargetBytes.byteLength === 0) {
    throw new Error(`ZIP symbolic-link target is empty: ${entry.name}`);
  }
  const targetPath = decodeCommandDataBytes({ bytes: effectiveTargetBytes });
  await context.files.symlink({
    path: destinationPath,
    targetPath,
    mode: entry.unixMode === undefined ? undefined : entry.unixMode & 0o777,
  });
}

async function writeEntryToFile({
  context,
  reader,
  entry,
  destinationPath,
}: {
  context: WeshCommandContext,
  reader: StreamingZipReader,
  entry: ZipArchiveEntry,
  destinationPath: string,
}): Promise<void> {
  await writeAllStreamToFile({
    files: context.files,
    path: destinationPath,
    stream: await reader.openEntry({ entry }),
    mode: 'truncate',
  });
}

async function listEntries({
  context,
  archiveOperand,
  reader,
  includeMatchers,
  excludeMatchers,
  matchedIncludeIndexes,
  matchedExcludeIndexes,
  quietCount,
}: {
  context: WeshCommandContext,
  archiveOperand: string,
  reader: StreamingZipReader,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
  matchedIncludeIndexes: Set<number>,
  matchedExcludeIndexes: Set<number>,
  quietCount: number,
}): Promise<void> {
  const writer = createBufferedCommandDataWriter({
    handle: context.stdout,
    maxBufferLength: 16 * 1024,
  });
  if (quietCount === 0) {
    await writer.write({ text: `Archive:  ${archiveOperand}\n` });
  }
  if (quietCount < 2) {
    await writer.write({ text: '  Length      Date    Time    Name\n' });
    await writer.write({ text: '---------  ---------- -----   ----\n' });
  }
  let totalLength = 0;
  let entryCount = 0;
  for await (const entry of reader.entries()) {
    if (!entryMatches({
      entry,
      includeMatchers,
      excludeMatchers,
      matchedIncludeIndexes,
      matchedExcludeIndexes,
    })) {
      continue;
    }
    totalLength += entry.isDirectory ? 0 : entry.uncompressedSize;
    entryCount += 1;
    const formattedDate = formatListDate({ date: entry.modifiedAt });
    await writer.write({
      text: `${padLeft({ text: String(entry.isDirectory ? 0 : entry.uncompressedSize), width: 9 })}  ${formattedDate.slice(0, 10)} ${formattedDate.slice(11)}   ${entry.name}\n`,
    });
  }
  if (quietCount < 2) {
    await writer.write({ text: '---------                     -------\n' });
    await writer.write({
      text: `${padLeft({ text: String(totalLength), width: 9 })}                     ${entryCount} ${entryCount === 1 ? 'file' : 'files'}\n`,
    });
  }
  await writer.flush();
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32({ crc, chunk }: { crc: number, chunk: Uint8Array }): number {
  let value = crc;
  for (const byte of chunk) {
    const tableValue = crc32Table[(value ^ byte) & 0xff];
    if (tableValue === undefined) {
      throw new Error('CRC32 table lookup failed');
    }
    value = (value >>> 8) ^ tableValue;
  }
  return value >>> 0;
}

function formatCrc32({ value }: { value: number }): string {
  return value.toString(16).padStart(8, '0');
}

async function testEntries({
  context,
  archiveOperand,
  reader,
  includeMatchers,
  excludeMatchers,
  matchedIncludeIndexes,
  matchedExcludeIndexes,
  quietCount,
  includePatterns,
  excludePatterns,
}: {
  context: WeshCommandContext,
  archiveOperand: string,
  reader: StreamingZipReader,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
  matchedIncludeIndexes: Set<number>,
  matchedExcludeIndexes: Set<number>,
  quietCount: number,
  includePatterns: readonly string[],
  excludePatterns: readonly string[],
}): Promise<{ readonly hadDataError: boolean, readonly hadUnmatchedPattern: boolean }> {
  const writer = createBufferedCommandDataWriter({
    handle: context.stdout,
    maxBufferLength: 16 * 1024,
  });
  if (quietCount === 0) {
    await writer.write({ text: `Archive:  ${archiveOperand}\n` });
  }

  let hadError = false;
  let testedEntryCount = 0;
  for await (const entry of reader.entries()) {
    if (!entryMatches({
      entry,
      includeMatchers,
      excludeMatchers,
      matchedIncludeIndexes,
      matchedExcludeIndexes,
    })) {
      continue;
    }

    testedEntryCount += 1;
    let crc = 0xffffffff;
    let error: unknown;
    if (!entry.isDirectory) {
      try {
        const streamReader = (await reader.openEntry({ entry })).getReader();
        try {
          while (true) {
            const result = await streamReader.read();
            if (result.done) {
              break;
            }
            crc = updateCrc32({ crc, chunk: result.value });
          }
        } finally {
          streamReader.releaseLock();
        }
      } catch (caught: unknown) {
        error = caught;
      }
    }

    if (error === undefined) {
      if (quietCount === 0) {
        await writer.write({
          text: `    testing: ${padEntryName({ name: entry.name, width: 25 })}OK\n`,
        });
      }
      continue;
    }

    hadError = true;
    const message = error instanceof Error ? error.message : String(error);
    if (message === `ZIP entry CRC mismatch: ${entry.name}`) {
      const actualCrc = (crc ^ 0xffffffff) >>> 0;
      const prefix = quietCount === 0 ? '    testing: ' : '';
      const nameWidth = quietCount === 0 ? 25 : 24;
      await writer.write({
        text: `${prefix}${padEntryName({ name: entry.name, width: nameWidth })}bad CRC ${formatCrc32({ value: actualCrc })}  (should be ${formatCrc32({ value: entry.crc32 })})\n`,
      });
    } else {
      const prefix = quietCount === 0 ? '    testing: ' : '';
      const nameWidth = quietCount === 0 ? 25 : 24;
      await writer.write({
        text: `${prefix}${padEntryName({ name: entry.name, width: nameWidth })}error: ${message}\n`,
      });
    }
  }

  let hadUnmatchedPattern = false;
  for (const [index, pattern] of includePatterns.entries()) {
    if (matchedIncludeIndexes.has(index)) {
      continue;
    }
    hadUnmatchedPattern = true;
    await writer.write({ text: `caution: filename not matched:  ${pattern}\n` });
  }
  for (const [index, pattern] of excludePatterns.entries()) {
    if (matchedExcludeIndexes.has(index)) {
      continue;
    }
    await writer.write({
      text: `caution: excluded filename not matched:  ${pattern}\n`,
    });
  }

  if (quietCount < 2) {
    if (hadError || hadUnmatchedPattern) {
      await writer.write({ text: `At least one error was detected in ${archiveOperand}.\n` });
    } else if (includePatterns.length > 0 || excludePatterns.length > 0) {
      await writer.write({
        text: `No errors detected in ${archiveOperand} for the ${testedEntryCount} ${testedEntryCount === 1 ? 'file' : 'files'} tested.\n`,
      });
    } else {
      await writer.write({ text: `No errors detected in compressed data of ${archiveOperand}.\n` });
    }
  }
  await writer.flush();
  return { hadDataError: hadError, hadUnmatchedPattern };
}

async function pipeEntries({
  context,
  reader,
  includeMatchers,
  excludeMatchers,
  matchedIncludeIndexes,
  matchedExcludeIndexes,
}: {
  context: WeshCommandContext,
  reader: StreamingZipReader,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
  matchedIncludeIndexes: Set<number>,
  matchedExcludeIndexes: Set<number>,
}): Promise<void> {
  for await (const entry of reader.entries()) {
    if (!entryMatches({
      entry,
      includeMatchers,
      excludeMatchers,
      matchedIncludeIndexes,
      matchedExcludeIndexes,
    })) {
      continue;
    }
    if (entry.isDirectory) {
      continue;
    }
    await writeAllStreamToHandle({
      stream: await reader.openEntry({ entry }),
      handle: context.stdout,
      closeHandle: false,
    });
  }
}

async function extractEntries({
  context,
  reader,
  includeMatchers,
  excludeMatchers,
  destinationRoot,
  junkPaths,
  neverOverwrite,
  overwrite,
  matchedIncludeIndexes,
  matchedExcludeIndexes,
}: {
  context: WeshCommandContext,
  reader: StreamingZipReader,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
  destinationRoot: string,
  junkPaths: boolean,
  neverOverwrite: boolean,
  overwrite: boolean,
  matchedIncludeIndexes: Set<number>,
  matchedExcludeIndexes: Set<number>,
}): Promise<number> {
  try {
    await ensureAbsoluteDirectoryPath({ context, path: destinationRoot });
  } catch (error: unknown) {
    await context.text().error({ text: `unzip: ${error instanceof Error ? error.message : String(error)}\n` });
    return error instanceof UnzipParentPathConflictError ? 2 : 1;
  }
  let exitCode = 0;
  const extractedSymbolicLinkPaths = new Set<string>();
  for await (const entry of reader.entries()) {
    if (!entryMatches({
      entry,
      includeMatchers,
      excludeMatchers,
      matchedIncludeIndexes,
      matchedExcludeIndexes,
    })) {
      continue;
    }
    try {
      if (junkPaths && entry.isDirectory) {
        continue;
      }
      const safePath = sanitizeArchivePath({ path: entry.name });
      const relativePath = junkPaths ? basename({ path: safePath }) : safePath;
      if (relativePath === '') {
        continue;
      }
      const destinationPath = resolvePath({ cwd: destinationRoot, path: relativePath });
      if (entry.isDirectory) {
        await ensureArchiveDirectoryPath({
          context,
          destinationRoot,
          relativeDirectoryPath: relativePath,
        });
        continue;
      }
      await ensureArchiveEntryParent({ context, destinationRoot, relativePath });
      const existingType = await getPathType({ context, path: destinationPath });
      if (existingType !== undefined) {
        if (neverOverwrite) {
          continue;
        }
        if (!overwrite) {
          await context.text().error({
            text: `unzip: ${destinationPath} already exists; use -o to overwrite or -n to skip\n`,
          });
          exitCode = Math.max(exitCode, 1);
          continue;
        }
        switch (existingType) {
        case 'directory':
          throw new UnzipReplacementConflictError(`cannot replace directory with ZIP entry: ${entry.name}`);
        case 'symlink':
          if (extractedSymbolicLinkPaths.has(destinationPath) && !entry.isSymbolicLink) {
            await context.text().error({
              text: `warning: deferred symlink (${destinationPath}) failed: invalid placeholder file\n`,
            });
          }
          break;
        case 'file':
        case 'fifo':
        case 'chardev':
          break;
        default: {
          const _exhaustiveCheck: never = existingType;
          throw new Error(`Unhandled path type: ${String(_exhaustiveCheck)}`);
        }
        }
        await context.files.unlink({ path: destinationPath });
        extractedSymbolicLinkPaths.delete(destinationPath);
      }
      if (entry.isSymbolicLink && entry.uncompressedSize > 0) {
        await writeSymbolicLinkEntry({ context, reader, entry, destinationPath });
        extractedSymbolicLinkPaths.add(destinationPath);
      } else {
        await writeEntryToFile({ context, reader, entry, destinationPath });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `unzip: ${message}\n` });
      const entryExitCode = error instanceof UnzipReplacementConflictError
        ? 50
        : error instanceof UnzipParentPathConflictError
          ? 2
          : 1;
      exitCode = Math.max(exitCode, entryExitCode);
    }
  }
  return exitCode;
}

export const unzipCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const preArchiveOptions = analyzeOptionsBeforeArchive({
      args: context.args,
    });
    const splitArgs = splitUnzipArgs({
      args: context.args,
      preArchiveOptions,
    });
    const parsed = parseStandardArgv({ args: splitArgs.mainArgs, spec: unzipArgvSpec });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'unzip',
        message: `unzip: ${diagnostic.message}`,
        argvSpec: unzipArgvSpec,
      });
      return { exitCode: 2 };
    }
    const quietCount = parsed.occurrences.reduce((count, occurrence) => {
      switch (occurrence.kind) {
      case 'flag':
      case 'special':
        return count + (occurrence.effects.some(effect =>
          effect.key === 'quiet' && effect.value === true,
        ) ? 1 : 0);
      case 'value':
        return count;
      default: {
        const _ex: never = occurrence;
        throw new Error(`Unhandled unzip option occurrence: ${String(_ex)}`);
      }
      }
    }, 0);

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'unzip', argvSpec: unzipArgvSpec });
      return { exitCode: 0 };
    }

    if (preArchiveOptions.destinationSelectionCount > 1) {
      await context.text().error({ text: 'error:  -d option used more than once (only one exdir allowed)\n' });
      return { exitCode: 10 };
    }
    if (splitArgs.missingDestinationValue) {
      await context.text().error({
        text: 'error:  must specify directory to which to extract with -d option\n',
      });
      return { exitCode: 10 };
    }

    const archiveOperand = parsed.positionals[0];
    if (archiveOperand === undefined) {
      await writeCommandUsageError({
        context,
        command: 'unzip',
        message: 'unzip: missing archive operand',
        argvSpec: unzipArgvSpec,
      });
      return { exitCode: 2 };
    }

    const archivePath = archiveOperand === '-'
      ? '-'
      : resolvePath({ cwd: context.cwd, path: archiveOperand });
    const destinationOption = parsed.optionValues.destination;
    const destinationRoot = typeof destinationOption === 'string'
      ? resolvePath({ cwd: context.cwd, path: destinationOption })
      : context.cwd;
    const includePatterns = parsed.positionals.slice(1);
    const includeMatchers = includePatterns.map(pattern => globToRegExp({ pattern }));
    const excludeMatchers = splitArgs.excludePatterns.map(pattern => globToRegExp({ pattern }));
    const matchedIncludeIndexes = new Set<number>();
    const matchedExcludeIndexes = new Set<number>();
    const neverOverwrite = parsed.optionValues.neverOverwrite === true;
    const overwrite = parsed.optionValues.overwrite === true;
    const isNonExtractingMode = parsed.optionValues.list === true
      || parsed.optionValues.test === true
      || parsed.optionValues.pipeToStdout === true;
    let archive: OpenedZipArchive | undefined;

    if (destinationOption !== undefined && isNonExtractingMode) {
      await context.text().error({ text: 'caution:  not extracting; -d ignored\n' });
    }
    if (neverOverwrite && overwrite) {
      await context.text().error({ text: 'caution:  both -n and -o specified; ignoring -o\n' });
    }

    try {
      archive = await openZipArchiveWithImplicitSuffix({ context, archivePath });
      const diagnosticArchiveOperand = archive.usedImplicitSuffix
        ? `${archiveOperand}.zip`
        : archiveOperand;
      if (parsed.optionValues.list === true) {
        await listEntries({
          context,
          archiveOperand: diagnosticArchiveOperand,
          reader: archive.reader,
          includeMatchers,
          excludeMatchers,
          matchedIncludeIndexes,
          matchedExcludeIndexes,
          quietCount,
        });
        const hadUnmatchedPattern = hasUnmatchedPatterns({
          patterns: includePatterns,
          matchedIndexes: matchedIncludeIndexes,
        });
        return { exitCode: hadUnmatchedPattern ? 11 : 0 };
      }
      if (parsed.optionValues.test === true) {
        const testResult = await testEntries({
          context,
          archiveOperand: diagnosticArchiveOperand,
          reader: archive.reader,
          includeMatchers,
          excludeMatchers,
          matchedIncludeIndexes,
          matchedExcludeIndexes,
          quietCount,
          includePatterns,
          excludePatterns: splitArgs.excludePatterns,
        });
        return {
          exitCode: testResult.hadDataError ? 2 : testResult.hadUnmatchedPattern ? 11 : 0,
        };
      }
      if (parsed.optionValues.pipeToStdout === true) {
        await pipeEntries({
          context,
          reader: archive.reader,
          includeMatchers,
          excludeMatchers,
          matchedIncludeIndexes,
          matchedExcludeIndexes,
        });
        const hadUnmatchedPattern = await reportUnmatchedIncludes({
          context,
          includePatterns,
          matchedIncludeIndexes,
        });
        await reportUnmatchedExcludes({
          context,
          excludePatterns: splitArgs.excludePatterns,
          matchedExcludeIndexes,
        });
        return { exitCode: hadUnmatchedPattern ? 11 : 0 };
      }
      if (quietCount === 0) {
        await context.text().print({ text: `Archive:  ${diagnosticArchiveOperand}\n` });
      }
      const extractionExitCode = await extractEntries({
        context,
        reader: archive.reader,
        includeMatchers,
        excludeMatchers,
        destinationRoot,
        junkPaths: parsed.optionValues.junkPaths === true,
        neverOverwrite,
        overwrite: overwrite && !neverOverwrite,
        matchedIncludeIndexes,
        matchedExcludeIndexes,
      });
      const hadUnmatchedPattern = await reportUnmatchedIncludes({
        context,
        includePatterns,
        matchedIncludeIndexes,
      });
      await reportUnmatchedExcludes({
        context,
        excludePatterns: splitArgs.excludePatterns,
        matchedExcludeIndexes,
      });
      return { exitCode: extractionExitCode !== 0 ? extractionExitCode : hadUnmatchedPattern ? 11 : 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNotFoundError({ message })) {
        if (preArchiveOptions.quietCount < 3) {
          await context.text().error({
            text: `unzip:  cannot find or open ${archiveOperand}, ${archiveOperand}.zip or ${archiveOperand}.ZIP.\n`,
          });
        }
        return { exitCode: 9 };
      }
      await context.text().error({ text: `unzip: ${message}\n` });
      return { exitCode: message.includes('End of central directory not found') ? 9 : 1 };
    } finally {
      await archive?.close();
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
