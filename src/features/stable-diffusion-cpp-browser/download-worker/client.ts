import { createImageDownloadFetchBridge } from './fetch-bridge';
import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { catalogDownloadProgressSchema } from './progress';
import type { ImageRecipeDownloadRequest } from '@/features/stable-diffusion-cpp-browser/logic/catalog-download';
import type { ImageDownloadWorker } from './types';

/** Only the hosted library imports this client; rendering the static catalog
 * cannot create a Worker or start metadata requests. Cancellation normally lets
 * the writer checkpoint. A crashed/stalled Worker cannot keep the UI busy forever.
 */
export async function downloadImageRecipeInWorker({ files, signal, onProgress }: ImageRecipeDownloadRequest): Promise<void> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-image-model-download' });
  const remote = (() => {
    try {
      return wrapWorkerRemote<ImageDownloadWorker>({ endpoint: worker });
    } catch (error) {
      worker.terminate(); throw error;
    }
  })();
  const bridge = createImageDownloadFetchBridge({ signal });
  const stopped = Promise.withResolvers<never>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const crash = (): void => stopped.reject(new Error('Model download Worker failed; completed files and pending checkpoints were retained'));
  const abort = (): void => {
    if (timer !== undefined) return;
    void remote.cancel().catch(crash);
    timer = setTimeout(() => stopped.reject(new DOMException('Download paused', 'AbortError')), 5000);
  };
  signal.addEventListener('abort', abort, { once: true });
  worker.addEventListener('error', crash); worker.addEventListener('messageerror', crash);
  try {
    const operation = remote.download({ files: files.map(file => ({ ...file })) }, workerProxy({ value: ({ progress }) => {
      const parsed = catalogDownloadProgressSchema.safeParse(progress);
      if (parsed.success && !signal.aborted) {
        try {
          onProgress({ progress: parsed.data });
        } catch { /* presentation only */ }
      }
    } }), workerProxy({ value: bridge.open }));
    if (signal.aborted) abort();
    await Promise.race([operation, stopped.promise]); signal.throwIfAborted();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    worker.removeEventListener('error', crash); worker.removeEventListener('messageerror', crash);
    try {
      void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => undefined);
    } catch { /* already stopped */ }
    bridge.dispose(); worker.terminate();
  }
}
export const TEST_ONLY = {
};
