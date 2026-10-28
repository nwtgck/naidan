import { q8KernelDiagnosticSchemaAsset } from 'virtual:llama-cpp-browser-core/availability';
import { releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { createQ8DiagnosticClientSession } from './q8-diagnostic-client-session';
import type { Q8DiagnosticClient, Q8DiagnosticWorkerApi } from './q8-diagnostic-worker-types';

export function createQ8DiagnosticClient(): Q8DiagnosticClient {
  const asset = q8KernelDiagnosticSchemaAsset;
  if (asset === undefined || typeof Worker === 'undefined') {
    return {
      async run({ signal }) {
        signal?.throwIfAborted();
        return { status: 'unavailable', reason: asset === undefined ? 'artifact' : 'worker' };
      },
      dispose() {},
    };
  }
  const worker = new Worker(new URL('../worker/q8-diagnostic-entry.ts', import.meta.url), { type: 'module', name: 'naidan-q8-kernel-diagnostic' });
  try {
    const remote = wrapWorkerRemote<Q8DiagnosticWorkerApi>({ endpoint: worker });
    return createQ8DiagnosticClientSession({
      worker,
      remote,
      request: { assetBaseURL: new URL(`${import.meta.env.BASE_URL}llama-cpp-browser-runtime/profiles/`, document.baseURI).href, schemaAssetSha256: asset.sha256 },
      disposeTransport() {
        try {
          void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => {});
        } catch { /* A failed endpoint still requires physical termination. */
        } finally {
          worker.terminate();
        }
      },
    });
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

export const TEST_ONLY = {
};
