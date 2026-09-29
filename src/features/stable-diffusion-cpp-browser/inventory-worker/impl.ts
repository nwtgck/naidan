import { releaseWorkerRemote, type WorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { scanImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { listImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import type { InspectionProgress, InspectionReport, InventoryWorker } from './types';

/** Read-only, single-use realm: cancellation can terminate synchronous parsing
 * and OPFS reads without touching the separate retained inference Worker. */
export function createInventoryWorker(): WorkerServerApi<InventoryWorker> {
  let used = false;
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Top-level Comlink callback.
    async inspect(input, report) {
      if (used) throw new Error('Inventory workers are single-use');
      used = true;
      let previous = 0, lastPhase: InspectionProgress['phase'] | undefined;
      function publish({ progress }: { progress: InspectionProgress }): void {
        const now = performance.now();
        if (progress.phase === lastPhase && now - previous < 200 && (!progress.total || progress.completed < progress.total)) return;
        lastPhase = progress.phase; previous = now;
        try {
          Promise.resolve(report({ progress })).catch(() => undefined);
        } catch { /* caller gone */ }
      }
      try {
        const repositories = input ?? await listImageRepositories({ signal: undefined, onProgress: publish });
        return await scanImageRepositories({ repositories, signal: undefined, onProgress: publish });
      } finally {
        try {
          Promise.resolve(releaseWorkerRemote({ remote: report as WorkerRemote<InspectionReport> })).catch(() => undefined);
        } catch { /* caller gone */ }
      }
    },
  };
}
export const TEST_ONLY = {
};
