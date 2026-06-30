import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import {
  createBlobZipSource,
  createWebZipCompressionCodec,
  StreamingZipReader,
  type ZipArchiveEntry,
} from '@/utils/zip-stream';
import { createWeshZipRandomAccessSource } from '@/features/wesh/zip-stream';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
} from '@/features/wesh/types';
import {
  openHandleReadStream,
  writeAllStreamToFile,
  writeAllStreamToHandle,
} from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';

const unzipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'l', long: undefined, effects: [{ key: 'list', value: true }], help: { summary: 'list archive files', category: 'common' } },
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
      allowAttachedValue: false,
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
}

interface OpenedZipArchive {
  readonly reader: StreamingZipReader,
  close(): Promise<void>,
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

function splitUnzipArgs({ args }: { args: string[] }): SplitUnzipArgsResult {
  const excludeIndex = args.indexOf('-x');
  if (excludeIndex === -1) {
    return { mainArgs: args, excludePatterns: [] };
  }
  return {
    mainArgs: args.slice(0, excludeIndex),
    excludePatterns: args.slice(excludeIndex + 1),
  };
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

  const temporaryDirectory = (context.env.get('TMPDIR') || '/tmp').replace(/\/$/u, '');
  const temporaryPath = `${temporaryDirectory}/wesh-unzip-stdin-${createTemporarySuffix()}.zip`;
  await context.files.mkdir({ path: temporaryDirectory, recursive: true });
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

function entryMatches({
  entry,
  includeMatchers,
  excludeMatchers,
}: {
  entry: ZipArchiveEntry,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
}): boolean {
  if (excludeMatchers.some(matcher => matcher.test(entry.name))) {
    return false;
  }
  return includeMatchers.length === 0 || includeMatchers.some(matcher => matcher.test(entry.name));
}

function sanitizeArchivePath({ path }: { path: string }): string {
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

async function ensureDirectory({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<void> {
  await context.files.mkdir({ path, recursive: true });
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
  const slashIndex = destinationPath.lastIndexOf('/');
  const parentPath = slashIndex <= 0 ? '/' : destinationPath.slice(0, slashIndex);
  await ensureDirectory({ context, path: parentPath });
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
}: {
  context: WeshCommandContext,
  archiveOperand: string,
  reader: StreamingZipReader,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
}): Promise<void> {
  const writer = createBufferedTextWriter({
    handle: context.stdout,
    maxBufferLength: 16 * 1024,
  });
  await writer.write({ text: `Archive:  ${archiveOperand}\n` });
  await writer.write({ text: '  Length      Date    Time    Name\n' });
  await writer.write({ text: '---------  ---------- -----   ----\n' });
  let totalLength = 0;
  let entryCount = 0;
  for await (const entry of reader.entries()) {
    if (!entryMatches({ entry, includeMatchers, excludeMatchers })) {
      continue;
    }
    totalLength += entry.isDirectory ? 0 : entry.uncompressedSize;
    entryCount += 1;
    const formattedDate = formatListDate({ date: entry.modifiedAt });
    await writer.write({
      text: `${padLeft({ text: String(entry.isDirectory ? 0 : entry.uncompressedSize), width: 9 })}  ${formattedDate.slice(0, 10)} ${formattedDate.slice(11)}   ${entry.name}\n`,
    });
  }
  await writer.write({ text: '---------                     -------\n' });
  await writer.write({
    text: `${padLeft({ text: String(totalLength), width: 9 })}                     ${entryCount} files\n`,
  });
  await writer.flush();
}

async function pipeEntries({
  context,
  reader,
  includeMatchers,
  excludeMatchers,
}: {
  context: WeshCommandContext,
  reader: StreamingZipReader,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
}): Promise<void> {
  for await (const entry of reader.entries()) {
    if (entry.isDirectory || !entryMatches({ entry, includeMatchers, excludeMatchers })) {
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
}: {
  context: WeshCommandContext,
  reader: StreamingZipReader,
  includeMatchers: readonly RegExp[],
  excludeMatchers: readonly RegExp[],
  destinationRoot: string,
  junkPaths: boolean,
  neverOverwrite: boolean,
  overwrite: boolean,
}): Promise<boolean> {
  let hadError = false;
  for await (const entry of reader.entries()) {
    if (!entryMatches({ entry, includeMatchers, excludeMatchers })) {
      continue;
    }
    try {
      const safePath = sanitizeArchivePath({ path: entry.name });
      const relativePath = junkPaths ? basename({ path: safePath }) : safePath;
      if (relativePath === '') {
        continue;
      }
      const destinationPath = resolvePath({ cwd: destinationRoot, path: relativePath });
      if (entry.isDirectory) {
        await ensureDirectory({ context, path: destinationPath });
        continue;
      }
      const exists = await pathExists({ context, path: destinationPath });
      if (exists) {
        if (neverOverwrite) {
          continue;
        }
        if (!overwrite) {
          await context.text().error({
            text: `unzip: ${destinationPath} already exists; use -o to overwrite or -n to skip\n`,
          });
          hadError = true;
          continue;
        }
      }
      await writeEntryToFile({ context, reader, entry, destinationPath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `unzip: ${message}\n` });
      hadError = true;
    }
  }
  return hadError;
}

export const unzipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'unzip',
    description: 'List, test and extract compressed files in a ZIP archive',
    usage: 'unzip [-lpnjoq] [-d dir] archive[.zip] [file ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const splitArgs = splitUnzipArgs({ args: context.args });
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
    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'unzip', argvSpec: unzipArgvSpec });
      return { exitCode: 0 };
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
    const includeMatchers = parsed.positionals.slice(1).map(pattern => globToRegExp({ pattern }));
    const excludeMatchers = splitArgs.excludePatterns.map(pattern => globToRegExp({ pattern }));
    let archive: OpenedZipArchive | undefined;

    try {
      archive = await openZipArchive({ context, archivePath });
      if (parsed.optionValues.list === true) {
        await listEntries({
          context,
          archiveOperand,
          reader: archive.reader,
          includeMatchers,
          excludeMatchers,
        });
        return { exitCode: 0 };
      }
      if (parsed.optionValues.pipeToStdout === true) {
        await pipeEntries({
          context,
          reader: archive.reader,
          includeMatchers,
          excludeMatchers,
        });
        return { exitCode: 0 };
      }
      const hadError = await extractEntries({
        context,
        reader: archive.reader,
        includeMatchers,
        excludeMatchers,
        destinationRoot,
        junkPaths: parsed.optionValues.junkPaths === true,
        neverOverwrite: parsed.optionValues.neverOverwrite === true,
        overwrite: parsed.optionValues.overwrite === true,
      });
      return { exitCode: hadError ? 1 : 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NotFoundError')) {
        await context.text().error({
          text: `unzip:  cannot find or open ${archiveOperand}, ${archiveOperand}.zip or ${archiveOperand}.ZIP.\n`,
        });
        return { exitCode: 9 };
      }
      await context.text().error({ text: `unzip: ${message}\n` });
      return { exitCode: 1 };
    } finally {
      await archive?.close();
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
