import { verifyStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import type { BlobContext, BlobView } from '@/utils/blob-view';
import { createWorkerBlobContext, type WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { isProjector } from './model-variants';
import { scanDeletionTree, pruneEmptyDirectories } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { openSyncAccess, type DownloadAccess } from './sync-access';
import { releaseWorkerProxyArgument, type WorkerCapability, type WorkerProxy, type WorkerServerApi, type WorkerTransfer } from '@/utils/worker-transport';
import { z } from 'zod';
import { readModelFiles, resolveModelFiles, validGgufView } from '@/features/llama-cpp-browser/runtime/model-directory';
import { isMissing, readJournal, repositoryFolder, selectedFile, writeJournal } from './storage';
import { journalSchema, sharedProjectorConflictMessage, existingModelConflictMessage, pendingName, selectionSchema, type BeginDownloadResult, type DownloadJournal, type DownloadSelection } from './types';

export type DownloadWriterApi = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink reverse proxies must be independent top-level arguments.
  verifyStorage(request: { probeId: string }, blobReadHost?: WorkerProxy<WorkerBlobReadHost>): Promise<boolean>,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- The download host is independent of both the request and the startup probe.
  begin(request: { selection: DownloadSelection }, blobReadHost?: WorkerProxy<WorkerBlobReadHost>): Promise<BeginDownloadResult>,
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
  let blobs: BlobContext | undefined;
  let comparison: BlobView | undefined;
  let access: DownloadAccess | undefined; let index: number | undefined;
  let position = 0; let checkpointPosition = 0; let checkpointTime = 0;
  let phase: 'idle' | 'opening' | 'ready' | 'finished' | 'closed' = 'idle';
  const reading = new AbortController();
  let currentReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  let active: Promise<void> | undefined; let pausing: Promise<void> | undefined;
  const check = (): void => reading.signal.throwIfAborted();
  const release = (): void => {
    const owned = blobs; blobs = undefined;
    owned?.dispose();
  };
  async function run<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    if (active || pausing) throw new Error('Download writer is busy or closed');
    const result = Promise.resolve().then(operation);
    const settled = result.then(() => {}, () => {});
    active = settled;
    try {
      return await result;
    } finally {
      if (active === settled) active = undefined;
    }
  }
  const ready = (): void => {
    check();
    switch (phase) {
    case 'ready': return;
    case 'idle': case 'opening': case 'finished': case 'closed':
      throw new Error('Download writer is not ready');
    default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
    }
  };
  const checkpoint = async (): Promise<void> => {
    if ((!access && !comparison) || index === undefined || !folder || !journal) return;
    access?.flush(); journal.bytes[index] = position;
    await writeJournal({ folder, journal }); checkpointPosition = position; checkpointTime = performance.now();
  };
  const closeFile = (): void => {
    const opened = access; access = undefined; comparison = undefined; index = undefined;
    opened?.close();
  };
  const append = async ({ bytes }: { bytes: Uint8Array }): Promise<number> => {
    ready();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024 || (!access && !comparison) || index === undefined || !journal) throw new Error('Invalid download chunk');
    if (bytes.byteLength > journal.selection.files[index]!.size - position) throw new Error('Download exceeds expected size');
    if (comparison) {
      const stored = await comparison.slice({ start: position, end: position + bytes.byteLength }).bytes({ signal: reading.signal });
      check();
      if (stored.length !== bytes.length || stored.some((byte, offset) => byte !== bytes[offset])) throw new Error(isProjector({ path: journal.selection.files[index]!.path }) ? sharedProjectorConflictMessage : existingModelConflictMessage);
      position += bytes.length;
    }
    let offset = 0;
    while (access && offset < bytes.length) {
      check();
      const count = access.write(bytes.subarray(offset), { at: position });
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error('Invalid download write progress');
      offset += count; position += count;
    }
    if (position - checkpointPosition >= 8 * 1024 * 1024 || performance.now() - checkpointTime >= 2000) await checkpoint();
    check();
    return position;
  };
  const finishFile = async (): Promise<void> => {
    ready();
    if ((!access && !comparison) || index === undefined || !journal || !folder || position !== journal.selection.files[index]!.size) throw new Error('Incomplete download');
    await checkpoint(); check();
    journal.complete[index] = true; await writeJournal({ folder, journal });
    closeFile(); check();
  };
  const stop = async (): Promise<void> => {
    reading.abort(new DOMException('Download paused', 'AbortError'));
    await currentReader?.cancel();
  };
  const api: WorkerServerApi<DownloadWriterApi> = {
    verifyStorage,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Own the reverse proxy for one download attempt, never globally.
    async begin({ selection }, blobReadHost) {
      if (phase !== 'idle' || active || pausing) {
        if (blobReadHost !== undefined) releaseWorkerProxyArgument({ value: blobReadHost });
        throw new Error('Download writer is busy or closed');
      }
      phase = 'opening'; blobs = createWorkerBlobContext({ host: blobReadHost });
      try {
        const result = await run<BeginDownloadResult>({ operation: async () => {
          check();
          selection = selectionSchema.parse(selection); resolveModelFiles({ files: selection.files });
          if (selection.files.filter(file => isProjector({ path: file.path })).length > 1) throw new Error('Only one projector can be downloaded');
          folder = await repositoryFolder({ repository: selection.repository, create: true }); check();
          try {
            journal = await readJournal({ folder, blobs, signal: reading.signal });
            if (JSON.stringify(journal.selection) !== JSON.stringify(selection)) return { status: 'conflict', reason: 'different-download' };
          } catch (error) {
            check();
            if (!isMissing({ error })) throw error;
            const contents = await scanDeletionTree({ folder }); check();
            const existing = new Map(contents.files.map(file => [file.path, file]));
            const projectors = contents.files.filter(file => isProjector({ path: file.path }) && /\.gguf$/i.test(file.path));
            const requestedProjector = selection.files.find(file => isProjector({ path: file.path }));
            if (requestedProjector && projectors.some(file => file.path !== requestedProjector.path)) return { status: 'conflict', reason: 'projector-conflict' };
            if (requestedProjector && existing.has(requestedProjector.path) && existing.get(requestedProjector.path)!.size !== requestedProjector.size) return { status: 'conflict', reason: 'projector-conflict' };
            const reused = selection.files.map(file => existing.has(file.path));
            // Multimodal is opt-in: adding its file after a text-only install must
            // not overwrite (or trust by size alone) the already installed model.
            // Only allow this upgrade when the complete main file set is present.
            // Reuse the existing read-only, byte-for-byte comparison path below:
            // it still transfers the pinned main bytes, but never allocates another
            // model-sized buffer or writes/truncates the installed weights.
            const addsProjector = requestedProjector !== undefined && !existing.has(requestedProjector.path);
            const mainFiles = selection.files.filter(file => !isProjector({ path: file.path }));
            const hasCompleteMainSet = mainFiles.every(file => existing.get(file.path)?.size === file.size);
            const comparesInstalledMain = addsProjector && hasCompleteMainSet;
            if (selection.files.some((file, index) => reused[index] && (existing.get(file.path)!.size !== file.size || (!isProjector({ path: file.path }) && !comparesInstalledMain)))) return { status: 'conflict', reason: 'existing-files' };
            if (!contents.files.length) await pruneEmptyDirectories({ folder, directories: contents.directories });
            check();
            journal = { version: 1, selection, reused, bytes: selection.files.map(() => 0), complete: selection.files.map(() => false) };
            await writeJournal({ folder, journal });
          }
          check();
          for (let i = 0; i < selection.files.length; i++) {
            const file = selection.files[i]!;
            if (journal.reused?.[i]) {
              // Recheck every byte against the pinned source on each resumed attempt.
              journal.bytes[i] = 0; journal.complete[i] = false; continue;
            }
            const handle = await selectedFile({ folder, path: file.path, create: true }); check();
            const sync = await openSyncAccess({ handle });
            try {
              check();
              const actual = sync.getSize(); const recorded = journal.bytes[i]!;
              if (actual < recorded || actual > file.size) throw new Error('Download file differs from its journal');
              if (actual !== recorded) {
                sync.truncate(recorded); sync.flush();
              }
            } finally {
              sync.close();
            }
          }
          check(); await writeJournal({ folder, journal }); check();
          return { status: 'ready', journal: journalSchema.parse(journal) };
        } });
        switch (result.status) {
        case 'ready': check(); phase = 'ready'; return result;
        case 'conflict': phase = 'closed'; release(); return result;
        default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
        }
      } catch (error) {
        phase = 'closed'; release(); throw error;
      }
    },
    open: ({ fileIndex, start }) => run({ operation: async () => {
      ready();
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(fileIndex);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(start);
      if (!folder || !journal || !blobs || access || comparison || fileIndex >= journal.selection.files.length) throw new Error('Invalid download writer state');
      if (start !== 0 && start !== journal.bytes[fileIndex]) throw new Error('Invalid download offset');
      const handle = await selectedFile({ folder, path: journal.selection.files[fileIndex]!.path, create: false }); check();
      if (journal.reused?.[fileIndex]) {
        if (start !== 0) throw new Error('Shared file verification must start at zero');
        const snapshot = await handle.getFile(); check();
        const view = blobs.fromNative({ blob: snapshot });
        if (view.size !== journal.selection.files[fileIndex]!.size) throw new Error(isProjector({ path: journal.selection.files[fileIndex]!.path }) ? sharedProjectorConflictMessage : existingModelConflictMessage);
        comparison = view;
      } else {
        access = await openSyncAccess({ handle });
        // A late access handle still belongs to pause(), which will close it.
        check();
      }
      index = fileIndex; position = start; checkpointPosition = start; checkpointTime = performance.now();
      access?.truncate(start); journal.complete[fileIndex] = false; await checkpoint(); check();
    } }),
    append: ({ bytes }) => run({ operation: () => append({ bytes }) }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callbacks must be top-level arguments.
    async consume({ stream }, onProgress) {
      let accepted = false;
      try {
        await run({ operation: async () => {
          ready();
          if ((!access && !comparison) || currentReader) throw new Error('Invalid download writer state');
          const reader = stream.getReader(); accepted = true; currentReader = reader; let reportedAt = 0;
          try {
            while (true) {
              const { done, value } = await reader.read(); check(); if (done) break;
              for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) {
                await append({ bytes: value.subarray(offset, offset + 1024 * 1024) });
              }
              if (performance.now() - reportedAt > 150) {
                await onProgress({ position }); reportedAt = performance.now(); check();
              }
            }
            check(); await finishFile(); check(); await onProgress({ position });
          } catch (error) {
            await reader.cancel().catch(() => {}); throw error;
          } finally {
            reader.releaseLock(); currentReader = undefined;
          }
        } });
      } finally {
        if (!accepted) await stream.cancel().catch(() => {});
        releaseWorkerProxyArgument({ value: onProgress });
      }
    },
    stop,
    finishFile: () => run({ operation: finishFile }),
    pause() {
      pausing ??= (async () => {
        try {
          await stop().catch(() => {});
          await active;
          // Acknowledge flushed progress, not unverified or cancelled bytes.
          // This write-only checkpoint does not need the aborted read signal.
          await checkpoint();
        } finally {
          phase = 'closed';
          try {
            closeFile();
          } finally {
            release();
          }
        }
      })();
      return pausing;
    },
    finish: () => run({ operation: async () => {
      ready();
      if (!folder || !journal || !blobs || access || comparison || !journal.complete.every(Boolean)) throw new Error('Incomplete download');
      const files = (await readModelFiles({ folder, prefix: '' })).filter(file => journal!.selection.files.some(expected => expected.path === file.path)); check();
      if (files.length !== journal.selection.files.length) throw new Error('Download file set changed');
      for (const file of files) {
        if (!journal.selection.files.some(expected => expected.path === file.path && expected.size === file.file.size)
          || !await validGgufView({ blob: blobs.fromNative({ blob: file.file }), signal: reading.signal })) throw new Error('Invalid downloaded GGUF');
      }
      resolveModelFiles({ files }); check();
      // Removing the journal publishes the download. Cancellation after a
      // successful removal must not recreate that marker or start rollback.
      await folder.removeEntry(pendingName);
      phase = 'finished'; release();
    } }),
  };
  return api;
}
export const TEST_ONLY = {
};
