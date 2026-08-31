import { releaseWorkerRemote, wrapWorkerRemote } from "@/utils/worker-transport";
import type {
  IModelSupportInvestigationEvidenceWorker,
  ModelSupportInvestigationEvidenceWorkerClient,
} from "@/features/transformers-js/model-support-investigation/evidence-worker/types";
import { createModelSupportInvestigationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/request";

export const DEFAULT_EVIDENCE_EXPORT_TIMEOUT_MS = 60 * 1000;

export class ModelSupportInvestigationEvidenceExportTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor({ timeoutMs }: { timeoutMs: number }) {
    super(`Model Support Investigation Evidence export timed out after ${timeoutMs} ms`);
    this.name = "ModelSupportInvestigationEvidenceExportTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function createModelSupportInvestigationEvidenceWorkerClient({
  timeoutMs = DEFAULT_EVIDENCE_EXPORT_TIMEOUT_MS,
}: {
  timeoutMs?: number,
} = {}): ModelSupportInvestigationEvidenceWorkerClient {
  if (typeof Worker === "undefined") {
    throw new Error("Model Support Investigation Evidence export requires a Worker");
  }

  const worker = new Worker(
    new URL("./entry.ts", import.meta.url),
    {
      type: "module",
      name: "naidan-model-support-investigation-evidence-worker",
    },
  );
  const remote = wrapWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ endpoint: worker });
  let disposed = false;
  let workerTerminated = false;

  function terminateWorker(): void {
    if (workerTerminated) return;
    workerTerminated = true;
    worker.terminate();
  }

  function releaseRemoteBestEffort(): void {
    try {
      const release = releaseWorkerRemote({ remote });
      if (release instanceof Promise) void release.catch(() => undefined);
    } catch {
      // The dedicated Worker is terminated below. A failed Comlink release must not stall Evidence recovery.
    }
  }

  return {
    async createPartialEvidence({ run, recovery }) {
      if (disposed || workerTerminated) {
        throw new Error("Model Support Investigation Evidence Worker client is disposed");
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          terminateWorker();
          reject(new ModelSupportInvestigationEvidenceExportTimeoutError({ timeoutMs }));
        }, timeoutMs);
      });

      try {
        return await Promise.race([
          remote.createPartialEvidence({
            request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }),
          }),
          timeout,
        ]);
      } catch (error) {
        // Each export gets a fresh Worker. A rejected/hung export is terminal for this client, so
        // terminate immediately rather than risking another hang while trying to release it.
        terminateWorker();
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (workerTerminated) return;
      // Disposal is deliberately non-blocking. Evidence export is a recovery path, so a hung
      // Comlink release must never keep the UI spinner alive after the archive itself completed.
      releaseRemoteBestEffort();
      terminateWorker();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
