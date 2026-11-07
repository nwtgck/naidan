import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from '@/utils/worker-transport-capabilities';
import { createDownloadStreamFetchBridge } from './fetch-bridge';
import { createFileDownloadSession } from '@/logic/hugging-face-download/worker/factory';
import { workerProxy, prepareWorkerCapability } from '@/utils/worker-transport';
import { fileDownloadProgressSchema } from './progress';
import type { HuggingFaceDownloadRequest } from './acquire';

/** Both hosted and standalone callers use this client; rendering the static catalog
 * cannot create a Worker or start metadata requests. Cancellation normally lets
 * the writer checkpoint. A crashed/stalled Worker cannot keep the UI busy forever.
 */
export async function downloadHuggingFaceFiles({ files, signal, onProgress, destination, expectedRoot, validation }: { files: HuggingFaceDownloadRequest['files'], signal: HuggingFaceDownloadRequest['signal'], onProgress: HuggingFaceDownloadRequest['onProgress'], destination?: HuggingFaceDownloadRequest['destination'], expectedRoot: FileSystemDirectoryHandle | undefined, validation: 'model-weight' | 'none' }): Promise<void> {
  signal.throwIfAborted();
  const report: HuggingFaceDownloadRequest['onProgress'] = ({ progress }) => {
    const parsed = fileDownloadProgressSchema.safeParse(progress);
    if (parsed.success && !signal.aborted) {
      try {
        onProgress({ progress: parsed.data });
      } catch { /* Presentation cannot control storage in either transport. */ }
    }
  };
  const capturedRoot = (() => {
    const kind = destination?.kind;
    switch (kind) {
    case 'host': return expectedRoot;
    case 'opfs': case undefined: return undefined;
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const request = { files: files.map(file => ({ ...file })), destination: destination && { ...destination }, expectedRoot: capturedRoot, validation };
  const prepared = await prepareWorkerCapability({
    value: request,
    capability: FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION,
    fallback: async () => undefined,
  });
  signal.throwIfAborted();
  if (prepared === undefined) {
    // Only linked-folder downloads carry a root handle. Keep that exact root
    // and the existing lock/identity/publication checks; do not resolve a queued
    // folder alias again in a different realm or retry a started download.
    const { acquireHuggingFaceFiles } = await import('./acquire');
    const { privacyFetchStream } = await import('@/features/privacy-fetch');
    signal.throwIfAborted();
    return acquireHuggingFaceFiles({ ...request, signal, onProgress: report, fetch: privacyFetchStream });
  }
  const session = await createFileDownloadSession({ signal });
  const { worker, remote } = session;
  const bridge = createDownloadStreamFetchBridge({ signal });
  const stopped = Promise.withResolvers<never>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const crash = (): void => stopped.reject(new Error('Model download Worker failed; completed files and pending checkpoints were retained'));
  const abort = (): void => {
    if (timer !== undefined) {
      return;
    }
    void remote.cancel().catch(crash);
    timer = setTimeout(() => stopped.reject(new DOMException('Download paused', 'AbortError')), 5000);
  };
  signal.addEventListener('abort', abort, { once: true });
  worker.addEventListener('error', crash);
  worker.addEventListener('messageerror', crash);
  try {
    signal.throwIfAborted();
    const operation = remote.download(prepared, workerProxy({ value: report }), workerProxy({ value: bridge.open }));
    if (signal.aborted) {
      abort();
    }
    await Promise.race([operation, stopped.promise]);
    // Resolved storage work is committed, including a coincident pause.
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    signal.removeEventListener('abort', abort);
    worker.removeEventListener('error', crash);
    worker.removeEventListener('messageerror', crash);
    bridge.dispose();
    await session.dispose();
  }
}

export const TEST_ONLY = {
};
