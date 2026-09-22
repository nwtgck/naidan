import { wrapWorkerRemote } from '@/utils/worker-transport';
import { createDedicatedDownloadWorkerSession } from '@/features/transformers-js/download-verification/dedicated-worker-cleanup';
import { downloadSizeResultSchema, type DownloadSizeRequest, type DownloadSizeResult, type DownloadSizeWorkerApi } from './types';

/** One optional observation owns one lightweight Worker and a hard deadline. */
export function createDownloadSizeClient() {
  let session: ReturnType<typeof createDedicatedDownloadWorkerSession<DownloadSizeWorkerApi>> | undefined;
  let closed = false;
  let started = false;
  const stopped = Promise.withResolvers<DownloadSizeResult>();
  const empty: DownloadSizeResult = { sizes: [], quotaLimited: false };
  function dispose(): void {
    closed = true; stopped.resolve(empty);
    try {
      session?.dispose();
    } catch { /* Observation cleanup cannot fail model acquisition. */ }
  }
  return {
    async collect({ request }: { request: DownloadSizeRequest }): Promise<DownloadSizeResult> {
      if (closed || started || typeof Worker === 'undefined') return empty;
      started = true;
      const timer = setTimeout(dispose, 5_000);
      try {
        const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
        session = createDedicatedDownloadWorkerSession({ worker, createRemote: () => wrapWorkerRemote<DownloadSizeWorkerApi>({ endpoint: worker }) });
        const value = await Promise.race([session.run({ operation: ({ remote }) => remote.collect(request) }), stopped.promise]);
        const parsed = downloadSizeResultSchema.safeParse(value);
        return parsed.success ? parsed.data : empty;
      } catch {
        return empty;
      } finally {
        clearTimeout(timer); dispose();
      }
    },
    dispose,
  };
}
export const TEST_ONLY = {
};
