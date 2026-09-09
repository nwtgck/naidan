import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { freshMetadataRequestSchema, freshMetadataResultSchema, freshMetadataSummarySchema, FRESH_METADATA_TIMEOUT_MS, type FreshMetadataResult, type FreshMetadataSummary, type FreshMetadataWorker } from './types';

export function createFreshMetadataWorkerClient() {
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
  const remote = wrapWorkerRemote<FreshMetadataWorker>({ endpoint: worker });
  const disposed = new AbortController();
  let state: 'unused' | 'running' | 'closed' = 'unused';
  function dispose() {
    switch (state) {
    case 'closed': return;
    case 'unused':
    case 'running': break;
    default: {
      const _ex: never = state;
      throw new Error(`Unknown fresh metadata client state: ${_ex}`);
    }
    }
    disposed.abort(new Error('Fresh metadata Worker disposed'));
    try {
      void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => undefined);
    } catch {
      // Remote release is advisory; physical termination owns the deadline.
    } finally {
      worker.terminate();
      state = 'closed';
    }
  }
  return {
    async run({ modelId, revision, maximumBytes, repositoryFiles, signal, onObservation }: {
      modelId: string,
      revision: string,
      maximumBytes: number,
      repositoryFiles: Array<{ path: string, size: number | undefined }>,
      signal: AbortSignal,
      onObservation: ({ summary }: { summary: FreshMetadataSummary }) => void,
    }): Promise<FreshMetadataResult> {
      switch (state) {
      case 'unused': break;
      case 'running':
      case 'closed': throw new Error('Fresh metadata client is single-use');
      default: {
        const _ex: never = state;
        throw new Error(`Unknown fresh metadata client state: ${_ex}`);
      }
      }
      state = 'running';
      let accepting = true;
      let summary: FreshMetadataSummary = { schemaVersion: 1, modelId, revision, maximumBytes, source: 'fresh-network-memory', status: 'running', receivedBytes: 0, requests: [] };
      const deadline = new AbortController();
      const operationSignal = AbortSignal.any([signal, disposed.signal, deadline.signal]);
      const interruption = Promise.withResolvers<never>();
      const onAbort = () => interruption.reject(operationSignal.reason);
      operationSignal.addEventListener('abort', onAbort, { once: true });
      if (operationSignal.aborted) onAbort();
      const timer = setTimeout(() => deadline.abort(new Error('Fresh metadata Worker deadline exceeded')), FRESH_METADATA_TIMEOUT_MS);
      try {
        const input = freshMetadataRequestSchema.parse({ modelId, revision, maximumBytes, repositoryFiles });
        // An already-aborted request must not start remote work.
        operationSignal.throwIfAborted();
        const result = await Promise.race([
          remote.run(input, workerProxy({ value: ({ summary: value }: { summary: FreshMetadataSummary }) => {
            if (!accepting || operationSignal.aborted) return;
            try {
              const next = freshMetadataSummarySchema.parse(value);
              if (next.modelId !== modelId || next.revision !== revision || next.maximumBytes !== maximumBytes) throw new Error('Fresh metadata observation identity mismatch');
              summary = next;
              onObservation({ summary });
            } catch (error) {
              accepting = false;
              interruption.reject(error);
            }
          } })),
          interruption.promise,
        ]);
        const parsed = freshMetadataResultSchema.parse(result);
        if (parsed.summary.modelId !== modelId || parsed.summary.revision !== revision || parsed.summary.maximumBytes !== maximumBytes) throw new Error('Fresh metadata result identity mismatch');
        return parsed;
      } catch {
        if (signal.aborted) throw signal.reason;
        return { summary: { ...summary, status: deadline.signal.aborted ? 'timeout' : 'failed', reason: 'Fresh metadata Worker did not complete; retained HTTP observations are partial.' }, files: [] };
      } finally {
        accepting = false;
        clearTimeout(timer);
        operationSignal.removeEventListener('abort', onAbort);
        // This handler also covers validation errors before Promise.race attaches.
        void interruption.promise.catch(() => undefined);
        dispose();
      }
    },
    dispose,
  };
}

export const TEST_ONLY = {
};
