import { releaseWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';

export function disposeDedicatedWorkerBestEffort<Api>({
  remote,
  worker,
}: {
  remote: WorkerRemote<Api>;
  worker: Worker;
}): void {
  try {
    const release = releaseWorkerRemote({ remote });
    void Promise.resolve(release).catch(() => undefined);
  } catch {
    // The Worker is terminated below. Remote release is advisory cleanup and must not
    // delay or replace a completed Download Verification result.
  }
  worker.terminate();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
