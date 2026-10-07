export type RpcConnectionHealth = 'responsive' | 'checking' | 'paused';
export type RpcResponseConfirmation = ({ signal, onRequestStarted }: { signal: AbortSignal; onRequestStarted(): void }) => Promise<void>;

/** RPC policy only. A cancelled probe never cancels DATA or replays a call. */
export async function monitorRpcConnection({ signal, confirmResponse, idleRevision, policy, changed, unresponsive }: {
  signal: AbortSignal;
  confirmResponse: RpcResponseConfirmation;
  idleRevision(): number | undefined;
  policy: { intervalMs: number; responseMs: number; missedResponses: number; suspensionToleranceMs: number };
  changed({ state }: { state: RpcConnectionHealth }): void;
  unresponsive({ revision }: { revision: number }): 'retiring' | 'observe-again';
}): Promise<void> {
  const { intervalMs, responseMs, missedResponses, suspensionToleranceMs, ...rest } = policy;
  rest satisfies Record<PropertyKey, never>;
  if (![intervalMs, responseMs, missedResponses, suspensionToleranceMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid RPC health policy');
  let paused = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  let windowRevision = 0, misses = 0, previousIdle: number | undefined;
  let active: AbortController | undefined;
  const change = { kind: 'observation-changed' }, ended = { kind: 'session-ended' };
  const reset = () => {
    windowRevision++; misses = 0; previousIdle = undefined; active?.abort(change);
  };
  const visibility = () => {
    paused = document.visibilityState === 'hidden'; reset();
  };
  const suspend = () => {
    paused = true; reset();
  };
  const resume = () => {
    paused = typeof document !== 'undefined' && document.visibilityState === 'hidden'; reset();
  };
  const stop = () => active?.abort(ended);
  signal.addEventListener('abort', stop);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend); document.addEventListener('resume', resume);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume); window.addEventListener('focus', resume); window.addEventListener('online', resume);
  }
  const wait = async () => {
    const controller = new AbortController(); active = controller;
    if (signal.aborted) controller.abort(ended);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>(resolve => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
        if (controller.signal.aborted) resolve(); else timer = setTimeout(resolve, intervalMs);
      });
    } finally {
      clearTimeout(timer); if (active === controller) active = undefined;
    }
  };
  try {
    while (!signal.aborted) {
      const idle = idleRevision();
      if (paused || idle === undefined) {
        misses = 0; previousIdle = undefined; changed({ state: paused ? 'paused' : 'responsive' }); await wait(); continue;
      }
      if (previousIdle !== idle) misses = 0;
      previousIdle = idle;
      const controller = new AbortController(); active = controller;
      const observation = windowRevision;
      const timeout = { kind: 'no-response' }, suspension = { kind: 'local-suspension' };
      let timer: ReturnType<typeof setTimeout> | undefined, started = false;
      try {
        if (signal.aborted) controller.abort(ended);
        await confirmResponse({ signal: controller.signal, onRequestStarted: () => {
          if (started || controller.signal.aborted) return;
          started = true;
          const monotonic = performance.now(), wall = Date.now();
          timer = setTimeout(() => {
            const elapsed = performance.now() - monotonic, elapsedWall = Date.now() - wall;
            const delayed = elapsed < 0 || elapsedWall < 0 || elapsed > responseMs + suspensionToleranceMs || elapsedWall > responseMs + suspensionToleranceMs || Math.abs(elapsed - elapsedWall) > suspensionToleranceMs;
            controller.abort(delayed ? suspension : timeout);
          }, responseMs);
        } });
        misses = 0; changed({ state: 'responsive' });
      } catch (error) {
        if (signal.aborted) return;
        if (error === timeout && !paused && windowRevision === observation && idleRevision() === idle) {
          misses++; changed({ state: 'checking' });
          if (misses >= missedResponses) {
            const outcome = unresponsive({ revision: idle });
            switch (outcome) {
            case 'retiring': return;
            case 'observe-again': misses = 0; previousIdle = undefined; break;
            default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
            }
          }
        } else if (error === change || error === suspension || error === timeout) {
          misses = 0; previousIdle = undefined; changed({ state: paused ? 'paused' : 'responsive' });
        } else throw error;
      } finally {
        clearTimeout(timer); controller.abort(change);
        if (active === controller) active = undefined;
      }
      if (!signal.aborted) await wait();
    }
  } finally {
    active?.abort(ended); signal.removeEventListener('abort', stop);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('freeze', suspend); document.removeEventListener('resume', resume);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    }
  }
}

export const TEST_ONLY = {
};
