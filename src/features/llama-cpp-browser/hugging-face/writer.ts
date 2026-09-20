import { scanDeletionTree, pruneEmptyDirectories } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { openSyncAccess, type DownloadAccess } from './sync-access';
import { releaseWorkerRemote, type WorkerRemote, type WorkerCapability, type WorkerProxy, type WorkerServerApi, type WorkerTransfer } from '@/utils/worker-transport';
import { z } from 'zod';
import { readModelFiles, resolveModelFiles, validGguf } from '@/features/llama-cpp-browser/runtime/model-directory';
import { isMissing, readJournal, repositoryFolder, selectedFile, writeJournal } from './storage';
import { journalSchema, pendingName, selectionSchema, type BeginDownloadResult, type DownloadJournal, type DownloadSelection } from './types';

export type DownloadWriterApi = {
  begin({ selection }: { selection: DownloadSelection }): Promise<BeginDownloadResult>,
  open({ fileIndex, start }: { fileIndex: number, start: number }): Promise<void>,
  append({ bytes }: WorkerTransfer<{ bytes: Uint8Array<ArrayBuffer> }>): Promise<number>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callbacks must be top-level arguments.
  consume(input: WorkerTransfer<WorkerCapability<{ stream: ReadableStream<Uint8Array<ArrayBuffer>> }, 'readable-stream-transfer'>>, onProgress: WorkerProxy<({ position }: { position: number }) => Promise<void>>): Promise<void>,
  stop(): Promise<void>,
  finishFile(): Promise<void>,
  pause(): Promise<void>,
  finish(): Promise<void>,
};
export function createDownloadWriter(): WorkerServerApi<DownloadWriterApi> {
  let folder: FileSystemDirectoryHandle | undefined; let journal: DownloadJournal | undefined;
  let access: DownloadAccess | undefined; let index: number | undefined;
  let position = 0; let checkpointPosition = 0; let checkpointTime = 0;
  let currentReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined; let stopped = false;
  const checkpoint = async (): Promise<void> => {
    if (!access || index === undefined || !folder || !journal) return;
    access.flush(); journal.bytes[index] = position;
    await writeJournal({ folder, journal }); checkpointPosition = position; checkpointTime = performance.now();
  };
  const close = async (): Promise<void> => {
    try {
      await checkpoint();
    } finally {
      access?.close(); access = undefined; index = undefined;
    }
  };
  const api: WorkerServerApi<DownloadWriterApi> = {
    async begin({ selection }: { selection: DownloadSelection }): Promise<BeginDownloadResult> {
      selection = selectionSchema.parse(selection); resolveModelFiles({ files: selection.files });
      folder = await repositoryFolder({ repository: selection.repository, create: true });
      try {
        journal = await readJournal({ folder });
        if (JSON.stringify(journal.selection) !== JSON.stringify(selection)) return { status: 'conflict', reason: 'different-download' };
      } catch (error) {
        if (!isMissing({ error })) throw error;
        const contents = await scanDeletionTree({ folder });
        if (contents.files.length) return { status: 'conflict', reason: 'existing-files' };
        await pruneEmptyDirectories({ folder, directories: contents.directories });
        if ((await scanDeletionTree({ folder })).files.length) return { status: 'conflict', reason: 'existing-files' };
        journal = { version: 1, selection, bytes: selection.files.map(() => 0), complete: selection.files.map(() => false) };
        await writeJournal({ folder, journal });
      }
      for (let i = 0; i < selection.files.length; i++) {
        const file = selection.files[i]!;
        const handle = await selectedFile({ folder, path: file.path, create: true });
        const sync = await openSyncAccess({ handle });
        try {
          const actual = sync.getSize(); const recorded = journal.bytes[i]!;
          if (actual < recorded || actual > file.size) throw new Error('Download file differs from its journal');
          if (actual !== recorded) {
            sync.truncate(recorded); sync.flush();
          }
        } finally {
          sync.close();
        }
      }
      return { status: 'ready', journal: journalSchema.parse(journal) };
    },
    async open({ fileIndex, start }: { fileIndex: number, start: number }): Promise<void> {
      z.number().int().nonnegative().parse(fileIndex); z.number().int().nonnegative().parse(start);
      if (!folder || !journal || access || fileIndex >= journal.selection.files.length) throw new Error('Invalid download writer state');
      if (start !== 0 && start !== journal.bytes[fileIndex]) throw new Error('Invalid download offset');
      access = await openSyncAccess({ handle: await selectedFile({ folder, path: journal.selection.files[fileIndex]!.path, create: false }) });
      stopped = false; index = fileIndex; position = start; checkpointPosition = start; checkpointTime = performance.now();
      access.truncate(start); journal.complete[fileIndex] = false; await checkpoint();
    },
    async append({ bytes }: { bytes: Uint8Array }): Promise<number> {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024 || !access || index === undefined || !journal) throw new Error('Invalid download chunk');
      if (position + bytes.byteLength > journal.selection.files[index]!.size) throw new Error('Download exceeds expected size');
      let offset = 0;
      while (offset < bytes.length) {
        const count = access.write(bytes.subarray(offset), { at: position });
        if (count <= 0) throw new Error('Download write made no progress'); offset += count; position += count;
      }
      if (position - checkpointPosition >= 8 * 1024 * 1024 || performance.now() - checkpointTime >= 2000) await checkpoint();
      return position;
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callbacks must be top-level arguments.
    async consume({ stream }: { stream: ReadableStream<Uint8Array<ArrayBuffer>> }, onProgress: ({ position }: { position: number }) => Promise<void>): Promise<void> {
      if (!access || currentReader) throw new Error('Invalid download writer state');
      const reader = stream.getReader(); currentReader = reader; let reportedAt = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (stopped) throw new DOMException('Download paused', 'AbortError');
          if (done) break;
          for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) {
            if (stopped) throw new DOMException('Download paused', 'AbortError');
            await api.append({ bytes: value.subarray(offset, offset + 1024 * 1024) });
          }
          if (performance.now() - reportedAt > 150) {
            await onProgress({ position }); reportedAt = performance.now();
          }
        }
        if (stopped) throw new DOMException('Download paused', 'AbortError');
        await api.finishFile(); await onProgress({ position });
      } catch (error) {
        await reader.cancel().catch(() => {}); throw error;
      } finally {
        reader.releaseLock(); currentReader = undefined;
        // Comlink delivers a remote function; release its callback port after EOF or cancellation.
        releaseWorkerRemote({ remote: onProgress as WorkerRemote<typeof onProgress> });
      }
    },
    async stop(): Promise<void> {
      stopped = true; await currentReader?.cancel();
    },
    async finishFile(): Promise<void> {
      if (!access || index === undefined || !journal || !folder || position !== journal.selection.files[index]!.size) throw new Error('Incomplete download');
      await checkpoint(); journal.complete[index] = true; await writeJournal({ folder, journal });
      access.close(); access = undefined; index = undefined;
    },
    async pause(): Promise<void> {
      await close();
    },
    async finish(): Promise<void> {
      if (!folder || !journal || access || !journal.complete.every(Boolean)) throw new Error('Incomplete download');
      const files = await readModelFiles({ folder, prefix: '' });
      if (files.length !== journal.selection.files.length) throw new Error('Download file set changed');
      for (const file of files) {
        if (!journal.selection.files.some(expected => expected.path === file.path && expected.size === file.file.size) || !await validGguf({ file: file.file })) throw new Error('Invalid downloaded GGUF');
      }
      resolveModelFiles({ files }); await folder.removeEntry(pendingName);
    },
  };
  return api;
}
export const TEST_ONLY = {
};
