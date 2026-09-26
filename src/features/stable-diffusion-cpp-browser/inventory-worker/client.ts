import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import type { ModelInventory } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import type { LocalImageRepository } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import { inspectionProgressSchema, type InspectionReport, type InventoryWorker } from './types';

// This is an inactivity bound, not a maximum duration for a large model library.
export const INSPECTION_STALL_MS = 60_000;
export async function inspectImageInventory({ signal, onProgress, repositories }: {
  signal: AbortSignal, onProgress: InspectionReport, repositories?: LocalImageRepository[],
}): Promise<ModelInventory> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'image-model-inspection' });
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  let lastProgress = 'starting inspection Worker';
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(signal.reason ?? new DOMException('Inspection cancelled', 'AbortError'));
  const crash = () => stopped.reject(new Error('Local model inspection Worker failed. Retry the scan.'));
  const pulse = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stopped.reject(new DOMException(`Local model inspection made no progress for 60 seconds (${lastProgress}). Retry the scan.`, 'TimeoutError')), INSPECTION_STALL_MS);
  };
  let remote: ReturnType<typeof wrapWorkerRemote<InventoryWorker>> | undefined;
  signal.addEventListener('abort', abort, { once: true });
  worker.addEventListener('error', crash); worker.addEventListener('messageerror', crash);
  try {
    remote = wrapWorkerRemote<InventoryWorker>({ endpoint: worker });
    pulse();
    if (signal.aborted) abort();
    return await Promise.race([remote.inspect(repositories, workerProxy({ value: ({ progress }) => {
      if (closed || signal.aborted) return;
      const parsed = inspectionProgressSchema.safeParse(progress);
      if (!parsed.success) return;
      lastProgress = `${parsed.data.phase}: ${parsed.data.path.slice(0, 512)}`;
      pulse();
      try {
        onProgress({ progress: parsed.data });
      } catch { /* observational */ }
    } })), stopped.promise]);
  } finally {
    closed = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
    worker.removeEventListener('error', crash); worker.removeEventListener('messageerror', crash);
    if (remote) try {
      Promise.resolve(releaseWorkerRemote({ remote })).catch(() => undefined);
    } catch { /* worker gone */ }
    worker.terminate();
  }
}
export const TEST_ONLY = {
};
