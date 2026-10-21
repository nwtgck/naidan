import { temporaryRootPathSchema } from '@/01-models/temporary-model-files';
import { inspectionRepositoryKeysSchema } from './types';
import { releaseWorkerRemote, type WorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { scanImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { listImageRepositories, listHostImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import type { InspectionProgress, InspectionReport, InventoryWorker } from './types';

/** Read-only, single-use realm: cancellation can terminate synchronous parsing
 * and OPFS reads without touching the separate retained inference Worker. */
export function createInventoryWorker(): WorkerServerApi<InventoryWorker> {
  let used = false;
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Top-level Comlink callback.
    async inspect(input, report, hostDirectories, repositoryKeys, temporaryRepositories) {
      if (used) {
        throw new Error('Inventory workers are single-use');
      }
      used = true;
      let previous = 0, lastPhase: InspectionProgress['phase'] | undefined;
      function publish({ progress }: { progress: InspectionProgress }): void {
        const now = performance.now();
        if (progress.phase === lastPhase && now - previous < 200 && (!progress.total || progress.completed < progress.total)) {
          return;
        }
        lastPhase = progress.phase;
        previous = now;
        try {
          Promise.resolve(report({ progress })).catch(() => undefined);
        } catch { /* caller gone */ }
      }
      try {
        const selectedRepositories = repositoryKeys === undefined ? undefined : inspectionRepositoryKeysSchema.parse(repositoryKeys);
        // Linked folders are independent of OPFS support. Skip only an absent
        // API; failures from an available OPFS must still reach the caller.
        const storedRepositoryKeys = selectedRepositories?.filter(repositoryKey => !temporaryRootPathSchema.safeParse(repositoryKey).success);
        const repositories = input ? [...input] : (typeof navigator.storage?.getDirectory === 'function' && (storedRepositoryKeys === undefined || storedRepositoryKeys.length > 0)
          ? await listImageRepositories({ signal: undefined, onProgress: publish, repositoryKeys: storedRepositoryKeys }) : []);
        if (hostDirectories?.length && selectedRepositories === undefined) {
          repositories.push(...await listHostImageRepositories({ directories: hostDirectories, signal: undefined, onProgress: publish }));
        }
        for (const repository of temporaryRepositories ?? []) {
          temporaryRootPathSchema.parse(repository.repositoryKey);
          if (!selectedRepositories || selectedRepositories.includes(repository.repositoryKey)) {
            repositories.push(repository);
          }
        }
        return await scanImageRepositories({ repositories: selectedRepositories ? repositories.filter(repository => selectedRepositories.includes(repository.repositoryKey)) : repositories, signal: undefined, onProgress: publish });
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
