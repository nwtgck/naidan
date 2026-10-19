import { createDownloadStreamFetchBridge } from './fetch-bridge';
import { createFileDownloadSession } from '@/logic/hugging-face-download/worker/factory';
import { workerProxy, workerCapability } from '@/utils/worker-transport';
import { fileDownloadProgressSchema } from './progress';
import type { HuggingFaceDownloadRequest } from './acquire';


/** Both hosted and standalone callers use this client; rendering the static catalog
 * cannot create a Worker or start metadata requests. Cancellation normally lets
 * the writer checkpoint. A crashed/stalled Worker cannot keep the UI busy forever.
 */
export async function downloadHuggingFaceFiles({ files, signal, onProgress, destination, expectedRoot, validation }: { files: HuggingFaceDownloadRequest['files'], signal: HuggingFaceDownloadRequest['signal'], onProgress: HuggingFaceDownloadRequest['onProgress'], destination?: HuggingFaceDownloadRequest['destination'], expectedRoot: FileSystemDirectoryHandle | undefined, validation: 'model-weight' | 'none' }): Promise<void> {
  signal.throwIfAborted();
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
    const operation = remote.download(workerCapability({ value: { files: files.map(file => ({ ...file })), destination, expectedRoot, validation }, capability: 'file-system-handle-clone' }), workerProxy({
      value: ({ progress }) => {
        const parsed = fileDownloadProgressSchema.safeParse(progress);
        if (parsed.success && !signal.aborted) {
          try {
            onProgress({ progress: parsed.data });
          } catch { /* presentation only */ }
        }
      },
    }), workerProxy({ value: bridge.open }));
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
