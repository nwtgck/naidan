import JSZip from 'jszip';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { generateZipReadableStream } from '@/services/wesh/commands/_shared/jszip';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshFileType,
  WeshOpenFlags,
} from '@/services/wesh/types';
import { handleToStream, readFile, streamToHandle } from '@/services/wesh/utils/fs';

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
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

interface PendingZipEntry {
  sourcePath: string;
  archivePath: string;
  type: WeshFileType;
}

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

function sanitizeArchiveRootName({
  path,
}: {
  path: string;
}): string {
  return path.replace(/^\/+/, '');
}

function buildArchivePath({
  operand,
  currentPath,
  junkPaths,
}: {
  operand: string;
  currentPath: string;
  junkPaths: boolean;
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
  const relativePart = currentPath.startsWith(prefix) ? currentPath.slice(prefix.length) : basename({ path: currentPath });
  const rootName = sanitizeArchiveRootName({ path: normalizedOperand });
  return rootName === '' ? relativePart : `${rootName}/${relativePart}`;
}

async function listZipEntriesForOperand({
  context,
  operand,
  recursive,
  junkPaths,
}: {
  context: WeshCommandContext;
  operand: string;
  recursive: boolean;
  junkPaths: boolean;
}): Promise<PendingZipEntry[]> {
  if (operand === '-') {
    return [{
      sourcePath: '-',
      archivePath: '-',
      type: 'file',
    }];
  }

  const stat = await context.files.stat({ path: operand });
  switch (stat.type) {
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    return [{
      sourcePath: operand,
      archivePath: buildArchivePath({
        operand,
        currentPath: operand,
        junkPaths,
      }),
      type: stat.type,
    }];
  case 'directory': {
    const directoryEntry: PendingZipEntry = {
      sourcePath: operand,
      archivePath: `${buildArchivePath({
        operand,
        currentPath: operand,
        junkPaths,
      })}/`,
      type: 'directory',
    };

    if (!recursive) {
      return [directoryEntry];
    }

    const output: PendingZipEntry[] = [directoryEntry];
    const stack: string[] = [operand];
    while (stack.length > 0) {
      const currentPath = stack.pop();
      if (currentPath === undefined) {
        continue;
      }

      const entries = await context.files.readDir({ path: currentPath });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        const childPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
        const archivePath = buildArchivePath({
          operand,
          currentPath: childPath,
          junkPaths,
        });

        switch (entry.type) {
        case 'directory':
          output.push({
            sourcePath: childPath,
            archivePath: `${archivePath}/`,
            type: 'directory',
          });
          stack.push(childPath);
          break;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          output.push({
            sourcePath: childPath,
            archivePath,
            type: entry.type,
          });
          break;
        default: {
          const _ex: never = entry.type;
          throw new Error(`Unhandled entry type: ${_ex}`);
        }
        }
      }
    }

    return output;
  }
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
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

async function addRegularEntryToZip({
  context,
  zip,
  entry,
  compression,
  compressionLevel,
}: {
  context: WeshCommandContext;
  zip: JSZip;
  entry: PendingZipEntry;
  compression: 'STORE' | 'DEFLATE';
  compressionLevel: number;
}): Promise<void> {
  const compressionOptions = (() => {
    switch (compression) {
    case 'DEFLATE':
      return { level: compressionLevel };
    case 'STORE':
      return undefined;
    default: {
      const _ex: never = compression;
      throw new Error(`Unhandled compression: ${_ex}`);
    }
    }
  })();

  if (entry.sourcePath === '-') {
    const stdinBytes = await readAllBytesFromStream({
      stream: handleToStream({ handle: context.stdin }),
    });
    zip.file(entry.archivePath, stdinBytes, {
      compression,
      compressionOptions,
      createFolders: true,
    });
    return;
  }

  const blobResult = await context.files.tryReadBlobEfficiently({ path: entry.sourcePath });
  switch (blobResult.kind) {
  case 'blob':
    zip.file(entry.archivePath, blobResult.blob, {
      compression,
      compressionOptions,
      createFolders: true,
    });
    return;
  case 'fallback-required': {
    const bytes = await readFile({
      files: context.files,
      path: entry.sourcePath,
    });
    zip.file(entry.archivePath, bytes, {
      compression,
      compressionOptions,
      createFolders: true,
    });
    return;
  }
  default: {
    const _ex: never = blobResult;
    throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
  }
  }
}

async function writeZipToDestination({
  context,
  archivePath,
  zip,
}: {
  context: WeshCommandContext;
  archivePath: string;
  zip: JSZip;
}): Promise<void> {
  const flags: WeshOpenFlags = {
    access: 'write',
    creation: 'if-needed',
    truncate: 'truncate',
    append: 'preserve',
  };
  const handle = await context.files.open({
    path: archivePath,
    flags,
  });
  await streamToHandle({
    stream: generateZipReadableStream({ zip }),
    handle,
  });
}

export const zipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'zip',
    description: 'Package and compress files into ZIP archives',
    usage: 'zip [-rjq0-9] zipfile file...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
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
      await writeCommandHelp({
        context,
        command: 'zip',
        argvSpec: zipArgvSpec,
      });
      return { exitCode: 0 };
    }

    const archiveOperand = parsed.positionals[0];
    if (archiveOperand === undefined || parsed.positionals.length < 2) {
      const archiveName = archiveOperand ?? 'zip';
      await context.text().error({
        text: `zip error: Nothing to do! (${archiveName})\n`,
      });
      return { exitCode: 12 };
    }

    const recursive = parsed.optionValues.recursive === true;
    const junkPaths = parsed.optionValues.junkPaths === true;
    const compressionMode = parsed.optionValues.compressionMode;
    const compressionLevelValue = parsed.optionValues.compressionLevel;
    const compressionLevel = typeof compressionLevelValue === 'number' ? compressionLevelValue : 6;
    const compression = compressionMode === 'store' ? 'STORE' : 'DEFLATE';

    const archivePath = resolvePath({
      cwd: context.cwd,
      path: archiveOperand,
    });

    const inputOperands = parsed.positionals.slice(1).map((path) => {
      if (path === '-') {
        return '-';
      }

      return resolvePath({
        cwd: context.cwd,
        path,
      });
    });

    const zip = new JSZip();
    let hadError = false;

    for (const operand of inputOperands) {
      try {
        const entries = await listZipEntriesForOperand({
          context,
          operand,
          recursive,
          junkPaths,
        });

        for (const entry of entries) {
          switch (entry.type) {
          case 'directory':
            zip.file(entry.archivePath, null, {
              dir: true,
              createFolders: true,
            });
            break;
          case 'file':
            await addRegularEntryToZip({
              context,
              zip,
              entry,
              compression,
              compressionLevel,
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
            const _ex: never = entry.type;
            throw new Error(`Unhandled file type: ${_ex}`);
          }
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({
          text: `zip error: ${message}\n`,
        });
        hadError = true;
      }
    }

    const entryNames = Object.keys(zip.files);
    if (entryNames.length === 0) {
      await context.text().error({
        text: `zip error: Nothing to do! (${archiveOperand})\n`,
      });
      return { exitCode: 12 };
    }

    await writeZipToDestination({
      context,
      archivePath,
      zip,
    });

    return { exitCode: hadError ? 1 : 0 };
  },
};
