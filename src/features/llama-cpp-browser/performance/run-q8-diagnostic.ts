import type { Q8DiagnosticClient, Q8DiagnosticWorkerResult } from './q8-diagnostic-worker-types';

/** Own cancellation from lazy import through final Worker retirement. A stalled
 * chunk request must not keep the service's exclusive lane after Stop. */
async function run({ signal, timeoutMs, onProgress, loadClient }: {
  signal: AbortSignal | undefined, timeoutMs: number,
  onProgress: Parameters<Q8DiagnosticClient['run']>[0]['onProgress'],
  loadClient: () => Promise<{ createQ8DiagnosticClient(): Q8DiagnosticClient }>,
}): Promise<Q8DiagnosticWorkerResult> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
    throw new RangeError('Invalid Q8 diagnostic timeout');
  }
  const control = new AbortController();
  let client: Q8DiagnosticClient | undefined;
  const retire = (): void => {
    const current = client;
    client = undefined;
    current?.dispose();
  };
  let stopped: { error: unknown } | undefined;
  const interrupted = Promise.withResolvers<never>();
  const stop = ({ error }: { error: unknown }): void => {
    stopped ??= { error };
    control.abort();
    try {
      retire();
    } catch { /* Cancellation still settles after a failed transport retirement. */
    } finally {
      interrupted.reject(error);
    }
  };
  const abort = () => stop({ error: new DOMException('Q8 diagnostic cancelled', 'AbortError') });
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop({ error: new Error('Q8 diagnostic timed out') }), timeoutMs);
  const operation = async (): Promise<Q8DiagnosticWorkerResult> => {
    control.signal.throwIfAborted();
    const loaded = await loadClient();
    control.signal.throwIfAborted();
    // Late imports can settle after cancellation, but can never create a Worker.
    client = loaded.createQ8DiagnosticClient();
    control.signal.throwIfAborted();
    return await client.run({ signal: control.signal, timeoutMs, onProgress });
  };
  try {
    if (signal?.aborted) {
      abort();
    }
    // Both late success and late rejection stay observed by the race. Physical
    // retirement is owned above; no native pointer is freed by this race.
    const result = await Promise.race([interrupted.promise, operation()]);
    if (stopped) {
      throw stopped.error;
    }
    return result;
  } catch (error) {
    throw stopped?.error ?? error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    control.abort();
    retire();
  }
}

export function runQ8Diagnostic({ signal, timeoutMs, onProgress }: {
  signal: AbortSignal | undefined, timeoutMs: number, onProgress: Parameters<Q8DiagnosticClient['run']>[0]['onProgress'],
}): Promise<Q8DiagnosticWorkerResult> {
  return run({ signal, timeoutMs, onProgress, loadClient: () => import('@/features/llama-cpp-browser/performance/q8-diagnostic-client') });
}

export const TEST_ONLY = {
  run,
};
