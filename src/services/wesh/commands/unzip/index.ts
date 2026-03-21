import { Unzip, UnzipInflate } from 'fflate';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
} from '@/services/wesh/types';
import { handleToStream, readFile } from '@/services/wesh/utils/fs';

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

function basename({
  path,
}: {
  path: string;
}): string {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function padLeft({
  text,
  width,
}: {
  text: string;
  width: number;
}): string {
  return text.padStart(width, ' ');
}

function formatListDate({
  date,
}: {
  date: Date;
}): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function globToRegExp({
  pattern,
}: {
  pattern: string;
}): RegExp {
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

interface SplitUnzipArgsResult {
  mainArgs: string[];
  excludePatterns: string[];
}

function splitUnzipArgs({
  args,
}: {
  args: string[];
}): SplitUnzipArgsResult {
  const excludeIndex = args.indexOf('-x');
  if (excludeIndex === -1) {
    return {
      mainArgs: args,
      excludePatterns: [],
    };
  }

  return {
    mainArgs: args.slice(0, excludeIndex),
    excludePatterns: args.slice(excludeIndex + 1),
  };
}

async function readAllBytesFromStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

async function ensureDirectory({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<void> {
  await context.files.mkdir({
    path,
    recursive: true,
  });
}

async function pathExists({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<boolean> {
  try {
    await context.files.lstat({ path });
    return true;
  } catch {
    return false;
  }
}

const PUSH_CHUNK_SIZE = 64 * 1024;

interface ZipEntryInfo {
  name: string;
  dir: boolean;
  date: Date;
  size: number;
}

export const unzipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'unzip',
    description: 'List, test and extract compressed files in a ZIP archive',
    usage: 'unzip [-lpnjoq] [-d dir] archive[.zip] [file ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const splitArgs = splitUnzipArgs({
      args: context.args,
    });
    const parsed = parseStandardArgv({
      args: splitArgs.mainArgs,
      spec: unzipArgvSpec,
    });

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
      await writeCommandHelp({
        context,
        command: 'unzip',
        argvSpec: unzipArgvSpec,
      });
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
      : resolvePath({
        cwd: context.cwd,
        path: archiveOperand,
      });
    const destinationOption = parsed.optionValues.destination;
    const destinationRoot = typeof destinationOption === 'string'
      ? resolvePath({
        cwd: context.cwd,
        path: destinationOption,
      })
      : context.cwd;

    try {
      // Load entire ZIP into memory
      let buffer: Uint8Array;
      if (archivePath === '-') {
        buffer = await readAllBytesFromStream({
          stream: handleToStream({ handle: context.stdin }),
        });
      } else {
        const blobResult = await context.files.tryReadBlobEfficiently({ path: archivePath });
        if (blobResult.kind === 'blob') {
          buffer = new Uint8Array(await blobResult.blob.arrayBuffer());
        } else {
          buffer = await readFile({ files: context.files, path: archivePath });
        }
      }

      // 1. Scan for entries (no decompression)
      const allEntries: ZipEntryInfo[] = [];
      const scanner = new Unzip();
      scanner.onfile = (file) => {
        allEntries.push({
          name: file.name,
          dir: file.name.endsWith('/'),
          date: new Date(),
          size: file.originalSize ?? 0,
        });
      };
      for (let i = 0; i < buffer.length; i += PUSH_CHUNK_SIZE) {
        scanner.push(buffer.subarray(i, i + PUSH_CHUNK_SIZE), i + PUSH_CHUNK_SIZE >= buffer.length);
      }

      const patterns = parsed.positionals.slice(1);
      const matchers = patterns.map((pattern) => globToRegExp({ pattern }));
      const excludeMatchers = splitArgs.excludePatterns.map((pattern) => globToRegExp({ pattern }));
      const selectedEntries = allEntries
        .filter((entry) => {
          if (patterns.length === 0) {
            return !excludeMatchers.some((matcher) => matcher.test(entry.name));
          }
          return matchers.some((matcher) => matcher.test(entry.name))
            && !excludeMatchers.some((matcher) => matcher.test(entry.name));
        });

      if (parsed.optionValues.list === true) {
        selectedEntries.sort((left, right) => left.name.localeCompare(right.name));
        const totalLength = selectedEntries.reduce((acc, entry) => acc + (entry.dir ? 0 : entry.size), 0);
        const lines = [
          `Archive:  ${archiveOperand}`,
          '  Length      Date    Time    Name',
          '---------  ---------- -----   ----',
          ...selectedEntries.map((entry) => {
            const length = entry.dir ? 0 : entry.size;
            const formattedDate = formatListDate({ date: entry.date });
            return `${padLeft({ text: String(length), width: 9 })}  ${formattedDate.slice(0, 10)} ${formattedDate.slice(11)}   ${entry.name}`;
          }),
          '---------                     -------',
          `${padLeft({ text: String(totalLength), width: 9 })}                     ${selectedEntries.length} files`,
        ];
        await context.text().print({ text: `${lines.join('\n')}\n` });
        return { exitCode: 0 };
      }

      const junkPaths = parsed.optionValues.junkPaths === true;
      const neverOverwrite = parsed.optionValues.neverOverwrite === true;
      const overwrite = parsed.optionValues.overwrite === true;
      const pipeToStdout = parsed.optionValues.pipeToStdout === true;
      let hadError = false;

      // 2. Second pass: Extract selected files in a single scan
      const unzipper = new Unzip();
      unzipper.register(UnzipInflate);

      const selectedNames = new Set(selectedEntries.map((e) => e.name));
      const extractionPromises: Promise<void>[] = [];

      unzipper.onfile = (file) => {
        if (!selectedNames.has(file.name)) {
          return;
        }

        const relativePath = junkPaths ? basename({ path: file.name }) : file.name;
        const destinationPath = resolvePath({
          cwd: destinationRoot,
          path: relativePath,
        });

        if (file.name.endsWith('/')) {
          if (!pipeToStdout) {
            extractionPromises.push(ensureDirectory({ context, path: destinationPath }));
          }
          return;
        }

        const extractionPromise = (async () => {
          if (pipeToStdout) {
            let writeQueue = Promise.resolve();
            file.ondata = (err, data) => {
              if (err) return;
              writeQueue = writeQueue.then(async () => {
                let written = 0;
                while (written < data.length) {
                  const { bytesWritten } = await context.stdout.write({
                    buffer: data,
                    offset: written,
                    length: data.length - written,
                  });
                  if (bytesWritten === 0) break;
                  written += bytesWritten;
                }
              });
            };
            file.start();
            await writeQueue;
          } else {
            const exists = await pathExists({ context, path: destinationPath });
            if (exists) {
              if (neverOverwrite) return;
              if (!overwrite) {
                await context.text().error({ text: `unzip: ${destinationPath} already exists; use -o to overwrite or -n to skip\n` });
                hadError = true;
                return;
              }
            }

            const lastSlashIndex = destinationPath.lastIndexOf('/');
            const parentPath = lastSlashIndex <= 0 ? '/' : destinationPath.slice(0, lastSlashIndex);
            await ensureDirectory({ context, path: parentPath });

            const writerResult = context.files.tryCreateFileWriterEfficiently === undefined
              ? undefined
              : await context.files.tryCreateFileWriterEfficiently({ path: destinationPath, mode: 'truncate' });

            let writeQueue = Promise.resolve();
            if (writerResult?.kind === 'writer') {
              const writer = writerResult.writer;
              file.ondata = (err, data, final) => {
                if (err) {
                  writer.abort({ reason: err });
                  return;
                }
                writeQueue = writeQueue.then(() => writer.write({ chunk: data }));
                if (final) {
                  writeQueue = writeQueue.then(() => writer.close());
                }
              };
            } else {
              const handle = await context.files.open({
                path: destinationPath,
                flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
              });
              let fileOffset = 0;
              file.ondata = (err, data, final) => {
                if (err) return;
                writeQueue = writeQueue.then(async () => {
                  let written = 0;
                  while (written < data.length) {
                    const { bytesWritten } = await handle.write({
                      buffer: data,
                      offset: written,
                      length: data.length - written,
                      position: fileOffset + written,
                    });
                    if (bytesWritten === 0) break;
                    written += bytesWritten;
                  }
                  fileOffset += written;
                });
                if (final) {
                  writeQueue = writeQueue.then(() => handle.close());
                }
              };
            }
            file.start();
            await writeQueue;
          }
        })();
        extractionPromises.push(extractionPromise);
      };

      for (let i = 0; i < buffer.length; i += PUSH_CHUNK_SIZE) {
        unzipper.push(buffer.subarray(i, i + PUSH_CHUNK_SIZE), i + PUSH_CHUNK_SIZE >= buffer.length);
        // We must await to avoid massive concurrency if buffer is huge and many files are small
        await Promise.all(extractionPromises);
        extractionPromises.length = 0;
      }

      return { exitCode: hadError ? 1 : 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `unzip: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
