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
  blob: Blob,
  skippedEntryCount: number,
};

function joinPath({ parentPath, name }: { parentPath: string, name: string }): string {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}

function joinArchivePath({ parentPath, name }: { parentPath: string, name: string }): string {
  return `${parentPath}/${name}`;
}

function createAbortAwareStream({
  stream,
  signal,
}: {
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
}): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let status: 'open' | 'closed' = 'open';
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  function releaseReader(): void {
    try {
      reader.releaseLock();
    } catch {
      // The reader can already be released after an overlapping cancel or completion.
    }
  }

  function removeAbortListener(): void {
    signal.removeEventListener('abort', handleAbort);
  }

  function isClosed(): boolean {
    return status === 'closed';
  }

  function handleAbort(): void {
    if (isClosed()) {
      return;
    }
    status = 'closed';
    removeAbortListener();
    const reason = signal.reason ?? new DOMException('Directory archive cancelled', 'AbortError');
    void reader.cancel(reason).catch(() => undefined).finally(releaseReader);
    streamController?.error(reason);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort, { once: true });
    },
    async pull(controller) {
      if (isClosed()) {
        return;
      }
      try {
        const result = await reader.read();
        if (isClosed()) {
          return;
        }
        if (result.done) {
          status = 'closed';
          removeAbortListener();
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (isClosed()) {
          return;
        }
        status = 'closed';
        removeAbortListener();
        await reader.cancel(error).catch(() => undefined);
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (isClosed()) {
        return;
      }
      status = 'closed';
      removeAbortListener();
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
}

export async function createFileExplorerDirectoryArchive({
  access,
  sourceRootPath,
  archiveRootName,
  excludedRelativePaths,
  signal,
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
  const blobPromise = new Response(output.stream).blob();
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
          stream: createAbortAwareStream({ stream, signal }),
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
    const blob = await blobPromise;
    signal.throwIfAborted();
    return {
      blob,
      skippedEntryCount,
    };
  } catch (error: unknown) {
    await output.abort({ reason: error }).catch(() => undefined);
    await blobPromise.catch(() => undefined);
    throw error;
  } finally {
    await centralDirectoryStore.dispose();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
