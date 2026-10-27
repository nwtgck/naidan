import { subscribeWorkerNotifications, type WorkerRemote } from '@/utils/worker-transport';
import { q8DiagnosticNotificationSchema, q8DiagnosticWorkerRequestSchema, q8DiagnosticWorkerResultSchema, type Q8DiagnosticClient, type Q8DiagnosticWorkerApi, type Q8DiagnosticWorkerRequest, type Q8DiagnosticWorkerResult } from './q8-diagnostic-worker-types';

/** Dedicated, single-use session. Cancellation terminates the physical Worker
 * before rejecting; it never frees a suspended call's native allocations. */
export function createQ8DiagnosticClientSession({ worker, remote, disposeTransport, request }: {
  worker: Pick<Worker, 'addEventListener' | 'removeEventListener' | 'postMessage'>,
  remote: WorkerRemote<Q8DiagnosticWorkerApi>,
  disposeTransport: () => void,
  request: Q8DiagnosticWorkerRequest,
}): Q8DiagnosticClient {
  let state: 'idle' | 'running' | 'disposed' = 'idle';
  let stop: (({ error }: { error: unknown }) => void) | undefined;
  const isRunning = (): boolean => {
    switch (state) {
    case 'running': return true;
    case 'idle': case 'disposed': return false;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled diagnostic state: ${exhaustive}`);
    }
    }
  };
  const dispose = (): void => {
    switch (state) {
    case 'disposed': return;
    case 'idle': case 'running': break;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled diagnostic state: ${exhaustive}`);
    }
    }
    state = 'disposed';
    disposeTransport();
  };
  return {
    async run({ signal, timeoutMs, onProgress }) {
      switch (state) {
      case 'idle': break;
      case 'running': case 'disposed': throw new Error('Q8 diagnostic client has already been used');
      default: {
        const exhaustive: never = state;
        throw new Error(`Unhandled diagnostic state: ${exhaustive}`);
      }
      }
      let accepted: Q8DiagnosticWorkerRequest;
      try {
        accepted = q8DiagnosticWorkerRequestSchema.parse(request);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
          throw new RangeError('Invalid Q8 diagnostic timeout');
        }
      } catch (error) {
        dispose();
        throw error;
      }
      state = 'running';
      const result = Promise.withResolvers<unknown>();
      let stopped: { error: unknown } | undefined;
      const fail = ({ error }: { error: unknown }): void => {
        stopped ??= { error };
        try {
          dispose();
        } catch { /* Preserve cancellation even if transport retirement fails. */
        } finally {
          result.reject(error);
        }
      };
      stop = fail;
      const abort = () => fail({ error: new DOMException('Q8 diagnostic cancelled', 'AbortError') });
      const failed = () => fail({ error: new Error('Q8 diagnostic Worker failed') });
      const unsubscribe = subscribeWorkerNotifications({
        endpoint: worker,
        schema: q8DiagnosticNotificationSchema,
        listener: ({ value }) => {
          if (!isRunning()) {
            return;
          }
          try {
            onProgress({ progress: value.progress });
          } catch (error) {
            fail({ error });
          }
        },
      });
      worker.addEventListener('error', failed);
      worker.addEventListener('messageerror', failed);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => fail({ error: new Error('Q8 diagnostic timed out') }), timeoutMs);
      try {
        if (signal?.aborted) {
          abort();
        } else {
          // Observe both branches even if cancellation retires this transport
          // first; a late RPC rejection must never become unhandled.
          void Promise.resolve().then<Q8DiagnosticWorkerResult>(() => {
            if (!isRunning()) {
              throw new DOMException('Q8 diagnostic cancelled', 'AbortError');
            }
            return remote.run({ request: accepted });
          }).then(result.resolve, result.reject);
        }
        const raw = await result.promise;
        if (stopped) {
          throw stopped.error;
        }
        const value = q8DiagnosticWorkerResultSchema.parse(raw);
        if (value.status === 'completed' && value.schemaAssetSha256 !== accepted.schemaAssetSha256) {
          throw new Error('Q8 diagnostic result asset identity mismatch');
        }
        return value;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker.removeEventListener('error', failed);
        worker.removeEventListener('messageerror', failed);
        unsubscribe();
        stop = undefined;
        dispose();
      }
    },
    dispose() {
      if (stop) {
        stop({ error: new DOMException('Q8 diagnostic disposed', 'AbortError') });
      } else {
        dispose();
      }
    },
  };
}

export const TEST_ONLY = {
};
