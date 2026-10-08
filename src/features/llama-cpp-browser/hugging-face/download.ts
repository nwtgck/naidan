import { isHostDestination, hostModelRoot, modelDestinationSchema, withDestinationLock, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { responseOffset } from './download-response';
import { modelDownloadUrl } from './download-url';
export { responseOffset } from './download-response';
import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { getReadableStreamTransferSupport, workerProxy, workerCapability, workerTransfer } from '@/utils/worker-transport';
import { deleteRepository, installedSelection, withRepositoryLock } from './storage';
import { beginDownloadResultSchema, sharedProjectorConflictMessage, existingModelConflictMessage, DownloadConflictError, progressSchema, selectionSchema, type BeginDownloadResult, type DownloadProgress, type DownloadSelection } from './types';
import { createDownloadWriterClient } from '@/features/llama-cpp-browser/hugging-face/writer-client';

export async function downloadRepository({ selection, signal, onProgress, destination, expectedRoot }: { selection: DownloadSelection, signal: AbortSignal, destination?: ModelDestination, expectedRoot?: FileSystemDirectoryHandle, onProgress: ({ progress }: { progress: DownloadProgress }) => void }): Promise<void> {
  selection = selectionSchema.parse(selection);
  const target = modelDestinationSchema.parse(destination ?? { kind: 'opfs' });
  await withDestinationLock({
    destination: target,
    signal,
    operation: () => withRepositoryLock({
      repository: selection.repository,
      operation: async () => {
        signal.throwIfAborted();
        if (isHostDestination(target)) {
          const current = await hostModelRoot({ destination: target, mode: 'readwrite' });
          if (expectedRoot && !await current.isSameEntry(expectedRoot)) throw new Error('Linked model folder changed after this download was queued');
          if (await installedSelection({ selection, destination: target })) return;
        }
        const session = await createDownloadWriterClient({ signal });
        const { worker, remote: writer } = session;
        const network = new AbortController();
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        const forwardAbort = (): void => {
          network.abort(); void writer.stop().catch(() => {});
          // Let in-flight writes acknowledge before pausing; forcibly abandon a
          // stalled writer only after the same grace period as inference cancellation.
          abortTimer = setTimeout(() => {
            fatal = new DOMException('Download paused', 'AbortError');
            pendingReject?.(fatal);
          }, 5_000);
        };
        signal.addEventListener('abort', forwardAbort, { once: true });
        if (signal.aborted) network.abort();
        let fatal: Error | undefined;
        let pendingReject: ReturnType<typeof Promise.withResolvers<unknown>>['reject'] | undefined;
        const onError = (): void => {
          fatal = new Error('Download storage worker failed'); network.abort(); pendingReject?.(fatal);
        };
        worker.addEventListener('error', onError); worker.addEventListener('messageerror', onError);
        const call = <T>({ promise }: { promise: Promise<T> }): Promise<T> => {
          if (fatal) return Promise.reject(fatal);
          return new Promise<T>((resolve, reject) => {
            pendingReject = reject;
            promise.then(value => {
              if (pendingReject === reject) pendingReject = undefined; resolve(value);
            }, error => {
              if (pendingReject === reject) pendingReject = undefined; reject(error);
            });
          });
        };
        const check = (): void => {
          if (fatal) throw fatal; network.signal.throwIfAborted();
        };
        let body: ReadableStream<Uint8Array<ArrayBuffer>> | undefined;
        try {
          check(); const streamTransfer = await getReadableStreamTransferSupport(); check(); const started = beginDownloadResultSchema.parse(await call<BeginDownloadResult>({ promise: writer.begin({ selection, ...(isHostDestination(target) ? { destination: target } : {}) }) }));
          switch (started.status) {
          case 'conflict': throw new DownloadConflictError({ reason: started.reason });
          case 'ready': break;
          default: { const exhaustive: never = started; throw new Error(String(exhaustive)); }
          }
          const journal = started.journal;
          // Full-size but unverified files will restart, so they are still remaining work.
          journal.bytes = journal.bytes.map((bytes, index) => !journal.complete[index] && bytes === selection.files[index]!.size ? 0 : bytes);
          const total = selection.files.reduce((sum, file) => sum + file.size, 0);
          let processed = 0;
          // This is transient progress, never journal/DTO data. Resumed/reused bytes
          // cannot reliably tell the UI which request is currently being processed.
          let currentFileIndex: number | undefined;
          const report = (): void => {
            const completed = journal.bytes.reduce((sum, bytes) => sum + bytes, 0);
            onProgress({ progress: progressSchema.parse({ completed, total, processed, phase: completed === total ? 'verifying' : 'transferring', ...(currentFileIndex === undefined ? {} : { currentFileIndex }) }) });
          };
          report();
          for (let index = 0; index < selection.files.length; index++) {
            check(); if (journal.complete[index]) continue;
            const file = selection.files[index]!;
            // A full-size but unverified response must be downloaded again, never
            // promoted by a 416 response or by size alone.
            const offset = journal.reused?.[index] || journal.bytes[index] === file.size ? 0 : journal.bytes[index]!;
            const url = modelDownloadUrl({ repository: selection.repository, revision: selection.revision, file });
            currentFileIndex = index; report(); check();
            const response = await privacyFetchStream({ request: { url, signal: network.signal, ...(offset > 0 ? { headers: [['Range', `bytes=${offset}-`]] } : {}) } });
            body = response.body;
            const start = responseOffset({ status: response.status, headers: response.headers, offset, size: file.size });
            check(); await call({ promise: writer.open({ fileIndex: index, start }) }); journal.bytes[index] = start; report();
            switch (streamTransfer) {
            case 'supported': {
              const stream = body; body = undefined;
              let previousPosition = start;
              const onPosition = workerProxy({
                value: async ({ position }: { position: number }): Promise<void> => {
                  if (!Number.isSafeInteger(position) || position < previousPosition || position > file.size) throw new Error('Invalid download progress');
                  processed += position - previousPosition; previousPosition = position;
                  journal.bytes[index] = position; report();
                },
              });
              await call({ promise: writer.consume(workerTransfer({ value: workerCapability({ value: { stream }, capability: 'readable-stream-transfer' }), transferables: [stream] }), onPosition) });
              check(); journal.complete[index] = true; continue;
            }
            case 'unsupported': break;
            default: { const exhaustive: never = streamTransfer; throw new Error(String(exhaustive)); }
            }
            const reader = body.getReader(); let received = start;
            try {
              while (true) {
                check(); const { done, value } = await reader.read(); check(); if (done) break;
                if (received + value.byteLength > file.size) throw new Error('Download exceeds expected size');
                for (let position = 0; position < value.byteLength; position += 1024 * 1024) {
                  check(); const bytes = value.slice(position, position + 1024 * 1024);
                  const previousPosition = received;
                  received = await call({ promise: writer.append(workerTransfer({ value: { bytes }, transferables: [bytes.buffer] })) });
                  if (!Number.isSafeInteger(received) || received < previousPosition || received > file.size) throw new Error('Invalid download progress');
                  processed += received - previousPosition;
                  journal.bytes[index] = received; report();
                }
              }
              if (received !== file.size) throw new Error('Download ended before its expected size');
              check(); await call({ promise: writer.finishFile() }); journal.complete[index] = true;
            } catch (error) {
              await reader.cancel().catch(() => {}); throw error;
            } finally {
              reader.releaseLock(); body = undefined;
            }
          }
          currentFileIndex = undefined; report();
          check(); await call({ promise: writer.finish() });
        } catch (error) {
          if (error instanceof Error && error.message === sharedProjectorConflictMessage) throw new DownloadConflictError({ reason: 'projector-conflict' });
          if (error instanceof Error && error.message === existingModelConflictMessage) throw new DownloadConflictError({ reason: 'existing-files' });
          throw error;
        } finally {
          await body?.cancel().catch(() => {});
          try {
            // Keep transport errors observable while pause acknowledges pending writes.
            await session.dispose({ beforeRelease: fatal ? undefined : () => call({ promise: writer.pause() }) });
          } finally {
            if (abortTimer !== undefined) clearTimeout(abortTimer);
            signal.removeEventListener('abort', forwardAbort); network.abort();
            worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onError);
          }
        }
      },
    }),
  });
}
export async function cancelDownload({ repository, plan, destination }: { repository: string, plan: DeletionPlan, destination?: ModelDestination }): Promise<DeletionResult> {
  return withDestinationLock({ destination, operation: () => withRepositoryLock({ repository, operation: () => deleteRepository({ repository, plan, destination }) }) });
}
export const TEST_ONLY = {
};
