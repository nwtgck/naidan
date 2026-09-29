import { z } from 'zod';
import { receiveByteStream } from '@/utils/byte-stream-port';
import { createEvidenceStreamRequest } from './stream-request';
import { releaseWorkerRemote, wrapWorkerRemote, workerTransfer } from "@/utils/worker-transport";
import type {
  IModelSupportInvestigationEvidenceWorker,
  ModelSupportInvestigationEvidenceWorkerClient,
} from "@/features/transformers-js/model-support-investigation/evidence-worker/types";
import { createModelSupportInvestigationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/request";
import { createModelSupportInvestigationBatchEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/batch-request";
import { createDownloadVerificationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/download-verification-request";
import { createOrdinaryDownloadTimingEvidenceFile } from '@/features/transformers-js/model-support-investigation/logic/ordinary-download-timing-evidence';

export const DEFAULT_EVIDENCE_EXPORT_TIMEOUT_MS = 60 * 1000;

export class ModelSupportInvestigationEvidenceExportTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor({ timeoutMs }: { timeoutMs: number }) {
    super(`Model Support Investigation Evidence export timed out after ${timeoutMs} ms`);
    this.name = "ModelSupportInvestigationEvidenceExportTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ModelSupportInvestigationEvidenceExportDisposedError extends Error {
  constructor() {
    super("Model Support Investigation Evidence export was cancelled because its Worker client was disposed");
    this.name = "ModelSupportInvestigationEvidenceExportDisposedError";
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
  const activeStreams = new Set<ReturnType<typeof receiveByteStream>>();
  let disposed = false;
  let workerTerminated = false;
  const activeOperationRejectors = new Set<ReturnType<typeof Promise.withResolvers<never>>['reject']>();

  function terminateWorker(): void {
    if (workerTerminated) return;
    workerTerminated = true;
    for (const stream of activeStreams) stream.abort({ reason: new ModelSupportInvestigationEvidenceExportDisposedError() });
    activeStreams.clear();
    worker.removeEventListener('error', handleWorkerFailure);
    worker.removeEventListener('messageerror', handleWorkerFailure);
    worker.terminate();
  }

  function handleWorkerFailure(): void {
    const error = new Error('Evidence Worker stopped responding');
    for (const reject of activeOperationRejectors) reject(error);
    terminateWorker();
  }
  worker.addEventListener('error', handleWorkerFailure);
  worker.addEventListener('messageerror', handleWorkerFailure);

  function releaseRemoteBestEffort(): void {
    try {
      const release = releaseWorkerRemote({ remote });
      if (release instanceof Promise) void release.catch(() => undefined);
    } catch {
      // The dedicated Worker is terminated below. A failed Comlink release must not stall Evidence recovery.
    }
  }

  async function runExportOperation<T>({ operation }: { operation: Promise<T> }): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        terminateWorker();
        reject(new ModelSupportInvestigationEvidenceExportTimeoutError({ timeoutMs }));
      }, timeoutMs);
    });
    const cancelled = Promise.withResolvers<never>();
    activeOperationRejectors.add(cancelled.reject);

    try {
      return await Promise.race([operation, timeout, cancelled.promise]);
    } catch (error) {
      // Each export gets a fresh Worker. A rejected, cancelled, or hung export is terminal
      // for this client, so terminate immediately rather than awaiting remote cleanup.
      terminateWorker();
      throw error;
    } finally {
      activeOperationRejectors.delete(cancelled.reject);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async openEvidenceStream({ input }) {
      if (disposed || workerTerminated) throw new Error('Model Support Investigation Evidence Worker client is disposed');
      // Snapshot before the first await, exactly as for the inspection APIs.
      const request = createEvidenceStreamRequest({ input });
      const channel = new MessageChannel();
      const received = receiveByteStream({ port: channel.port1 });
      activeStreams.add(received);
      void received.completed.then(() => activeStreams.delete(received), () => activeStreams.delete(received));
      try {
        // The timeout covers validation/metadata, never a slow disk or paused download.
        const metadata = z.object({ fileName: z.string().min(1) }).strict().parse(await runExportOperation({
          operation: remote.streamEvidence(workerTransfer({ value: { input: request, port: channel.port2 }, transferables: [channel.port2] })),
        }));
        return { stream: received.stream, fileName: metadata.fileName };
      } catch (reason) {
        received.abort({ reason });
        channel.port2.close();
        throw reason;
      }
    },
    async createPartialEvidence({ run, recovery, replayMetadata, nativeEvidence, ordinaryDownloadTiming }) {
      if (disposed || workerTerminated) {
        throw new Error("Model Support Investigation Evidence Worker client is disposed");
      }

      return await runExportOperation({
        operation: remote.createPartialEvidence({
          request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }),
          replayMetadata,
          nativeEvidence,
          ordinaryDownloadTiming: ordinaryDownloadTiming === undefined ? undefined : createOrdinaryDownloadTimingEvidenceFile({ snapshot: ordinaryDownloadTiming, association: { kind: 'investigation-run', runId: run.runId } }),
        }),
      });
    },
    async createBatchEvidence({ batchId, items, ordinaryDownloadTiming }) {
      if (disposed || workerTerminated) {
        throw new Error("Model Support Investigation Evidence Worker client is disposed");
      }

      return await runExportOperation({
        operation: remote.createBatchEvidence({
          request: createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId, items }),
          replayMetadata: items.map(item => item.replayMetadata),
          nativeEvidence: items.map(item => item.nativeEvidence),
          ordinaryDownloadTiming: ordinaryDownloadTiming === undefined ? undefined : createOrdinaryDownloadTimingEvidenceFile({ snapshot: ordinaryDownloadTiming, association: { kind: 'investigation-batch', batchId } }),
        }),
      });
    },
    async createDownloadVerificationEvidence({ evidence }) {
      if (disposed || workerTerminated) {
        throw new Error("Model Support Investigation Evidence Worker client is disposed");
      }

      return await runExportOperation({
        operation: remote.createDownloadVerificationEvidence({
          request: createDownloadVerificationEvidenceWorkerRequest({ evidence }),
        }),
      });
    },
    async createRetainedDownloadTimingEvidence({ snapshot, exportId }) {
      if (disposed || workerTerminated) throw new Error('Model Support Investigation Evidence Worker client is disposed');
      return await runExportOperation({ operation: remote.createRetainedDownloadTimingEvidence({
        request: createOrdinaryDownloadTimingEvidenceFile({ snapshot, association: { kind: 'retained-export', exportId, investigation: 'not-run' } }),
      }) });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const reject of activeOperationRejectors) {
        reject(new ModelSupportInvestigationEvidenceExportDisposedError());
      }
      activeOperationRejectors.clear();
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
