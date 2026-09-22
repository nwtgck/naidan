import { createWorkerBlobReadHost } from '@/utils/worker-blob-context';
import { workerProxy } from '@/utils/worker-transport';
import { verifySharedStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/llama-cpp-browser';
import { createStandaloneWorkerSession, disposeStandaloneWorkerSession, STANDALONE_WORKER_CLEANUP_TIMEOUT_MS } from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import { logFailure } from '@/features/llama-cpp-browser/debug-log';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { parseRuntimeOptions } from '@/features/llama-cpp-browser/runtime/profile-policy-standalone';
import { createLlamaCppWorkerSessionClient } from './client-session';
import type { LlamaCppWorkerApi, LlamaCppWorkerClient } from './types';

export function createLlamaCppWorkerClient(): LlamaCppWorkerClient {
  let disposed = false;
  const disposeListeners = new Set<() => void>();
  let client: LlamaCppWorkerClient | undefined;
  let starting: Promise<LlamaCppWorkerClient> | undefined;
  let startupFailure: LlamaCppBrowserError | undefined;
  const lifetime = new AbortController();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    client?.dispose();
    for (const listener of disposeListeners) {
      try {
        listener();
      } catch { /* Disposal observers cannot interrupt cleanup. */ }
    }
    disposeListeners.clear();
  };
  const start = async (): Promise<LlamaCppWorkerClient> => {
    if (typeof Worker === 'undefined') throw new LlamaCppBrowserError({ code: 'unavailable' });
    const session = await createStandaloneWorkerSession<LlamaCppWorkerApi>({ createWorker: createStandaloneWorker });
    const ready = createLlamaCppWorkerSessionClient({
      ...session,
      getAssetBaseURL: () => undefined,
      disposeTransport({ active }) {
        void disposeStandaloneWorkerSession({
          session,
          // Busy native work cannot service another request. The transport
          // release is bounded even when the worker is no longer responding.
          beforeRelease: active ? undefined : () => session.remote.release(),
          cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
        }).catch(error => logFailure({ stage: 'cleanup', error }));
      },
    });
    if (disposed) {
      ready.dispose();
      throw new LlamaCppBrowserError({ code: 'worker-failed' });
    }
    client = ready;
    ready.subscribeDisposed({ listener: dispose });
    const probeLifetime = new AbortController();
    const stopProbe = () => probeLifetime.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener('abort', stopProbe, { once: true });
    try {
      if (lifetime.signal.aborted) stopProbe();
      const host = createWorkerBlobReadHost({ signal: probeLifetime.signal });
      await verifySharedStorage({
        verify: ({ probeId }) => session.remote.verifyStorage({ probeId }, workerProxy({ value: host })),
        signal: lifetime.signal,
      });
    } finally {
      lifetime.signal.removeEventListener('abort', stopProbe);
      // Even a successful probe must not leave a host reader available to late
      // calls. Model operations do not borrow this short-lived probe context.
      probeLifetime.abort(new DOMException('Storage probe finished', 'AbortError'));
    }
    return ready;
  };
  const getClient = async ({ signal }: { signal: AbortSignal | undefined }): Promise<LlamaCppWorkerClient> => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    if (disposed) throw new LlamaCppBrowserError({ code: 'worker-failed' });
    starting ??= start().catch(error => {
      startupFailure = error instanceof LlamaCppBrowserError ? error : new LlamaCppBrowserError({ code: 'worker-failed' });
      dispose();
      logFailure({ stage: 'worker-error', error });
      throw startupFailure;
    });
    let rejectWaiting: ReturnType<typeof Promise.withResolvers<never>>['reject'] | undefined;
    const reject = (): void => rejectWaiting?.(signal?.aborted
      ? new LlamaCppBrowserError({ code: 'aborted' })
      : startupFailure ?? new LlamaCppBrowserError({ code: 'worker-failed' }));
    const abort = (): void => {
      dispose(); reject();
    };
    signal?.addEventListener('abort', abort, { once: true });
    lifetime.signal.addEventListener('abort', reject, { once: true });
    try {
      return await Promise.race([starting, new Promise<never>((_resolve, rejectPromise) => {
        rejectWaiting = rejectPromise;
        if (disposed || signal?.aborted) reject();
      })]);
    } finally {
      signal?.removeEventListener('abort', abort);
      lifetime.signal.removeEventListener('abort', reject);
    }
  };
  return {
    subscribeDisposed({ listener }) {
      if (disposed) {
        listener(); return () => {};
      }
      disposeListeners.add(listener); return () => {
        disposeListeners.delete(listener);
      };
    },
    probeProfiles: async ({ signal }) => (await getClient({ signal })).probeProfiles({ signal }),
    listModels: async ({ signal }) => (await getClient({ signal })).listModels({ signal }),
    importModel: async ({ file, onProgress, signal }) => (await getClient({ signal })).importModel({ file, onProgress, signal }),
    importDirectory: async ({ directory, onProgress, signal }) => (await getClient({ signal })).importDirectory({ directory, onProgress, signal }),
    removeModel: async ({ plan, signal }) => (await getClient({ signal })).removeModel({ plan, signal }),
    generate: async ({ request, onEvent, onProgress, signal }) => {
      parseRuntimeOptions({ options: request.options });
      return (await getClient({ signal })).generate({ request, onEvent, onProgress, signal });
    },
    canReuse: () => !disposed && (client?.canReuse() ?? true),
    dispose,
  };
}
export const TEST_ONLY = {
};
