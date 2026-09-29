import { createAbortableByteStream } from '@/utils/abortable-byte-stream';
import {
  StreamingZipWriter,
  createWebZipCompressionCodec,
} from '@/utils/zip-stream';
import {
  createMemoryZipCentralDirectoryStore,
  createReadableZipOutput,
} from '@/utils/zip-stream/memory';
import {
  isDirectoryDownloadPathExcluded,
  isSafeDirectoryDownloadPathSegment,
} from '@/features/file-explorer/logic/directory-download';

export type FileExplorerDirectoryArchiveSourceEntry = {
  name: string,
  kind: 'file' | 'directory' | 'unsupported',
  modifiedAt: Date | undefined,
};

export interface FileExplorerDirectoryArchiveAccess {
  listDirectory({ path }: { path: string }): Promise<FileExplorerDirectoryArchiveSourceEntry[]>,
  openFileStream({ path }: { path: string }): Promise<ReadableStream<Uint8Array>>,
}

export type FileExplorerDirectoryArchiveResult = {
  stream: ReadableStream<Uint8Array>,
  completed: Promise<{ skippedEntryCount: number }>,
};

function joinPath({ parentPath, name }: { parentPath: string, name: string }): string {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}

function joinArchivePath({ parentPath, name }: { parentPath: string, name: string }): string {
  return `${parentPath}/${name}`;
}


export async function createFileExplorerDirectoryArchive({
  access,
  sourceRootPath,
  archiveRootName,
  excludedRelativePaths,
  signal: parentSignal,
}: {
  access: FileExplorerDirectoryArchiveAccess,
  sourceRootPath: string,
  archiveRootName: string,
  excludedRelativePaths: readonly string[],
  signal: AbortSignal,
}): Promise<FileExplorerDirectoryArchiveResult> {
  if (!isSafeDirectoryDownloadPathSegment({ name: archiveRootName })) {
    throw new Error(`Unsafe ZIP root directory name: ${archiveRootName}`);
  }

  const output = createReadableZipOutput({ highWaterMarkBytes: 512 * 1024 });
  const centralDirectoryStore = createMemoryZipCentralDirectoryStore();
  const writer = new StreamingZipWriter({
    output: output.sink,
    centralDirectoryStore,
    compressionCodec: createWebZipCompressionCodec(),
  });
  const abortController = new AbortController();
  const signal = abortController.signal;
  const forwardAbort = () => abortController.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', forwardAbort, { once: true });
  if (parentSignal.aborted) forwardAbort();
  const stream = createAbortableByteStream({
    stream: output.stream,
    signal,
    onCancel: () => abortController.abort(new DOMException('Directory archive cancelled', 'AbortError')),
  });
  const exclusions = new Set(excludedRelativePaths);
  let skippedEntryCount = 0;

  const addDirectory = async ({
    sourcePath,
    relativePath,
    archivePath,
    modifiedAt,
  }: {
    sourcePath: string,
    relativePath: string,
    archivePath: string,
    modifiedAt: Date,
  }): Promise<void> => {
    signal.throwIfAborted();
    await writer.addDirectory({ name: archivePath, modifiedAt });

    const entries = await access.listDirectory({ path: sourcePath });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      if (!isSafeDirectoryDownloadPathSegment({ name: entry.name })) {
        skippedEntryCount += 1;
        continue;
      }
      const childRelativePath = relativePath === ''
        ? entry.name
        : `${relativePath}/${entry.name}`;
      if (isDirectoryDownloadPathExcluded({
        relativePath: childRelativePath,
        excludedRelativePaths: exclusions,
      })) {
        continue;
      }

      const childSourcePath = joinPath({ parentPath: sourcePath, name: entry.name });
      const childArchivePath = joinArchivePath({ parentPath: archivePath, name: entry.name });
      const childModifiedAt = entry.modifiedAt ?? modifiedAt;
      switch (entry.kind) {
      case 'directory':
        await addDirectory({
          sourcePath: childSourcePath,
          relativePath: childRelativePath,
          archivePath: childArchivePath,
          modifiedAt: childModifiedAt,
        });
        break;
      case 'file': {
        const stream = await access.openFileStream({ path: childSourcePath });
        await writer.addFile({
          name: childArchivePath,
          modifiedAt: childModifiedAt,
          compression: 'deflate',
          stream: createAbortableByteStream({ stream, signal, onCancel: undefined }),
        });
        break;
      }
      case 'unsupported':
        skippedEntryCount += 1;
        break;
      default: {
        const _ex: never = entry.kind;
        throw new Error(`Unhandled directory archive entry kind: ${String(_ex)}`);
      }
      }
    }
  };

  const produce = async (): Promise<{ skippedEntryCount: number }> => {
    try {
      await addDirectory({
        sourcePath: sourceRootPath,
        relativePath: '',
        archivePath: archiveRootName,
        modifiedAt: new Date(),
      });
      signal.throwIfAborted();
      await writer.finalize();
      signal.throwIfAborted();
      await output.close();
      signal.throwIfAborted();
      return { skippedEntryCount };
    } catch (error: unknown) {
      // Compression/output implementations may surface their own error during
      // cancellation; preserve the operation's explicit cancellation reason.
      const reason = signal.aborted
        ? signal.reason ?? new DOMException('Directory archive cancelled', 'AbortError')
        : error;
      await output.abort({ reason }).catch(() => undefined);
      throw reason;
    } finally {
      parentSignal.removeEventListener('abort', forwardAbort);
      await centralDirectoryStore.dispose();
    }
  };
  const completed = produce();
  void completed.catch(() => undefined);
  return { stream, completed };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
