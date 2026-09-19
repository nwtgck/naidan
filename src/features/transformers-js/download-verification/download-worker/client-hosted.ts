import { workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { createDedicatedDownloadWorkerSession } from '@/features/transformers-js/download-verification/dedicated-worker-cleanup';
import { downloadResourcePath, downloadTransferProgressSchema, downloadFailedTransferObservationSchema, observeDownloadSafely } from '@/features/transformers-js/download-progress';
import { parsePrefetchResult } from './prefetch-result';
import type {
  ITransformersJsDownloadWorker,
  ProgressInfo,
  TransformersJsPrefetchResult,
  TransformersJsProgressCallback,
} from '@/features/transformers-js/types';

export interface TransformersJsDownloadWorkerClient {
  prefetchUrls({ urls, progressCallback }: {
    urls: string[];
    progressCallback: TransformersJsProgressCallback;
  }): Promise<TransformersJsPrefetchResult>;
  dispose(): Promise<void>;
}

export function createTransformersJsDownloadWorkerClient(): TransformersJsDownloadWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async prefetchUrls() {
        throw new Error('Transformers.js Download Worker requires a browser Worker');
      },
      async dispose() {
      },
    };
  }

  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
  const session = createDedicatedDownloadWorkerSession({
    worker,
    createRemote: () => wrapWorkerRemote<ITransformersJsDownloadWorker>({ endpoint: worker }),
  });
  return {
    async prefetchUrls({ urls, progressCallback }) {
      let accepting = true;
      const paths = new Set(urls.map(url => downloadResourcePath({ url })).filter(path => path !== undefined));
      const deliveredTerminals = new Map<string, string>();
      function publishProgress({ info }: { info: ProgressInfo }): Promise<void> | undefined {
        const { status, file, loaded, total, progress, name, downloadTiming, downloadCumulativeTiming, downloadTotalKind, ...unhandled } = info;
        unhandled satisfies Record<PropertyKey, never>;
        if (file === undefined) return;
        const terminal = status === 'done' || status === 'cached' || status === 'error';
        if (terminal) {
          // Keep only immutable scalars, before invoking an observer that may
          // mutate its input. The RPC result may correct a differing terminal.
          const signature = JSON.stringify([status, file, loaded, total, progress, name, downloadTiming, downloadCumulativeTiming, downloadTotalKind]);
          if (deliveredTerminals.get(file) === signature) return;
          deliveredTerminals.set(file, signature);
        } else if (deliveredTerminals.has(file)) {
          return;
        }
        // Preserve the ACK for the bounded Worker emitter, without making I/O
        // await it. A held observer cannot prevent final result reconciliation.
        try {
          return Promise.resolve(progressCallback({ info })).catch(() => undefined);
        } catch {
          return;
        }
      }
      try {
        const rawResult = await session.run({ operation: ({ remote }) => remote.prefetchUrls(
          urls,
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callback is a positional remote boundary.
          workerProxy({ value: (info: ProgressInfo) => {
            if (!accepting || !session.isActive()) return;
            const parsed = downloadTransferProgressSchema.safeParse(info);
            if (!parsed.success || !paths.has(parsed.data.file)) return;
            // A verified file can finish long before a later shard. Reflect its
            // terminal now; only an identical result notification is redundant.
            return publishProgress({ info: parsed.data });
          } }),
        ) });
        const result = parsePrefetchResult({ value: rawResult });
        accepting = false;
        // RPC completion is authoritative; callback ports can still have queued
        // samples. Reconcile every terminal without waiting for a UI observer.
        for (const file of result.files) {
          if (!session.isActive()) break;
          const path = downloadResourcePath({ url: file.url });
          if (path === undefined || !paths.has(path)) continue;
          const info: ProgressInfo = (() => {
            switch (file.status) {
            case 'failed': {
              const observed = downloadFailedTransferObservationSchema.safeParse(file.transferObservation);
              return { status: 'error', file: path, ...(observed.success ? { loaded: observed.data.receivedBytes, total: observed.data.expectedBytes } : {}) };
            }
            case 'cached': return { status: 'cached', file: path, loaded: file.byteLength, total: file.byteLength, progress: 100 };
            case 'downloaded': return { status: 'done', file: path, loaded: file.byteLength, total: file.byteLength, progress: 100 };
            default: { const exhaustive: never = file; throw new Error(String(exhaustive)); }
            }
          })();
          observeDownloadSafely({ observe: () => publishProgress({ info }) });
        }
        return result;
      } finally {
        accepting = false;
      }
    },
    async dispose() {
      session.dispose();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
